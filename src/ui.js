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
