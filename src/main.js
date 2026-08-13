import './style.css';
import {URLS, V3_BASE} from './config.js';
import {upstreamRange} from './data.js';
import {applyHighlight, applyStreamStyle, archive, BASEMAPS, clearHighlight, currentBasemap, currentSelection, initMap, layersPresent, layersVisible, map, setBasemap, setGroupHover, setLayersVisible, setSelectionHighlightVisible, streamLayerIds,} from './map.js';
import {compileLayers} from './streamStyle.js';
import {loadStreamAttributes} from './streamAttributes.js';
import {createStylePanel} from './stylePanel.js';
import {downloadGeometry} from './geometry.js';
import {clearStatus, fmt, progress, progressHistory, stageHistory, stages, status} from './ui.js';

let sel = null;
let hoverGroupIds = [];
let stylePanel = null;

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
/** The Group boundary layer, if this dataset published one. Set from the map at boot. */
let groupHoverLayers = [];

function clearGroupHover() {
  setGroupHover([]);
  hoverGroupIds = [];
}

function onMapHover(e) {
  const stream = map.queryRenderedFeatures(e.point, {layers: streamLayerIds()})[0];
  map.getCanvas().style.cursor = stream ? 'pointer' : '';

  const ids = groupHoverLayers.length
    ? [...new Set(map.queryRenderedFeatures(e.point, {layers: groupHoverLayers})
      .map(f => f.id).filter(id => id != null))]
    : [];
  if (ids.join() !== hoverGroupIds.join()) {
    setGroupHover(ids);
    hoverGroupIds = ids;
  }
}

function onMapClick(e) {
  const hits = map.queryRenderedFeatures(
    [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], {layers: streamLayerIds()});
  if (!hits.length) return;
  const p = hits[0].properties;
  if (p.riverId == null) return;
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
function setStyleCollapsed(collapsed) {
  $('panel-right').classList.toggle('style-collapsed', collapsed);
  $('style-collapse').textContent = collapsed ? '▸' : '▾';
  $('style-collapse').title = collapsed ? 'Expand the styling panel' : 'Collapse the styling panel';
}

$('style-collapse').addEventListener('click', () =>
  setStyleCollapsed(!$('panel-right').classList.contains('style-collapsed')));
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
    m.on('mouseout', clearGroupHover);
    syncLayerBoxes();
    groupHoverLayers = layersPresent(['group-fill']) ? ['group-fill'] : [];
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
