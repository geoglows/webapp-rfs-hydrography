/**
 * The map: basemap, v3 stream tiles, the placeholder Group boundaries, and the two highlights.
 *
 * The upstream set is painted by feature-state on the same layer that draws the network, so a
 * reach changes colour the moment its tile arrives — no second source, no re-filtering, and no
 * `in` expression over a 200k-element literal array.
 */
import maplibregl from 'maplibre-gl';
import {Protocol} from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import {MAX_HIGHLIGHT, URLS} from './config.js';
import {fmt, status} from './ui.js';

// Positron — Carto's light grey basemap. The four line colours below are the saturated mid-tones
// that hold up against it; the pale blues and lilacs a dark basemap invites simply vanish on light
// grey. They are also what the sidebar legend swatches use, so the two cannot drift apart.
const CARTO_LIGHT = ['a', 'b', 'c', 'd']
  .map(s => `https://${s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png`);

const STREAM = '#2a7fd4';
const UPSTREAM = '#f06a1e';
const OUTLET = '#e0417a';
const GROUP = '#8b5cf6';

export let map = null;
let highlightedIds = [];

export async function initMap() {
  maplibregl.addProtocol('pmtiles', new Protocol({metadata: true}).tile);

  map = new maplibregl.Map({
    container: 'map',
    hash: 'map',
    center: [0, 20],
    zoom: 2,
    maxZoom: 16,
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
        {
          id: 'group-fill', type: 'fill', source: 'group',
          paint: {
            'fill-color': GROUP,
            'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.16, 0.045],
          },
        },
        {
          id: 'group-line', type: 'line', source: 'group',
          paint: {
            'line-color': GROUP, 'line-dasharray': [3, 2], 'line-opacity': 0.7,
            'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2.5, 1],
          },
        },
        {
          id: 'streams', type: 'line', source: 'streams', 'source-layer': 'streams',
          layout: {'line-cap': 'round', 'line-join': 'round'},
          paint: {
            'line-color': ['case', ['boolean', ['feature-state', 'up'], false], UPSTREAM, STREAM],
            // Opaque from further out than the dark basemap needed. A 0.6px line at 70% over light
            // grey is close to invisible; over dark it read fine.
            'line-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.85, 9, 1],
            'line-width': ['interpolate', ['linear'], ['zoom'],
              3, ['case', ['boolean', ['feature-state', 'up'], false], 1.6, 0.7],
              9, ['case', ['boolean', ['feature-state', 'up'], false], 3.2, 1.4],
              14, ['case', ['boolean', ['feature-state', 'up'], false], 6, 3]],
          },
        },
        {
          id: 'outlet', type: 'line', source: 'streams', 'source-layer': 'streams',
          filter: ['==', ['get', 'riverId'], -1],
          layout: {'line-cap': 'round', 'line-join': 'round'},
          paint: {
            'line-color': OUTLET,
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

/** Paint `ids` as upstream and `outlet` as the selected reach, clearing whatever was there. */
export function applyHighlight(ids, outlet) {
  for (const id of highlightedIds) {
    map.setFeatureState({source: 'streams', sourceLayer: 'streams', id}, {up: false});
  }
  highlightedIds = [];
  map.setFilter('outlet', ['==', ['get', 'riverId'], outlet]);

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
  map.setFilter('outlet', ['==', ['get', 'riverId'], -1]);
}

export const highlightCount = () => highlightedIds.length;

export function setGroupVisible(visible) {
  const v = visible ? 'visible' : 'none';
  for (const id of ['group-fill', 'group-line']) map.setLayoutProperty(id, 'visibility', v);
}
