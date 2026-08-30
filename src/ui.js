const $ = id => document.getElementById(id);

const stagesEl = $('stages');
const progressEl = $('progress');
const phaseEl = $('progress-phase');
const pctEl = $('progress-pct');
const fillEl = $('progress-fill');
const detailEl = $('progress-detail');

export const fmt = n => n.toLocaleString();
export const mb = b => `${(b / 1e6).toFixed(2)} MB`;

// The phases a cached dataset's build reports, in the order it reports them. RFS v3 says the same
// words for the same downloads, which is the point: they are the same downloads.
const DATA_PHASES = {
  download: 'Downloading',
  sort: 'Building lookup',
  verify: 'Verifying',
  store: 'Saving',
};

/**
 * "Downloading 42%" — one build's progress as a line of text. Watched from two places now, the
 * search box and the Settings row, so it reads the same in both. A percentage rather than a count:
 * the download reports per chunk over hundreds of chunks, and nothing else stays legible at that
 * rate.
 */
export function dataProgress({phase, done, total}) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return `${DATA_PHASES[phase] ?? 'Starting…'} ${pct}%`;
}

/** Elapsed/remaining seconds as m:ss, which reads faster than "97.4 s" at a glance. */
export const clock = s => {
  if (!isFinite(s) || s < 0) return '';
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${s.toFixed(s < 10 ? 1 : 0)}s`;
};

let hideTimer = null;

let high = 0;

const HISTORY = 200;
export const progressHistory = [];
const record = (pct, phase, detail, indeterminate = false) => {
  progressHistory.push({pct, phase, detail, indeterminate, at: performance.now()});
  if (progressHistory.length > HISTORY) progressHistory.shift();
};

export const progress = {
  /** Open the block for a new run, at 0. */
  begin(phase, detail = '') {
    clearTimeout(hideTimer);
    progressHistory.length = 0;
    record(0, phase, detail);
    high = 0;
    progressEl.style.display = 'block';
    progressEl.classList.remove('indeterminate', 'done');
    fillEl.style.width = '0%';
    phaseEl.textContent = phase;
    pctEl.textContent = '0%';
    detailEl.textContent = detail;
    detailEl.style.display = detail ? 'block' : 'none';
  },

  set(pct, {phase, detail} = {}) {
    high = Math.max(high, Math.min(100, Math.max(0, pct)));
    record(high, phase ?? phaseEl.textContent, detail ?? detailEl.textContent);
    progressEl.classList.remove('indeterminate');
    fillEl.style.width = `${high}%`;
    pctEl.textContent = `${Math.round(high)}%`;
    if (phase != null) phaseEl.textContent = phase;
    if (detail != null) {
      detailEl.textContent = detail;
      detailEl.style.display = detail ? 'block' : 'none';
    }
  },

  indeterminate(phase, detail = '') {
    clearTimeout(hideTimer);
    record(high, phase, detail, true);
    progressEl.style.display = 'block';
    progressEl.classList.add('indeterminate');
    if (phase != null) phaseEl.textContent = phase;
    pctEl.textContent = '';
    detailEl.textContent = detail;
    detailEl.style.display = detail ? 'block' : 'none';
  },

  /** Land on 100%, hold it long enough to register, then fade the block out. */
  finish(phase, detail = '') {
    progressEl.classList.remove('indeterminate');
    high = 100;
    record(100, phase, detail);
    fillEl.style.width = '100%';
    pctEl.textContent = '100%';
    progressEl.classList.add('done');
    if (phase != null) phaseEl.textContent = phase;
    detailEl.textContent = detail;
    detailEl.style.display = detail ? 'block' : 'none';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      progressEl.style.display = 'none';
    }, 1400);
  },

  hide() {
    clearTimeout(hideTimer);
    high = 0;
    progressEl.style.display = 'none';
    progressEl.classList.remove('indeterminate', 'done');
    fillEl.style.width = '0%';
  },
};

export const stageHistory = [];
const STAGE_HISTORY = 400;

let plan = {groups: [], phases: []};
let phaseState = new Map();
let nodes = new Map();
let groupNodes = new Map();

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const bar = () => {
  const track = el('div', 'stage-bar');
  track.appendChild(el('div', 'stage-fill'));
  return track;
};

const MARK = {pending: '·', active: '▸', done: '✓', failed: '✕', skipped: '–'};

function paintPhase(key) {
  const s = phaseState.get(key);
  const n = nodes.get(key);
  if (!s || !n) return;
  n.row.className = `stage-line ${s.state}${s.indeterminate ? ' indeterminate' : ''}`;
  n.mark.textContent = MARK[s.state] ?? '·';
  n.detail.textContent = s.detail ?? '';
  n.row.title = s.detail ? `${n.label}: ${s.detail}` : n.label;
  n.fill.style.width = `${s.state === 'done' ? 100 : s.pct}%`;
}

function paintGroup(groupKey) {
  const phases = plan.phases.filter(p => p.group === groupKey);
  const total = phases.reduce((a, p) => a + (p.weight ?? 1), 0) || 1;
  const doneW = phases.reduce((a, p) => {
    const s = phaseState.get(p.key);
    return a + (p.weight ?? 1) * (s?.state === 'done' ? 100 : s?.pct ?? 0);
  }, 0);
  const pct = Math.min(100, doneW / total);
  const g = groupNodes.get(groupKey);
  if (!g) return;
  g.fill.style.width = `${pct}%`;
  g.pct.textContent = `${Math.round(pct)}%`;
  g.box.classList.toggle('done', phases.every(p => phaseState.get(p.key)?.state === 'done'));
}

export const stages = {
  begin({groups, phases}) {
    plan = {groups, phases};
    phaseState = new Map(phases.map(p => [p.key, {pct: 0, state: 'pending', detail: ''}]));
    nodes = new Map();
    groupNodes = new Map();
    stageHistory.length = 0;
    stagesEl.replaceChildren();
    stagesEl.style.display = 'block';

    for (const g of groups) {
      const box = el('div', 'stage-group');
      const head = el('div', 'stage-group-head');
      head.appendChild(el('span', 'stage-group-name', g.label));
      const pct = el('span', 'stage-group-pct', '0%');
      head.appendChild(pct);
      const track = bar();
      box.append(head, track);
      for (const p of phases.filter(x => x.group === g.key)) {
        const row = el('div', 'stage-line pending');
        const mark = el('span', 'stage-mark', MARK.pending);
        const name = el('span', 'stage-name', p.label);
        const detail = el('span', 'stage-detail', '');
        const lineBar = bar();
        row.append(mark, name, detail, lineBar);
        row.title = p.label;
        box.appendChild(row);
        nodes.set(p.key, {row, mark, detail, label: p.label, fill: lineBar.firstChild});
      }
      stagesEl.appendChild(box);
      groupNodes.set(g.key, {box, pct, fill: track.firstChild});
      paintGroup(g.key);
    }
  },

  set(key, {pct, detail, state, indeterminate} = {}) {
    const s = phaseState.get(key);
    if (!s) return;
    if (pct != null) s.pct = Math.min(100, Math.max(s.pct, pct));
    if (detail != null) s.detail = detail;
    if (indeterminate != null) s.indeterminate = indeterminate;
    s.state = state ?? (s.pct >= 100 ? 'done' : 'active');
    if (s.state === 'done') s.indeterminate = false;
    stageHistory.push({
      key, pct: s.pct, state: s.state, detail: s.detail,
      indeterminate: !!s.indeterminate, at: performance.now()
    });
    if (stageHistory.length > STAGE_HISTORY) stageHistory.shift();
    paintPhase(key);
    paintGroup(plan.phases.find(p => p.key === key)?.group);
  },

  done: (key, detail) => stages.set(key, {pct: 100, detail, state: 'done'}),

  /** Everything that ran, finished. Anything still pending never had to run, and says so. */
  finish() {
    for (const p of plan.phases) {
      const s = phaseState.get(p.key);
      if (!s || s.state === 'failed') continue;
      stages.set(p.key, s.state === 'pending' ? {state: 'skipped'} : {pct: 100, state: 'done'});
    }
  },

  /** The phase that broke keeps its detail; what was never reached is marked skipped, not failed. */
  fail(message) {
    let broke = false;
    for (const p of plan.phases) {
      const s = phaseState.get(p.key);
      if (!s) continue;
      if (s.state === 'active') {
        broke = true;
        stages.set(p.key, {state: 'failed', detail: message});
      } else if (s.state === 'pending') {
        stages.set(p.key, {state: 'skipped'});
      }
    }
    return broke;
  },

  hide() {
    stagesEl.style.display = 'none';
    stagesEl.replaceChildren();
    plan = {groups: [], phases: []};
    phaseState = new Map();
    nodes = new Map();
    groupNodes = new Map();
  },
};
