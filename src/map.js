import maplibregl from 'maplibre-gl';
import {PMTiles, Protocol} from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import {MAX_ZOOM, URLS} from './config.js';
import {BASE_LAYER_ID, COLORS, compileLayers, defaultSpec, inRangeExpr} from './streamStyle.js';

const CARTO_LIGHT = ['a', 'b', 'c', 'd'].map(s => `https://${s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png`);

const GROUP_SOURCE = 'group';
const GROUP = '#8b5cf6';
let groupLayer = 'groups';
let groupIdField = 'groupId';
let hovered = [];


async function readGroupArchive() {
  try {
    const md = await new PMTiles(URLS.groupsPmtiles).getMetadata();
    const layer = md?.vector_layers?.[0];
    if (!layer) return;
    groupLayer = layer.id;
    const fields = Object.keys(layer.fields ?? {});
    groupIdField = ['groupId', 'group_id', 'group', 'id'].find(f => fields.includes(f))
      ?? fields[0] ?? groupIdField;
    console.info(`[map] groups.pmtiles: layer "${groupLayer}", Group id from "${groupIdField}"`);
  } catch (err) {
    console.warn(`[map] could not read groups.pmtiles metadata (${err.message}) — ` +
      `assuming layer "${groupLayer}" keyed by "${groupIdField}"`);
  }
}

/** Rule layers are inserted under this one, so the selected outlet is never painted over. */
const TOP_LAYER = 'outlet';

const CATCHMENT_SOURCE = 'catchments';
const CATCHMENT_FILL_LAYER = 'catchments';
const CATCHMENT_LINE_LAYER = 'catchment_lines';
const CATCHMENT = '#D55E00';
const CATCHMENT_EDGE = '#000000';
const CATCHMENT_OPACITY = 0.16;
const CATCHMENT_UP_OPACITY = 0.32;

export let map = null;
export let archive = null;
let layerOrder = [BASE_LAYER_ID];
let applied = new Map();

export async function initMap() {
  const protocol = new Protocol({metadata: true});
  archive = new PMTiles(URLS.streamsPmtiles);
  protocol.add(archive);
  maplibregl.addProtocol('pmtiles', protocol.tile);
  await readGroupArchive();

  const streamLayers = compileLayers(defaultSpec(), {highlight: true});
  for (const l of streamLayers) applied.set(l.id, l);
  layerOrder = streamLayers.map(l => l.id);

  map = new maplibregl.Map({
    container: 'map',
    hash: 'map',
    center: [0, 20],
    zoom: 2,
    maxZoom: MAX_ZOOM,
    // Flat, north-up, and no way out of it. This is a map for reading a network off, not a scene:
    // a tilted view foreshortens the upstream lines it exists to show and puts the far half of the
    // canvas at a scale the bar in the corner no longer describes. `maxPitch: 0` is the one that
    // actually forces it — the handlers below are what stop a drag or a keypress from asking.
    pitch: 0,
    bearing: 0,
    maxPitch: 0,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    style: {
      version: 8,
      sources: {
        basemap: {
          type: 'raster', tiles: CARTO_LIGHT, tileSize: 256, maxzoom: 20,
          attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
        },
        [GROUP_SOURCE]: {
          type: 'vector', url: `pmtiles://${URLS.groupsPmtiles}`,
          promoteId: {[groupLayer]: groupIdField}, attribution: 'GEOGLOWS RFS v3',
        },
        [CATCHMENT_SOURCE]: {
          type: 'vector', url: `pmtiles://${URLS.catchmentsPmtiles}`,
          attribution: 'GEOGLOWS RFS v3',
        },
        streams: {
          type: 'vector', url: `pmtiles://${URLS.streamsPmtiles}`,
          promoteId: {streams: 'riverId'}, attribution: 'GEOGLOWS RFS v3',
        },
      },
      layers: [
        {id: 'basemap', type: 'raster', source: 'basemap'},
        {
          id: 'catchment-fill', type: 'fill', source: CATCHMENT_SOURCE,
          'source-layer': CATCHMENT_FILL_LAYER,
          layout: {visibility: 'none'},
          paint: {'fill-color': CATCHMENT, 'fill-opacity': CATCHMENT_OPACITY},
        },
        {
          id: 'catchment-outlet', type: 'fill', source: CATCHMENT_SOURCE,
          'source-layer': CATCHMENT_FILL_LAYER,
          layout: {visibility: 'none'},
          filter: ['==', ['get', 'riverId'], -1],
          paint: {'fill-color': COLORS.outlet, 'fill-opacity': 0.35},
        },
        {
          id: 'catchment-line', type: 'line', source: CATCHMENT_SOURCE,
          'source-layer': CATCHMENT_LINE_LAYER,
          layout: {visibility: 'none'},
          paint: {
            'line-color': CATCHMENT_EDGE,
            'line-opacity': 0.55,
            'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.9, 10, 1.6, 14, 2.6],
          },
        },
        {
          id: 'group-fill', type: 'fill', source: GROUP_SOURCE, 'source-layer': groupLayer,
          paint: {
            'fill-color': GROUP,
            'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.07, 0.045],
          },
        },
        {
          id: 'group-line', type: 'line', source: GROUP_SOURCE, 'source-layer': groupLayer,
          paint: {
            'line-color': GROUP, 'line-opacity': 0.7,
            'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 5, 2.2],
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

  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  const northUp = () => {
    if (map.getBearing()) map.setBearing(0);
  };
  map.on('rotate', northUp);
  northUp();
  map.addControl(new maplibregl.NavigationControl({showCompass: false}), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({unit: 'metric'}), 'bottom-left');
  await new Promise(resolve => map.on('load', resolve));
  return map;
}

// ── the styled stream layers ─────────────────────────────────────────────────
/** Every layer currently drawing the network, for `queryRenderedFeatures` and for the tests. */
export const streamLayerIds = () => layerOrder.filter(id => map?.getLayer(id));

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

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

// ── layer visibility ─────────────────────────────────────────────────────────
export function setLayersVisible(ids, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
}

export const layersVisible = ids =>
  ids.some(id => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');

// ── the upstream highlight ───────────────────────────────────────────────────
let selection = null;

export const currentSelection = () => selection;

/** Select `outlet` and everything in `range`; `onStyle` recompiles the stream layers around it. */
export function applyHighlight(range, outlet, onStyle) {
  selection = range ? {...range, outlet} : null;
  map.setFilter(TOP_LAYER, ['==', ['get', 'riverId'], outlet ?? -1]);
  onStyle?.();
  syncCatchmentHighlight();
}

export function clearHighlight(onStyle) {
  applyHighlight(null, null, onStyle);
}

// ── the catchments ───────────────────────────────────────────────────────────
/**
 * The catchments follow the selection the same way the streams do — the same range expression,
 * pushed as two paint properties whenever the selection changes.
 *
 * This is where the leaf tiles have to catch up. They carry `riverId` but not yet `riverIndex`, and
 * `inRangeExpr` guards on `["has", "riverIndex"]`, so the expression is simply false against
 * today's archive and the catchments stay the neutral wash. Adding `riverIndex` alongside the
 * `riverId` already there — the same field the aggregate levels need for their outlet reach — turns
 * this on at every zoom with no change here.
 */
function syncCatchmentHighlight() {
  if (!map?.getLayer('catchment-fill')) return;
  const up = selection ? inRangeExpr(selection) : null;
  map.setPaintProperty('catchment-fill', 'fill-color',
    up ? ['case', up, COLORS.upstream, CATCHMENT] : CATCHMENT);
  map.setPaintProperty('catchment-fill', 'fill-opacity',
    up ? ['case', up, CATCHMENT_UP_OPACITY, CATCHMENT_OPACITY] : CATCHMENT_OPACITY);
  map.setFilter('catchment-outlet', ['==', ['get', 'riverId'], selection?.outlet ?? -1]);
}

/**
 * Light up the hovered Groups, and put out whatever was lit before.
 *
 * Feature state on a vector source is addressed by source *and* source-layer, which is why this
 * lives here rather than at the call site: the layer name was read off the archive at boot and is
 * nobody else's business. Passing an empty array is how the hover is cleared.
 */
export function setGroupHover(ids) {
  if (!map) return;
  const target = id => ({source: GROUP_SOURCE, sourceLayer: groupLayer, id});
  for (const id of hovered) map.setFeatureState(target(id), {hover: false});
  for (const id of ids) map.setFeatureState(target(id), {hover: true});
  hovered = ids;
}
