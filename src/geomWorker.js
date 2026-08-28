import * as hp from 'hyparquet';
import {geojsonToWkb, parquetWriteBuffer} from 'hyparquet-writer';
import {compressors} from 'hyparquet-compressors';
import {streamingBuffer, throttle} from './rangeBuffer.js';

const MAX_SPAN_BYTES = 64e6;

const post = (type, extra) => self.postMessage({type, ...extra});
const mb = b => (b / 1e6).toFixed(1);
const fmt = n => n.toLocaleString();

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
  const eta = rate > 0 && secs > 0.8 ? (total - done) / rate : NaN;
  return `${mb(done)} / ${mb(total)} MB` +
    (rate ? ` · ${mb(rate)} MB/s` : '') +
    (isFinite(eta) && eta > 0.5 ? ` · ~${clock(eta)} left` : '');
}

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
  const {url, lo: selLo, hi: selHi, spans} = e.data;
  // A watershed is one run of riverIndex; an AOI is the same run with the runs above its inlets cut
  // out. Both arrive as a list of runs, and everything below works off the list.
  const selSpans = spans?.length ? spans : [{lo: selLo, hi: selHi}];
  const wanted = selSpans.reduce((n, s) => n + s.hi - s.lo + 1, 0);
  try {
    // A row group is worth reading if any run reaches into it; the holes an AOI leaves are why this
    // asks each run rather than only the outer bounds.
    const hasIndexIn = (lo, hi) => selSpans.some(s => hi >= s.lo && lo <= s.hi);
    const inSelection = ix => selSpans.some(s => ix >= s.lo && ix <= s.hi);

    let fetched = 0;
    let phase = 'open';
    let onChunk = null;
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
    console.info(`[geometry] ${fileName}: ${picked.length}/${md.row_groups.length} row groups, ` +
      `${keptRows.toLocaleString()}/${totalRows.toLocaleString()} rows to read for ` +
      `riverIndex ${selLo.toLocaleString()}-${selHi.toLocaleString()}` +
      (selSpans.length > 1 ? ` in ${selSpans.length} runs` : ''));
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
    stage('plan', 100, `${picked.length}/${md.row_groups.length} groups · ${mb(spanBytes)} MB` +
      (batches.length > 1 ? ` · ${batches.length} batches` : ''));

    const schemaCols = topLevelColumns(md.schema);
    const cols = schemaCols.map(s => s.name);
    const ri = cols.indexOf('riverIndex');
    if (ri < 0) throw new Error('the geometry file has no riverIndex column to select on');

    const srcGeo = md.key_value_metadata?.find(k => k.key === 'geo')?.value;
    const geo = srcGeo ? JSON.parse(srcGeo) : {version: '1.1.0', primary_column: 'geometry', columns: {}};
    const primary = geo.primary_column || 'geometry';
    const gcol = geo.columns[primary] || (geo.columns[primary] = {});
    const nativeType = NATIVE_GEOMETRY_TYPES[String(gcol.encoding ?? '').toLowerCase()] ?? null;
    const kept = [];

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
          return base.slice(s, en);
        },
      };
      const batchLabel = batches.length > 1 ? `batch ${bi + 1} of ${batches.length} · ` : '';
      stage('decode', 100 * decodedBytes / spanBytes, `${batchLabel}${fmt(b.end - b.start)} rows`);
      await new Promise((resolve, reject) => {
        hp.parquetRead({
          file, metadata: md, compressors, columns: cols, rowFormat: 'array',
          utf8: false,
          rowStart: b.start, rowEnd: b.end,
          onComplete: rows => {
            for (const r of rows) {
              if (inSelection(Number(r[ri]))) kept.push(r);
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
      if ((i & 511) === 511) {
        encBar.emit(100 * (i + 1) / kept.length, `${fmt(i + 1)} of ${fmt(kept.length)} reaches`);
      }
    }
    stage('encode', 100, `${fmt(kept.length)} reaches · ${[...geomTypes].sort().join(', ') || 'no geometry'}`);

    gcol.encoding = 'WKB';
    gcol.geometry_types = [...geomTypes].sort();
    // In the geometry column's own CRS, per the spec — degrees for a 4326 source, metres for 3857.
    if (isFinite(bbox[0])) gcol.bbox = bbox;

    const typeOf = Object.fromEntries(schemaCols.map(s => [s.name, writerType(s)]));
    const columnData = cols.map((name, i) => {
      const type = i === gi ? 'BYTE_ARRAY' : typeOf[name];
      if (i === gi) return {name, data: wkb, type};
      let data = kept.map(r => r[i]);
      // An int64 source column arrives as BigInt; an INT32 output column fed BigInt writes garbage.
      if (type === 'INT32') data = data.map(v => (v == null ? null : Number(v)));
      return {name, data, type};
    });

    stage('write', 0, `${fmt(kept.length)} reaches, ${cols.length} columns`, {indeterminate: true});

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
