import './style.css';
import maplibregl from 'maplibre-gl';
import {URLS, V3_BASE} from './config.js';
import {upstreamRange} from './data.js';
import {applyHighlight, applyStreamStyle, archive, BASEMAPS, clearHighlight, currentBasemap, currentSelection, hoverRegions, initMap, layersPresent, layersVisible, map, regionsAt, setBasemap, setLayersVisible, setSelectionHighlightVisible, streamLayerIds,} from './map.js';
import {compileLayers} from './streamStyle.js';
import {loadStreamAttributes} from './streamAttributes.js';
import {createStylePanel} from './stylePanel.js';
import {downloadGeometry} from './geometry.js';
import {clearStatus, fmt, progress, progressHistory, stageHistory, stages, status} from './ui.js';
import {heroIcon} from './icons.js';

let sel = null;
let stylePanel = null;
let regionPopup = null;

const $ = id => document.getElementById(id);

// ── selection ────────────────────────────────────────────────────────────────
function selectOutlet(at) {
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);
  const riverId = num(at.riverId);
  const riverIndex = num(at.riverIndex);
  const upstreamCount = num(at.upstreamCount);
  clearStatus();
  try {
    if (riverId == null || riverIndex == null || upstreamCount == null) {
      throw new Error('That reach is missing riverId, riverIndex or upstreamCount — the tiles it ' +
        'came from cannot describe a subset');
    }
    const range = upstreamRange({riverIndex, upstreamCount});
    sel = {
      outletId: riverId,
      riverIndex: range.hi,
      upstreamCount,
      lo: range.lo,
      hi: range.hi,
      count: range.count,
      groupId: num(at.groupId),
      strahlerOrder: num(at.strahlerOrder),
    };
    applyHighlight({lo: sel.lo, hi: sel.hi}, riverId, applyStyle);
    renderSelectionInfo();
    selectionChanged();
    setBusy(false);
    status(`${fmt(sel.count)} reaches selected` +
      (sel.groupId != null ? ` · Group ${sel.groupId}` : ''), 'success');
  } catch (err) {
    status(err.message, 'error');
    console.error(err);
  }
}

function renderSelectionInfo() {
  const el = $('selection-info');
  const n = sel.count;
  el.style.display = 'block';
  el.innerHTML =
    `<span class="count">${fmt(n)}</span> <span class="k">stream${n === 1 ? '' : 's'} selected</span>` +
    `<br><span class="k">outlet</span> <span class="outlet">${sel.outletId}</span>` +
    (sel.strahlerOrder != null ? ` <span class="k">ord</span> ${sel.strahlerOrder}` : '') +
    (sel.groupId != null ? ` <span class="k">group</span> <span class="group">${sel.groupId}</span>` : '') +
    `<br><span class="k">riverIndex</span> ${fmt(sel.lo)}&ndash;${fmt(sel.hi)}`;
}

function setBusy(busy) {
  $('btn-geoparquet').disabled = busy || sel === null;
}

function clearSelection() {
  sel = null;
  clearHighlight(applyStyle);
  $('selection-info').style.display = 'none';
  $('btn-geoparquet').disabled = true;
  clearStatus();
  progress.hide();
  stages.hide();
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

// ── map interactions ─────────────────────────────────────────────────────────
function onMapHover(e) {
  const stream = map.queryRenderedFeatures(e.point, {layers: streamLayerIds()})[0];
  map.getCanvas().style.cursor = stream ? 'pointer' : '';
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
  // The feature is the selection: outlet, index, upstream count and Group all come off it.
  selectOutlet(p);
}

// ── boot ─────────────────────────────────────────────────────────────────────
$('btn-clear').addEventListener('click', clearSelection);
$('btn-geoparquet').addEventListener('click', () => {
  if (!sel) return;
  setBusy(true);
  downloadGeometry({
    groupId: sel.groupId, outletId: sel.outletId, lo: sel.lo, hi: sel.hi, count: sel.count,
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

const layerBoxes = () => [...$('layer-toggles').querySelectorAll('input[type=checkbox]')];
const layersOf = box => box.dataset.layers.split(' ');

$('layer-toggles').addEventListener('change', e => {
  setLayersVisible(layersOf(e.target), e.target.checked);
});

const MISSING = 'These tiles are not published in this dataset, so the layer is not on the map.';

function syncLayerBoxes() {
  for (const box of layerBoxes()) {
    const ids = layersOf(box);
    const present = layersPresent(ids);
    box.checked = present && layersVisible(ids);
    box.disabled = !present;
    const row = box.closest('.legend-item');
    row.classList.toggle('unavailable', !present);
    const label = row.querySelector('label');
    if (!present && label) label.title = label.title ? `${label.title}\n\n${MISSING}` : MISSING;
  }
}

const basemapSelect = $('basemap-select');
basemapSelect.replaceChildren(...BASEMAPS.map(b => {
  const o = document.createElement('option');
  o.value = b.id;
  o.textContent = b.label;
  return o;
}));
basemapSelect.addEventListener('change', e => setBasemap(e.target.value));

let ready = false;

(async () => {
  try {
    console.info(`[explorer] v3 base ${V3_BASE}`);
    progress.begin('Loading the map');
    const m = await initMap();
    m.on('click', onMapClick);
    m.on('mousemove', onMapHover);
    m.on('mouseout', () => hoverRegions(null));
    syncLayerBoxes();
    basemapSelect.value = currentBasemap();

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
