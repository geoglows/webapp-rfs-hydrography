import {createReadStream, existsSync, realpathSync, statSync} from 'node:fs';
import {extname, join, normalize, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
// ./data is a symlink to wherever the v3 artifacts actually live. Serving it from the Vite server
// is the point: PMTiles, the metadata parquets and the geometry parquets are all read by byte
// range — so one server does the app and the data, with no second process and no CORS. The
// artifacts are gigabytes and deliberately not copied into dist/.
const DATA_MOUNT = '/data';
const dataLink = `${here}data`;
const dataRoot = existsSync(dataLink) ? realpathSync(dataLink) : null;

const TYPES = {
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.parquet': 'application/vnd.apache.parquet',
  '.pmtiles': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Range-aware static file serving, in the ~40 lines it actually takes.
 *
 * Everything this app reads it reads by byte range, so **206 with a correct `Content-Range` is the
 * whole job** — a server that answers 200 with the entire file makes PMTiles refuse the response
 * outright ("content-length exceeding request") and makes a parquet footer read pull the whole
 * gigabyte. That is the one behaviour worth being careful about, and it is small enough not to be
 * worth a dependency.
 *
 * The 416 path matters too: PMTiles probes an archive it does not know the length of and reads the
 * size back out of `Content-Range: bytes * /size` on the refusal.
 */
const serveRange = (root, req, res, next) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  // Normalising an *absolute* path clamps at "/" — `/a/../../../etc/passwd` collapses to
  // `/etc/passwd` rather than climbing above it — so forcing the leading slash is what stops a
  // traversal, and the prefix check below is the second lock rather than the only one.
  const path = join(root, normalize(`/${rel}`));
  if (path !== root && !path.startsWith(root + sep)) {
    res.statusCode = 403;
    return res.end('forbidden\n');
  }
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return next();
  }
  if (!stat.isFile()) return next();

  const size = stat.size;
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('content-type', TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream');
  // No caching: this serves whatever the symlink points at right now, which during a pipeline run
  // is a file that changes under you.
  res.setHeader('cache-control', 'no-cache');

  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let start = 0;
  let end = size - 1;
  if (m) {
    // "bytes=-500" is the last 500 bytes; "bytes=500-" is everything from 500 on.
    if (m[1] === '') start = Math.max(0, size - Number(m[2]));
    else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
    }
    if (!(start <= end) || start >= size) {
      res.statusCode = 416;
      res.setHeader('content-range', `bytes */${size}`);
      return res.end();
    }
    res.statusCode = 206;
    res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('content-length', end - start + 1);
  if (req.method === 'HEAD') return res.end();
  createReadStream(path, {start, end}).on('error', () => res.destroy()).pipe(res);
};

/**
 * Mount ./data on both the dev server and the preview server.
 *
 * The same middleware for both, rather than leaning on `server.fs.allow` in dev, so the two behave
 * identically and there is only one thing to reason about — and `fs.allow` would not help the
 * preview server at all, which serves dist/ and nothing else.
 *
 * The explicit 404 matters more than it looks. Vite's SPA fallback rewrites any unmatched path to
 * index.html, so a missing artifact would come back as **200 with a page of HTML** — PMTiles then
 * fails on a malformed header and a parquet read on a bad magic number, neither of which says
 * "that file is not there". Ending the request here keeps a missing file looking like a missing
 * file. Registering in configureServer (not its returned post-hook) puts this ahead of the
 * fallback.
 */
const serveData = () => {
  const mount = server => {
    if (!dataRoot) return;
    server.middlewares.use(DATA_MOUNT, (req, res) => serveRange(dataRoot, req, res, () => {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain');
      res.end(`no such file under ${DATA_MOUNT}: ${req.url}\n`);
    }));
  };
  return {
    name: 'serve-data-symlink',
    configureServer: mount,
    configurePreviewServer: mount,
    buildStart() {
      if (!dataRoot) {
        this.warn(`./data is missing or dangling — the app will have no v3 artifacts to read. ` +
          `Symlink it: ln -s <path-to-v3-data> ${dataLink}`);
      }
    },
  };
};

// The moment this bundle was made, printed at the bottom of the settings dialog. A deployment is a
// static site with no version anywhere in it, so a bug report can otherwise only say "the site" —
// the stamp says which build. It is a module rather than a `define` because a define is not
// substituted by the dev server, which would leave the line blank for everyone running `npm run
// dev`. Stamped when the config is loaded: the build itself under `vite build`, and the moment the
// server started under `vite dev`.
const BUILD_DATE_ID = 'virtual:build-date';

const stampBuildDate = () => {
  const resolved = '\0' + BUILD_DATE_ID;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  return {
    name: 'stamp-build-date',
    resolveId: id => (id === BUILD_DATE_ID ? resolved : null),
    load: id => (id === resolved ? `export default ${JSON.stringify(stamp)};` : null),
  };
};

// The portal builds every app with `vite build --base="$BASE/"` (see apps.geoglows
// scripts/build-local.sh), so `base` is left at the default here and supplied on the command line.
// Nothing in the app hardcodes a path: the data root resolves against document.baseURI, so the
// same bundle works at /, at /rfs-hydrography-explorer/, and under a PORTAL_BASE prefix.
export default defineConfig({
  plugins: [serveData(), stampBuildDate()],
  // Vite crawls the page's imports to decide what to pre-bundle, and it does not crawl into
  // workers. The riverId lookup's zarr reads are reachable from nowhere else, so in dev they were
  // discovered only when someone pressed Download — at which point Vite re-optimized, and the
  // worker's already-loaded module ids went stale: a 504 on numcodecs/blosc, a worker that never
  // answers, and a download that silently never starts. Naming them here has them bundled before
  // the server is listening.
  optimizeDeps: {
    include: ['riverforecastsystem/v3', 'riverforecastsystem/v3/hydrography', 'numcodecs/blosc'],
  },
  build: {
    target: ['es2020', 'safari14'],
    // The geometry worker pulls in hyparquet + its compressors, which are large and only needed
    // once someone asks for a download. Keeping it a separate chunk keeps first paint cheap.
    chunkSizeWarningLimit: 1500,
  },
  worker: {format: 'es'},
});
