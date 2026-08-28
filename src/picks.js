/**
 * The collected watershed outlets.
 *
 * Single-select answers "what is upstream of this reach". Multi-select answers a different
 * question: which watersheds, anywhere in the world, belong on a list you keep somewhere else —
 * an exclusion list, a QA queue, a set of basins to reprocess. So what this holds is not a map
 * state but a working set: it survives a reload, it is added to a click at a time over a long
 * session, and the point of it is what comes out — the outlet riverIds, in a form another tool
 * will take.
 *
 * A pick is keyed by its outlet riverId, so clicking the same reach twice never doubles it.
 */
const KEY = 'rfs-hydrography-picks';
const MODE_KEY = 'rfs-hydrography-multiselect';

/** A ceiling high enough that no hand-clicked session reaches it, low enough to stay paintable. */
export const MAX_PICKS = 2000;

const store = {
  read(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch { /* private mode — the list holds for this tab and is not remembered */ }
  },
};

const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

/** Only records that can still describe a watershed are kept — a half-written one is dropped. */
function clean(p) {
  const outletId = num(p?.outletId);
  const lo = num(p?.lo);
  const hi = num(p?.hi);
  if (outletId == null || lo == null || hi == null) return null;
  return {
    outletId, lo, hi,
    count: num(p.count) ?? hi - lo + 1,
    upstreamCount: num(p.upstreamCount) ?? hi - lo,
    groupId: num(p.groupId),
    strahlerOrder: num(p.strahlerOrder),
    lon: num(p.lon),
    lat: num(p.lat),
  };
}

function load() {
  const raw = store.read(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : []).map(clean).filter(Boolean).slice(0, MAX_PICKS);
  } catch (err) {
    console.warn('[picks] the stored list could not be read, starting empty', err);
    return [];
  }
}

let list = load();
let listeners = [];

const emit = () => {
  store.write(KEY, JSON.stringify(list));
  for (const fn of listeners) fn(list);
};

export const picks = {
  /** Called with the whole list whenever it changes — the map and the panel both ride on this. */
  onChange(fn) {
    listeners.push(fn);
    return () => {
      listeners = listeners.filter(f => f !== fn);
    };
  },

  all: () => list,
  count: () => list.length,
  has: id => list.some(p => p.outletId === Number(id)),
  full: () => list.length >= MAX_PICKS,

  /** Newest first: the thing you just clicked is the thing you are looking for in the list. */
  add(rec) {
    const p = clean(rec);
    if (!p) return null;
    if (picks.has(p.outletId)) return 'kept';
    if (list.length >= MAX_PICKS) return 'full';
    list = [p, ...list];
    emit();
    return 'added';
  },

  remove(id) {
    const before = list.length;
    list = list.filter(p => p.outletId !== Number(id));
    if (list.length === before) return false;
    emit();
    return true;
  },

  /** One click on a river both collects and uncollects it, which is how a working set is built. */
  toggle(rec) {
    const p = clean(rec);
    if (!p) return null;
    return picks.has(p.outletId) ? (picks.remove(p.outletId), 'removed') : picks.add(p);
  },

  clear() {
    if (!list.length) return;
    list = [];
    emit();
  },

  modeOn: () => store.read(MODE_KEY) === '1',
  setMode: on => store.write(MODE_KEY, on ? '1' : '0'),
};

// ── what comes out ───────────────────────────────────────────────────────────
/** Oldest first for export: the order they were picked in is the order they were reasoned about. */
const exportOrder = () => [...list].reverse();

export const idsText = () => exportOrder().map(p => p.outletId).join('\n');

export const idsJson = () => JSON.stringify(exportOrder().map(p => p.outletId));

const CSV_COLUMNS = [
  ['outletRiverId', p => p.outletId],
  ['groupId', p => p.groupId],
  ['strahlerOrder', p => p.strahlerOrder],
  ['reachCount', p => p.count],
  ['riverIndexLo', p => p.lo],
  ['riverIndexHi', p => p.hi],
  ['lon', p => (p.lon == null ? null : p.lon.toFixed(5))],
  ['lat', p => (p.lat == null ? null : p.lat.toFixed(5))],
];

/** Every number the app knows about each pick — ids alone are enough to exclude by, the rest is
 *  what makes the list reviewable a week later. */
export const csv = () => [
  CSV_COLUMNS.map(c => c[0]).join(','),
  ...exportOrder().map(p => CSV_COLUMNS.map(c => c[1](p) ?? '').join(',')),
].join('\n');
