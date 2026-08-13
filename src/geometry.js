import {URLS} from './config.js';
import {clock, fmt, mb, progress, stages, status, statusLines} from './ui.js';

let running = false;
export const isBusy = () => running;

const DATASETS = [
  {key: 'streams', label: 'Streams', url: URLS.streams},
  {key: 'catchments', label: 'Catchments', url: URLS.catchments},
];

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

function runDataset(dataset, {groupId, outletId, lo, hi, count}) {
  const key = p => scoped(dataset.key, p);
  return new Promise((resolve, reject) => {
    stages.done(key('prepare'), `${fmt(count)} reaches · riverIndex ${fmt(lo)}-${fmt(hi)}`);
    stages.set(key('index'), {pct: 2, detail: `opening Group ${groupId}`});
    const t0 = performance.now();
    const worker = new Worker(new URL('./geomWorker.js', import.meta.url), {type: 'module'});
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

async function runAll(selection) {
  const lines = [];
  for (const dataset of DATASETS) {
    try {
      lines.push(...await runDataset(dataset, selection));
      statusLines(lines);
    } catch (err) {
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
