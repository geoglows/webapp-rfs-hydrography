import {getConfig, urls} from "riverforecastsystem/v3";
import {deleteRecord, isUsable, isUsableMeta, readMeta, readRecord} from "./riverIndexDb.js";

/**
 * TWIN FILE: webapp-rfs-v3/src/data/riverIndex.js — the same module, keep the two in step.
 *
 * The riverId -> riverIndex lookup, from the app side: start the build, report on it, answer
 * lookups against it.
 *
 * riverIndex — the reach's position on the zarr riverId axis — is what every reader takes, so it is
 * the app's currency and an id alone is the incomplete form. Map clicks and saved rivers carry an
 * index already; anything holding only an id calls resolve(), which downloads this lookup if the
 * device hasn't got it. That download is ~17 MB across a few hundred chunk requests, so it is never
 * on the critical path of app load — but when a feature does need it, it fetches it rather than
 * telling the user to go and arrange it.
 */
let worker = null;
// The lookup arrays, once pulled out of IndexedDB. ~44 MB resident, so this stays lazy: it is
// loaded on the first lookup, not when the cache is built or the app starts.
let loaded = null;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./riverIndexWorker.js", import.meta.url), {type: "module"});
  // The worker has its own instance of the package's config, blank like every other, so the v3 root
  // travels in the init message — the same handshake the flood worker uses.
  worker.postMessage({type: "init", v3Base: getConfig().v3Base});
  return worker;
}

/** What's cached right now, or null. Reads the meta record, so it costs nothing to call on every open. */
async function status() {
  const meta = await readMeta().catch(() => null);
  if (!isUsableMeta(meta, urls.hydrographyMetadataZarr())) return null;
  return {n: meta.n, builtAt: meta.builtAt, source: meta.source};
}

// One build at a time no matter how many callers ask for it: Settings, the search box and the
// charts dock all reach for the same download, and a second one would be another 17 MB fetching
// what the first is already fetching. Everyone waiting gets the same progress and the same answer.
let building = null;
const watchers = new Set();

/**
 * Build the lookup, or resolve immediately if a valid one is already cached.
 *
 * onProgress({phase, done, total}) reports through download -> sort -> verify -> store. Call
 * cancel() to abort; the returned promise rejects with an AbortError.
 */
function build({onProgress} = {}) {
  if (onProgress) watchers.add(onProgress);
  if (building) return building;
  const w = ensureWorker();
  building = new Promise((ready, fail) => {
    const done = (fn, arg) => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      w.removeEventListener("messageerror", onError);
      fn(arg);
    };
    const onMessage = (ev) => {
      const msg = ev.data;
      if (msg.type === "progress") for (const watcher of watchers) watcher(msg);
      else if (msg.type === "ready") {
        // A rebuild invalidates whatever this thread was holding.
        loaded = null;
        done(ready, {n: msg.n, cached: msg.cached});
      } else if (msg.type === "cancelled") done(fail, new DOMException("River index build cancelled", "AbortError"));
      else if (msg.type === "error") done(fail, new Error(msg.message));
    };
    // A worker that fails to evaluate its module never answers, and every message posted to it is
    // dropped in silence — without this the button sits on "Cancel" forever with no way to tell
    // that nothing is running. Drop the handle too, so the next click builds a fresh worker rather
    // than posting into the same dead one.
    const onError = (ev) => {
      worker = null;
      done(fail, new Error(ev.message || "the river index worker failed to start"));
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    w.addEventListener("messageerror", onError);
    w.postMessage({type: "build"});
  });
  // Settled either way, the next call starts a fresh build. Attached with a handler on both sides
  // so a rejection here is not a second, unhandled one — the callers hold the promise itself.
  const finish = () => {
    building = null;
    watchers.clear();
  };
  building.then(finish, finish);
  return building;
}

const cancel = () => worker?.postMessage({type: "cancel"});

/** Whether a build is in flight — this caller's, or one started somewhere else entirely. */
const isBuilding = () => building !== null;

async function load() {
  if (loaded) return loaded;
  // The one place the full record is read — and so the one place the buffers' lengths are checked.
  const record = await readRecord().catch(() => null);
  if (!isUsable(record, urls.hydrographyMetadataZarr())) return null;
  loaded = {
    sortedIds: new Int32Array(record.sortedIds),
    positions: new Uint32Array(record.positions)
  };
  return loaded;
}

/**
 * The reach's position on the zarr riverId axis, or -1 if the id is not in the network. Returns
 * null — distinct from -1 — when the lookup has not been built, so a caller can tell "no such
 * river" apart from "cannot answer yet".
 *
 * ~23 probes over a contiguous typed array. The fetch it precedes costs five orders of magnitude
 * more, which is why a fancier structure than a sorted array would buy nothing.
 */
async function lookup(riverId) {
  const index = await load();
  if (!index) return null;
  const {sortedIds, positions} = index;
  const target = Number(riverId);
  let lo = 0;
  let hi = sortedIds.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const value = sortedIds[mid];
    if (value === target) return positions[mid];
    if (value < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * The reach's position on the axis for a river known only by its id — building the lookup first if
 * this device hasn't got it. -1 if the id is not in the network; that is the only "no".
 *
 * The one place an id becomes an index, and it never hands back "cannot answer yet": the lookup is
 * a download, so a caller that needs one takes the download rather than sending the user to
 * Settings to arrange it. onProgress({phase, done, total}) is how that wait gets reported.
 */
async function resolve(riverId, {onProgress} = {}) {
  const cached = await lookup(riverId);
  if (cached !== null) return cached;
  await build({onProgress});
  const index = await lookup(riverId);
  // Built and immediately unreadable: the record was erased underneath us, or the browser refused
  // to keep it. Not "no such river" — say so rather than sending back an answer we don't have.
  if (index === null) throw new Error("the river ID lookup was built but could not be read back");
  return index;
}

/** Drop this thread's copy of the arrays. For whoever erased the record underneath us — see data/datasets.js. */
function forget() {
  loaded = null;
}

async function clear() {
  await deleteRecord();
  forget();
}

export {build, cancel, clear, forget, isBuilding, lookup, resolve, status};
