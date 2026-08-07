/**
 * The sidebar's two output surfaces: one status line, and the download progress block.
 *
 * This replaces a running log. The log printed every step of every lookup, which meant the one
 * line that mattered — an error, or how far a download had got — scrolled away under lines that
 * only confirmed things had gone normally. `status()` overwrites rather than appends, so what is
 * on screen is the current state instead of a transcript of how it was reached.
 *
 * Detail that used to be logged is not lost, it is placed where it belongs: counts and ids in the
 * selection box, phase and bytes in the progress block, and the full story of a failure in the
 * console, where it can be read without occupying the panel.
 */
const $ = id => document.getElementById(id);

const statusEl = $('status');
const stagesEl = $('stages');
const progressEl = $('progress');
const phaseEl = $('progress-phase');
const pctEl = $('progress-pct');
const fillEl = $('progress-fill');
const detailEl = $('progress-detail');

export const fmt = n => n.toLocaleString();
export const mb = b => `${(b / 1e6).toFixed(2)} MB`;

/** Elapsed/remaining seconds as m:ss, which reads faster than "97.4 s" at a glance. */
export const clock = s => {
  if (!isFinite(s) || s < 0) return '';
  const m = Math.floor(s / 60);
  return m ? `${m}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${s.toFixed(s < 10 ? 1 : 0)}s`;
};

/** The one status line. `cls` is '' | 'info' | 'success' | 'error'. */
export function status(msg, cls = '') {
  statusEl.textContent = msg || '';
  statusEl.className = cls;
  statusEl.style.display = msg ? 'block' : 'none';
}

export const clearStatus = () => status('');

let hideTimer = null;

/**
 * The progress block.
 *
 * Percentages only ever move forward within a run: a bar that goes backwards reads as a bug even
 * when the underlying estimate genuinely improved, so `set` clamps to the high-water mark and
 * `begin` is the only thing that resets it.
 */
let high = 0;

/**
 * The last N updates, newest last.
 *
 * Sampling the DOM to find out whether the bar really moved is a race — a local read can finish
 * inside one polling interval and the interesting states are gone before anything looks. This
 * records them as they happen, which is what the test suite asserts against and what makes a
 * "did the bar sit still?" question answerable after the fact.
 */
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

  /**
   * A phase whose length cannot be known — the synchronous parquet encode is one call that either
   * has returned or has not. A striped bar that is honestly indeterminate beats a percentage
   * invented to keep it moving.
   */
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
    hideTimer = setTimeout(() => { progressEl.style.display = 'none'; }, 1400);
  },

  hide() {
    clearTimeout(hideTimer);
    high = 0;
    progressEl.style.display = 'none';
    progressEl.classList.remove('indeterminate', 'done');
    fillEl.style.width = '0%';
  },
};

/**
 * The staged progress block, for a run with more than one thing going on.
 *
 * One bar is the right shape for a lookup: it is one fetch and one decode, and a single number says
 * how far along it is. A GeoParquet export is not that — it fetches an index, prunes row groups,
 * streams tens of megabytes, decodes them, re-encodes every geometry and writes a file, and a single
 * percentage flattens all of it into a number that appears to stall for seconds at a time with no
 * way to tell which part is slow.
 *
 * So the export gets a bar per *kind* of work — bytes off the wire, and work done on them — and a
 * line per phase under each. The whole plan is declared before the run starts, so the steps that
 * have not happened yet are on screen greyed out rather than appearing one at a time: what is
 * coming is as informative as what is done, and a phase that is slow is obvious because it is the
 * one line that is moving.
 *
 * Group percentages are a weighted mean of their phases, weighted by what each phase actually costs
 * rather than by counting phases equally — writing the file is not a quarter of the processing work
 * and a bar that says it is would be lying by construction.
 */
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
  // A finished line's detail is ellipsised to keep the block narrow; the title is where the rest
  // of it goes, rather than nowhere.
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
  /**
   * Declare the run. `groups` are the bars; `phases` are the lines, each naming its group and what
   * share of it it is worth.
   */
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

  /**
   * Move one phase. Percentages only go forward within a phase, for the same reason the single bar
   * clamps: a number that goes backwards reads as a bug even when the estimate genuinely improved.
   */
  set(key, {pct, detail, state, indeterminate} = {}) {
    const s = phaseState.get(key);
    if (!s) return;
    if (pct != null) s.pct = Math.min(100, Math.max(s.pct, pct));
    if (detail != null) s.detail = detail;
    if (indeterminate != null) s.indeterminate = indeterminate;
    s.state = state ?? (s.pct >= 100 ? 'done' : 'active');
    if (s.state === 'done') s.indeterminate = false;
    stageHistory.push({key, pct: s.pct, state: s.state, detail: s.detail,
      indeterminate: !!s.indeterminate, at: performance.now()});
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
