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
import {clock, fmt, progress, status} from './ui.js';

let worker = null;
export const isBusy = () => worker !== null;

export function downloadGeometry({groupId, outletId, ids, onSettled}) {
  if (worker) return;
  if (ids.size > MAX_GEOMETRY_REACHES) {
    status(`Geometry download caps at ${fmt(MAX_GEOMETRY_REACHES)} reaches; this subset has ` +
      `${fmt(ids.size)}. The ID list export has no such limit.`, 'error');
    return;
  }
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

  status('');
  progress.begin(`Preparing ${fmt(ids.size)} reaches`);
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
    if (m.type === 'progress') {
      if (m.indeterminate) return progress.indeterminate(m.phase, m.detail);
      return progress.set(m.pct, {phase: m.phase, detail: m.detail});
    }
    if (m.type === 'done') {
      const name = `rfs_v3_group${groupId}_${outletId}_streams.parquet`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([m.buffer], {type: 'application/vnd.apache.parquet'}));
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      const secs = (performance.now() - t0) / 1000;
      progress.finish('Download complete',
        `${(m.buffer.byteLength / 1e6).toFixed(1)} MB written · ` +
        `${(m.fetched / 1e6).toFixed(1)} MB fetched · ${clock(secs)}`);
      status(`Saved ${name} — ${fmt(m.rows)} reaches`, 'success');
    } else if (m.type === 'error') {
      progress.hide();
      status(`Geometry download failed: ${m.message}`, 'error');
    }
    finish();
  };
  worker.onerror = err => {
    progress.hide();
    status(`Geometry worker failed: ${err.message}`, 'error');
    finish();
  };

  worker.postMessage(
    {url: URLS.streams(groupId), ids: idArray, riverIndexes: idxArray},
    [idArray.buffer, idxArray.buffer],
  );
}
