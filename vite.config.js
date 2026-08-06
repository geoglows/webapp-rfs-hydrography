import {existsSync, realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import sirv from 'sirv';

const here = fileURLToPath(new URL('.', import.meta.url));
// ./data is a symlink to wherever the v3 artifacts actually live. Serving it from the Vite server
// is the point: PMTiles, the connectivity parquets and the geometry parquets are all read by byte
// range, and sirv answers 206 — so one server does the app and the data, with no second process
// and no CORS. The artifacts are gigabytes and deliberately not copied into dist/.
const DATA_MOUNT = '/data';
const dataLink = `${here}data`;
const dataRoot = existsSync(dataLink) ? realpathSync(dataLink) : null;

/**
 * Mount ./data on both the dev server and the preview server.
 *
 * The same middleware for both, rather than leaning on `server.fs.allow` in dev, so the two behave
 * identically and there is only one thing to reason about.
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
    const serve = sirv(dataRoot, {etag: true, dev: true});
    server.middlewares.use(DATA_MOUNT, (req, res, next) => serve(req, res, () => {
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

// The portal builds every app with `vite build --base="$BASE/"` (see apps.geoglows
// scripts/build-local.sh), so `base` is left at the default here and supplied on the command line.
// Nothing in the app hardcodes a path: the data root resolves against document.baseURI, so the
// same bundle works at /, at /rfs-hydrography-explorer/, and under a PORTAL_BASE prefix.
export default defineConfig({
  plugins: [serveData()],
  build: {
    target: ['es2020', 'safari14'],
    // The geometry worker pulls in hyparquet + its compressors, which are large and only needed
    // once someone asks for a download. Keeping it a separate chunk keeps first paint cheap.
    chunkSizeWarningLimit: 1500,
  },
  worker: {format: 'es'},
});
