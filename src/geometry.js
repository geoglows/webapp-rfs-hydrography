/**
 * The GeoParquet download: the streams of a subset, then their catchments, saved as each finishes.
 *
 * Two files, one worker at a time, in that order. They are the same reaches twice — a line and the
 * polygon it drains — written in the same riverIndex order with the same selection columns, so the
 * worker that subsets one subsets the other unchanged and the only difference between the two runs
 * is the URL it is handed. Sequential rather than concurrent: each run holds a Group's worth of
 * decoded geometry and a parquet file being written in memory at once, and two of those at the same
 * time is the tab's memory ceiling for no gain — the second file is bytes off the same wire.
 *
 * Everything expensive — decoding tens of thousands of geometries and encoding a parquet file —
 * happens in the worker, so the map keeps painting throughout. Vite bundles the worker and its
 * hyparquet dependencies into their own chunk, so none of that is fetched until someone asks for a
 * download.
 */
import {MAX_GEOMETRY_REACHES, URLS} from './config.js';
import {clock, fmt, mb, progress, stages, status, statusLines} from './ui.js';

let running = false;
export const isBusy = () => running;

/**
 * What is exported, in the order it is fetched. `key` is also the filename suffix, so a dataset is
 * one entry here and nothing else in this file names either of them.
 */
const DATASETS = [
  {key: 'streams', label: 'Streams', url: URLS.streams},
  {key: 'catchments', label: 'Catchments', url: URLS.catchments},
];

/**
 * The export, declared before it runs.
 *
 * Two bars per dataset because there are two kinds of work with different bottlenecks — bytes off
 * the wire, and what is done to them once they land — and they overlap: a batch decodes while the
 * next one is still arriving. Weights are what each phase actually costs on a real subset, so a
 * group's percentage tracks time rather than counting steps.
 *
 * Four bars rather than two, because the datasets run one after the other: a single pair of bars
 * would have to be reset halfway through, taking the record of the streams run off the screen at
 * the moment the catchments run started needing it for comparison. This way the whole job is on
 * screen from the start — what has finished, what is moving, and what has not begun.
 */
const KINDS = [
  {key: 'download', label: 'download'},
  {key: 'process', label: 'processing'},
];

const PHASES = [
  {key: 'index', kind: 'download', label: 'File index', weight: 4},
  {key: 'geometry', kind: 'download', label: 'Geometry bytes', weight: 96},
  {key: 'prepare', kind: 'process', label: 'Prepare selection', weight: 2},
  {key: 'plan', kind: 'process', label: 'Prune row groups', weight: 6},
  {key: 'decode', kind: 'process', label: 'Decode + filter rows', weight: 42},
  {key: 'encode', kind: 'process', label: 'Encode geometry', weight: 36},
  {key: 'write', kind: 'process', label: 'Write GeoParquet', weight: 14},
];

/** Phase and group keys are namespaced by dataset, so the two runs cannot address each other's. */
const scoped = (dataset, key) => `${dataset}:${key}`;

const EXPORT_PLAN = {
  groups: DATASETS.flatMap(d => KINDS.map(k => ({
    key: scoped(d.key, k.key), label: `${d.label} · ${k.label}`,
  }))),
  phases: DATASETS.flatMap(d => PHASES.map(p => ({
    key: scoped(d.key, p.key), group: scoped(d.key, p.kind), label: p.label, weight: p.weight,
  }))),
};

function save(buffer, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([buffer], {type: 'application/vnd.apache.parquet'}));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * One dataset: one worker, run to completion, resolving with the lines it earned on the status
 * block. Rejects on the first thing that goes wrong, which is what stops the run — see `runAll`.
 *
 * `lo`/`hi` are the selection's riverIndex range, and they are the only thing the worker needs.
 * riverIndex is both the pruning key and the membership test: both files are written in that order,
 * so a row group is relevant exactly when its min/max overlaps the range, and a row is wanted
 * exactly when its index falls inside it. The worker used to be handed two Int32Arrays — every
 * selected id and every selected index — and had to binary-search the second for every row group
 * and hash the first for every row. Two numbers replace both.
 */
function runDataset(dataset, {groupId, outletId, lo, hi, count}) {
  const key = p => scoped(dataset.key, p);
  return new Promise((resolve, reject) => {
    stages.done(key('prepare'), `${fmt(count)} reaches · riverIndex ${fmt(lo)}-${fmt(hi)}`);
    stages.set(key('index'), {pct: 2, detail: `opening Group ${groupId}`});
    const t0 = performance.now();
    const worker = new Worker(new URL('./geomWorker.js', import.meta.url), {type: 'module'});
    // A note is something worth keeping on screen after the run — a partial result, not a step — so
    // it is carried out with the result rather than written to the status line the moment it
    // arrives, where the next thing to finish would overwrite it.
    const notes = [];

    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'note') {
        return notes.push({text: `${dataset.label}: ${m.text}`, cls: m.cls || ''});
      }
      if (m.type === 'stage') {
        return stages.set(key(m.key), {pct: m.pct, detail: m.detail, indeterminate: m.indeterminate});
      }
      worker.terminate();
      if (m.type === 'error') return reject(new Error(m.message));
      const name = `rfs_v3_group${groupId}_${outletId}_${dataset.key}.parquet`;
      save(m.buffer, name);
      resolve([...notes, {
        text: `Saved ${name} — ${fmt(m.rows)} reaches · ${mb(m.buffer.byteLength)} written · ` +
          `${mb(m.fetched)} fetched · ${clock((performance.now() - t0) / 1000)}`,
        cls: 'success',
      }]);
    };
    worker.onerror = err => {
      worker.terminate();
      reject(new Error(err.message || 'the geometry worker stopped'));
    };

    worker.postMessage({url: dataset.url(groupId), lo, hi});
  });
}

/**
 * Both datasets, in order, stopping at the first failure.
 *
 * A file that has already been saved stays saved and stays reported: if the catchments run fails,
 * the streams line is still on the block above the error, because the user has that file. Stopping
 * rather than carrying on is deliberate — the two runs read the same Group over the same range, so
 * whatever broke the first is overwhelmingly likely to break the second, and one clear error beats
 * the same error twice.
 */
async function runAll(selection) {
  const lines = [];
  for (const dataset of DATASETS) {
    try {
      lines.push(...await runDataset(dataset, selection));
      statusLines(lines);
    } catch (err) {
      // The phase that broke keeps its line and its detail: which step broke is the useful half of
      // the message, and hiding the block would take it away with everything else. Everything the
      // stop skipped — the rest of this dataset, and all of the next — says skipped, not failed.
      stages.fail(err.message);
      statusLines([...lines, {text: `${dataset.label} download failed: ${err.message}`, cls: 'error'}]);
      console.error(`[geometry] ${dataset.key}`, err);
      return;
    }
  }
  stages.finish();
}

export function downloadGeometry({groupId, outletId, lo, hi, count, onSettled}) {
  if (running) return;
  const refuse = msg => {
    status(msg, 'error');
    onSettled?.();
  };
  if (count > MAX_GEOMETRY_REACHES) {
    return refuse(`Geometry download caps at ${fmt(MAX_GEOMETRY_REACHES)} reaches; this subset has ` +
      `${fmt(count)}. Pick an outlet further upstream, or take its tributaries one at a time.`);
  }
  if (groupId == null) {
    return refuse('No Group for this selection, so there is no geometry file to open.');
  }
  running = true;
  status('');
  progress.hide();
  stages.begin(EXPORT_PLAN);
  runAll({groupId, outletId, lo, hi, count}).finally(() => {
    running = false;
    onSettled?.();
  });
}
