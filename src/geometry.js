/**
 * The GeoParquet download: hand the selection to a worker, drive the progress, save the file.
 *
 * Everything expensive — decoding tens of thousands of WKB geometries and encoding a parquet file —
 * happens in the worker, so the map keeps painting throughout. Vite bundles the worker and its
 * hyparquet dependencies into their own chunk, so none of that is fetched until someone asks for a
 * download.
 */
import {MAX_GEOMETRY_REACHES, URLS} from './config.js';
import {cachedGroupNetwork} from './data.js';
import {clock, fmt, mb, progress, stages, status} from './ui.js';

let worker = null;
export const isBusy = () => worker !== null;

/**
 * The export, declared before it runs.
 *
 * Two bars because there are two kinds of work with different bottlenecks — bytes off the wire, and
 * what is done to them once they land — and they overlap: a batch decodes while the next one is
 * still arriving. Weights are what each phase actually costs on a real subset (see
 * docs/subsetting-geometry.md), so a group's percentage tracks time rather than counting steps.
 */
const EXPORT_PLAN = {
  groups: [
    {key: 'download', label: 'Download'},
    {key: 'process', label: 'Processing'},
  ],
  phases: [
    {key: 'index', group: 'download', label: 'File index', weight: 4},
    {key: 'geometry', group: 'download', label: 'Geometry bytes', weight: 96},
    {key: 'prepare', group: 'process', label: 'Prepare selection', weight: 2},
    {key: 'plan', group: 'process', label: 'Prune row groups', weight: 6},
    {key: 'decode', group: 'process', label: 'Decode + filter rows', weight: 42},
    {key: 'encode', group: 'process', label: 'Encode geometry', weight: 36},
    {key: 'write', group: 'process', label: 'Write GeoParquet', weight: 14},
  ],
};

export function downloadGeometry({groupId, outletId, ids, onSettled}) {
  if (worker) return;
  if (ids.size > MAX_GEOMETRY_REACHES) {
    status(`Geometry download caps at ${fmt(MAX_GEOMETRY_REACHES)} reaches; this subset has ` +
      `${fmt(ids.size)}. The ID list export has no such limit.`, 'error');
    return;
  }
  status('');
  progress.hide();
  stages.begin(EXPORT_PLAN);
  stages.set('prepare', {pct: 10, detail: `${fmt(ids.size)} reaches`});

  const conn = cachedGroupNetwork(groupId);
  const idArray = new Int32Array(ids.size);
  const idxArray = new Int32Array(ids.size);
  let i = 0;
  for (const id of ids) {
    idArray[i] = id;
    // riverIndex is the pruning key: the file is written in that order, so its per-row-group
    // min/max are tight where riverId's span the whole Group. Already in hand from the metadata read.
    idxArray[i] = conn.attrs.get(id)?.riverIndex ?? -1;
    i++;
  }
  stages.done('prepare', `${fmt(ids.size)} reaches`);
  stages.set('index', {pct: 2, detail: `opening Group ${groupId}`});
  const t0 = performance.now();

  worker = new Worker(new URL('./geomWorker.js', import.meta.url), {type: 'module'});
  const finish = () => {
    worker.terminate();
    worker = null;
    onSettled?.();
  };

  worker.onmessage = e => {
    const m = e.data;
    // A note is something worth keeping on screen after the run — a partial result, not a step.
    if (m.type === 'note') return status(m.text, m.cls || '');
    if (m.type === 'stage') {
      return stages.set(m.key, {pct: m.pct, detail: m.detail, indeterminate: m.indeterminate});
    }
    if (m.type === 'done') {
      const name = `rfs_v3_group${groupId}_${outletId}_streams.parquet`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([m.buffer], {type: 'application/vnd.apache.parquet'}));
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      const secs = (performance.now() - t0) / 1000;
      stages.finish();
      status(`Saved ${name} — ${fmt(m.rows)} reaches · ${mb(m.buffer.byteLength)} written · ` +
        `${mb(m.fetched)} fetched · ${clock(secs)}`, 'success');
    } else if (m.type === 'error') {
      // The failed phase keeps its line and its detail: which step broke is the useful half of the
      // message, and hiding the block would take it away with everything else.
      stages.fail(m.message);
      status(`Geometry download failed: ${m.message}`, 'error');
    }
    finish();
  };
  worker.onerror = err => {
    stages.fail(err.message);
    status(`Geometry worker failed: ${err.message}`, 'error');
    finish();
  };

  worker.postMessage(
    {url: URLS.streams(groupId), ids: idArray, riverIndexes: idxArray},
    [idArray.buffer, idxArray.buffer],
  );
}
