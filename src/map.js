/**
 * The map: basemap, v3 stream tiles, the placeholder Group boundaries, and the two highlights.
 *
 * The upstream set is painted by feature-state on the same layers that draw the network, so a
 * reach changes colour the moment its tile arrives — no second source, no re-filtering, and no
 * `in` expression over a 200k-element literal array.
 *
 * The stream layers themselves are not written here. They are compiled from the style spec
 * (streamStyle.js), starting from the default spec — which is the look this app has always had —
 * and replaced by `applyStreamStyle` whenever the style panel changes something. The base layer
 * keeps the id `streams` through all of it, because clicks, hovers and the test suite name it.
 */
import maplibregl from 'maplibre-gl';
import {PMTiles, Protocol} from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import {MAX_HIGHLIGHT, MAX_ZOOM, URLS} from './config.js';
import {BASE_LAYER_ID, COLORS, compileLayers, defaultSpec} from './streamStyle.js';
import {fmt, status} from './ui.js';

// Positron — Carto's light grey basemap. The line colours in streamStyle.js are the saturated
// mid-tones that hold up against it; the pale blues and lilacs a dark basemap invites simply vanish
// on light grey. They are also what the sidebar legend swatches use, so the two cannot drift apart.
const CARTO_LIGHT = ['a', 'b', 'c', 'd']
  .map(s => `https://${s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png`);

const GROUP = '#8b5cf6';
/** Rule layers are inserted under this one, so the selected outlet is never painted over. */
const TOP_LAYER = 'outlet';

export let map = null;
/** The tile archive, shared with the protocol the map renders through — see streamAttributes.js. */
export let archive = null;
let highlightedIds = [];
let layerOrder = [BASE_LAYER_ID];
let applied = new Map();

export async function initMap() {
  const protocol = new Protocol({metadata: true});
  // One PMTiles instance for both jobs: the protocol renders tiles through it and the style panel
  // reads its metadata for the attribute menu. Registering it here means the header and directory
  // reads are shared rather than done twice.
  archive = new PMTiles(URLS.streamsPmtiles);
  protocol.add(archive);
  maplibregl.addProtocol('pmtiles', protocol.tile);

  const streamLayers = compileLayers(defaultSpec(), {highlight: true});
  for (const l of streamLayers) applied.set(l.id, l);
  layerOrder = streamLayers.map(l => l.id);

  map = new maplibregl.Map({
    container: 'map',
    hash: 'map',
    center: [0, 20],
    zoom: 2,
    maxZoom: MAX_ZOOM,
    style: {
      version: 8,
      sources: {
        basemap: {
          type: 'raster', tiles: CARTO_LIGHT, tileSize: 256, maxzoom: 20,
          attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        },
        group: {type: 'geojson', data: URLS.groupBoundaries},
        // promoteId lifts riverId to the feature id, which is what lets the upstream highlight be
        // a feature-state lookup.
        streams: {
          type: 'vector', url: `pmtiles://${URLS.streamsPmtiles}`,
          promoteId: {streams: 'riverId'}, attribution: 'GEOGLOWS RFS v3',
        },
      },
      layers: [
        // Full opacity on the basemap: Positron is pale enough already, and dimming it only makes
        // the thin low-zoom stream lines harder to pick out.
        {id: 'basemap', type: 'raster', source: 'basemap'},
        // Hover is carried by the outline, not by the wash. A fill that jumped to 0.16 tinted every
        // stream under it — the thing the boundary is meant to help you look at — so the hovered
        // group is now barely more filled than its neighbours and clearly more drawn around.
        {
          id: 'group-fill', type: 'fill', source: 'group',
          paint: {
            'fill-color': GROUP,
            'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.07, 0.045],
          },
        },
        {
          id: 'group-line', type: 'line', source: 'group',
          paint: {
            'line-color': GROUP, 'line-dasharray': [3, 2], 'line-opacity': 0.7,
            'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 3.2, 1],
          },
        },
        ...streamLayers,
        {
          id: TOP_LAYER, type: 'line', source: 'streams', 'source-layer': 'streams',
          filter: ['==', ['get', 'riverId'], -1],
          layout: {'line-cap': 'round', 'line-join': 'round'},
          paint: {
            'line-color': COLORS.outlet,
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 3, 9, 5.5, 14, 9],
          },
        },
      ],
    },
  });

  map.addControl(new maplibregl.NavigationControl({showCompass: false}), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({unit: 'metric'}), 'bottom-left');
  await new Promise(resolve => map.on('load', resolve));
  return map;
}

// ── the styled stream layers ─────────────────────────────────────────────────
/** Every layer currently drawing the network, for `queryRenderedFeatures` and for the tests. */
export const streamLayerIds = () => layerOrder.filter(id => map?.getLayer(id));

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Apply compiled layers, changing as little as possible.
 *
 * Dragging a colour picker fires a change per frame, and removing and re-adding a layer makes
 * MapLibre re-parse every loaded tile for it. So the ids are compared first: while the rule set is
 * unchanged — which is the whole time someone is adjusting values — this only pushes the paint
 * properties that actually differ, and the map keeps up with the slider.
 */
export function applyStreamStyle(layers) {
  const ids = layers.map(l => l.id);
  if (!same(ids, layerOrder)) {
    for (const id of layerOrder) {
      if (id !== BASE_LAYER_ID && map.getLayer(id)) map.removeLayer(id);
    }
    applied = new Map(applied.has(BASE_LAYER_ID) ? [[BASE_LAYER_ID, applied.get(BASE_LAYER_ID)]] : []);
    layerOrder = ids;
  }

  for (const l of layers) {
    if (!map.getLayer(l.id)) {
      map.addLayer(l, map.getLayer(TOP_LAYER) ? TOP_LAYER : undefined);
      applied.set(l.id, l);
      continue;
    }
    const prev = applied.get(l.id) ?? {};
    if (!same(prev.filter, l.filter)) map.setFilter(l.id, l.filter ?? null);
    if (prev.minzoom !== l.minzoom || prev.maxzoom !== l.maxzoom) {
      map.setLayerZoomRange(l.id, l.minzoom ?? 0, l.maxzoom ?? 24);
    }
    for (const [k, v] of Object.entries(l.paint)) {
      if (!same(prev.paint?.[k], v)) map.setPaintProperty(l.id, k, v);
    }
    applied.set(l.id, l);
  }
}

/** The selected outlet's own line. Off when the panel is previewing the style without app state. */
export function setSelectionHighlightVisible(visible) {
  map.setLayoutProperty(TOP_LAYER, 'visibility', visible ? 'visible' : 'none');
}

// ── the upstream highlight ───────────────────────────────────────────────────
/** Paint `ids` as upstream and `outlet` as the selected reach, clearing whatever was there. */
export function applyHighlight(ids, outlet) {
  for (const id of highlightedIds) {
    map.setFeatureState({source: 'streams', sourceLayer: 'streams', id}, {up: false});
  }
  highlightedIds = [];
  map.setFilter(TOP_LAYER, ['==', ['get', 'riverId'], outlet]);

  if (ids.size > MAX_HIGHLIGHT) {
    status(`Map highlight skipped above ${fmt(MAX_HIGHLIGHT)} reaches — the subset and both ` +
      `exports are complete.`, 'info');
    return;
  }
  const t0 = performance.now();
  for (const id of ids) {
    if (id === outlet) continue;
    map.setFeatureState({source: 'streams', sourceLayer: 'streams', id}, {up: true});
    highlightedIds.push(id);
  }
  console.info(`[map] highlighted ${highlightedIds.length.toLocaleString()} reaches in ` +
    `${(performance.now() - t0).toFixed(0)}ms`);
}

export function clearHighlight() {
  for (const id of highlightedIds) {
    map.setFeatureState({source: 'streams', sourceLayer: 'streams', id}, {up: false});
  }
  highlightedIds = [];
  map.setFilter(TOP_LAYER, ['==', ['get', 'riverId'], -1]);
}

export const highlightCount = () => highlightedIds.length;

export function setGroupVisible(visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['group-fill', 'group-line']) map.setLayoutProperty(id, 'visibility', v);
}
