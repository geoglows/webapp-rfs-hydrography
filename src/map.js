import maplibregl from 'maplibre-gl';
import {PMTiles, Protocol} from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import {MAX_ZOOM, URLS} from './config.js';
import {BASE_LAYER_ID, COLORS, compileLayers, defaultSpec, inRangeExpr} from './streamStyle.js';

const TILE_SETS = {
  'gray-light': {
    tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 16,
    attribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
  },
  'gray-light-labels': {
    tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 16,
    attribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
  },
  'gray-dark': {
    tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 16,
    attribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
  },
  'gray-dark-labels': {
    tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 16,
    attribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
  },
  imagery: {
    tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 19,
    attribution: 'Esri, Vantor, Earthstar Geographics, and the GIS User Community',
  },
  places: {
    tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 19,
    attribution: 'Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
  },
  topo: {
    tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 19,
    attribution: 'Esri, HERE, Garmin, USGS, NGA, FAO, NOAA, &copy; OpenStreetMap contributors, ' +
      'and the GIS User Community',
  },
  osm: {
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    maxzoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  },
  // OpenTopoMap renders from its own servers and asks that its tiles not be hammered; it stops at
  // z17, which is well past the zooms this app is read at.
  opentopo: {
    tiles: ['a', 'b', 'c'].map(s => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
    maxzoom: 17,
    attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)',
  },
};

export const BASEMAPS = [
  {id: 'gray-light', label: 'Light Gray (Esri)', tileSets: ['gray-light', 'gray-light-labels']},
  {id: 'gray-dark', label: 'Dark Gray (Esri)', tileSets: ['gray-dark', 'gray-dark-labels']},
  {id: 'osm', label: 'OpenStreetMap', tileSets: ['osm']},
  {id: 'opentopo', label: 'OpenTopoMap', tileSets: ['opentopo']},
  {id: 'topo', label: 'Topographic (Esri)', tileSets: ['topo']},
  {id: 'imagery', label: 'Imagery (Esri)', tileSets: ['imagery']},
  {id: 'imagery-labels', label: 'Imagery + Labels (Esri)', tileSets: ['imagery', 'places']},
];

/**
 * The one the map opens on. Dark grey rather than the first entry in the list, because the network
 * is drawn in light saturated colours that were chosen against a dark ground - on the light basemap
 * they sit at about 1.8:1 and wash out. The list keeps its own order: light grey still reads first
 * in the picker, where the order is about finding a basemap, not about which one you start on.
 */
const DEFAULT_BASEMAP = 'gray-dark';

/** A tile set's source and layer share one id, because there is exactly one layer per set. */
const tileSetId = key => `basemap-${key}`;

let basemap = DEFAULT_BASEMAP;

export const currentBasemap = () => basemap;

const basemapById = id => BASEMAPS.find(b => b.id === id) ?? BASEMAPS[0];

export function setBasemap(id) {
  const pick = basemapById(id);
  basemap = pick.id;
  for (const key of Object.keys(TILE_SETS)) {
    if (map?.getLayer(tileSetId(key))) {
      map.setLayoutProperty(tileSetId(key), 'visibility',
        pick.tileSets.includes(key) ? 'visible' : 'none');
    }
  }
}

const GROUP_SOURCE = 'group';
const GROUP = '#A78BFA';
let groupLayer = 'groups';
let groupIdField = 'groupId';

const BASIN_SOURCE = 'basins';
const BASIN = '#14b8a6';
let basinLayer = 'hydrobasins_level2';
let basinIdField = 'HYBAS_ID';

/**
 * The polygon regions a click reports and a hover highlights, outermost first.
 *
 * The layer name and id field of each archive are read at boot, so these are getters rather than
 * values — by the time anything calls them the archive has been opened.
 */
const REGIONS = [
  {
    key: 'basin', label: 'HydroBASINS L2', color: BASIN, source: BASIN_SOURCE, visible: false,
    layer: 'basin-fill', sourceLayer: () => basinLayer, idField: () => basinIdField,
  },
  {
    key: 'group', label: 'Group', color: GROUP, source: GROUP_SOURCE,
    layer: 'group-fill', sourceLayer: () => groupLayer, idField: () => groupIdField,
  },
];

const hovered = {basin: [], group: []};

async function openArchive(protocol, url, label) {
  const pmtiles = new PMTiles(url);
  protocol.add(pmtiles);
  try {
    return (await pmtiles.getMetadata()) ?? {};
  } catch (err) {
    console.warn(`[map] ${label} is unavailable (${err.message}) — ${url} — ` +
      'its layers are left off the map');
    return null;
  }
}

/** A region archive's layer name and id field, read off the archive rather than assumed. */
function readRegionArchive(md, file, candidates, fallback) {
  const layer = md?.vector_layers?.[0];
  if (!layer) {
    console.warn(`[map] ${file} declares no vector layers — ` +
      `assuming layer "${fallback.layer}" keyed by "${fallback.idField}"`);
    return fallback;
  }
  const fields = Object.keys(layer.fields ?? {});
  const idField = candidates.find(f => fields.includes(f)) ?? fields[0] ?? fallback.idField;
  console.info(`[map] ${file}: layer "${layer.id}", region id from "${idField}"`);
  return {layer: layer.id, idField};
}

function readCatchmentArchive(md) {
  const ids = (md?.vector_layers ?? []).map(l => l.id);
  if (!ids.length) return true;
  if (!ids.includes(catchmentFillLayer)) {
    const pick = ids.find(id => id !== catchmentLineLayer);
    if (!pick) {
      console.warn(`[map] catchments.pmtiles has no polygon layer (it has ${ids.join(', ')}) — ` +
        'the catchments are left off the map');
      return false;
    }
    console.warn(`[map] catchments.pmtiles has no "${catchmentFillLayer}" layer ` +
      `(it has ${ids.join(', ')}) — drawing "${pick}"`);
    catchmentFillLayer = pick;
  }
  catchmentLines = ids.includes(catchmentLineLayer);
  return true;
}

/** Rule layers are inserted under this one, so the selected outlet is never painted over. */
const TOP_LAYER = 'outlet';

/** The multi-select collection: every picked watershed, and the outlet reach of each. */
const PICK_UP_LAYER = 'picked-upstream';
const PICK_LAYER = 'picked-outlet';

/** The AOI subsetter's inlets: the reaches the selection is cut off above. */
const INLET_LAYER = 'aoi-inlet';

/**
 * What the restyled rule layers are inserted under. Everything in here paints the app's own state
 * — what is selected, what is collected, where an AOI is cut — and none of it may be painted over
 * by a style rule. Listed bottom to top: rule layers go under the first of them that exists.
 */
const OVERLAYS = [PICK_UP_LAYER, PICK_LAYER, TOP_LAYER, INLET_LAYER];

/** A filter that matches no reach — how a highlight layer is switched off. */
const NOTHING = ['==', ['get', 'riverId'], -1];

const CATCHMENT_SOURCE = 'catchments';
let catchmentFillLayer = 'catchments';
const catchmentLineLayer = 'catchment_lines';
let catchmentLines = true;
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

  const [groupsMd, catchmentsMd, basinsMd] = await Promise.all([
    openArchive(protocol, URLS.groupsPmtiles, 'groups.pmtiles'),
    openArchive(protocol, URLS.catchmentsPmtiles, 'catchments.pmtiles'),
    openArchive(protocol, URLS.basinsPmtiles, 'hydrobasins_level2.pmtiles'),
  ]);
  const hasGroups = groupsMd !== null;
  if (hasGroups) {
    ({layer: groupLayer, idField: groupIdField} = readRegionArchive(groupsMd, 'groups.pmtiles',
      ['groupId', 'group_id', 'group', 'id'], {layer: groupLayer, idField: groupIdField}));
  }
  const hasBasins = basinsMd !== null;
  if (hasBasins) {
    ({layer: basinLayer, idField: basinIdField} = readRegionArchive(basinsMd,
      'hydrobasins_level2.pmtiles', ['HYBAS_ID', 'hybas_id', 'HYBAS_ID2', 'id'],
      {layer: basinLayer, idField: basinIdField}));
  }
  const hasCatchments = catchmentsMd !== null && readCatchmentArchive(catchmentsMd);

  const streamLayers = compileLayers(defaultSpec(), {highlight: true});
  for (const l of streamLayers) applied.set(l.id, l);
  layerOrder = streamLayers.map(l => l.id);

  map = new maplibregl.Map({
    container: 'map',
    hash: 'map',
    center: [0, 20],
    zoom: 2,
    maxZoom: MAX_ZOOM,
    pitch: 0,
    bearing: 0,
    maxPitch: 0,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    style: {
      version: 8,
      sources: {
        ...Object.fromEntries(Object.entries(TILE_SETS).map(([key, t]) => [tileSetId(key), {
          type: 'raster', tiles: t.tiles, tileSize: 256, maxzoom: t.maxzoom,
          attribution: t.attribution,
        }])),
        ...(hasGroups ? {
          [GROUP_SOURCE]: {
            type: 'vector', url: `pmtiles://${URLS.groupsPmtiles}`,
            promoteId: {[groupLayer]: groupIdField}, attribution: 'GEOGLOWS RFS v3',
          },
        } : {}),
        ...(hasBasins ? {
          [BASIN_SOURCE]: {
            type: 'vector', url: `pmtiles://${URLS.basinsPmtiles}`,
            promoteId: {[basinLayer]: basinIdField}, attribution: 'HydroSHEDS HydroBASINS',
          },
        } : {}),
        ...(hasCatchments ? {
          [CATCHMENT_SOURCE]: {
            type: 'vector', url: `pmtiles://${URLS.catchmentsPmtiles}`,
            attribution: 'GEOGLOWS RFS v3',
          },
        } : {}),
        streams: {
          type: 'vector', url: `pmtiles://${URLS.streamsPmtiles}`,
          promoteId: {streams: 'riverId'}, attribution: 'GEOGLOWS RFS v3',
        },
      },
      layers: [
        ...Object.keys(TILE_SETS).map(key => ({
          id: tileSetId(key), type: 'raster', source: tileSetId(key),
          layout: {
            visibility: basemapById(basemap).tileSets.includes(key) ? 'visible' : 'none',
          },
        })),
        ...(hasBasins ? [
          {
            id: 'basin-fill', type: 'fill', source: BASIN_SOURCE, 'source-layer': basinLayer,
            layout: {visibility: 'none'},
            paint: {
              'fill-color': BASIN,
              'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.12, 0.05],
            },
          },
          {
            id: 'basin-line', type: 'line', source: BASIN_SOURCE, 'source-layer': basinLayer,
            layout: {visibility: 'none'},
            paint: {
              'line-color': BASIN, 'line-opacity': 0.75,
              'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 4, 1.6],
            },
          },
        ] : []),
        ...(hasCatchments ? [
          {
            id: 'catchment-fill', type: 'fill', source: CATCHMENT_SOURCE,
            'source-layer': catchmentFillLayer,
            layout: {visibility: 'none'},
            paint: {'fill-color': CATCHMENT, 'fill-opacity': CATCHMENT_OPACITY},
          },
          {
            id: 'catchment-outlet', type: 'fill', source: CATCHMENT_SOURCE,
            'source-layer': catchmentFillLayer,
            layout: {visibility: 'none'},
            filter: ['==', ['get', 'riverId'], -1],
            paint: {'fill-color': COLORS.outlet, 'fill-opacity': 0.35},
          },
          ...(catchmentLines ? [{
            id: 'catchment-line', type: 'line', source: CATCHMENT_SOURCE,
            'source-layer': catchmentLineLayer,
            layout: {visibility: 'none'},
            paint: {
              'line-color': CATCHMENT_EDGE,
              'line-opacity': 0.55,
              'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.9, 10, 1.6, 14, 2.6],
            },
          }] : []),
        ] : []),
        ...(hasGroups ? [
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
        ] : []),
        ...streamLayers,
        {
          id: PICK_UP_LAYER, type: 'line', source: 'streams', 'source-layer': 'streams',
          filter: NOTHING,
          layout: {'line-cap': 'round', 'line-join': 'round'},
          paint: {
            'line-color': COLORS.upstream,
            'line-opacity': 0.95,
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.6, 9, 3.2, 14, 5.5],
          },
        },
        {
          id: PICK_LAYER, type: 'line', source: 'streams', 'source-layer': 'streams',
          filter: NOTHING,
          layout: {'line-cap': 'round', 'line-join': 'round'},
          paint: {
            'line-color': COLORS.outlet,
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 3, 9, 5.5, 14, 9],
          },
        },
        {
          id: TOP_LAYER, type: 'line', source: 'streams', 'source-layer': 'streams',
          filter: ['==', ['get', 'riverId'], -1],
          layout: {'line-cap': 'round', 'line-join': 'round'},
          paint: {
            'line-color': COLORS.outlet,
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 5.5, 9, 8.5, 14, 12],
          },
        },
        {
          // Over the outlet, because an inlet can be the outlet's own reach on a one-reach AOI,
          // and because it is the thing you are placing while you are placing it.
          id: INLET_LAYER, type: 'line', source: 'streams', 'source-layer': 'streams',
          filter: NOTHING,
          layout: {'line-cap': 'round', 'line-join': 'round'},
          paint: {
            // The outlet's own dark orange, and narrower than the outlet: an inlet is the other
            // end of the same selection, without outweighing the reach it drains to.
            'line-color': COLORS.outlet,
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 4, 9, 6, 14, 8],
          },
        },
      ],
    },
  });

  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  // Shift-click is how a river is added to the multi-select collection, and MapLibre's box zoom
  // eats the click that ends a shift-drag. Scroll and the +/- control already do the zooming.
  map.boxZoom.disable();
  const northUp = () => {
    if (map.getBearing()) map.setBearing(0);
  };
  map.on('rotate', northUp);
  northUp();
  // Zoom top left, the app's own pickers top right, the scale bar bottom left. The credits stay
  // where MapLibre puts them, along the bottom right, and the legend sits above them.
  map.addControl(new maplibregl.NavigationControl({showCompass: false}), 'top-left');
  map.addControl(new maplibregl.ScaleControl({unit: 'metric'}), 'bottom-left');
  await ready(map);
  return map;
}

function ready(m) {
  return new Promise(resolve => {
    let styled = false;
    m.on('style.load', () => {
      styled = true;
    });
    m.once('load', resolve);
    m.on('error', e => {
      if (!styled) return;
      console.warn(`[map] opening without waiting for "load" — ${e.error?.message ?? e.type}`);
      resolve();
    });
  });
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

  const under = OVERLAYS.find(id => map.getLayer(id));
  for (const l of layers) {
    if (!map.getLayer(l.id)) {
      map.addLayer(l, under);
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
  // The inlets go with the outlet: they are both the app painting what is selected, and a style
  // previewed with the highlight off should not still have red reaches over it.
  for (const id of [TOP_LAYER, INLET_LAYER]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}

// ── layer visibility ─────────────────────────────────────────────────────────
export function setLayersVisible(ids, visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
}

export const layersVisible = ids =>
  ids.some(id => map.getLayer(id) && map.getLayoutProperty(id, 'visibility') !== 'none');

export const layersPresent = ids => ids.some(id => !!map?.getLayer(id));

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

/** Draw the AOI's inlets — the reaches the selection stops above. Pass [] to draw none. */
export function applyInlets(ids) {
  if (!map?.getLayer(INLET_LAYER)) return;
  map.setFilter(INLET_LAYER, ids.length
    ? ['in', ['get', 'riverId'], ['literal', ids]]
    : NOTHING);
}

// ── the multi-select collection ──────────────────────────────────────────────
let picked = [];

/**
 * Paint every collected watershed: the whole upstream network of each in the pick colour, with the
 * outlet reach of each drawn over it. Both come off one `riverIndex` range per pick, the same range
 * the single selection is drawn from, so a collected watershed looks like a selected one that
 * stayed.
 */
export function applyPicks(list) {
  picked = list ?? [];
  if (!map?.getLayer(PICK_LAYER)) return;
  map.setFilter(PICK_LAYER, picked.length
    ? ['in', ['get', 'riverId'], ['literal', picked.map(p => p.outletId)]]
    : NOTHING);
  map.setFilter(PICK_UP_LAYER, picked.length
    ? ['any', ...picked.map(inRangeExpr)]
    : NOTHING);
}

/** Bring one pick into view without changing how far in the map is already zoomed. */
export function flyToPick({lon, lat}) {
  if (!map || lon == null || lat == null) return;
  map.easeTo({center: [lon, lat], zoom: Math.max(map.getZoom(), 8), duration: 700});
}

/**
 * A river found by name, which is a whole river rather than a reach — so the camera frames its
 * published extent instead of travelling to a point on it.
 *
 * The names table carries the bounding box of every reach the name covers, which is the only way
 * either app can frame a river at all: the reaches are in vector tiles that are not loaded until the
 * camera is already looking at them. Flying to the mouth instead would put the Amazon on screen as
 * an estuary, with the river off the west edge.
 *
 * Falls back to the point when a row carries no box — an older release of the table has none, and a
 * river is still worth going to.
 */
export function fitRiverBounds(bbox, at) {
  if (!map) return;
  if (!bbox || bbox.length !== 4) return flyToPick(at ?? {});
  const [west, south, east, north] = bbox;
  const {width} = map.getContainer().getBoundingClientRect();
  map.fitBounds([[west, south], [east, north]], {
    // A river narrower than the padding cannot be fitted at all, so the padding is capped at a
    // share of the window rather than being a flat number of pixels.
    padding: Math.min(80, Math.round(width * 0.12)),
    // A single short reach has a near-degenerate box, and fitting one lands the camera at z22 on a
    // stream. 8 is the zoom flyToPick treats as close enough to read one.
    maxZoom: 8,
  });
}

// ── the catchments ───────────────────────────────────────────────────────────
function syncCatchmentHighlight() {
  if (!map?.getLayer('catchment-fill')) return;
  const up = selection ? inRangeExpr(selection) : null;
  map.setPaintProperty('catchment-fill', 'fill-color',
    up ? ['case', up, COLORS.upstream, CATCHMENT] : CATCHMENT);
  map.setPaintProperty('catchment-fill', 'fill-opacity',
    up ? ['case', up, CATCHMENT_UP_OPACITY, CATCHMENT_OPACITY] : CATCHMENT_OPACITY);
  map.setFilter('catchment-outlet', ['==', ['get', 'riverId'], selection?.outlet ?? -1]);
}

// ── the region polygons: Groups and HydroBASINS ──────────────────────────────
/** Only layers that are on the map and switched on answer a query, so a hidden region is inert. */
const drawnRegions = () => REGIONS.filter(r => map?.getLayer(r.layer));

/** The regions under `point` and the id of each, outermost first — what a click reports. */
export function regionsAt(point) {
  const layers = drawnRegions().map(r => r.layer);
  if (!layers.length) return [];
  const hits = map.queryRenderedFeatures(point, {layers});
  return REGIONS.map(r => {
    const f = hits.find(h => h.layer.id === r.layer);
    const id = f?.properties?.[r.idField()] ?? f?.id;
    return id == null ? null : {label: r.label, id, color: r.color};
  }).filter(Boolean);
}

/** Highlight every region under `point`; pass null to drop the highlight. */
export function hoverRegions(point) {
  const hits = point && drawnRegions().length
    ? map.queryRenderedFeatures(point, {layers: drawnRegions().map(r => r.layer)})
    : [];
  for (const r of REGIONS) {
    if (!map?.getSource(r.source)) continue;
    const ids = [...new Set(hits.filter(h => h.layer.id === r.layer)
      .map(h => h.id).filter(id => id != null))];
    if (ids.join() === hovered[r.key].join()) continue;
    const target = id => ({source: r.source, sourceLayer: r.sourceLayer(), id});
    for (const id of hovered[r.key]) map.setFeatureState(target(id), {hover: false});
    for (const id of ids) map.setFeatureState(target(id), {hover: true});
    hovered[r.key] = ids;
  }
}
