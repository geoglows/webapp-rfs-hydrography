/**
 * RFS Hydrography Explorer — pick a reach, take everything upstream of it, export it.
 *
 * The whole app rests on one property of the v3 network: reaches are numbered in post-order, so
 * everything upstream of a reach is the contiguous `riverIndex` range ending at it. See data.js.
 *
 * A selection begins at a clicked feature and nowhere else. The tile carries `riverIndex` and
 * `upstreamCount`, which are the subset, and `groupId`, which is the Group whose geometry file the
 * export opens — so a click makes no request of any kind. Nothing is read at boot either: the app
 * opens the map and waits. The export reads the Group's own two published geometry files and
 * nothing else — `streams_<group>.geo.parquet` and `catchments_<group>.geo.parquet` — and it reads
 * them in a worker. There is no index file any more, and no parquet on the main thread at all.
 */
import './style.css';
import {URLS, V3_BASE} from './config.js';
import {upstreamRange} from './data.js';
import {applyHighlight, applyStreamStyle, archive, clearHighlight, currentSelection, initMap, layersVisible, map, setGroupHover, setLayersVisible, setSelectionHighlightVisible, streamLayerIds,} from './map.js';
import {compileLayers} from './streamStyle.js';
import {loadStreamAttributes} from './streamAttributes.js';
import {createStylePanel} from './stylePanel.js';
import {downloadGeometry} from './geometry.js';
import {clearStatus, fmt, progress, progressHistory, stageHistory, stages, status} from './ui.js';

/**
 * The current subset: an outlet and an index range, never a list of ids.
 *
 * `sel` is what a selection *is* now — `{outletId, riverIndex, upstreamCount, lo, hi, count,
 * groupId}`. No list of ids is ever built: the index range is printed in the selection box, and
 * the exported files carry `riverId` on every row for anyone who wants the ids themselves.
 */
let sel = null;
let hoverGroupIds = [];
let stylePanel = null;

const $ = id => document.getElementById(id);

// ── selection ────────────────────────────────────────────────────────────────
/**
 * Select a clicked reach and everything upstream of it.
 *
 * `at` is the reach's own tile properties, and that is the entire input: `riverIndex` and
 * `upstreamCount` are the subset, `groupId` is the geometry file the export opens, `strahlerOrder`
 * is the readout. Nothing is looked up and nothing is fetched — the whole function is arithmetic,
 * which is why it is synchronous.
 */
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

/**
 * The selection box: how many reaches, and where they drain to.
 *
 * The index range is printed alongside the count because it *is* the subset — two numbers anyone
 * can carry into a query against the same data, and the thing to quote when a subset looks wrong.
 */
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

// The export button tracks whether a selection exists, not whether the last click succeeded — a
// click on empty water after a good subset must not strand the user with a selection on screen
// they cannot export.
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
/**
 * The panel edits a spec; this compiles it against the app's own state and hands the layers to the
 * map. Nothing else knows how a rule becomes a layer.
 *
 * Called on every selection change too, not only on edits: the highlight colours and the
 * selection-scoped fade are compiled *into* the layers, so a new subset is a new compile. When
 * nothing about the result differs the map's own diff finds no change to push, so it costs nothing.
 */
function applyStyle() {
  if (!stylePanel || !map) return;
  const spec = stylePanel.getSpec();
  const {highlight} = stylePanel.options();
  applyStreamStyle(compileLayers(spec, {highlight, selection: currentSelection()}));
  setSelectionHighlightVisible(highlight);
  // The legend swatch describes the network's colour, so it follows the base style rather than
  // going quietly stale the first time someone changes it.
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

/**
 * How many reaches each layer is actually drawing right now.
 *
 * A rule that matches nothing looks exactly like a rule whose colour is wrong, and this is the
 * difference. It is one query for all the stream layers on map idle, tallied by layer — the counts
 * are approximate because a reach crossing a tile boundary is returned once per tile, which is why
 * the panel prints them with a "≈". If the query ever costs more than a frame's worth of time on a
 * dense view, it stops running rather than making the map feel heavy: a nicety must not become a
 * tax on panning.
 */
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
function clearGroupHover() {
  setGroupHover([]);
  hoverGroupIds = [];
}

/**
 * The pointer, and the Group outline under it.
 *
 * There is no readout to fill any more, so the hover is purely what the map shows: a pointer over
 * anything clickable, and the boundary under the cursor drawn a little harder than its neighbours.
 * A boundary polygon is tiled, so one Group comes back once per tile under the cursor and the ids
 * are deduped — the hover state is keyed by them and wants each one once.
 */
function onMapHover(e) {
  // Every layer the style compiled to, not just the base one — a reach claimed by a rule is drawn
  // by that rule's layer and would be invisible to a query naming only `streams`.
  const stream = map.queryRenderedFeatures(e.point, {layers: streamLayerIds()})[0];
  map.getCanvas().style.cursor = stream ? 'pointer' : '';

  const ids = [...new Set(map.queryRenderedFeatures(e.point, {layers: ['group-fill']})
    .map(f => f.id).filter(id => id != null))];
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
// The export runs for as long as two files take, so the button goes with it: `onSettled` fires
// whether it finished, failed or refused to start, which is what makes disabling it here safe.
$('btn-geoparquet').addEventListener('click', () => {
  if (!sel) return;
  setBusy(true);
  downloadGeometry({
    groupId: sel.groupId, outletId: sel.outletId, lo: sel.lo, hi: sel.hi, count: sel.count,
    onSettled: () => setBusy(false),
  });
});
/**
 * The styling panel, folded or open — the class, the glyph and the tooltip in one place, because
 * all three have to agree and the starting state is set the same way a click is.
 *
 * It starts folded. The panel is an editor and the map is what someone came for: collapsed it is
 * the legend and one chevron, and expanding it is one click for the people who want it. Nothing
 * about it is deferred by folding it — the spec is compiled and the layers are on the map either
 * way, so what opens is already in step with what is drawn.
 */
function setStyleCollapsed(collapsed) {
  $('panel-right').classList.toggle('style-collapsed', collapsed);
  $('style-collapse').textContent = collapsed ? '▸' : '▾';
  $('style-collapse').title = collapsed ? 'Expand the styling panel' : 'Collapse the styling panel';
}

$('style-collapse').addEventListener('click', () =>
  setStyleCollapsed(!$('panel-right').classList.contains('style-collapsed')));
setStyleCollapsed(true);

/**
 * The layer checkboxes, which are a view of the map and not a record of anything.
 *
 * Each box names its layers in `data-layers`, so the legend row *is* the wiring — one delegated
 * listener covers however many rows the HTML has, and adding a layer to the panel needs no change
 * here. The boxes are then set from what those layers are actually doing, so the starting state is
 * declared once, in the style, and never risks disagreeing with the mark in the box.
 */
const layerBoxes = () => [...$('layer-toggles').querySelectorAll('input[type=checkbox]')];
const layersOf = box => box.dataset.layers.split(' ');

$('layer-toggles').addEventListener('change', e => {
  setLayersVisible(layersOf(e.target), e.target.checked);
});

let ready = false;

(async () => {
  try {
    console.info(`[explorer] v3 base ${V3_BASE}`);
    progress.begin('Loading the map');
    const m = await initMap();
    m.on('click', onMapClick);
    m.on('mousemove', onMapHover);
    m.on('mouseout', clearGroupHover);
    for (const box of layerBoxes()) box.checked = layersVisible(layersOf(box));

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

// A way into the running app from the browser console: select an outlet, read the current style,
// see which layers the spec compiled to, replay the progress history. One named namespace rather
// than a scattering of globals, so what is exposed is legible from here and nothing else leaks.
window.__explorer = {
  selectOutlet, upstreamRange, URLS,
  get ready() {
    return ready;
  },
  get style() {
    return stylePanel;
  },
  get styleLayers() {
    return streamLayerIds();
  },
  get progressHistory() {
    return progressHistory;
  },
  get stageHistory() {
    return stageHistory;
  },
  get map() {
    return map;
  },
  get selection() {
    return sel;
  },
  get outletId() {
    return sel?.outletId ?? null;
  },
  get outletGroup() {
    return sel?.groupId ?? null;
  },
};
