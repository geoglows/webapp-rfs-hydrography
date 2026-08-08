/**
 * The stream style: one small spec the panel edits, the map renders live, and the export publishes.
 *
 * Three decisions shape everything below.
 *
 * **Every style value is a list of zoom stops, and every stop sits on the half-zoom grid.** Colour,
 * width and opacity all take the same shape — `[{zoom, value}, ...]` — so a constant is just a
 * one-stop list and there is one editor, one validator and one compiler rather than three. Zooms
 * are snapped to `ZOOM_STEP` on the way in from every direction (the editor only offers grid
 * values, and a loaded file is snapped and told about it), so a ramp cannot end up with two stops
 * 0.03 apart.
 *
 * **A rule compiles to its own MapLibre layer, and the layers are mutually exclusive.** Rule *i*'s
 * filter is ANDed with the negation of every rule above it, and the base layer with the negation of
 * all of them, so each reach is drawn by exactly one layer. That is what makes a per-rule zoom
 * range a real visibility toggle: hiding a rule between z0 and z6 would mean nothing if the base
 * layer were still painting those same reaches underneath it.
 *
 * **The zoom ramp stays outermost.** MapLibre only accepts `["zoom"]` as the input of a top-level
 * `interpolate`/`step`, so the selection highlight and the selection-scope dimming are folded into
 * each *stop's output* rather than wrapped around the ramp. `ramp()` takes that output mapper,
 * which is why nothing here ever nests an interpolate inside a case.
 */
import {MAX_ZOOM, MIN_ZOOM, ZOOM_STEP} from './config.js';
import {compact} from './streamAttributes.js';

export const SOURCE = 'streams';
export const SOURCE_LAYER = 'streams';
/** The base layer keeps the id the rest of the app queries for clicks, hovers and tests. */
export const BASE_LAYER_ID = 'streams';
export const RULE_LAYER_PREFIX = 'stream-rule-';
export const ruleLayerId = i => `${RULE_LAYER_PREFIX}${i + 1}`;

/**
 * The map's three line colours. They live here rather than in map.js because the default style is
 * built here and map.js renders it — one definition, and the legend swatches in style.css match
 * these by hand as they always did.
 */
export const COLORS = {stream: '#4A90E2', upstream: '#7ED321', outlet: '#F5A623'};

/** Upstream reaches keep the ~2.2x width bump the app has always drawn them with. */
const UP_WIDTH_SCALE = 2.2;
/** How far out-of-scope reaches fade when the style is previewed on the selection only. */
const OUT_OF_SCOPE_OPACITY = 0.12;

// ── the zoom grid ────────────────────────────────────────────────────────────
export const ZOOM_STEPS = (() => {
  const out = [];
  for (let z = MIN_ZOOM; z <= MAX_ZOOM + 1e-9; z += ZOOM_STEP) out.push(Math.round(z * 2) / 2);
  return out;
})();

export const snapZoom = z => {
  const n = Number(z);
  if (!isFinite(n)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(n / ZOOM_STEP) * ZOOM_STEP));
};

export const isGridZoom = z => Number.isFinite(Number(z)) && Math.abs(Number(z) - snapZoom(z)) < 1e-9;

/** z6 and z6.5, never z6.0 — the trailing zero reads as precision that is not on offer. */
export const fmtZoom = z => (Number.isInteger(z) ? `z${z}` : `z${z.toFixed(1)}`);

// ── conditions ───────────────────────────────────────────────────────────────
export const NUMBER_OPS = [
  {op: '>=', label: '≥'}, {op: '>', label: '>'},
  {op: '<=', label: '≤'}, {op: '<', label: '<'},
  {op: '==', label: '='}, {op: '!=', label: '≠'},
  {op: 'between', label: 'in range', arity: 2},
];
export const STRING_OPS = [
  {op: '==', label: 'is'}, {op: '!=', label: 'is not'}, {op: 'in', label: 'is one of', list: true},
];
export const opsFor = type => (type === 'string' ? STRING_OPS : NUMBER_OPS);

export const newCondition = attr => ({
  attribute: attr?.name ?? '',
  type: attr?.type ?? 'number',
  op: attr?.type === 'string' ? '==' : '>=',
  value: attr?.suggested ?? 0,
  value2: attr?.max ?? 0,
});

const listValues = v => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map(s => String(s).trim()).filter(Boolean);

/**
 * One condition as a MapLibre expression, or null if it is not usable yet.
 *
 * Every comparison is guarded by `["has", attr]`. A reach missing the attribute then matches no
 * condition about it — including `!=`, which is the reading that keeps a rule meaning "reaches
 * whose region is not X" rather than "reaches we know nothing about".
 */
export function conditionExpr(c) {
  if (!c?.attribute || !c.op) return null;
  const get = ['get', c.attribute];
  const has = ['has', c.attribute];
  const asValue = v => (c.type === 'string' ? String(v ?? '') : Number(v));
  if (c.op === 'between') {
    const lo = Number(c.value), hi = Number(c.value2);
    if (!isFinite(lo) || !isFinite(hi)) return null;
    return ['all', has, ['>=', get, Math.min(lo, hi)], ['<=', get, Math.max(lo, hi)]];
  }
  if (c.op === 'in') {
    const vals = listValues(c.value);
    return vals.length ? ['all', has, ['in', get, ['literal', vals]]] : null;
  }
  const v = asValue(c.value);
  if (c.type !== 'string' && !isFinite(v)) return null;
  return ['all', has, [c.op, get, v]];
}

export const MATCH_MODES = [
  {mode: 'all', label: 'AND', hint: 'every condition must hold'},
  {mode: 'any', label: 'OR', hint: 'any one condition is enough'},
];

/**
 * A condition list as one expression, combined with AND or OR.
 *
 * An empty list is `true` under either mode, not `false` under 'any': a rule with no conditions
 * means "everything left", which is how the base block and a fresh rule are both written. An `any`
 * of nothing being vacuously false would turn a half-built rule into an invisible one.
 */
export const conditionsExpr = (list, match = 'all') => {
  const parts = (list ?? []).map(conditionExpr).filter(Boolean);
  if (!parts.length) return true;
  if (parts.length === 1) return parts[0];
  return [match === 'any' ? 'any' : 'all', ...parts];
};

const allOf = (...terms) => {
  const t = terms.filter(x => x !== true && x != null);
  if (t.some(x => x === false)) return false;
  if (!t.length) return null;
  return t.length === 1 ? t[0] : ['all', ...t];
};

const not = expr => (expr === true ? false : expr === false ? true : ['!', expr]);

/**
 * "order ≥ 6 and area ≥ 7 G" — what a rule matches, in one line, for the panel.
 *
 * Numbers are abbreviated here and only here: this is the line you read to see what a rule is, and
 * a drainage-area threshold written out in full is ten digits nobody counts. The exact value is in
 * the condition's own input directly below it.
 */
export function describeConditions(list, attrsByName = new Map(), match = 'all') {
  const v = (value, type) => (type === 'string' ? value : compact(Number(value)));
  const parts = (list ?? []).map(c => {
    const label = attrsByName.get(c.attribute)?.label ?? c.attribute;
    const op = opsFor(c.type).find(o => o.op === c.op);
    if (c.op === 'between') return `${label} ${v(c.value, c.type)}–${v(c.value2, c.type)}`;
    if (c.op === 'in') return `${label} in ${listValues(c.value).join(', ')}`;
    return `${label} ${op?.label ?? c.op} ${v(c.value, c.type)}`;
  });
  return parts.join(match === 'any' ? ' or ' : ' and ');
}

// ── stops ────────────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const LIMITS = {
  color: {kind: 'color'},
  width: {kind: 'number', min: 0, max: 24, step: 0.1},
  opacity: {kind: 'number', min: 0, max: 1, step: 0.05},
};

const coerce = (prop, v) => {
  const lim = LIMITS[prop];
  if (lim.kind === 'color') return String(v ?? COLORS.stream);
  const n = Number(v);
  return isFinite(n) ? clamp(n, lim.min, lim.max) : lim.min;
};

/**
 * Snap zooms to the grid, coerce values, drop duplicates (last wins) and sort ascending — which is
 * also exactly what MapLibre requires of `interpolate` stop inputs.
 */
export function normalizeStops(prop, stops) {
  const byZoom = new Map();
  for (const s of stops ?? []) {
    if (s == null) continue;
    byZoom.set(snapZoom(s.zoom), coerce(prop, s.value));
  }
  return [...byZoom.entries()].sort((a, b) => a[0] - b[0]).map(([zoom, value]) => ({zoom, value}));
}

/**
 * A property expression from stops, with `out` applied to each stop's value.
 *
 * `out` is where feature-dependent overrides go — the upstream highlight, the out-of-scope fade —
 * because they have to sit *inside* the ramp: MapLibre rejects a zoom ramp nested in a case.
 */
function ramp(prop, stops, out = v => v) {
  const s = normalizeStops(prop, stops);
  if (!s.length) return out(coerce(prop, null));
  if (s.length === 1) return out(s[0].value);
  return ['interpolate', ['linear'], ['zoom'], ...s.flatMap(p => [p.zoom, out(p.value)])];
}

// ── the spec ─────────────────────────────────────────────────────────────────
export const SPEC_VERSION = 1;
export const SPEC_FORMAT = 'rfs-hydrography-explorer/stream-style';

const stop = (zoom, value) => ({zoom: snapZoom(zoom), value});

/** New rules cycle these — saturated mid-tones, all of which hold up on the Positron basemap. */
export const RULE_PALETTE = ['#1d4ed8', '#0e7490', '#15803d', '#b45309', '#be123c', '#7c3aed'];

let ruleSeq = 0;
export const newRule = ({name, conditions = [], match = 'all', color, minZoom = null, maxZoom = null, width, opacity} = {}) => ({
  id: `r${++ruleSeq}`,
  name: name ?? `Rule ${ruleSeq}`,
  enabled: true,
  match,
  conditions,
  color: [stop(0, color ?? RULE_PALETTE[(ruleSeq - 1) % RULE_PALETTE.length])],
  width: width ?? [stop(3, 1), stop(9, 2), stop(14, 4)],
  opacity: opacity ?? [stop(0, 1)],
  minZoom,
  maxZoom,
});

/** The base block is the catch-all: no conditions, and it draws whatever no rule claimed. */
const defaultBase = () => ({
  name: 'All other streams',
  color: [stop(0, COLORS.stream)],
  width: [stop(3, 0.7), stop(9, 1.4), stop(14, 3)],
  opacity: [stop(3, 0.85), stop(9, 1)],
  minZoom: null,
  maxZoom: null,
});

/**
 * The style the app opens with is the style the app has always drawn.
 *
 * That matters more than it looks: the panel is an editor, not a redesign, so switching it on must
 * change nothing on the map until someone changes something. It also means the base block is a
 * worked example of every control the panel offers.
 */
export const defaultSpec = () => ({
  version: SPEC_VERSION,
  name: 'RFS v3 default',
  scope: 'all',
  filter: {match: 'all', conditions: []},
  base: defaultBase(),
  rules: [],
});

export const cloneSpec = spec => JSON.parse(JSON.stringify(spec));

// ── compile ──────────────────────────────────────────────────────────────────
/**
 * The spec as MapLibre layers, bottom first.
 *
 * `highlight` folds the app's own selection colours in; the JSON export compiles without it, so
 * what is published is the cartography and not the state of one session's click. `scope: 'selection'`
 * fades everything the current subset does not contain, which is only meaningful while a selection
 * exists — with none, it compiles as 'all'.
 */
export function compileLayers(spec, {highlight = false, outletId = null, hasSelection = false} = {}) {
  const rules = (spec.rules ?? []).filter(r => r.enabled !== false);
  const globalFilter = conditionsExpr(spec.filter?.conditions, spec.filter?.match);
  const ruleFilters = rules.map(r => conditionsExpr(r.conditions, r.match));

  const scoped = spec.scope === 'selection' && hasSelection;
  const inSelection = outletId != null
    ? ['any', ['boolean', ['feature-state', 'up'], false], ['==', ['get', 'riverId'], outletId]]
    : ['boolean', ['feature-state', 'up'], false];
  const isUp = ['boolean', ['feature-state', 'up'], false];

  const colorOut = v => (highlight ? ['case', isUp, COLORS.upstream, v] : v);
  const widthOut = v => (highlight
    ? ['case', isUp, Math.round(v * UP_WIDTH_SCALE * 100) / 100, v]
    : v);
  const opacityOut = v => (scoped
    ? ['case', inSelection, v, Math.round(v * OUT_OF_SCOPE_OPACITY * 1000) / 1000]
    : v);

  const layer = (id, style, filter, meta) => {
    const l = {
      id, type: 'line', source: SOURCE, 'source-layer': SOURCE_LAYER,
      layout: {'line-cap': 'round', 'line-join': 'round'},
      paint: {
        'line-color': ramp('color', style.color, colorOut),
        'line-width': ramp('width', style.width, widthOut),
        'line-opacity': ramp('opacity', style.opacity, opacityOut),
      },
    };
    // A zoom range is only written when it restricts something: `minzoom: 0` on every layer is
    // noise in a file someone is meant to read.
    const min = style.minZoom == null ? null : snapZoom(style.minZoom);
    const max = style.maxZoom == null ? null : snapZoom(style.maxZoom);
    if (min != null && min > MIN_ZOOM) l.minzoom = min;
    if (max != null && (min == null || max > min)) l.maxzoom = max;
    if (filter != null) l.filter = filter;
    if (meta) l.metadata = meta;
    return l;
  };

  const layers = [layer(
    BASE_LAYER_ID,
    spec.base ?? defaultBase(),
    allOf(globalFilter, ...ruleFilters.map(not)),
    {'rfs:rule': spec.base?.name ?? 'All other streams'},
  )];
  rules.forEach((r, i) => layers.push(layer(
    ruleLayerId(i),
    r,
    allOf(globalFilter, ruleFilters[i], ...ruleFilters.slice(0, i).map(not)),
    {'rfs:rule': r.name},
  )));
  return layers;
}

/**
 * Which rule, if any, claims every reach — anything below it is dead and the panel should say so
 * before someone spends ten minutes styling a rule that can never match.
 */
export function shadowedRules(spec) {
  const out = new Set();
  let claimed = false;
  for (const r of spec.rules ?? []) {
    if (r.enabled === false) continue;
    if (claimed) out.add(r.id);
    if (conditionsExpr(r.conditions, r.match) === true) claimed = true;
  }
  return out;
}

// ── JSON in and out ──────────────────────────────────────────────────────────
/**
 * The downloadable file: the spec as the panel holds it, plus the compiled MapLibre layers and the
 * source they read from, so it is both editable here and directly usable there.
 *
 * Deliberately no timestamp. Two runs of the same style produce byte-identical files, which is what
 * makes a diff between two styles worth looking at — the same reasoning as the sorted id export.
 */
export function styleJson(spec, {pmtiles, selection = null} = {}) {
  const clean = cloneSpec(spec);
  clean.version = SPEC_VERSION;
  for (const block of [clean.base, ...(clean.rules ?? [])]) {
    for (const prop of ['color', 'width', 'opacity']) block[prop] = normalizeStops(prop, block[prop]);
    block.minZoom = block.minZoom == null ? null : snapZoom(block.minZoom);
    block.maxZoom = block.maxZoom == null ? null : snapZoom(block.maxZoom);
  }
  const json = {
    format: SPEC_FORMAT,
    version: SPEC_VERSION,
    name: clean.name,
    zoom: {min: MIN_ZOOM, max: MAX_ZOOM, step: ZOOM_STEP},
    scope: clean.scope === 'selection' && selection
      ? {
        mode: 'selection', outletRiverId: selection.outletId, groupId: selection.groupId,
        reachCount: selection.count,
        note: 'styled for one subset — pair this file with the exported river ID list'
      }
      : {mode: 'all'},
    filter: clean.filter,
    base: clean.base,
    rules: clean.rules,
    maplibre: {
      sources: {
        [SOURCE]: {
          type: 'vector',
          url: pmtiles ? `pmtiles://${pmtiles}` : undefined,
          promoteId: {[SOURCE_LAYER]: 'riverId'},
          attribution: 'GEOGLOWS RFS v3',
        },
      },
      // Compiled without the app's selection colours: what is published is the style, not the
      // state of one session's click.
      layers: compileLayers(clean, {highlight: false}),
    },
  };
  return json;
}

const num = (v, fallback = null) => (isFinite(Number(v)) ? Number(v) : fallback);

/**
 * Read a style file back in.
 *
 * Everything is repaired rather than rejected — an off-grid zoom is snapped, an unknown property is
 * dropped, a missing block falls back to the default — and every repair is reported, because a file
 * that silently loads as something slightly different is worse than one that says what it changed.
 */
export function parseStyleJson(obj) {
  const notes = [];
  if (!obj || typeof obj !== 'object') throw new Error('not a JSON object');
  if (obj.format && obj.format !== SPEC_FORMAT) notes.push(`format "${obj.format}" is not ${SPEC_FORMAT} — read anyway`);

  const readStops = (prop, stops, fallback) => {
    if (!Array.isArray(stops) || !stops.length) return fallback;
    let snapped = 0;
    const list = stops.map(s => {
      const z = num(s?.zoom, 0);
      if (!isGridZoom(z)) snapped++;
      return {zoom: snapZoom(z), value: s?.value};
    });
    const out = normalizeStops(prop, list);
    if (snapped) notes.push(`${snapped} ${prop} stop(s) snapped to the nearest ${ZOOM_STEP} zoom`);
    if (out.length < list.length) notes.push(`${list.length - out.length} duplicate ${prop} stop(s) dropped`);
    return out;
  };

  const readBlock = (block, fallback) => {
    const b = block && typeof block === 'object' ? block : {};
    const zoomOf = key => {
      if (b[key] == null) return null;
      const z = num(b[key]);
      if (z == null) return null;
      if (!isGridZoom(z)) notes.push(`${key} ${z} snapped to ${snapZoom(z)}`);
      return snapZoom(z);
    };
    return {
      name: typeof b.name === 'string' ? b.name : fallback.name,
      color: readStops('color', b.color, fallback.color),
      width: readStops('width', b.width, fallback.width),
      opacity: readStops('opacity', b.opacity, fallback.opacity),
      minZoom: zoomOf('minZoom'),
      maxZoom: zoomOf('maxZoom'),
    };
  };

  const readConditions = list => (Array.isArray(list) ? list : [])
    .map(c => ({
      attribute: String(c?.attribute ?? ''),
      type: c?.type === 'string' ? 'string' : 'number',
      op: String(c?.op ?? '>='),
      value: c?.value,
      value2: c?.value2,
    }))
    .filter(c => {
      const ok = c.attribute && opsFor(c.type).some(o => o.op === c.op) && conditionExpr(c) != null;
      if (!ok) notes.push(`dropped an unusable condition on "${c.attribute || '(no attribute)'}"`);
      return ok;
    });

  // A file written before the AND/OR choice existed, or by hand without it, means AND.
  const readMatch = m => (m === 'any' ? 'any' : 'all');

  const base = defaultSpec();
  const spec = {
    version: SPEC_VERSION,
    name: typeof obj.name === 'string' ? obj.name : 'Loaded style',
    scope: obj.scope?.mode === 'selection' || obj.scope === 'selection' ? 'selection' : 'all',
    filter: {match: readMatch(obj.filter?.match), conditions: readConditions(obj.filter?.conditions)},
    base: readBlock(obj.base, base.base),
    rules: (Array.isArray(obj.rules) ? obj.rules : []).map((r, i) => ({
      ...readBlock(r, {...base.base, name: `Rule ${i + 1}`}),
      id: `r${++ruleSeq}`,
      enabled: r?.enabled !== false,
      match: readMatch(r?.match),
      conditions: readConditions(r?.conditions),
    })),
  };
  return {spec, notes};
}

// ── presets ──────────────────────────────────────────────────────────────────
/**
 * Four starting points, each of which is also a demonstration: the ramp preset shows per-rule zoom
 * ranges on half steps, the big-rivers preset shows the visibility filter, and the area preset shows a
 * measure other than order carrying the design.
 *
 * `needs` is checked against the attributes actually in the tiles, so a preset keyed to a field a
 * future tileset drops is never offered rather than silently drawing nothing.
 */
export const PRESETS = [
  {
    id: 'default',
    label: 'v3 default',
    hint: 'what the map draws with no rules at all',
    needs: [],
    build: () => defaultSpec(),
  },
  {
    id: 'order-ramp',
    label: 'Order ramp',
    hint: 'four bands of Strahler order, each entering at its own zoom',
    needs: ['strahlerOrder'],
    build: () => {
      const spec = defaultSpec();
      spec.name = 'Strahler order ramp';
      spec.base = {
        ...defaultBase(),
        name: 'Headwaters (order < 4)',
        color: [stop(0, '#94c5e8')],
        width: [stop(9, 0.6), stop(14, 1.6)],
        opacity: [stop(9, 0.7), stop(11, 0.95)],
        minZoom: 9,
        maxZoom: null,
      };
      spec.rules = [
        newRule({
          name: 'Major rivers (order ≥ 8)',
          conditions: [{attribute: 'strahlerOrder', type: 'number', op: '>=', value: 8}],
          color: '#0b3d91',
          width: [stop(3, 1.4), stop(6.5, 2.4), stop(10, 4), stop(14, 7)],
        }),
        newRule({
          name: 'Large rivers (order 6–7)',
          conditions: [{attribute: 'strahlerOrder', type: 'number', op: 'between', value: 6, value2: 7}],
          color: '#1d6fd0',
          width: [stop(4.5, 1), stop(9, 2), stop(14, 4.5)],
          minZoom: 4.5,
        }),
        newRule({
          name: 'Tributaries (order 4–5)',
          conditions: [{attribute: 'strahlerOrder', type: 'number', op: 'between', value: 4, value2: 5}],
          color: '#4a9fe0',
          width: [stop(7, 0.8), stop(9.5, 1.5), stop(14, 2.8)],
          minZoom: 7,
        }),
      ];
      return spec;
    },
  },
  {
    id: 'big-rivers',
    label: 'Big rivers only',
    hint: 'a global visibility filter — everything below order 6 is dropped, not dimmed',
    needs: ['strahlerOrder'],
    build: () => {
      const spec = defaultSpec();
      spec.name = 'Big rivers only';
      spec.filter = {match: 'all', conditions: [{attribute: 'strahlerOrder', type: 'number', op: '>=', value: 6}]};
      spec.base = {
        ...defaultBase(),
        name: 'Order ≥ 6',
        color: [stop(0, '#0f3f73')],
        width: [stop(2, 0.8), stop(6.5, 1.8), stop(11, 3.5), stop(14, 6)],
        opacity: [stop(0, 1)],
      };
      return spec;
    },
  },
  {
    id: 'by-area',
    label: 'By contributing area',
    hint: 'three bands of drainage area, coloured warm to cool',
    needs: ['DSContArea'],
    build: () => {
      const spec = defaultSpec();
      spec.name = 'Contributing area bands';
      spec.base = {
        ...defaultBase(),
        name: 'Under 1 G m²',
        color: [stop(0, '#9fc7e8')],
        width: [stop(7, 0.6), stop(14, 2)],
        opacity: [stop(7, 0.75), stop(10, 1)],
        minZoom: 7,
      };
      spec.rules = [
        newRule({
          name: '≥ 100 G m²',
          conditions: [{attribute: 'DSContArea', type: 'number', op: '>=', value: 1e11}],
          color: '#7c2d12',
          width: [stop(3, 1.4), stop(8.5, 3), stop(14, 6)],
        }),
        newRule({
          name: '10–100 G m²',
          conditions: [{attribute: 'DSContArea', type: 'number', op: 'between', value: 1e10, value2: 1e11}],
          color: '#b45309',
          width: [stop(4, 1), stop(9, 2.2), stop(14, 4.5)],
          minZoom: 4,
        }),
        newRule({
          name: '1–10 G m²',
          conditions: [{attribute: 'DSContArea', type: 'number', op: 'between', value: 1e9, value2: 1e10}],
          color: '#0e7490',
          width: [stop(5.5, 0.8), stop(9.5, 1.6), stop(14, 3.2)],
          minZoom: 5.5,
        }),
      ];
      return spec;
    },
  },
];

export const presetsFor = attributes => {
  const have = new Set(attributes.map(a => a.name));
  return PRESETS.filter(p => p.needs.every(n => have.has(n)));
};
