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
 * How the percentage is apportioned.
 *
 * The old bar jumped 8 → 70 across however many batches there were, which on the common
 * single-batch case meant one step with a multi-second freeze either side of it. These weights
 * come from what the phases actually cost, and the read phase is driven by bytes off the wire
 * rather than by batch count, so the bar moves continuously through the part that takes longest.
 */
const P = {plan: 4, read: 66, encode: 22, write: 8};
const AT = {
  plan: 0,
  read: P.plan,
  encode: P.plan + P.read,
  write: P.plan + P.read + P.encode,
};

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
 * Widen `acc` by one GeoJSON geometry's coordinates, and record its type.
 *
 * hyparquet decodes a GeoParquet WKB column into GeoJSON objects and offers no way to opt out
 * (neither `geoparquet:false` nor `geoParquet:false` has any effect in 1.27.1), so the rows
 * arrive as {type, coordinates} and the output column is re-encoded with geojsonToWkb. The
 * round trip is lossless — float64 in the WKB, float64 in JS, float64 back out.
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
  const {url, ids, riverIndexes} = e.data;
  try {
    const idSet = new Set(ids);
    const want = Int32Array.from(riverIndexes).sort();
    // Any selected riverIndex inside [lo, hi]? Binary search for the first >= lo.
    const hasIndexIn = (lo, hi) => {
      let a = 0, b = want.length - 1, found = -1;
      while (a <= b) { const m = (a + b) >> 1; if (want[m] >= lo) { found = m; b = m - 1; } else a = m + 1; }
      return found !== -1 && want[found] <= hi;
    };

    // Bytes off the wire, whatever phase asked for them. `stage` decides which phase's bar the
    // arriving chunks drive, so the streaming callback does not have to know who called it.
    let fetched = 0;
    let stage = 'open';
    let onChunk = null;
    const raw = await hp.asyncBufferFromUrl({url}).catch(() => null);
    if (!raw) throw new Error('no geometry file for this Group (streams_<id>.geo.parquet)');
    const base = streamingBuffer(raw, url, n => {
      fetched += n;
      if (stage === 'read') onChunk?.(n);
    });

    post('progress', {pct: 1, phase: 'Reading file index', detail: `${mb(raw.byteLength)} MB file`});
    const md = await hp.parquetMetadataAsync(base);
    const totalRows = Number(md.num_rows);
    post('progress', {pct: AT.read, phase: 'Planning read', detail: `${md.row_groups.length} row groups`});

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
    console.info(`[geometry] ${picked.length}/${md.row_groups.length} row groups, ` +
      `${keptRows.toLocaleString()}/${totalRows.toLocaleString()} rows to read` +
      (keptRows > 0.5 * totalRows
        ? ' — pruning is weak: published riverIndex order scatters a watershed across the file ' +
          '(see docs/subsetting-geometry.md)'
        : ''));
    if (!picked.length) throw new Error('no row group contains any selected reach');

    // ---- batch the row groups so each buffered span stays under the ceiling ----
    const batches = [];
    for (const rg of picked) {
      const last = batches[batches.length - 1];
      if (last && rg.start === last.end && rg.hi - last.lo <= MAX_SPAN_BYTES) {
        last.end = rg.end; last.hi = Math.max(last.hi, rg.hi);
      } else {
        batches.push({start: rg.start, end: rg.end, lo: rg.lo, hi: rg.hi});
      }
    }
    const spanBytes = batches.reduce((a, b) => a + (b.hi - b.lo), 0);

    // ---- read each batch ----
    // hyparquet slices per column per row group; on a file with ~1,800 such chunks that is
    // enough concurrent range requests for Chrome to abandon them with ERR_INSUFFICIENT_RESOURCES.
    // Buffering each batch's span up front makes it one sequential read, which object storage
    // also much prefers.
    const cols = md.schema.slice(1).map(s => s.name);
    const ri = cols.indexOf('riverId');
    const kept = [];

    // The read phase is split between bytes arriving and rows being decoded, because both are slow
    // and only one of them can report continuously. Fetching drives the bar chunk by chunk;
    // decoding steps it once per batch, which is the finest granularity hyparquet offers.
    const FETCH_W = 0.6, DECODE_W = 0.4;
    let readBytes = 0, decodedBytes = 0;
    const readStart = performance.now();
    const readPct = () => AT.read + P.read *
      (FETCH_W * Math.min(1, readBytes / spanBytes) + DECODE_W * (decodedBytes / spanBytes));
    const bar = throttle((pct, phase, detail) => post('progress', {pct, phase, detail}));

    stage = 'read';
    onChunk = n => {
      readBytes += n;
      bar.emit(readPct(), 'Fetching geometry',
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
      const batchLabel = batches.length > 1 ? `batch ${bi + 1} of ${batches.length}, ` : '';
      bar.flush(readPct(), 'Decoding rows', `${batchLabel}${fmt(b.end - b.start)} rows`);
      await new Promise((resolve, reject) => {
        hp.parquetRead({
          file, metadata: md, compressors, columns: cols, rowFormat: 'array',
          // utf8:false is not optional and fails quietly: without it hyparquet UTF-8-decodes
          // every BYTE_ARRAY, which for a geometry column means U+FFFD where the bytes were.
          // The geometry still arrives as GeoJSON regardless — see scanGeometry above.
          utf8: false,
          rowStart: b.start, rowEnd: b.end,
          onComplete: rows => {
            for (const r of rows) if (idSet.has(Number(r[ri]))) kept.push(r);
            resolve();
          },
        }).catch(reject);
      });
      decodedBytes += b.hi - b.lo;
      bar.flush(readPct(), 'Decoding rows', `${fmt(kept.length)} of ${fmt(ids.length)} reaches matched`);
    }
    stage = 'done-reading';

    const missing = ids.length - kept.length;
    if (missing > 0) {
      post('note', {
        text: `${fmt(missing)} of ${fmt(ids.length)} selected reaches have no geometry in this file`,
        cls: 'error',
      });
    }

    // ---- encode geometry ----
    // bbox/type scan and the WKB re-encode in one pass rather than two: both touch every
    // coordinate of every reach, and on a large subset that is the difference between one walk
    // over ~10M vertices and two.
    const gi = cols.indexOf('geometry');
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    const geomTypes = new Set();
    const wkb = new Array(kept.length);
    const encBar = throttle((pct, detail) =>
      post('progress', {pct, phase: 'Encoding geometry', detail}));
    stage = 'encode';
    post('progress', {
      pct: AT.encode, phase: 'Encoding geometry', detail: `0 / ${fmt(kept.length)} reaches`,
    });
    for (let i = 0; i < kept.length; i++) {
      const g = kept[i][gi];
      if (g) {
        scanGeometry(g, bbox, geomTypes);
        wkb[i] = geojsonToWkb(g);
      } else {
        wkb[i] = null;
      }
      // Synchronous, so the worker never yields — but postMessage still queues, and the main
      // thread is idle, so the bar keeps painting through a pass that can run for seconds.
      if ((i & 511) === 511) {
        encBar.emit(AT.encode + P.encode * (i + 1) / kept.length,
          `${fmt(i + 1)} / ${fmt(kept.length)} reaches`);
      }
    }

    // The source's own `geo` key, carried forward. It holds the CRS as PROJJSON, which is what
    // keeps a 3857 mapping file readable as 3857 and a 4326 file readable as 4326 — GDAL and
    // GeoPandas take the CRS from here, so neither the writer nor the app has to know which it is.
    // Only the parts that the subset actually changes are overwritten below.
    const srcGeo = md.key_value_metadata?.find(k => k.key === 'geo')?.value;
    const geo = srcGeo ? JSON.parse(srcGeo) : {version: '1.1.0', primary_column: 'geometry', columns: {}};
    const primary = geo.primary_column || 'geometry';
    const gcol = geo.columns[primary] || (geo.columns[primary] = {});
    gcol.encoding = 'WKB';
    // Taken from the rows actually written rather than hardcoded. A GeoParquet file that omits a
    // type it contains is one GDAL and GeoPandas both read happily and a strict validator rejects.
    gcol.geometry_types = [...geomTypes].sort();
    // In the geometry column's own CRS, per the spec — degrees for a 4326 source, metres for 3857.
    if (isFinite(bbox[0])) gcol.bbox = bbox;

    const typeOf = Object.fromEntries(md.schema.slice(1).map(s => [s.name, writerType(s)]));
    const columnData = cols.map((name, i) => {
      const type = typeOf[name];
      if (i === gi) return {name, data: wkb, type};
      let data = kept.map(r => r[i]);
      // An int64 source column arrives as BigInt; an INT32 output column fed BigInt writes garbage.
      if (type === 'INT32') data = data.map(v => (v == null ? null : Number(v)));
      return {name, data, type};
    });

    // parquetWriteBuffer is one synchronous call: it has either returned or it has not, and there
    // is no callback to sample. An indeterminate bar says that honestly; a percentage here would
    // be invented.
    post('progress', {
      pct: AT.write, phase: 'Writing GeoParquet', indeterminate: true,
      detail: `${fmt(kept.length)} reaches, ${cols.length} columns`,
    });

    // SNAPPY, not ZSTD: hyparquet-writer labels pages ZSTD while writing them uncompressed when no
    // zstd compressor is supplied, and the result is a file GDAL refuses to open.
    const out = parquetWriteBuffer({
      columnData,
      kvMetadata: [{key: 'geo', value: JSON.stringify(geo)}],
      codec: 'SNAPPY',
      rowGroupSize: 2000,
    });
    const buffer = out.buffer ? out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) : out;
    post('done', {buffer, rows: kept.length, fetched});
  } catch (err) {
    post('error', {message: err.message});
  }
};
