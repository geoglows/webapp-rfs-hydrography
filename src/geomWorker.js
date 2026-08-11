import * as hp from 'hyparquet';
import {geojsonToWkb, parquetWriteBuffer} from 'hyparquet-writer';
// Geometry files are zstd — the codec that pays for itself here (67 MB against snappy's 182 MB on
// the same rows), and the pipeline writes it everywhere. hyparquet cannot decode zstd alone, so
// unlike the main thread's opportunistic load this import is required. Bundled into this
// worker's own chunk, so its wasm is only fetched when someone asks for a download.
import {compressors} from 'hyparquet-compressors';
import {streamingBuffer, throttle} from './rangeBuffer.js';

// Peak memory ceiling for the buffered byte span. Row groups are fetched in batches that fit
// inside this, so a poorly ordered file that forces most of a Group to be read costs many sequential
// requests rather than one enormous allocation.
const MAX_SPAN_BYTES = 64e6;

const post = (type, extra) => self.postMessage({type, ...extra});
const mb = b => (b / 1e6).toFixed(1);
const fmt = n => n.toLocaleString();

/**
 * One report per phase, each on its own scale.
 *
 * Every phase reports 0–100 of *itself* and the panel does the apportioning, which is what lets
 * fetching and decoding — which interleave batch by batch — advance two separate bars at once
 * instead of taking turns pushing one shared number around.
 */
const stage = (key, pct, detail, extra) => post('stage', {key, pct, detail, ...extra});

const clock = s => {
  if (!isFinite(s) || s < 0) return '';
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${s.toFixed(s < 10 ? 1 : 0)}s`;
};

/** "12.4 / 31.2 MB · 8.1 MB/s · ~0:03 left" — the line under the bar during the read. */
function readDetail(done, total, startedAt) {
  const secs = (performance.now() - startedAt) / 1000;
  const rate = secs > 0.4 ? done / secs : 0;
  // Gated on elapsed time rather than bytes: a byte threshold hides the estimate entirely on a
  // small file, which is the case where a slow link makes it most worth showing.
  const eta = rate > 0 && secs > 0.8 ? (total - done) / rate : NaN;
  return `${mb(done)} / ${mb(total)} MB` +
    (rate ? ` · ${mb(rate)} MB/s` : '') +
    (isFinite(eta) && eta > 0.5 ? ` · ~${clock(eta)} left` : '');
}

/**
 * The flat parquet schema's *top-level* columns, subtrees skipped.
 *
 * `schema.slice(1)` is not this. The list is a depth-first flattening, so a nested column arrives
 * as its own node followed by its children — `geometry`, `list`, `element`, `list`, `element`,
 * `x`, `y` — and handing those names to `parquetRead` fails with "parquet column not found: list".
 * It went unnoticed while the export read `streams_mapping_`, whose geometry is a flat WKB
 * BYTE_ARRAY with no children at all.
 */
function topLevelColumns(schema) {
  const out = [];
  let pos = 1;
  const consume = () => {
    const node = schema[pos++];
    for (let k = 0; k < (node.num_children ?? 0); k++) consume();
    return node;
  };
  while (pos < schema.length) out.push(consume());
  return out;
}

/**
 * A decoded geometry value as GeoJSON, whichever way the source stored it.
 *
 * GeoParquet allows two encodings and v3 uses both across its history. A WKB column comes back
 * from hyparquet already decoded to `{type, coordinates}` — it offers no way to opt out (neither
 * `geoparquet:false` nor `geoParquet:false` has any effect in 1.27.1). A 1.1 *native* column —
 * which is what `streams_<id>.geo.parquet` uses, declaring `"encoding": "multilinestring"` — comes
 * back as the nested lists themselves, with each coordinate a `{x, y}` struct.
 *
 * Both are normalised here so everything downstream sees GeoJSON and the output is WKB either way.
 * The round trip is lossless: float64 in the source, float64 in JS, float64 back out.
 */
const NATIVE_GEOMETRY_TYPES = {
  point: 'Point', linestring: 'LineString', polygon: 'Polygon',
  multipoint: 'MultiPoint', multilinestring: 'MultiLineString', multipolygon: 'MultiPolygon',
};

const nativeCoords = v => (Array.isArray(v)
  ? v.map(nativeCoords)
  : (v.z == null ? [v.x, v.y] : [v.x, v.y, v.z]));

function asGeoJson(value, nativeType) {
  if (value == null) return null;
  // A WKB source is already {type, coordinates}; a native one is bare nested lists.
  if (!Array.isArray(value)) return value.type && value.coordinates ? value : null;
  if (!nativeType) return null;
  return {type: nativeType, coordinates: nativeCoords(value)};
}

/**
 * Widen `acc` by one GeoJSON geometry's coordinates, and record its type.
 */
function scanGeometry(g, acc, types) {
  if (!g || !g.coordinates) return;
  types.add(g.type);
  const walk = c => {
    if (typeof c[0] === 'number') {
      if (c[0] < acc[0]) acc[0] = c[0];
      if (c[1] < acc[1]) acc[1] = c[1];
      if (c[0] > acc[2]) acc[2] = c[0];
      if (c[1] > acc[3]) acc[3] = c[1];
    } else for (const sub of c) walk(sub);
  };
  walk(g.coordinates);
}

/** hyparquet schema element -> hyparquet-writer column type. */
const writerType = el =>
  el.type === 'BYTE_ARRAY' ? (el.converted_type === 'UTF8' ? 'STRING' : 'BYTE_ARRAY') : el.type;

/** Byte span a row group occupies, across all its column chunks. */
function rowGroupSpan(rg) {
  let lo = Infinity, hi = 0;
  for (const c of rg.columns) {
    const m = c.meta_data;
    if (!m) continue;
    const s = Number(m.dictionary_page_offset ?? m.data_page_offset);
    const e = s + Number(m.total_compressed_size);
    if (s < lo) lo = s;
    if (e > hi) hi = e;
  }
  return [lo, hi];
}

self.onmessage = async e => {
  // The selection is a riverIndex range, so both questions this worker used to answer with a
  // sorted array and a hash set are now interval arithmetic: a row group is worth reading when it
  // overlaps [selLo, selHi], and a row is wanted when its index is inside it.
  const {url, lo: selLo, hi: selHi} = e.data;
  const wanted = selHi - selLo + 1;
  try {
    const hasIndexIn = (lo, hi) => hi >= selLo && lo <= selHi;

    // Bytes off the wire, whatever phase asked for them. `phase` decides which bar the arriving
    // chunks drive, so the streaming callback does not have to know who called it.
    let fetched = 0;
    let phase = 'open';
    let onChunk = null;
    // The file names itself in anything the user reads, so the same worker can say which of the
    // two files it was opening without being told separately which dataset it is running.
    const fileName = url.split('/').pop();
    const raw = await hp.asyncBufferFromUrl({url}).catch(() => null);
    if (!raw) throw new Error(`no ${fileName} published for this Group`);
    const base = streamingBuffer(raw, url, n => {
      fetched += n;
      if (phase === 'read') onChunk?.(n);
    });

    stage('index', 15, `${mb(raw.byteLength)} MB file`);
    const md = await hp.parquetMetadataAsync(base);
    const totalRows = Number(md.num_rows);
    stage('index', 100, `${mb(fetched)} MB read · ${md.row_groups.length} row groups`);
    stage('plan', 5, `scanning ${md.row_groups.length} row groups`);

    // ---- which row groups can hold a selected reach ----
    const picked = [];
    let row = 0, keptRows = 0;
    for (const rg of md.row_groups) {
      const n = Number(rg.num_rows);
      const st = rg.columns.find(c => c.meta_data.path_in_schema[0] === 'riverIndex')?.meta_data?.statistics;
      const lo = st?.min_value, hi = st?.max_value;
      // No statistics means the row group cannot be ruled out, so it is read.
      if (lo == null || hi == null || hasIndexIn(Number(lo), Number(hi))) {
        const [bLo, bHi] = rowGroupSpan(rg);
        picked.push({start: row, end: row + n, lo: bLo, hi: bHi});
        keptRows += n;
      }
      row += n;
    }
    // Pruning is exact now rather than approximate. The file is written in riverIndex order and a
    // subset is a contiguous riverIndex range, so the row groups that overlap it are consecutive
    // and hold nothing but the selection and its immediate neighbours — a 413-reach watershed out
    // of a 42,031-reach Group reads 2 row groups of 85. It used to be handed a scattered set of
    // ids, which is what the old warning about weak pruning was about.
    console.info(`[geometry] ${fileName}: ${picked.length}/${md.row_groups.length} row groups, ` +
      `${keptRows.toLocaleString()}/${totalRows.toLocaleString()} rows to read for ` +
      `riverIndex ${selLo.toLocaleString()}-${selHi.toLocaleString()}`);
    if (!picked.length) throw new Error('no row group contains any selected reach');

    // ---- batch the row groups so each buffered span stays under the ceiling ----
    const batches = [];
    for (const rg of picked) {
      const last = batches[batches.length - 1];
      if (last && rg.start === last.end && rg.hi - last.lo <= MAX_SPAN_BYTES) {
        last.end = rg.end;
        last.hi = Math.max(last.hi, rg.hi);
      } else {
        batches.push({start: rg.start, end: rg.end, lo: rg.lo, hi: rg.hi});
      }
    }
    const spanBytes = batches.reduce((a, b) => a + (b.hi - b.lo), 0);
    // The full accounting — rows kept of rows total, and why — is on the console line above; this
    // is the part that fits on one row of the panel.
    stage('plan', 100, `${picked.length}/${md.row_groups.length} groups · ${mb(spanBytes)} MB` +
      (batches.length > 1 ? ` · ${batches.length} batches` : ''));

    // ---- read each batch ----
    // hyparquet slices per column per row group; on a file with ~1,800 such chunks that is
    // enough concurrent range requests for Chrome to abandon them with ERR_INSUFFICIENT_RESOURCES.
    // Buffering each batch's span up front makes it one sequential read, which object storage
    // also much prefers.
    const schemaCols = topLevelColumns(md.schema);
    const cols = schemaCols.map(s => s.name);
    const ri = cols.indexOf('riverIndex');
    if (ri < 0) throw new Error('the geometry file has no riverIndex column to select on');

    // The source's own `geo` key, read now rather than at write time because its `encoding` is
    // what says how to read the geometry column back.
    const srcGeo = md.key_value_metadata?.find(k => k.key === 'geo')?.value;
    const geo = srcGeo ? JSON.parse(srcGeo) : {version: '1.1.0', primary_column: 'geometry', columns: {}};
    const primary = geo.primary_column || 'geometry';
    const gcol = geo.columns[primary] || (geo.columns[primary] = {});
    const nativeType = NATIVE_GEOMETRY_TYPES[String(gcol.encoding ?? '').toLowerCase()] ?? null;
    const kept = [];

    // Fetching and decoding are separate phases on separate bars, because they interleave: a batch
    // is decoded while nothing is on the wire, and the next batch is fetched while nothing is being
    // decoded. Fetching reports chunk by chunk; decoding steps once per batch, which is the finest
    // granularity hyparquet offers.
    let readBytes = 0, decodedBytes = 0;
    const readStart = performance.now();
    const fetchBar = throttle((pct, detail) => stage('geometry', pct, detail));

    phase = 'read';
    onChunk = n => {
      readBytes += n;
      fetchBar.emit(100 * Math.min(1, readBytes / spanBytes),
        readDetail(Math.min(readBytes, spanBytes), spanBytes, readStart));
    };

    for (let bi = 0; bi < batches.length; bi++) {
      const b = batches[bi];
      const buf = await base.slice(b.lo, b.hi);
      const file = {
        byteLength: base.byteLength,
        slice: (s, en) => {
          en = en ?? base.byteLength;
          if (s >= b.lo && en <= b.hi) return buf.slice(s - b.lo, en - b.lo);
          // No manual byte accounting here: base is the streaming buffer, which counts what it
          // transfers. Adding to `fetched` as well would double-count every fallback read.
          return base.slice(s, en);
        },
      };
      const batchLabel = batches.length > 1 ? `batch ${bi + 1} of ${batches.length} · ` : '';
      stage('decode', 100 * decodedBytes / spanBytes, `${batchLabel}${fmt(b.end - b.start)} rows`);
      await new Promise((resolve, reject) => {
        hp.parquetRead({
          file, metadata: md, compressors, columns: cols, rowFormat: 'array',
          // utf8:false is not optional and fails quietly: without it hyparquet UTF-8-decodes
          // every BYTE_ARRAY, which for a geometry column means U+FFFD where the bytes were.
          // The geometry still arrives as GeoJSON regardless — see scanGeometry above.
          utf8: false,
          rowStart: b.start, rowEnd: b.end,
          onComplete: rows => {
            for (const r of rows) {
              const ix = Number(r[ri]);
              if (ix >= selLo && ix <= selHi) kept.push(r);
            }
            resolve();
          },
        }).catch(reject);
      });
      decodedBytes += b.hi - b.lo;
      stage('decode', 100 * decodedBytes / spanBytes,
        `${batchLabel}${fmt(kept.length)} of ${fmt(wanted)} reaches matched`);
    }
    phase = 'done-reading';
    // The wire is quiet from here, so whatever the fetch bar was showing is what it fetched.
    stage('geometry', 100, `${mb(Math.min(readBytes, spanBytes))} MB of geometry fetched`);
    stage('decode', 100, `${fmt(kept.length)} of ${fmt(wanted)} reaches matched`);

    const missing = wanted - kept.length;
    if (missing > 0) {
      post('note', {
        text: `${fmt(missing)} of ${fmt(wanted)} selected reaches have no geometry in this file`,
        cls: 'error',
      });
    }

    // ---- encode geometry ----
    // bbox/type scan and the WKB re-encode in one pass rather than two: both touch every
    // coordinate of every reach, and on a large subset that is the difference between one walk
    // over ~10M vertices and two.
    const gi = cols.indexOf(primary);
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    const geomTypes = new Set();
    const wkb = new Array(kept.length);
    const encBar = throttle((pct, detail) => stage('encode', pct, detail));
    phase = 'encode';
    stage('encode', 0, `0 of ${fmt(kept.length)} reaches`);
    for (let i = 0; i < kept.length; i++) {
      const g = asGeoJson(kept[i][gi], nativeType);
      if (g) {
        scanGeometry(g, bbox, geomTypes);
        wkb[i] = geojsonToWkb(g);
      } else {
        wkb[i] = null;
      }
      // Synchronous, so the worker never yields — but postMessage still queues, and the main
      // thread is idle, so the bar keeps painting through a pass that can run for seconds.
      if ((i & 511) === 511) {
        encBar.emit(100 * (i + 1) / kept.length, `${fmt(i + 1)} of ${fmt(kept.length)} reaches`);
      }
    }
    stage('encode', 100, `${fmt(kept.length)} reaches · ${[...geomTypes].sort().join(', ') || 'no geometry'}`);

    // The source's `geo` block, parsed above, is carried forward: it holds the CRS as PROJJSON, so
    // the export comes out in whatever CRS the source is in and GDAL and GeoPandas take it from
    // here. Only the parts the subset actually changes are overwritten. `encoding` is one of them —
    // the output is WKB whatever the source was, so a native-encoded source must not have its
    // `"multilinestring"` copied onto a column of WKB blobs.
    gcol.encoding = 'WKB';
    // Taken from the rows actually written rather than hardcoded. A GeoParquet file that omits a
    // type it contains is one GDAL and GeoPandas both read happily and a strict validator rejects.
    gcol.geometry_types = [...geomTypes].sort();
    // In the geometry column's own CRS, per the spec — degrees for a 4326 source, metres for 3857.
    if (isFinite(bbox[0])) gcol.bbox = bbox;

    const typeOf = Object.fromEntries(schemaCols.map(s => [s.name, writerType(s)]));
    const columnData = cols.map((name, i) => {
      // The geometry column is written as WKB blobs regardless of how it arrived, so its output
      // type is BYTE_ARRAY even when the source node is a nested group with no `type` of its own.
      const type = i === gi ? 'BYTE_ARRAY' : typeOf[name];
      if (i === gi) return {name, data: wkb, type};
      let data = kept.map(r => r[i]);
      // An int64 source column arrives as BigInt; an INT32 output column fed BigInt writes garbage.
      if (type === 'INT32') data = data.map(v => (v == null ? null : Number(v)));
      return {name, data, type};
    });

    // parquetWriteBuffer is one synchronous call: it has either returned or it has not, and there
    // is no callback to sample. An indeterminate line says that honestly; a percentage here would
    // be invented.
    stage('write', 0, `${fmt(kept.length)} reaches, ${cols.length} columns`, {indeterminate: true});

    // SNAPPY, not ZSTD: hyparquet-writer labels pages ZSTD while writing them uncompressed when no
    // zstd compressor is supplied, and the result is a file GDAL refuses to open.
    const out = parquetWriteBuffer({
      columnData,
      kvMetadata: [{key: 'geo', value: JSON.stringify(geo)}],
      codec: 'SNAPPY',
      rowGroupSize: 2000,
    });
    const buffer = out.buffer ? out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) : out;
    stage('write', 100, `${mb(buffer.byteLength)} MB, snappy, ${Math.ceil(kept.length / 2000)} row groups`);
    post('done', {buffer, rows: kept.length, fetched});
  } catch (err) {
    post('error', {message: err.message});
  }
};
