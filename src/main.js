/**
 * RFS Hydrography Explorer — pick a reach, take everything upstream of it, export it.
 *
 * The whole app rests on one property of the v3 network: a Group (`groupId`) is assigned by
 * `outletRiverId`, so every reach in a terminal watershed shares one and an upstream walk cannot
 * leave the Group it started in. That is why a subset needs exactly one metadata file, and why
 * the Group boundaries are worth drawing — they are the index to which file to open.
 */
import './style.css';
import {DEEP_LINK_RIVER, FULL_DETAIL_ZOOM, URLS, V3_BASE} from './config.js';
import {
  candidateGroups, getGroupIndex, isLoaded, loadGroupNetwork, loadedGroupIds, loadGroupIndex, groupInfo,
} from './data.js';
import {applyHighlight, clearHighlight, highlightCount, initMap, map, setGroupVisible} from './map.js';
import {downloadGeometry} from './geometry.js';
import {clearStatus, fmt, mb, progress, progressHistory, status} from './ui.js';

/** How many riverIds the selection box lists before it summarises the rest. */
const ID_PREVIEW = 40;

let outletId = null;
let outletGroup = null;
let selectedIds = null;
let hoverGroupIds = [];

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
 * The selection box: how many reaches, and which.
 *
 * The id preview is the one thing the running log was genuinely useful for — a sanity check that
 * the selection is the reaches you meant. Sorted the same way the export is, so what is on screen
 * is the head of the file you are about to download rather than a different arbitrary order.
 */
function renderSelectionInfo(conn) {
  const el = $('selection-info');
  const m = conn.attrs.get(outletId) || {};
  const n = selectedIds.size;
  const sorted = [...selectedIds].sort((a, b) => a - b);
  const head = sorted.slice(0, ID_PREVIEW);
  const zoomNote = map.getZoom() < FULL_DETAIL_ZOOM
    ? `<br><span class="k">below z${FULL_DETAIL_ZOOM} the tiles hide small reaches &mdash; the count is still complete</span>`
    : '';
  el.style.display = 'block';
  el.innerHTML =
    `<span class="count">${fmt(n)}</span> <span class="k">stream${n === 1 ? '' : 's'} selected</span>` +
    `<br><span class="k">outlet</span> <span class="outlet">${outletId}</span>` +
    (m.strahlerOrder != null ? ` <span class="k">ord</span> ${m.strahlerOrder}` : '') +
    ` <span class="k">group</span> <span class="group">${outletGroup}</span>` +
    zoomNote +
    `<div class="ids">${head.join(' ')}` +
    (n > head.length ? `<span class="more">+ ${fmt(n - head.length)} more</span>` : '') +
    `</div>`;
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
}

// ── map interactions ─────────────────────────────────────────────────────────
function clearGroupHover() {
  for (const id of hoverGroupIds) map.setFeatureState({source: 'group', id}, {hover: false});
  hoverGroupIds = [];
}

function onMapHover(e) {
  const stream = map.queryRenderedFeatures(e.point, {layers: ['streams']})[0];
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
    [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]], {layers: ['streams']});
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

let ready = false;

(async () => {
  try {
    console.info(`[explorer] v3 base ${V3_BASE}`);
    progress.begin('Loading network index');
    const [m] = await Promise.all([initMap(), loadGroupIndex()]);
    m.on('click', onMapClick);
    m.on('mousemove', onMapHover);
    m.on('mouseout', clearGroupHover);
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

// tests/explorer.test.mjs drives the real app in a browser, so it needs a way in. One named
// namespace rather than a scattering of globals, so what the tests depend on is legible from here
// and nothing else leaks.
window.__explorer = {
  selectOutlet, subsetText, loadGroupNetwork, candidateGroups, URLS,
  get ready() { return ready; },
  get progressHistory() { return progressHistory; },
  get map() { return map; },
  get groupIndex() { return getGroupIndex(); },
  get loadedGroups() { return loadedGroupIds(); },
  get selectedIds() { return selectedIds; },
  get highlightedCount() { return highlightCount(); },
  get outletId() { return outletId; },
  get outletGroup() { return outletGroup; },
};
