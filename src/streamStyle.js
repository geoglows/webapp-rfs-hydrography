import {MAX_ZOOM, MIN_ZOOM, ZOOM_STEP} from './config.js';
import {compact} from './streamAttributes.js';

export const SOURCE = 'streams';
export const SOURCE_LAYER = 'streams';
export const BASE_LAYER_ID = 'streams';
export const RULE_LAYER_PREFIX = 'stream-rule-';
export const ruleLayerId = i => `${RULE_LAYER_PREFIX}${i + 1}`;

export const COLORS = {
  /**
   * Amber against the blue of the network, because that pair survives every common form of colour
   * blindness — the one distinction on this map that has to hold is selected from not selected.
   * Both ends stay on the yellow side of orange: a red-leaning dark end is the one thing that
   * would put the pair back into a red/blue clash.
   * Everything a selection is made of is one hue at two depths: `upstream` is the area it covers,
   * `outlet` is the reaches that bound it — the one it drains to and the inlets it stops above.
   * The multi-select collection is drawn in the same two, because a collected watershed is the
   * same kind of thing as a selected one; the map tells them apart by which is on it at the time.
   */
  stream: '#3B82F6', upstream: '#F5A623', outlet: '#B45309',
};

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

export function normalizeStops(prop, stops) {
  const byZoom = new Map();
  for (const s of stops ?? []) {
    if (s == null) continue;
    byZoom.set(snapZoom(s.zoom), coerce(prop, s.value));
  }
  return [...byZoom.entries()].sort((a, b) => a[0] - b[0]).map(([zoom, value]) => ({zoom, value}));
}

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

/** New rules cycle these — saturated mid-tones, all of which hold up on the light gray basemap. */
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
const spanExpr = ({lo, hi}) => [
  'all',
  ['has', 'riverIndex'],
  ['>=', ['get', 'riverIndex'], lo],
  ['<=', ['get', 'riverIndex'], hi],
];

/**
 * Every reach a selection holds. A watershed is one contiguous run of riverIndex, and passes as
 * `{lo, hi}`; an AOI is that run with the run above each of its inlets cut out, and passes the runs
 * it has left as `spans`. One run compiles to the same expression it always did.
 */
export const inRangeExpr = sel => {
  const spans = sel.spans ?? [{lo: sel.lo, hi: sel.hi}];
  // A selection with no runs left holds no reaches. aoi.js will not build one — it refuses to make
  // the outlet its own inlet — but the empty list must not read as "everything" if one ever arrives.
  if (!spans.length) return ['==', ['get', 'riverIndex'], -1];
  return spans.length === 1 ? spanExpr(spans[0]) : ['any', ...spans.map(spanExpr)];
};

/**
 * `names` swaps every rule's colour for one expression over riverIndex - the River Names mode. It
 * replaces the spec's colours rather than filtering anything, so the network stays exactly as wide
 * and as filtered as the panel left it and only the hue changes. The selection highlight still wins
 * over it: selected from not selected is the one distinction on this map that has to hold, whatever
 * else is being shown.
 */
export function compileLayers(spec, {highlight = false, selection = null, names = null} = {}) {
  const rules = (spec.rules ?? []).filter(r => r.enabled !== false);
  const globalFilter = conditionsExpr(spec.filter?.conditions, spec.filter?.match);
  const ruleFilters = rules.map(r => conditionsExpr(r.conditions, r.match));

  const scoped = spec.scope === 'selection' && selection != null;
  const isUp = selection ? inRangeExpr(selection) : null;
  const on = highlight && isUp != null;

  const colorOut = v => {
    const base = names ? names.color : v;
    return on ? ['case', isUp, COLORS.upstream, base] : base;
  };
  const widthOut = v => {
    // A named reach is drawn several points heavier than the rest of the network, so the extent a
    // name covers is legible at a glance instead of being a colour you have to hunt for. The
    // selection keeps its own bump on top: an upstream reach is the selection's width whether or
    // not it happens to be named.
    const wide = names ? ['case', names.named, Math.round(v * names.scale * 100) / 100, v] : v;
    return on ? ['case', isUp, Math.round(v * UP_WIDTH_SCALE * 100) / 100, wide] : wide;
  };
  const opacityOut = v => (scoped
    ? ['case', isUp, v, Math.round(v * OUT_OF_SCOPE_OPACITY * 1000) / 1000]
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
        note: 'styled for one subset — pair this file with the exported GeoParquet'
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
      layers: compileLayers(clean, {highlight: false}),
    },
  };
  return json;
}

const num = (v, fallback = null) => (isFinite(Number(v)) ? Number(v) : fallback);

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
