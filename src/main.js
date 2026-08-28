import './style.css';
import maplibregl from 'maplibre-gl';
import {URLS, V3_BASE} from './config.js';
import {upstreamRange} from './data.js';
import {applyHighlight, applyInlets, applyPicks, applyStreamStyle, archive, clearHighlight, currentSelection, flyToPick, hoverRegions, initMap, map, regionsAt, setSelectionHighlightVisible, streamLayerIds,} from './map.js';
import {compileLayers} from './streamStyle.js';
import {loadStreamAttributes} from './streamAttributes.js';
import {createStylePanel} from './stylePanel.js';
import {renderRiverAttributes} from './riverPanel.js';
import {MAX_PICKS, picks} from './picks.js';
import {aoi, isDownstreamOf, spanCount} from './aoi.js';
import {renderAoi} from './aoiPanel.js';
import {renderPicks} from './picksPanel.js';
import {downloadGeometry} from './geometry.js';
import {clearStatus, fmt, progress, progressHistory, stageHistory, stages, status} from './ui.js';
import {heroIcon} from './icons.js';
import {initMapControls, syncLayerPicker} from './mapControls.js';
import {initSettings, onSetting} from './settings.js';

let sel = null;
let riverCardShown = false;
let stylePanel = null;
let regionPopup = null;

const $ = id => document.getElementById(id);

// ── selection ────────────────────────────────────────────────────────────────
const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * The reach a click landed on, as the numbers a subset is cut from: its own riverIndex, and the
 * contiguous run of riverIndex that everything upstream of it occupies. Both a watershed selection
 * and an AOI's outlet and inlets are this record — they differ only in what is done with it.
 */
function reachRecord(at) {
  const riverId = num(at.riverId);
  const riverIndex = num(at.riverIndex);
  const upstreamCount = num(at.upstreamCount);
  if (riverId == null || riverIndex == null || upstreamCount == null) {
    throw new Error('That reach is missing riverId, riverIndex or upstreamCount — the tiles it ' +
      'came from cannot describe a subset');
  }
  const range = upstreamRange({riverIndex, upstreamCount});
  return {
    outletId: riverId,
    riverIndex: range.hi,
    upstreamCount,
    lo: range.lo,
    hi: range.hi,
    count: range.count,
    groupId: num(at.groupId),
    strahlerOrder: num(at.strahlerOrder),
  };
}

/**
 * Make `spans` the selection, under `rec`'s outlet. A watershed passes its one run; an AOI passes
 * what its inlets left. Everything downstream — the readout, the highlight, the styling scope, the
 * export — reads `sel`, so both arrive there the same way.
 */
function setSelection(rec, spans) {
  sel = {...rec, spans, count: spanCount(spans)};
  applyHighlight({lo: rec.lo, hi: rec.hi, spans}, rec.outletId, applyStyle);
  renderSelectionInfo();
  selectionChanged();
  setBusy(false);
  return sel;
}

function selectOutlet(at) {
  clearStatus();
  try {
    const rec = reachRecord(at);
    setSelection(rec, [{lo: rec.lo, hi: rec.hi}]);
    status(`${fmt(sel.count)} reaches selected` +
      (sel.groupId != null ? ` · Group ${sel.groupId}` : ''), 'success');
    return sel;
  } catch (err) {
    status(err.message, 'error');
    console.error(err);
    return null;
  }
}

function renderSelectionInfo() {
  const el = $('selection-info');
  const n = sel.count;
  el.style.display = 'block';
  $('watershed-count').textContent = fmt(n);
  el.innerHTML =
    `<span class="count">${fmt(n)}</span> <span class="k">stream${n === 1 ? '' : 's'} selected</span>` +
    `<br><span class="k">outlet</span> <span class="outlet">${sel.outletId}</span>` +
    (sel.strahlerOrder != null ? ` <span class="k">ord</span> ${sel.strahlerOrder}` : '') +
    (sel.groupId != null ? ` <span class="k">group</span> <span class="group">${sel.groupId}</span>` : '') +
    `<br><span class="k">riverIndex</span> ${fmt(sel.lo)}&ndash;${fmt(sel.hi)}` +
    (sel.spans.length > 1
      ? `<br><span class="k">aoi</span> ${sel.spans.length} runs <span class="k">·</span> ` +
        `<span class="trimmed">&minus;${fmt(sel.upstreamCount + 1 - n)}</span> <span class="k">trimmed</span>`
      : '');
}

/**
 * The clicked reach's own attributes, in the folding section under the selection summary. The
 * section is on the page from the start — an empty one still tells you where the attributes will
 * land — and the fold state is whatever the user last left it at, except that the first click of
 * the session opens it once.
 */
function showRiverAttributes(props) {
  renderRiverAttributes($('river-body'), props);
  const id = props?.riverId;
  $('river-card-id').textContent = id == null ? '' : String(id);
  if (props != null && !riverCardShown) {
    riverCardShown = true;
    setRiverCollapsed(false);
  }
}

function setBusy(busy) {
  $('btn-geoparquet').disabled = busy || sel === null;
}

function clearSelection() {
  sel = null;
  clearHighlight(applyStyle);
  $('selection-info').style.display = 'none';
  $('watershed-count').textContent = '';
  showRiverAttributes(null);
  riverCardShown = false;
  $('btn-geoparquet').disabled = true;
  clearStatus();
  progress.hide();
  stages.hide();
  // Quiet when there is no AOI, so this cannot bounce back through the change handler below.
  aoi.clear();
  selectionChanged();
}

// ── styling ──────────────────────────────────────────────────────────────────
function applyStyle() {
  if (!stylePanel || !map) return;
  const spec = stylePanel.getSpec();
  const {highlight} = stylePanel.options();
  applyStreamStyle(compileLayers(spec, {highlight, selection: currentSelection()}));
  setSelectionHighlightVisible(highlight);
  const base = spec.base.color[0]?.value;
  if (base) document.documentElement.style.setProperty('--stream', base);
}

const selectionForStyle = () => (sel
  ? {outletId: sel.outletId, groupId: sel.groupId, count: sel.count}
  : null);

function selectionChanged() {
  stylePanel?.selectionChanged();
  applyStyle();
}

let countCost = 0;

function refreshCounts() {
  if (!stylePanel || countCost > 300) return;
  const layers = streamLayerIds();
  if (!layers.length) return;
  const t0 = performance.now();
  let feats;
  try {
    feats = map.queryRenderedFeatures({layers});
  } catch {
    return;
  }
  countCost = performance.now() - t0;
  const tally = new Map(layers.map(id => [id, 0]));
  for (const f of feats) tally.set(f.layer.id, (tally.get(f.layer.id) ?? 0) + 1);
  stylePanel.setCounts(tally);
}

// ── the selection methods ────────────────────────────────────────────────────
/**
 * Three things a click on a river can mean, and exactly one of them at a time. Each has a card in
 * the column and an on/off switch at the head of it, and turning one on turns the other two off —
 * they are three answers to the same question, not three features that stack.
 *
 *   watershed  everything that drains to the reach you clicked
 *   aoi        the same, minus what came in from each inlet you then click
 *   multi      collect the watershed above the reach, and keep collecting
 *
 * Shift-click is the exception, and the only one: it collects a watershed without leaving the
 * method you are in, for the river you noticed while doing something else.
 */
const MODES = {
  watershed: {card: 'watershed', key: 'w'},
  aoi: {card: 'aoi', key: 'a'},
  multi: {card: 'picks', key: 'm'},
};

/** Multi-select is the one method that is remembered, because its collection is. */
let mode = picks.modeOn() ? 'multi' : 'watershed';

function setMode(next, {say = false} = {}) {
  mode = next in MODES ? next : 'watershed';
  picks.setMode(mode === 'multi');
  for (const [name, {card}] of Object.entries(MODES)) {
    const on = name === mode;
    const btn = $(`${card}-mode`);
    btn.textContent = on ? 'On' : 'Off';
    btn.classList.toggle('on', on);
    $('sidebar').classList.toggle(`${card}-on`, on);
  }
  // The method you just turned on is the one you are about to use, so it is opened.
  ({watershed: setWatershedCollapsed, aoi: setAoiCollapsed, multi: setPicksCollapsed})[mode](false);
  // A watershed already selected is an AOI with no inlets yet, so it is adopted rather than asked
  // for again — the first click of the mode goes to an inlet instead of repeating itself.
  if (mode === 'aoi' && sel && !aoi.state().outlet) {
    const {spans: _ignored, ...rec} = sel;
    aoi.setOutlet({...rec, count: rec.hi - rec.lo + 1});
  }
  if (!say) return;
  const {outlet} = aoi.state();
  status({
    watershed: 'Watershed selector on — a click selects everything that drains to the reach it ' +
      'lands on.',
    aoi: outlet
      ? `AOI subsetter on, outlet ${outlet.outletId} — click each inlet to drop what drains into it.`
      : 'AOI subsetter on — click the reach at the outlet of your area of interest.',
    multi: 'Multi-select on — every click collects the watershed above the reach it lands on.',
  }[mode], 'info');
}

// ── the AOI subsetter ────────────────────────────────────────────────────────
/**
 * A third thing a click can mean. Single-select answers "what drains to this reach"; the AOI
 * subsetter answers "what drains to this reach that did not come in from up there", which takes two
 * kinds of click — one for the outlet, then one per inlet. aoi.js holds the state and does the
 * arithmetic; what is here is the mode, what a click means while it is on, and the painting.
 */
function setAoiCollapsed(collapsed) {
  $('sidebar').classList.toggle('aoi-collapsed', collapsed);
  $('aoi-collapse').replaceChildren(heroIcon(collapsed ? 'chevron-right' : 'chevron-down'));
  $('aoi-collapse').title = collapsed
    ? 'Expand the AOI subsetter'
    : 'Collapse the AOI subsetter';
}

/** What a click on a river means while the mode is on: the outlet first, then inlets. */
function aoiClick(at, lngLat) {
  clearStatus();
  let rec;
  try {
    rec = reachRecord(at);
  } catch (err) {
    return status(err.message, 'error');
  }
  const point = {lon: lngLat.lng, lat: lngLat.lat};
  const {outlet} = aoi.state();
  if (!outlet) {
    aoi.setOutlet({...rec, ...point});
    return status(`AOI outlet ${rec.outletId} · ${fmt(rec.count)} reaches upstream — now click ` +
      'the inlets you want trimmed off.', 'success');
  }
  // A click below the outlet is not a failed inlet — it is the outlet moved down. The area only
  // grows, so the inlets stay where they were put and go on cutting the same ground.
  if (isDownstreamOf(rec, outlet)) {
    aoi.setOutlet({...rec, ...point});
    const {count, inlets} = aoi.state();
    const kept = inlets.length
      ? `, ${fmt(inlets.length)} inlet${inlets.length === 1 ? '' : 's'} kept`
      : '';
    return status(`AOI outlet moved downstream to ${rec.outletId} · ` +
      `${fmt(count)} reach${count === 1 ? '' : 'es'} in the AOI${kept}.`, 'success');
  }
  const result = aoi.toggleInlet({...rec, ...point});
  const {count, inlets} = aoi.state();
  const left = `${fmt(count)} reach${count === 1 ? '' : 'es'} left in the AOI`;
  if (result === 'added') {
    return status(`Inlet ${rec.outletId} — it and what drains into it are out. ` +
      `${fmt(inlets.length)} inlet${inlets.length === 1 ? '' : 's'} · ${left}.`, 'success');
  }
  if (result === 'removed') {
    return status(`Inlet ${rec.outletId} removed — it and the ground above it are back. ${left}.`,
      'info');
  }
  if (result === 'outside') {
    return status(`${rec.outletId} is not inside this AOI, so it cannot be one of its inlets. ` +
      `Click a reach that drains to ${outlet.outletId}.`, 'error');
  }
  if (result === 'is-outlet') {
    return status(`${rec.outletId} is the AOI's own outlet — making it an inlet would cut the ` +
      'whole area away. Click a reach upstream of it instead.', 'error');
  }
  return status(`${rec.outletId} is already above an inlet, so it is out of the AOI along with ` +
    'everything around it.', 'info');
}

/** The AOI changed: repaint the card, the inlets on the map, and the selection it adds up to. */
function paintAoi() {
  const state = aoi.state();
  $('aoi-count').textContent = String(state.inlets.length);
  applyInlets(state.inlets.map(i => i.outletId));
  renderAoi($('aoi-body'), state, {
    onRemove: inlet => aoi.removeInlet(inlet.outletId),
    onZoom: inlet => flyToPick(inlet),
    onClear: () => {
      if (!aoi.clear()) status('No AOI to clear.', 'info');
    },
  });
  if (state.outlet) setSelection(state.outlet, state.spans);
  // The AOI was the selection, so dropping it drops that too. clearSelection() calls aoi.clear(),
  // which is already quiet by now, so this does not come back around.
  else if (sel) clearSelection();
}

aoi.onChange(paintAoi);

// ── multi-select ─────────────────────────────────────────────────────────────
/**
 * Collecting is a second thing a click can mean. Single-select answers "what is upstream of this
 * reach"; collecting builds a list of watersheds to hand to something else, so it is deliberately
 * additive, survives a reload, and never clears itself.
 *
 * Two ways in, because the two are used differently: the mode, for a session spent going around the
 * world clicking rivers, and a shift-click, for the one you noticed while doing something else.
 */
/** One click both collects and uncollects, so a wrong pick is undone where it was made. */
function collect(rec) {
  const result = picks.toggle(rec);
  if (result === 'full') {
    return status(`The collection is at its ceiling of ${fmt(MAX_PICKS)} — export it and clear ` +
      'it to keep collecting.', 'error');
  }
  const n = picks.count();
  status(`${result === 'removed' ? 'Removed' : 'Collected'} ${rec.outletId} · ` +
    `${fmt(n)} outlet${n === 1 ? '' : 's'} collected`, result === 'removed' ? 'info' : 'success');
}

/** The list changed: repaint the map, the count beside the heading, and the rows. */
function paintPicks() {
  const list = picks.all();
  applyPicks(list);
  $('picks-count').textContent = String(list.length);
  renderPicks($('picks-body'), {
    onRemove: p => picks.remove(p.outletId),
    onZoom: p => flyToPick(p),
    onClear: () => {
      const n = picks.count();
      if (!n) return status('Nothing collected yet.', 'info');
      if (!confirm(`Clear all ${fmt(n)} collected outlets? They are not saved anywhere else.`)) return;
      picks.clear();
      status('Collection cleared.', 'info');
    },
    report: status,
  });
}

picks.onChange(paintPicks);

// ── map interactions ─────────────────────────────────────────────────────────
function onMapHover(e) {
  const stream = map.queryRenderedFeatures(e.point, {layers: streamLayerIds()})[0];
  map.getCanvas().style.cursor = stream
    ? ({multi: 'copy', aoi: 'crosshair', watershed: 'pointer'})[mode]
    : '';
  hoverRegions(e.point);
}

/**
 * The id of every region polygon under the click — HydroBASINS level 2, and the Group.
 *
 * Built as nodes rather than a string: the ids come out of the tiles, so nothing from the data
 * gets to be markup.
 */
function showRegions(e) {
  regionPopup?.remove();
  regionPopup = null;
  const regions = regionsAt(e.point);
  if (!regions.length) return;
  const body = document.createElement('div');
  body.className = 'region-popup-body';
  for (const r of regions) {
    const row = document.createElement('div');
    row.className = 'region-row';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = r.color;
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = r.label;
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = String(r.id);
    row.append(dot, k, v);
    body.append(row);
  }
  regionPopup = new maplibregl.Popup({className: 'region-popup', maxWidth: '280px'})
    .setLngLat(e.lngLat)
    .setDOMContent(body)
    .addTo(map);
}

function onMapClick(e) {
  const hits = map.queryRenderedFeatures(
    [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], {layers: streamLayerIds()});
  // A click that misses the network is asking about the region it landed in instead.
  if (!hits.length) return showRegions(e);
  const p = hits[0].properties;
  if (p.riverId == null) return;
  regionPopup?.remove();
  regionPopup = null;
  const mod = e.originalEvent;
  const additive = !!(mod && (mod.shiftKey || mod.metaKey || mod.ctrlKey));
  // Every field the tiles carry for that reach, whether or not a subset can be cut from it.
  showRiverAttributes(p);
  // With the AOI mode on, every click on a river belongs to the AOI — the outlet while there isn't
  // one, an inlet after that. A modified click is not an exception: while you are placing inlets,
  // a slipped modifier key should not tip you into collecting watersheds instead.
  if (mode === 'aoi') return aoiClick(p, e.lngLat);
  // The feature is the selection: outlet, index, upstream count and Group all come off it.
  const rec = selectOutlet(p);
  // A reach the tiles cannot describe a subset of is not a watershed, so it cannot be collected.
  if (!rec || !(mode === 'multi' || additive)) return;
  // A modified click collects without switching methods — the one you noticed on the way past.
  collect({...rec, lon: e.lngLat.lng, lat: e.lngLat.lat});
}

// ── boot ─────────────────────────────────────────────────────────────────────
$('btn-clear').addEventListener('click', clearSelection);
$('btn-geoparquet').addEventListener('click', () => {
  if (!sel) return;
  setBusy(true);
  downloadGeometry({
    groupId: sel.groupId, outletId: sel.outletId, lo: sel.lo, hi: sel.hi, count: sel.count,
    spans: sel.spans,
    onSettled: () => setBusy(false),
  });
});
// ── theme ────────────────────────────────────────────────────────────────────
// The RFS v3 app remembers its light/dark choice under this key. Both apps are served from
// apps.geoglows.org, so that is one localStorage — switching theme in either is switching it for
// both, which is the point of matching the palette in the first place.
const THEME_KEY = 'rfs-theme';
const isTheme = v => v === 'light' || v === 'dark';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // The button shows what a click would switch to, the way RFS v3's does: a sun to go light.
  $('btn-theme').replaceChildren(heroIcon(theme === 'dark' ? 'sun' : 'moon'));
}

const storedTheme = () => {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
};

let theme = isTheme(storedTheme()) ? storedTheme() : 'dark';
applyTheme(theme);

$('btn-theme').addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch { /* private mode — the choice holds for this tab and is not remembered */ }
  applyTheme(theme);
});

// The other app, in another tab, flipping the same key. Only fires for other documents, so this
// cannot loop with the click handler above.
window.addEventListener('storage', e => {
  if (e.key !== THEME_KEY || !isTheme(e.newValue) || e.newValue === theme) return;
  theme = e.newValue;
  applyTheme(theme);
});

// ── the styling section ──────────────────────────────────────────────────────
function setStyleCollapsed(collapsed) {
  $('sidebar').classList.toggle('style-collapsed', collapsed);
  $('style-collapse').replaceChildren(heroIcon(collapsed ? 'chevron-right' : 'chevron-down'));
  $('style-collapse').title = collapsed ? 'Expand the styling panel' : 'Collapse the styling panel';
}

$('style-collapse').addEventListener('click', () =>
  setStyleCollapsed(!$('sidebar').classList.contains('style-collapsed')));
setStyleCollapsed(true);

// ── the multi-select section ─────────────────────────────────────────────────
function setPicksCollapsed(collapsed) {
  $('sidebar').classList.toggle('picks-collapsed', collapsed);
  $('picks-collapse').replaceChildren(heroIcon(collapsed ? 'chevron-right' : 'chevron-down'));
  $('picks-collapse').title = collapsed
    ? 'Expand the multi-select list'
    : 'Collapse the multi-select list';
}

$('picks-collapse').addEventListener('click', () =>
  setPicksCollapsed(!$('sidebar').classList.contains('picks-collapsed')));

$('aoi-collapse').addEventListener('click', () =>
  setAoiCollapsed(!$('sidebar').classList.contains('aoi-collapsed')));

// One switch per method, all three doing the same thing: make this the method a click means.
for (const [name, {card}] of Object.entries(MODES)) {
  $(`${card}-mode`).addEventListener('click', () => setMode(name, {say: true}));
}

// The other way in, for a session spent on the map rather than in the panel. The key of the method
// already on drops back to the watershed selector, so M stays the toggle it has always been.
// Ignored while a form control has the keyboard, so typing "m" into the styling editor stays typing.
window.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();
  const hit = Object.entries(MODES).find(([, m]) => m.key === key);
  if (!hit) return;
  const t = e.target;
  if (t?.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t?.tagName)) return;
  setMode(mode === hit[0] ? 'watershed' : hit[0], {say: true});
});

paintPicks();
setPicksCollapsed(!picks.count());
paintAoi();
setAoiCollapsed(true);
setMode(mode);

// ── the layer switches ───────────────────────────────────────────────────────
// mapControls.js fills the rows; the fold is the column's business, like every other section's.
function setLayersCollapsed(collapsed) {
  $('sidebar').classList.toggle('layers-collapsed', collapsed);
  $('layers-collapse').replaceChildren(heroIcon(collapsed ? 'chevron-right' : 'chevron-down'));
  $('layers-collapse').title = collapsed ? 'Expand the layer list' : 'Collapse the layer list';
}

$('layers-collapse').addEventListener('click', () =>
  setLayersCollapsed(!$('sidebar').classList.contains('layers-collapsed')));
setLayersCollapsed(false);

// ── the watershed selector ───────────────────────────────────────────────────
// What the last click selected, and the two things there are to do with it. Folds like the sections
// under it: the heading keeps the stream count, so a folded card still says what is selected.
function setWatershedCollapsed(collapsed) {
  $('sidebar').classList.toggle('watershed-collapsed', collapsed);
  $('watershed-collapse').replaceChildren(heroIcon(collapsed ? 'chevron-right' : 'chevron-down'));
  $('watershed-collapse').title = collapsed
    ? 'Expand the watershed selector'
    : 'Collapse the watershed selector';
}

$('watershed-collapse').addEventListener('click', () =>
  setWatershedCollapsed(!$('sidebar').classList.contains('watershed-collapsed')));
setWatershedCollapsed(false);

// ── the river attributes section ─────────────────────────────────────────────
function setRiverCollapsed(collapsed) {
  $('sidebar').classList.toggle('river-collapsed', collapsed);
  $('river-collapse').replaceChildren(heroIcon(collapsed ? 'chevron-right' : 'chevron-down'));
  $('river-collapse').title = collapsed
    ? 'Expand the river attributes panel'
    : 'Collapse the river attributes panel';
}

$('river-collapse').addEventListener('click', () =>
  setRiverCollapsed(!$('sidebar').classList.contains('river-collapsed')));
setRiverCollapsed(false);
showRiverAttributes(null);

// ── the map's own controls ───────────────────────────────────────────────────
// The layer switches, the basemap choice and the legend live over the map rather than in this
// column; mapControls.js owns all three.
initMapControls();

// ── settings ─────────────────────────────────────────────────────────────────
// The cog beside the theme button. Wired before anything subscribes, so that onSetting() below
// hands out the stored value rather than the fallback.
initSettings();
$('btn-settings').replaceChildren(heroIcon('cog-6-tooth'));
onSetting('legend', on => $('legend-overlay').classList.toggle('hidden', !on));

let ready = false;

(async () => {
  try {
    console.info(`[explorer] v3 base ${V3_BASE}`);
    progress.begin('Loading the map');
    const m = await initMap();
    m.on('click', onMapClick);
    m.on('mousemove', onMapHover);
    m.on('mouseout', () => hoverRegions(null));
    syncLayerPicker();
    // The collection outlives the page, so whatever was restored is painted as soon as there is a
    // map to paint it on.
    applyPicks(picks.all());

    stylePanel = createStylePanel({
      mount: $('style-body'),
      onChange: applyStyle,
      selection: selectionForStyle,
      status,
      pmtiles: URLS.streamsPmtiles,
    });
    const showZoom = () => {
      $('style-zoom').textContent = `z${m.getZoom().toFixed(1)}`;
    };
    m.on('move', showZoom);
    m.on('idle', refreshCounts);
    showZoom();
    loadStreamAttributes(archive).then(info => stylePanel.setAttributes(info));
    progress.hide();
    ready = true;
  } catch (err) {
    progress.hide();
    status(`Init failed: ${err.message}`, 'error');
    console.error(err);
  }
})();
