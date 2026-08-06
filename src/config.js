/**
 * Where the v3 hydrography lives, and the two limits the app enforces.
 *
 * The bucket layout is rfsjs's to know, not this app's: `configure({v3Base})` points the package at
 * a root and `urls.*` builds the paths, so this app never spells out `hydrography/group=N` itself
 * and cannot drift from the rest of the RFS clients if the layout moves.
 *
 * The placeholder Group boundaries and the Group index have no rfsjs builder because they are this
 * app's own artifacts rather than published v3 products. They still hang off
 * `urls.hydrographyGroup()`, so the shared builder remains the single source of the base path.
 *
 * Resolution order for the root: `?base=` on the URL, then VITE_V3_BASE at build time, then
 * rfsjs's own default — the published v3 root, which is where a deployed copy of this app should
 * be reading from. Both overrides may be relative (`data`, `../shared-data`); they resolve against
 * document.baseURI rather than a literal path, so one bundle works at the domain root, at
 * /rfs-hydrography-explorer/, and under a PORTAL_BASE prefix without being rebuilt.
 *
 * There is deliberately no relative `data/` fallback here. Serving the artifacts next to the
 * bundle is a dev-server arrangement (see vite.config.js), not how the app is deployed: the portal
 * copies only dist/ to the CDN, so a built-in `data/` default silently points a production build
 * at a prefix that does not exist and every read comes back 403. `data` is set as the default for
 * dev in .env.development, where it is true, and nowhere else.
 */
import {configure, getConfig, urls} from 'rfsjs/v3';

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

// Leaving v3Base unset keeps rfsjs's default; passing undefined to configure() would too, but not
// calling it at all is the clearer statement of "this app has nothing to say about the root".
const resolved = resolveBase();
if (resolved) configure({v3Base: resolved});

export const V3_BASE = getConfig().v3Base;

const group = g => urls.hydrographyGroup({group: g});

/**
 * Which per-Group geometry file the GeoParquet export reads.
 *
 * Both hold the same reaches — same count, same riverIds, same order, same columns — and differ
 * only in how the lines are stored:
 *
 *   'mapping'  streams_mapping_<id>.geo.parquet  EPSG:3857, coordinates snapped to whole metres,
 *              half the vertices (measured on Group 103: 11.2M against 22.5M), 46 MB against 72 MB.
 *   'full'     streams_<id>.geo.parquet          EPSG:4326, every vertex the pipeline published.
 *
 * 'mapping' is the default: it is a third fewer bytes to fetch and its shapes are indistinguishable
 * on a screen. It is a generalisation, though — a reach's length measured off it is not the
 * pipeline's length — so switch to 'full' if the export is meant to be authoritative geometry
 * rather than something to draw.
 *
 * Either way the CRS travels with the file. The worker copies the source's GeoParquet `geo`
 * metadata, PROJJSON and all, into what it writes, so GDAL and GeoPandas read the result in the
 * CRS it is actually in and reproject it themselves if asked. Nothing downstream assumes degrees.
 */
export const GEOMETRY_SOURCE = 'mapping';

const streamsFile = g => (GEOMETRY_SOURCE === 'mapping'
  ? `streams_mapping_${g}.geo.parquet`
  : `streams_${g}.geo.parquet`);

export const URLS = {
  streamsPmtiles: urls.streamsPmtiles(),
  groupBoundaries: `${group(0)}/group_boundaries.geojson`,
  groupIndex: `${group(0)}/group_index.json`,
  metadata: g => `${group(g)}/metadata_${g}.parquet`,
  streams: g => `${group(g)}/${streamsFile(g)}`,
};

/** A reach highlighted through feature-state costs one setFeatureState call. Past this the map is
 * left showing only the outlet and the count; the subset and both exports are unaffected. */
export const MAX_HIGHLIGHT = 400000;

/** Full-precision geometry runs ~5.6 KB of WKB per reach, held in memory twice — once decoded,
 * once in the file being written. The work happens in a worker so the map stays live through it,
 * but the tab's memory is still the ceiling. The ID list export has no such limit. */
export const MAX_GEOMETRY_REACHES = 100000;

/** The v3 tiles carry strahlerOrder >= 2 only from z9 up, so below this a reach can be in the
 * subset and absent from the map. The trace reads the metadata table, not tiles, so the count is right
 * either way — only the highlight looks sparse. */
export const FULL_DETAIL_ZOOM = 9;

export const DEEP_LINK_RIVER = params.get('river');
