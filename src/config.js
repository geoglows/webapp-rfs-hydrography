import {configure, getConfig, urls} from 'riverforecastsystem/v3';

const params = new URLSearchParams(window.location.search);

const absolute = value => (/^[a-z][a-z0-9+.-]*:/i.test(value)
  ? value
  : new URL(value, document.baseURI).href);

const resolveBase = () => {
  const fromUrl = params.get('base');
  if (fromUrl) return absolute(fromUrl);
  const configured = import.meta.env.VITE_V3_BASE;
  return configured ? absolute(configured) : undefined;
};

// Leaving v3Base unset keeps riverforecastsystem's default; passing undefined to configure() would
// too, but not calling it at all is the clearer statement of "this app has nothing to say about the
// root".
const resolved = resolveBase();
if (resolved) configure({v3Base: resolved});

export const V3_BASE = getConfig().v3Base;

const group = g => urls.hydrographyGroup({group: g});

/**
 * The two per-Group geometry files, which are the same reaches twice: `streams_<id>` as the lines,
 * `catchments_<id>` as the polygon each line drains. Both are written in riverIndex order with the
 * same `riverId`/`riverIndex` columns, which is what lets one worker subset either of them — and
 * what lets the ID list come out of `streams_` now that `riverId_riverIndex.parquet` is gone.
 */
export const URLS = {
  streamsPmtiles: urls.streamsPmtiles(),
  catchmentsPmtiles: `${group(0)}/catchments.pmtiles`,
  groupsPmtiles: `${group(0)}/groups.pmtiles`,
  streams: g => `${group(g)}/streams_${g}.geo.parquet`,
  catchments: g => `${group(g)}/catchments_${g}.geo.parquet`,
};

export const MAX_GEOMETRY_REACHES = 100000;
export const MIN_ZOOM = 0;
export const MAX_ZOOM = 16;
export const ZOOM_STEP = 0.5;
export const TILE_ORDER_LADDER = [
  {zoom: 0, minOrder: 7},
  {zoom: 5, minOrder: 6},
  {zoom: 7, minOrder: 4},
  {zoom: 9, minOrder: 2},
];

/** Which zoom a reach of this Strahler order first appears at, per the ladder above. */
export const firstZoomForOrder = order => {
  const hit = TILE_ORDER_LADDER.find(step => order >= step.minOrder);
  return hit ? hit.zoom : null;
};
