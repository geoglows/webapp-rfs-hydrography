/**
 * The AOI subsetter: a watershed with the watersheds above its inlets cut out of it.
 *
 * A watershed selection answers "everything that drains to here". An area of interest is the other
 * half of the question — "everything that drains to here, except what came in from up there" — the
 * shape you want when the ground above an inlet is somebody else's model, or a reservoir, or a
 * gauge you are treating as a boundary condition.
 *
 * It works because of how the hydrography is ordered: every reach upstream of a reach is a
 * contiguous run of riverIndex ending at that reach, which is what upstreamRange() returns. So the
 * AOI is one run with a run cut out of it per inlet, and what comes out is a list of disjoint runs
 * — the same shape as a watershed, only more than one of them. Everything downstream of here (the
 * map filter, the export) takes that list.
 *
 * An inlet takes itself away along with the ground above it: what it marks is where the AOI stops,
 * so the AOI runs from just below each inlet down to the outlet. The outlet reach is the one that
 * cannot be an inlet — there would be nothing left.
 *
 * Nothing here is remembered across a reload. An AOI is a live reading of the map, like the
 * single selection it produces — not a working set like the multi-select collection, which is kept.
 */

/** The number of reaches a list of runs covers. */
export const spanCount = spans => spans.reduce((n, s) => n + s.hi - s.lo + 1, 0);

/** What one inlet takes away: itself, and everything that drains to it. */
export const inletCut = ({lo, hi}) => ({lo, hi});

/**
 * Is `rec` a different reach downstream of `of`? Everything upstream of a reach is a contiguous run
 * of riverIndex ending at that reach, so `of` is upstream of `rec` exactly when its own index falls
 * inside `rec`'s run — and it is a *different* reach when that run ends further down than its own.
 */
export const isDownstreamOf = (rec, of) =>
  !!of && rec.lo <= of.hi && of.hi < rec.hi;

/** `spans` minus `cut`, both sorted and disjoint, and disjoint and sorted on the way out. */
function subtract(spans, cut) {
  const out = [];
  for (const s of spans) {
    if (cut.hi < s.lo || cut.lo > s.hi) {
      out.push(s);
      continue;
    }
    if (cut.lo > s.lo) out.push({lo: s.lo, hi: cut.lo - 1});
    if (cut.hi < s.hi) out.push({lo: cut.hi + 1, hi: s.hi});
  }
  return out;
}

/** The runs an outlet and a set of inlets leave behind. */
export function spansFor(outlet, inlets) {
  if (!outlet) return [];
  let spans = [{lo: outlet.lo, hi: outlet.hi}];
  for (const inlet of inlets) spans = subtract(spans, inletCut(inlet));
  return spans;
}

let outlet = null;
let inlets = [];
let modeOn = false;
let listeners = [];

const emit = () => {
  for (const fn of listeners) fn(aoi.state());
};

export const aoi = {
  /** Called with the whole state whenever it changes — the map and the panel both ride on this. */
  onChange(fn) {
    listeners.push(fn);
    return () => {
      listeners = listeners.filter(f => f !== fn);
    };
  },

  /**
   * Everything a reader of the AOI needs, derived rather than stored: the runs, how many reaches
   * they hold, and how many the inlets took off. `outlet` doubles as "is there an AOI at all".
   */
  state() {
    const spans = spansFor(outlet, inlets);
    const count = spanCount(spans);
    return {
      outlet,
      inlets,
      spans,
      count,
      trimmed: outlet ? outlet.count - count : 0,
      mode: modeOn,
    };
  },

  on: () => modeOn,

  setMode(on) {
    modeOn = !!on;
  },

  /**
   * Start an AOI, or move it. Moving the outlet downstream only widens the area: every inlet is
   * still inside it and still cuts away exactly the ground it cut before, so the inlets come along.
   * Any other move lands on a network the inlets were never points on, and drops them.
   */
  setOutlet(rec) {
    if (!rec) return null;
    const extended = isDownstreamOf(rec, outlet);
    if (!extended) inlets = [];
    outlet = rec;
    emit();
    return extended ? 'extended' : 'outlet';
  },

  /**
   * Add an inlet, or take one back off — one click does both, so a misplaced inlet is undone where
   * it was made. The refusals are the three a click can honestly earn: a reach outside the AOI, the
   * outlet itself, and a reach an inlet below it has already cut away.
   *
   * Refusing the outlet is what keeps the AOI from ever being empty. Every other reach in the AOI
   * is upstream of the outlet, so its run stops short of the outlet's own riverIndex, and the
   * outlet reach survives however many inlets are placed.
   */
  toggleInlet(rec) {
    if (!rec) return null;
    if (!outlet) return 'no-outlet';
    if (inlets.some(i => i.outletId === rec.outletId)) {
      inlets = inlets.filter(i => i.outletId !== rec.outletId);
      emit();
      return 'removed';
    }
    if (rec.outletId === outlet.outletId) return 'is-outlet';
    if (rec.hi < outlet.lo || rec.hi > outlet.hi) return 'outside';
    const before = spanCount(spansFor(outlet, inlets));
    if (spanCount(spansFor(outlet, [...inlets, rec])) === before) return 'covered';
    inlets = [...inlets, rec];
    emit();
    return 'added';
  },

  removeInlet(id) {
    const before = inlets.length;
    inlets = inlets.filter(i => i.outletId !== Number(id));
    if (inlets.length === before) return false;
    emit();
    return true;
  },

  /** Quiet when there is nothing to clear, so a caller can call it on every reset. */
  clear() {
    if (!outlet && !inlets.length) return false;
    outlet = null;
    inlets = [];
    emit();
    return true;
  },
};
