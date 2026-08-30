import './style.css';
import maplibregl from 'maplibre-gl';
import {URLS, V3_BASE} from './config.js';
import {upstreamRange} from './data.js';
import {applyHighlight, applyInlets, applyPicks, applyStreamStyle, archive, clearHighlight, currentSelection, flyToPick, hoverRegions, initMap, map, regionsAt, setSelectionHighlightVisible, streamLayerIds,} from './map.js';
import {compileLayers} from './streamStyle.js';
import {loadRiverNames, namesStyle, riverNames} from './riverNames.js';
import {loadStreamAttributes} from './streamAttributes.js';
import {createStylePanel} from './stylePanel.js';
import {renderRiverAttributes} from './riverPanel.js';
import {idsText, MAX_PICKS, picks} from './picks.js';
import {aoi, isDownstreamOf, spanCount} from './aoi.js';
import {renderAoi} from './aoiPanel.js';
import {renderPicks} from './picksPanel.js';
import {downloadGeometry} from './geometry.js';
import {fmt, progress, progressHistory, stageHistory, stages} from './ui.js';
import {heroIcon} from './icons.js';
import {initMapControls, syncLayerPicker} from './mapControls.js';
import {initSettings, onSetting} from './settings.js';

let sel = null;
/** The whole watershed record of the reach last clicked, whatever the method made of it. */
let lastRec = null;
let namesOn = false;
let namesError = null;
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

/**
 * The reach itself, as a selection. Everything downstream of here reads `spans`, so a single reach
 * is simply the run of one that its own riverIndex makes — no separate path through the highlight,
 * the catchment shading, the styling scope or the export.
 */
const reachOnlyRecord = rec => ({
  ...rec, lo: rec.riverIndex, hi: rec.riverIndex, upstreamCount: 0, count: 1, reachOnly: true,
});

/**
 * Select what a click means in the method that is on, and hand back the *watershed* record either
 * way — shift-click collects the network above the reach whatever the method, so it must not be
 * handed the one-reach version.
 */
function selectOutlet(at) {
  try {
    const full = reachRecord(at);
    // Kept whole whichever method read it, so switching between river and watershed can re-read
    // the same click rather than asking for it again.
    lastRec = full;
    const rec = mode === 'river' ? reachOnlyRecord(full) : full;
    setSelection(rec, [{lo: rec.lo, hi: rec.hi}]);
    return full;
  } catch (err) {
    console.error(err);
    return null;
  }
}

/**
 * The picked reach, in the river selector's own card. The full attribute list still lands in the
 * River attributes section below — this is the one line that says which reach those belong to.
 */
function renderReachInfo() {
  const el = $('river-select-info');
  if (!sel?.reachOnly) {
    el.style.display = 'none';
    $('river-select-count').textContent = '';
    return;
  }
  el.style.display = 'block';
  $('river-select-count').textContent = String(sel.outletId);
  el.innerHTML =
    `<span class="k">reach</span> <span class="outlet">${sel.outletId}</span>` +
    (sel.strahlerOrder != null ? ` <span class="k">ord</span> ${sel.strahlerOrder}` : '') +
    (sel.groupId != null ? ` <span class="k">group</span> <span class="group">${sel.groupId}</span>` : '') +
    `<br><span class="k">riverIndex</span> ${fmt(sel.riverIndex)}`;
}

function renderSelectionInfo() {
  renderReachInfo();
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
 * land — and the fold is the user's alone: a click on the map fills the panel, it never opens it.
 */
function showRiverAttributes(props) {
  renderRiverAttributes($('river-body'), props);
  const id = props?.riverId;
  $('river-card-id').textContent = id == null ? '' : String(id);
}

/**
 * The three buttons at the head of the column — download, copy, clear — belong to whichever method
 * is on rather than to a method each, because they mean the same thing in all four: take what is
 * selected, put it on the clipboard, throw it away. Multi-select is the one that holds something
 * without a selection behind it, so it is the one exception in the test.
 */
let busy = false;

function paintActions() {
  const held = mode === 'multi' ? picks.count() > 0 : sel !== null;
  $('btn-geoparquet').disabled = busy || sel === null;
  $('btn-copy').disabled = !held;
  $('btn-clear').disabled = !held;
}

function setBusy(on) {
  busy = on;
  paintActions();
}

/** Whatever the method that is on has to hand, one outlet riverId per line. */
async function copyIds() {
  const text = mode === 'multi' ? idsText() : (sel ? String(sel.outletId) : '');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    // Clipboard access is denied on an insecure origin and in some embeddings; the ids are on the
    // page either way, so say why rather than just failing.
    console.warn('[explorer] clipboard write refused', err);
  }
}

/** One Clear for all four methods: it empties what the one you are in is holding. */
function clearCurrent() {
  if (mode !== 'multi') return clearSelection();
  const n = picks.count();
  if (!n) return;
  if (!confirm(`Clear all ${fmt(n)} collected outlets? They are not saved anywhere else.`)) return;
  picks.clear();
}

function clearSelection() {
  sel = null;
  lastRec = null;
  clearHighlight(applyStyle);
  $('selection-info').style.display = 'none';
  $('watershed-count').textContent = '';
  $('river-select-info').style.display = 'none';
  $('river-select-count').textContent = '';
  showRiverAttributes(null);
  paintActions();
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
  const names = namesOn ? namesStyle() : null;
  applyStreamStyle(compileLayers(spec, {highlight, selection: currentSelection(), names}));
  setSelectionHighlightVisible(highlight);
  // The legend swatch has to be the colour the line on the map actually is. With the names mode on
  // the network no longer has one colour, so the swatch stands for the unnamed reaches — which the
  // mode leaves in the app's own blue precisely so that the network still reads as itself.
  const base = names ? riverNames().unnamed : spec.base.color[0]?.value;
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
 * Four things a click on a river can mean, and exactly one of them at a time. Each has a card in
 * the column and an on/off switch at the head of it, and turning one on turns the others off —
 * they are four answers to the same question, not four features that stack.
 *
 *   river      the reach you clicked, and nothing else
 *   watershed  everything that drains to the reach you clicked
 *   aoi        the same, minus what came in from each inlet you then click
 *   multi      collect the watershed above the reach, and keep collecting
 *
 * The river selector leads because it is the smallest answer and the one a click means before you
 * have asked for anything larger: you point at a reach to find out what it is. Selecting a whole
 * continent's drainage is the deliberate act, so it is the one you switch into.
 *
 * Shift-click is the exception, and the only one: it collects a watershed without leaving the
 * method you are in, for the river you noticed while doing something else.
 */
const MODES = {
  river: {card: 'river-select', key: 'r'},
  watershed: {card: 'watershed', key: 'w'},
  aoi: {card: 'aoi', key: 'a'},
  multi: {card: 'picks', key: 'm'},
};

/** Multi-select is the one method that is remembered, because its collection is. */
let mode = picks.modeOn() ? 'multi' : 'river';

/**
 * Give up what the method being left was holding, and say so first when that is a real loss.
 *
 * River and watershed hold nothing of their own — the same click means something in both — so
 * leaving them costs nothing. The other two accumulate: multi-select a list of watersheds, the AOI
 * subsetter the inlets trimming one. Neither survives the switch, so neither goes quietly.
 *
 * Returns false when the answer is no, in which case the method does not change.
 */
function leaveMode(prev) {
  if (prev === 'multi') {
    const n = picks.count();
    if (n > 1 && !confirm(`Leaving multi-select clears the ${fmt(n)} collected watersheds. They ` +
      'are not saved anywhere else. Leave and clear them?')) return false;
    picks.clear();
    return true;
  }
  if (prev === 'aoi') {
    const {inlets} = aoi.state();
    // No inlets is no AOI worth the name — the outlet is just the watershed selection, and it
    // carries over to whichever method is next rather than being thrown away.
    if (!inlets.length) return true;
    if (!confirm(`Leaving the AOI subsetter drops its outlet and the ${fmt(inlets.length)} ` +
      `inlet${inlets.length === 1 ? '' : 's'} trimming it. Leave and clear it?`)) return false;
    aoi.clear();
    return true;
  }
  return true;
}

function setMode(next) {
  const want = next in MODES ? next : 'river';
  const prev = mode;
  if (want !== prev && !leaveMode(prev)) return;
  mode = want;
  picks.setMode(mode === 'multi');
  for (const [name, {card}] of Object.entries(MODES)) {
    const on = name === mode;
    const btn = $(`${card}-mode`);
    btn.textContent = on ? 'On' : 'Off';
    btn.classList.toggle('on', on);
    $('sidebar').classList.toggle(`${card}-on`, on);
  }
  paintActions();
  // The same reach, read the other way. River and watershed are one click with two answers, so
  // switching between them repaints the map from what is already selected instead of leaving the
  // old answer on it until the next click.
  const between = m => m === 'river' || m === 'watershed';
  if (sel && lastRec && mode !== prev && between(mode) && between(prev)) {
    const rec = mode === 'river' ? reachOnlyRecord(lastRec) : lastRec;
    setSelection(rec, [{lo: rec.lo, hi: rec.hi}]);
  }
  // A watershed already selected is an AOI with no inlets yet, so it is adopted rather than asked
  // for again — the first click of the mode goes to an inlet instead of repeating itself.
  // A one-reach selection is not a watershed, so it is not an AOI outlet either — coming from the
  // river selector, the AOI still asks for the outlet of the area you actually mean.
  if (mode === 'aoi' && sel && !sel.reachOnly && !aoi.state().outlet) {
    const {spans: _ignored, ...rec} = sel;
    aoi.setOutlet({...rec, count: rec.hi - rec.lo + 1});
  }
}

// ── the AOI subsetter ────────────────────────────────────────────────────────
/**
 * A third thing a click can mean. Single-select answers "what drains to this reach"; the AOI
 * subsetter answers "what drains to this reach that did not come in from up there", which takes two
 * kinds of click — one for the outlet, then one per inlet. aoi.js holds the state and does the
 * arithmetic; what is here is the mode, what a click means while it is on, and the painting.
 */
/** What a click on a river means while the mode is on: the outlet first, then inlets. */
function aoiClick(at, lngLat) {
  let rec;
  try {
    rec = reachRecord(at);
  } catch (err) {
    return console.error(err);
  }
  const point = {lon: lngLat.lng, lat: lngLat.lat};
  const {outlet} = aoi.state();
  if (!outlet) {
    return aoi.setOutlet({...rec, ...point});
  }
  // A click below the outlet is not a failed inlet — it is the outlet moved down. The area only
  // grows, so the inlets stay where they were put and go on cutting the same ground.
  if (isDownstreamOf(rec, outlet)) {
    return aoi.setOutlet({...rec, ...point});
  }
  aoi.toggleInlet({...rec, ...point});
}

/** The AOI changed: repaint the card, the inlets on the map, and the selection it adds up to. */
function paintAoi() {
  const state = aoi.state();
  $('aoi-count').textContent = String(state.inlets.length);
  applyInlets(state.inlets.map(i => i.outletId));
  renderAoi($('aoi-body'), state, {
    onRemove: inlet => aoi.removeInlet(inlet.outletId),
    onZoom: inlet => flyToPick(inlet),
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
  picks.toggle(rec);
}

/** The list changed: repaint the map, the count beside the heading, and the rows. */
function paintPicks() {
  const list = picks.all();
  applyPicks(list);
  $('picks-count').textContent = String(list.length);
  renderPicks($('picks-body'), {
    onRemove: p => picks.remove(p.outletId),
    onZoom: p => flyToPick(p),
  });
  paintActions();
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
$('btn-clear').addEventListener('click', clearCurrent);
$('btn-copy').addEventListener('click', copyIds);
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

// ── the river names section ──────────────────────────────────────────────────
/**
 * Colouring the network by the river names table.
 *
 * This is a display switch, not a fourth selection method: it changes what the map is coloured by
 * and never what a click on it means, which is why it is wired on its own instead of joining
 * MODES. Its card is edged in a name colour rather than the selection orange for the same reason.
 */
function paintNames() {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const row = (swatches, label) => {
    const r = el('div', 'legend-item');
    for (const c of swatches) {
      const sw = el('span', 'swatch');
      sw.style.background = c;
      r.append(sw);
    }
    r.append(el('span', null, label));
    return r;
  };
  const n = riverNames();
  if (!n) {
    $('names-count').textContent = '';
    $('names-body').replaceChildren(el('div', 'names-hint', namesError
      ? `The names table could not be read: ${namesError}`
      : 'Loading the river names…'));
    return;
  }
  $('names-count').textContent = fmt(n.riverCount);
  $('names-body').replaceChildren(
    row(n.palette, 'Named'),
    row([n.unnamed], 'No name in the table'),
  );
}

function setNamesOn(on, {say = false} = {}) {
  if (on && !riverNames()) {
    return;
  }
  namesOn = on;
  $('names-mode').textContent = on ? 'On' : 'Off';
  $('names-mode').classList.toggle('on', on);
  $('sidebar').classList.toggle('names-on', on);
  if (on) setNamesCollapsed(false);
  applyStyle();
}

function setNamesCollapsed(collapsed) {
  $('sidebar').classList.toggle('names-collapsed', collapsed);
  $('names-collapse').replaceChildren(heroIcon(collapsed ? 'chevron-right' : 'chevron-down'));
  $('names-collapse').title = collapsed
    ? 'Expand the river names panel'
    : 'Collapse the river names panel';
}

$('names-collapse').addEventListener('click', () =>
  setNamesCollapsed(!$('sidebar').classList.contains('names-collapsed')));
$('names-mode').addEventListener('click', () => setNamesOn(!namesOn, {say: true}));

// Same guard the method keys use, so typing "n" into the styling editor stays typing.
window.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== 'n') return;
  const t = e.target;
  if (t?.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t?.tagName)) return;
  setNamesOn(!namesOn, {say: true});
});

// The switch cannot do anything until the table is here, so it says so rather than looking broken.
$('names-mode').disabled = true;
paintNames();
setNamesCollapsed(true);
loadRiverNames()
  .then(() => {
    $('names-mode').disabled = false;
    paintNames();
  })
  .catch(err => {
    namesError = err.message;
    console.warn('[names] riverNames.json could not be read', err);
    paintNames();
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

// ── the method rows ──────────────────────────────────────────────────────────
// The whole row is the switch, not just the On/Off pill in it, because the four rows are one
// control: you are picking which of them a click on the map belongs to.
for (const [name, {card}] of Object.entries(MODES)) {
  $(`${card}-head`).addEventListener('click', () => setMode(name));
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
  setMode(mode === hit[0] ? 'river' : hit[0]);
});

paintPicks();
paintAoi();
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
// What the last click selected, in the readout the four rows share.

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
    console.error(err);
  }
})();
