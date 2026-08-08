/**
 * RFS Hydrography Explorer — pick a reach, take everything upstream of it, export it.
 *
 * The whole app rests on one property of the v3 network: a Group (`groupId`) is assigned by
 * `outletRiverId`, so every reach in a terminal watershed shares one and an upstream walk cannot
 * leave the Group it started in. That is why a subset needs exactly one metadata file, and why
 * the Group boundaries are worth drawing — they are the index to which file to open.
 */
import './style.css';
import {DEEP_LINK_RIVER, URLS, V3_BASE} from './config.js';
import {candidateGroups, getGroupIndex, groupInfo, isLoaded, loadedGroupIds, loadGroupIndex, loadGroupNetwork,} from './data.js';
import {applyHighlight, applyStreamStyle, archive, clearHighlight, highlightCount, initMap, map, setGroupVisible, setSelectionHighlightVisible, streamLayerIds,} from './map.js';
import {compileLayers} from './streamStyle.js';
import {loadStreamAttributes} from './streamAttributes.js';
import {createStylePanel} from './stylePanel.js';
import {downloadGeometry} from './geometry.js';
import {clearStatus, fmt, mb, progress, progressHistory, stageHistory, stages, status} from './ui.js';

let outletId = null;
let outletGroup = null;
let selectedIds = null;
let hoverGroupIds = [];
let stylePanel = null;

const $ = id => document.getElementById(id);

// ── selection ────────────────────────────────────────────────────────────────
async function selectOutlet(riverId, {groupId = null, lngLat = null, fly = false} = {}) {
  if (!Number.isInteger(riverId) || riverId <= 0) {
    status(`"${riverId}" is not a River ID — expected a positive whole number`, 'error');
    return;
  }
  $('input-id').value = String(riverId);
  setBusy(true);
  clearStatus();
  progress.begin(`Looking up ${riverId}`);
  try {
    // A map click already knows the Group — the tiles carry groupId per reach. A typed id does not.
    let conn = null;
    if (groupId != null && Number.isFinite(groupId)) {
      conn = await loadGroupNetwork(groupId);
      if (!conn.network.has(riverId)) conn = null;
    }
    if (!conn) {
      // Three distinct ways a typed id can fail, and saying which one it was is the difference
      // between "you mistyped the region digits" and "that reach was simplified out of v3".
      const {prefix, inRegion, candidates} = candidateGroups(riverId, lngLat || map.getCenter());
      if (!inRegion.length) {
        progress.hide();
        status(`No Group carries the id prefix ${prefix}. v3 riverIds start with one of the ` +
          `50 two-digit TDX-Hydro region codes.`, 'error');
        return;
      }
      if (!candidates.length) {
        progress.hide();
        status(`${riverId} falls outside the id range of all ${inRegion.length} Group(s) in TDX ` +
          `region ${inRegion[0].tdxHydroRegion} — not in the v3 network.`, 'error');
        return;
      }
      for (const c of candidates) {
        const candidate = await loadGroupNetwork(c.groupId);
        if (candidate.network.has(riverId)) {
          conn = candidate;
          break;
        }
      }
      if (!conn) {
        progress.hide();
        status(`River ${riverId} is not in the v3 network.`, 'error');
        return;
      }
    }

    progress.set(96, {phase: 'Tracing upstream', detail: `from Group ${conn.groupId}`});
    const ids = conn.network.upstreamOf(riverId);

    outletId = riverId;
    outletGroup = conn.groupId;
    selectedIds = ids;
    applyHighlight(ids, riverId);
    renderSelectionInfo(conn);
    selectionChanged();

    const at = lngLat || conn.attrs.get(riverId);
    if (at && fly) {
      map.flyTo({center: [at.lng ?? at.lon, at.lat], zoom: Math.max(map.getZoom(), 8), duration: 900});
    }
    progress.finish(`${fmt(ids.size)} reaches selected`, `Group ${conn.groupId}`);
  } catch (err) {
    progress.hide();
    status(err.message, 'error');
    console.error(err);
  } finally {
    setBusy(false);
  }
}

/**
 * The selection box: how many reaches, and where they drain to.
 *
 * The count, the outlet and the Group are what a subset is identified by. There is no preview of
 * the ids themselves — forty of two hundred thousand answered no question the count did not, and
 * the file is one click away for anyone who wants to look at them.
 */
function renderSelectionInfo(conn) {
  const el = $('selection-info');
  const m = conn.attrs.get(outletId) || {};
  const n = selectedIds.size;
  el.style.display = 'block';
  el.innerHTML =
    `<span class="count">${fmt(n)}</span> <span class="k">stream${n === 1 ? '' : 's'} selected</span>` +
    `<br><span class="k">outlet</span> <span class="outlet">${outletId}</span>` +
    (m.strahlerOrder != null ? ` <span class="k">ord</span> ${m.strahlerOrder}` : '') +
    ` <span class="k">group</span> <span class="group">${outletGroup}</span>`;
}

// The export buttons track whether a selection exists, not whether the last lookup succeeded — a
// typo after a good subset must not strand the user with a selection on screen they cannot export.
function setBusy(busy) {
  $('input-id').disabled = busy;
  const exportable = !busy && selectedIds !== null;
  for (const id of ['btn-download', 'btn-copy', 'btn-geoparquet']) $(id).disabled = !exportable;
}

// ── exports ──────────────────────────────────────────────────────────────────
// Ascending rather than BFS order so two runs of the same outlet produce identical files and a
// diff between two subsets means something.
const subsetText = () => [...selectedIds].sort((a, b) => a - b).join('\n') + '\n';

function downloadList() {
  if (!selectedIds) return;
  const name = `rfs_v3_group${outletGroup}_${outletId}_riverids.txt`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([subsetText()], {type: 'text/plain'}));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  status(`Saved ${name} — ${fmt(selectedIds.size)} ids`, 'success');
}

async function copyList() {
  if (!selectedIds) return;
  try {
    await navigator.clipboard.writeText(subsetText());
    status(`Copied ${fmt(selectedIds.size)} river IDs to the clipboard`, 'success');
  } catch (err) {
    status(`Clipboard blocked (${err.message}) — use Download instead`, 'error');
  }
}

function clearSelection() {
  clearHighlight();
  outletId = null;
  outletGroup = null;
  selectedIds = null;
  $('input-id').value = '';
  $('selection-info').style.display = 'none';
  for (const id of ['btn-download', 'btn-copy', 'btn-geoparquet']) $(id).disabled = true;
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
  applyStreamStyle(compileLayers(spec, {highlight, outletId, hasSelection: selectedIds !== null}));
  setSelectionHighlightVisible(highlight);
  // The legend swatch describes the network's colour, so it follows the base style rather than
  // going quietly stale the first time someone changes it.
  const base = spec.base.color[0]?.value;
  if (base) document.documentElement.style.setProperty('--stream', base);
}

const selectionForStyle = () => (selectedIds
  ? {outletId, groupId: outletGroup, count: selectedIds.size}
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
  for (const id of hoverGroupIds) map.setFeatureState({source: 'group', id}, {hover: false});
  hoverGroupIds = [];
}

function onMapHover(e) {
  // Every layer the style compiled to, not just the base one — a reach claimed by a rule is drawn
  // by that rule's layer and would be invisible to a query naming only `streams`.
  const stream = map.queryRenderedFeatures(e.point, {layers: streamLayerIds()})[0];
  map.getCanvas().style.cursor = stream ? 'pointer' : '';

  const ids = map.queryRenderedFeatures(e.point, {layers: ['group-fill']})
    .map(f => f.id).filter(id => id != null);
  if (ids.join() !== hoverGroupIds.join()) {
    clearGroupHover();
    for (const id of ids) map.setFeatureState({source: 'group', id}, {hover: true});
    hoverGroupIds = ids;
  }
  renderGroupReadout(ids, stream);
}

function renderGroupReadout(ids, stream) {
  const el = $('group-readout');
  // A reach knows its own Group from the tile attribute; the polygons are the reference layer, and
  // where they overlap (they are hulls, so they do near the edges) the reach's own groupId wins.
  const streamGroup = stream?.properties?.groupId;
  const shown = streamGroup != null ? [streamGroup] : ids;
  if (!shown.length) {
    el.innerHTML = '<span class="hint">Hover the map.</span>';
    return;
  }
  el.innerHTML = shown.map(id => {
      const v = groupInfo(id);
      return `<div><span class="id">Group ${id}</span>` +
        (isLoaded(id) ? ' <span class="loaded">&#9679; loaded</span>' : '') +
        (v ? `<br>${fmt(v.reachCount)} reaches &middot; ${mb(v.networkBytes ?? v.metadataBytes)}` +
          `<br><span class="hint">TDX ${v.tdxHydroRegion}</span>` : '') +
        `<span class="file">metadata_${id}.parquet</span></div>`;
    }).join('<hr style="border:none;border-top:1px solid var(--border);margin:8px 0">') +
    (streamGroup != null && ids.length > 1
      ? `<div class="hint" style="margin-top:6px">${ids.length} placeholder hulls overlap here; the reach's own groupId decides.</div>`
      : '');
}

async function onMapClick(e) {
  const hits = map.queryRenderedFeatures(
    [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], {layers: streamLayerIds()});
  if (!hits.length) return;
  const p = hits[0].properties;
  if (p.riverId == null) return;
  await selectOutlet(Number(p.riverId), {groupId: Number(p.groupId), lngLat: e.lngLat});
}

// ── boot ─────────────────────────────────────────────────────────────────────
$('input-id').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const v = e.target.value.trim();
  if (v) selectOutlet(Number(v), {fly: true});
});
$('btn-download').addEventListener('click', downloadList);
$('btn-copy').addEventListener('click', copyList);
$('btn-clear').addEventListener('click', clearSelection);
$('btn-geoparquet').addEventListener('click', () => downloadGeometry({
  groupId: outletGroup, outletId, ids: selectedIds, onSettled: () => setBusy(false),
}));
$('toggle-group').addEventListener('change', e => setGroupVisible(e.target.checked));
$('style-collapse').addEventListener('click', () => {
  const collapsed = $('panel-right').classList.toggle('style-collapsed');
  $('style-collapse').textContent = collapsed ? '▸' : '▾';
  $('style-collapse').title = collapsed ? 'Expand the styling panel' : 'Collapse the styling panel';
});

let ready = false;

(async () => {
  try {
    console.info(`[explorer] v3 base ${V3_BASE}`);
    progress.begin('Loading network index');
    const [m] = await Promise.all([initMap(), loadGroupIndex()]);
    m.on('click', onMapClick);
    m.on('mousemove', onMapHover);
    m.on('mouseout', clearGroupHover);

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
    // The attribute menu is the tiles' own metadata, so it arrives after the map does and the panel
    // is usable (presets, base style) in the meantime.
    loadStreamAttributes(archive).then(info => stylePanel.setAttributes(info));

    const meta = getGroupIndex().meta;
    progress.hide();
    ready = true;
    status(`${meta.groupCount} Groups · ${fmt(meta.reachCount)} reaches. ` +
      `Click a river, or type a River ID.`, '');
    if (DEEP_LINK_RIVER) await selectOutlet(Number(DEEP_LINK_RIVER), {fly: true});
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
  selectOutlet, subsetText, loadGroupNetwork, candidateGroups, URLS,
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
  get groupIndex() {
    return getGroupIndex();
  },
  get loadedGroups() {
    return loadedGroupIds();
  },
  get selectedIds() {
    return selectedIds;
  },
  get highlightedCount() {
    return highlightCount();
  },
  get outletId() {
    return outletId;
  },
  get outletGroup() {
    return outletGroup;
  },
};
