import {asyncBufferFromUrl, parquetRead} from 'hyparquet';
import {RiverNetwork} from 'riverforecastsystem/v3/hydrography';
import {URLS} from './config.js';
import {streamingBuffer, throttle} from './rangeBuffer.js';
import {fmt, mb, progress} from './ui.js';

let groupIndex = null;
let groupById = new Map();
let compressors;
const connCache = new Map();

export const getGroupIndex = () => groupIndex;
export const groupInfo = id => groupById.get(Number(id));
export const isLoaded = id => connCache.has(Number(id));
export const cachedGroupNetwork = id => connCache.get(Number(id));
export const loadedGroupIds = () => [...connCache.keys()];

export async function loadGroupIndex() {
  const resp = await fetch(URLS.groupIndex);
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText} for group_index.json`);
  groupIndex = await resp.json();
  groupById = new Map(groupIndex.groups.map(v => [v.groupId, v]));
  return groupIndex;
}

/**
 * Groups that could hold this riverId, best candidate first.
 *
 * `riverId // 10^7` is one-to-one with the 50 TDX-Hydro regions, so the prefix cuts 125 Groups to one
 * region's handful, and the id range rules out most of what is left. Neither pins a single Group —
 * the ranges of Groups in a region interleave — so the caller opens what survives in turn. Ordering
 * by bbox distance from the map centre puts the one the user is looking at first.
 */
export function candidateGroups(riverId, near) {
  const prefix = Math.floor(riverId / groupIndex.schema.idPrefixDivisor);
  const inRegion = groupIndex.groups.filter(v => v.riverIdPrefix === prefix);
  const inRange = inRegion.filter(v => !v.riverIdRange ||
    (riverId >= v.riverIdRange[0] && riverId <= v.riverIdRange[1]));
  if (!near) return {prefix, inRegion, candidates: inRange};
  const d = v => {
    const [w, s, e, n] = v.bbox;
    const dx = Math.max(w - near.lng, 0, near.lng - e);
    const dy = Math.max(s - near.lat, 0, near.lat - n);
    return dx * dx + dy * dy;
  };
  return {prefix, inRegion, candidates: inRange.slice().sort((a, b) => d(a) - d(b))};
}

async function ensureCompressors() {
  // Every file this app writes is snappy, which hyparquet decodes on its own. The compressors
  // module is loaded only because the pipeline writes zstd, which hyparquet cannot decode alone;
  // a build that somehow shipped snappy still reads without it.
  if (compressors !== undefined) return compressors;
  try {
    ({compressors} = await import('hyparquet-compressors'));
  } catch {
    compressors = null;
  }
  return compressors;
}

export async function loadGroupNetwork(groupId) {
  groupId = Number(groupId);
  if (connCache.has(groupId)) return connCache.get(groupId);
  const entry = groupById.get(groupId);
  const t0 = performance.now();
  const codecs = await ensureCompressors();

  // The metadata table is every attribute of every reach. Only these six are needed to walk the
  // network and locate a reach, and parquet is columnar, so asking for them fetches their column
  // chunks and nothing else — measured at 3.74 MB of a 6.78 MB region file. That projection is why
  // there is no separate connectivity file: it would be these same columns, same rows, same bytes.
  //
  // Range-read rather than downloading the file, so the columns left behind are never transferred.
  const cols = groupIndex.schema.networkColumns ?? ['riverId', 'nextRiverId', 'riverIndex', 'strahlerOrder', 'lat', 'lon'];
  const url = URLS.metadata(groupId);
  const raw = await asyncBufferFromUrl({url}).catch(() => null);
  if (!raw) throw new Error(`could not open metadata_${groupId}.parquet`);

  // The projected read is several MB and used to be a dead wait — the click registered and then
  // nothing moved until the whole thing landed. `networkBytes` from the index is what the six
  // columns cost, so the bar has a real denominator before the first byte arrives.
  const expect = entry?.networkBytes ?? entry?.metadataBytes ?? raw.byteLength;
  let got = 0;
  const bar = throttle(pct => progress.set(pct, {
    phase: `Reading Group ${groupId}`,
    detail: `${mb(Math.min(got, expect))} of ~${mb(expect)}` +
      (entry ? ` · ${fmt(entry.reachCount)} reaches` : ''),
  }));
  progress.begin(`Reading Group ${groupId}`, `metadata_${groupId}.parquet`);
  const file = streamingBuffer(raw, url, n => {
    got += n;
    // Held under 90: the decode and graph build still have to happen after the last byte, and a
    // bar that reaches 100 and then waits is worse than one that never claimed to be finished.
    bar.emit(Math.min(90, 90 * got / expect));
  });

  // rowFormat 'array' rather than objects: one array per row instead of one keyed object, which on
  // the largest Group (234k reaches) is ~35 ms against ~65 ms plus 234k short-lived objects.
  const rows = await new Promise((resolve, reject) => {
    const opts = {file, columns: cols, rowFormat: 'array', onComplete: resolve};
    if (codecs) opts.compressors = codecs;
    parquetRead(opts).catch(reject);
  });
  progress.set(94, {phase: `Building network`, detail: `${fmt(rows.length)} edges`});

  // RiverNetwork builds the reverse adjacency; this only has to shape the rows into the graph it
  // takes. Caching the result means a second outlet in the same Group costs nothing.
  //
  // `attrs` is deliberately separate rather than folded into the graph: RiverNetwork.meta is the
  // dataset's own metadata, and these are per-reach columns this app carries for the fly-to and the
  // geometry download's pruning key.
  // The pipeline writes these as int32 (schema.enforce_int32), which hyparquet decodes to Number.
  // An int64 column would decode to BigInt instead, and BigInt neither compares nor hashes equal to
  // Number — `upAdj.get(621010293)` finds nothing when the keys are `621010293n`. The graph would
  // build perfectly and every traversal would return only the reach it started from, with no error
  // anywhere. So: expect int32, convert anything else, and say so once rather than silently
  // papering over a file that is not what this app is built for.
  const attrs = new Map();
  const edges = new Array(rows.length);
  let widened = false;
  for (let i = 0; i < rows.length; i++) {
    const [id, ds, idx, order, lat, lon] = rows[i];
    if (typeof id === 'bigint') widened = true;
    const rid = Number(id);
    edges[i] = [rid, Number(ds)];
    attrs.set(rid, {riverIndex: Number(idx), strahlerOrder: Number(order), lat, lon});
  }
  if (widened) {
    console.warn(`[data] metadata_${groupId}.parquet stores ids as int64, not int32 — converted on read`);
  }

  const network = new RiverNetwork({
    schema: {terminal_value: groupIndex.schema.terminalValue},
    meta: {groupId, reachCount: rows.length},
    edges,
  });
  const cached = {groupId, network, attrs, bytes: file.byteLength};
  connCache.set(groupId, cached);
  console.info(`[data] Group ${groupId}: ${rows.length.toLocaleString()} edges, ` +
    `${(got / 1e6).toFixed(2)} MB in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  return cached;
}
