import {firstZoomForOrder, TILE_ORDER_LADDER} from './config.js';

export const SOURCE_LAYER = 'streams';

const KNOWN = {
  strahlerOrder: {
    label: 'Strahler order', role: 'measure',
    note: `tiles carry order >= ${TILE_ORDER_LADDER[0].minOrder} below z${TILE_ORDER_LADDER[1].zoom}` +
      TILE_ORDER_LADDER.slice(1).map(s => `, >= ${s.minOrder} from z${s.zoom}`).join('') +
      '; order 1 is in no tile',
  },
  shreveOrder: {label: 'Shreve order', role: 'measure', note: 'upstream link count — magnitude, not rank'},
  DSContArea: {label: 'Contributing area', role: 'measure', unit: 'm²', note: 'drainage area at the downstream end'},
  areaM2: {label: 'Catchment area', role: 'measure', unit: 'm²', note: "this reach's own catchment"},
  Length: {label: 'Reach length', role: 'measure', unit: 'm'},
  TDXHydroRegion: {label: 'TDX-Hydro region', role: 'category'},
  groupId: {label: 'Group', role: 'category', note: 'the per-Group geometry file a reach belongs to'},
  riverId: {label: 'River ID', role: 'identity'},
  nextRiverId: {label: 'Next river ID', role: 'identity', note: 'downstream reach, -1 at a terminal'},
  outletRiverId: {label: 'Outlet river ID', role: 'identity', note: 'terminal reach of the watershed'},
  riverIndex: {label: 'River index', role: 'identity', note: 'post-order rank — a watershed is one contiguous run of these'},
  upstreamCount: {label: 'Upstream reaches', role: 'measure', note: 'how far back the run reaches, excluding this one'},
};

const ROLE_ORDER = {measure: 0, category: 1, identity: 2};

/** What the app knows about one field name, with a sane fallback for a field it has never seen. */
export const fieldInfo = (name, type = 'number') => ({
  label: name,
  unit: '',
  note: '',
  role: type === 'string' ? 'category' : 'measure',
  ...(KNOWN[name] ?? {}),
});

export const roleRank = role => ROLE_ORDER[role] ?? 3;

/** Human-scale numbers for a menu: 1.2 M, 8.4 k, 0.75 — never 5384105885696. */
export const compact = v => {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(1)} T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)} G`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)} M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)} k`;
  if (a >= 100) return String(Math.round(v));
  if (Number.isInteger(v)) return String(v);
  // Number() again to drop the trailing zeros toPrecision leaves behind: 7.8, not 7.80.
  return String(Number(v.toPrecision(3)));
};

export function suggestedThreshold({type, min, max, values}) {
  if (type === 'string') return values?.[0] ?? '';
  if (min == null || max == null) return 0;
  if (max - min <= 12) return Math.max(min, Math.round((min + max) / 2));
  const mid = (min > 0 && max / Math.max(min, 1e-9) > 100)
    ? Math.sqrt(min * max)
    : (min + max) / 2;
  const mag = 10 ** Math.floor(Math.log10(Math.abs(mid) || 1));
  return Math.round(mid / mag) * mag;
}

/** Merge `vector_layers[].fields` (names + types) with tilestats (ranges + distinct values). */
function build(fields, stats) {
  const byName = new Map((stats?.attributes ?? []).map(a => [a.attribute, a]));
  const names = new Set([...Object.keys(fields ?? {}), ...byName.keys()]);
  return [...names].map(name => {
    const s = byName.get(name);
    const declared = String(fields?.[name] ?? s?.type ?? 'number').toLowerCase();
    const type = declared === 'string' ? 'string' : declared === 'boolean' ? 'boolean' : 'number';
    const known = KNOWN[name] ?? {};
    const attr = {
      name,
      type,
      label: known.label ?? name,
      unit: known.unit ?? '',
      note: known.note ?? '',
      role: known.role ?? (type === 'string' ? 'category' : 'measure'),
      min: s?.min ?? null,
      max: s?.max ?? null,
      values: type === 'string' ? (s?.values ?? []).map(String).sort() : [],
    };
    attr.suggested = suggestedThreshold(attr);
    return attr;
  }).sort((a, b) => (ROLE_ORDER[a.role] - ROLE_ORDER[b.role]) || a.label.localeCompare(b.label));
}

export async function loadStreamAttributes(archive) {
  try {
    const md = await archive.getMetadata();
    const layer = (md.vector_layers ?? []).find(l => l.id === SOURCE_LAYER) ?? md.vector_layers?.[0];
    const stats = (md.tilestats?.layers ?? []).find(l => l.layer === SOURCE_LAYER) ?? md.tilestats?.layers?.[0];
    const attributes = build(layer?.fields, stats);
    if (!attributes.length) return {attributes: [], error: 'the tiles declare no attributes'};
    return {
      attributes,
      minzoom: layer?.minzoom ?? md.minzoom ?? 0,
      maxzoom: layer?.maxzoom ?? md.maxzoom ?? null,
      reachCount: stats?.count ?? null,
    };
  } catch (err) {
    console.warn('[style] could not read tile attributes', err);
    return {attributes: [], error: err.message};
  }
}

export function orderVisibilityWarning(condition, minZoom) {
  if (condition?.attribute !== 'strahlerOrder') return null;
  const order = Number(condition.value);
  if (!isFinite(order) || !['>=', '>', '==', 'between'].includes(condition.op)) return null;
  const wanted = condition.op === '>' ? order + 1 : order;
  const from = firstZoomForOrder(wanted);
  if (from == null) return `order ${wanted} is in no tile at any zoom`;
  if (from > (minZoom ?? 0)) return `order ${wanted} first appears at z${from}`;
  return null;
}
