import {fetchMetadataArray} from "riverforecastsystem/v3/hydrography";
import {configure, urls} from "riverforecastsystem/v3";
import {isUsableMeta, readMeta, SCHEMA_VERSION, writeRecord} from "./riverIndexDb.js";

/**
 * TWIN FILE: webapp-rfs-v3/src/data/riverIndexWorker.js — the same worker, keep the two in step.
 *
 * Builds the riverId -> riverIndex lookup and caches it, off the main thread.
 *
 * The metadata store's riverId axis is in topological order — a hydrologically meaningful
 * ordering, not ascending id — so a reach's position in it IS its riverIndex, but the array cannot
 * be searched by id as downloaded. The permutation is real information and has to be built here:
 *
 *   sortedIds   Int32Array(N)    ids ascending
 *   positions   Uint32Array(N)   positions[k] = axis position of sortedIds[k]
 *
 * Binary search sortedIds, read the answer out of positions. Nothing about the store needs to
 * change for this; the ordering is not going to become ascending and the client absorbs it once.
 *
 * Messages in:
 *   init    {v3Base}    point the package at the data (its config is per-thread)
 *   build   {}          reuse a valid cache, else download -> sort -> verify -> store
 *   cancel  {}          abort an in-flight build
 * Messages out: ready {n, cached} · progress {phase, done, total} · cancelled · error {message}
 */
function createRiverIndexWorker(post) {
  let controller = null;

  // ── the sort ───────────────────────────────────────────────────────────────
  // LSD radix, four passes over the four bytes of an int32. sort() with a comparator would be
  // millions of JS calls and the GC churn to match — seconds of jank even off the main thread.
  // This allocates once and touches each element four times.
  //
  // The most significant pass XORs its bucket by 0x80, which maps negative ids below positive ones
  // and makes the result correct for any int32 rather than only the positive ones today's ids
  // happen to be. Free: it is an XOR by zero on the other three passes.
  function buildLookup(ids, onPass) {
    const n = ids.length;
    // `ids` is consumed as scratch — the caller must not hold on to it after this.
    let keysIn = ids;
    let valsIn = new Uint32Array(n);
    // Identity to start: a reach's position on the axis is its riverIndex, so this is the payload
    // the sort carries along and permutes.
    for (let i = 0; i < n; i++) valsIn[i] = i;
    let keysOut = new Int32Array(n);
    let valsOut = new Uint32Array(n);
    const counts = new Uint32Array(256);

    for (let shift = 0, pass = 0; shift < 32; shift += 8, pass++) {
      const flip = shift === 24 ? 0x80 : 0;
      counts.fill(0);
      for (let i = 0; i < n; i++) counts[(((keysIn[i] >>> shift) & 0xFF) ^ flip)]++;
      let sum = 0;
      for (let b = 0; b < 256; b++) {
        const c = counts[b];
        counts[b] = sum;
        sum += c;
      }
      for (let i = 0; i < n; i++) {
        const key = keysIn[i];
        const at = counts[(((key >>> shift) & 0xFF) ^ flip)]++;
        keysOut[at] = key;
        valsOut[at] = valsIn[i];
      }
      const tk = keysIn;
      keysIn = keysOut;
      keysOut = tk;
      const tv = valsIn;
      valsIn = valsOut;
      valsOut = tv;
      onPass?.(pass + 1);
    }
    // Four passes is an even number of swaps, so the result lands back in the arrays that came in.
    return {sortedIds: keysIn, positions: valsIn};
  }

  // A truncated or reordered download is otherwise undetectable downstream: every index it yields
  // is a plausible row number, and the discharge readers echo back no riverId to contradict it.
  function verify(sortedIds, expectedLength) {
    if (sortedIds.length !== expectedLength) {
      throw new Error(`sorted ${sortedIds.length} ids, expected ${expectedLength}`);
    }
    for (let i = 1; i < sortedIds.length; i++) {
      if (sortedIds[i] <= sortedIds[i - 1]) {
        throw new Error(`ids are not strictly ascending at ${i} (${sortedIds[i - 1]} then ${sortedIds[i]}) — the download is corrupt or the store has duplicate river ids`);
      }
    }
  }

  // ── build ──────────────────────────────────────────────────────────────────
  async function build() {
    const source = urls.hydrographyMetadataZarr();
    // The meta record, not the arrays: deciding whether to skip the download must not cost more
    // than reading the thing it would skip to.
    const existing = await readMeta().catch(() => null);
    if (isUsableMeta(existing, source)) {
      post({type: "ready", n: existing.n, cached: true});
      return;
    }

    controller = new AbortController();
    const {signal} = controller;

    const ids = await fetchMetadataArray({
      variable: "riverId",
      signal,
      onProgress: ({done, total}) => post({type: "progress", phase: "download", done, total})
    });

    const n = ids.length;
    post({type: "progress", phase: "sort", done: 0, total: 4});
    const {sortedIds, positions} = buildLookup(ids, (pass) =>
      post({type: "progress", phase: "sort", done: pass, total: 4}));

    post({type: "progress", phase: "verify", done: 0, total: 1});
    verify(sortedIds, n);
    post({type: "progress", phase: "verify", done: 1, total: 1});

    post({type: "progress", phase: "store", done: 0, total: 1});
    await writeRecord({
      schema: SCHEMA_VERSION,
      source,
      n,
      builtAt: Date.now(),
      sortedIds: sortedIds.buffer,
      positions: positions.buffer
    });
    post({type: "progress", phase: "store", done: 1, total: 1});
    post({type: "ready", n, cached: false});
  }

  return (ev) => {
    const msg = ev.data;
    if (msg.type === "init") {
      configure({v3Base: msg.v3Base});
      return;
    }
    if (msg.type === "cancel") {
      controller?.abort();
      return;
    }
    if (msg.type === "build") {
      build().catch((e) => {
        if (e?.name === "AbortError") post({type: "cancelled"});
        else post({type: "error", message: e.message});
      }).finally(() => {
        controller = null;
      });
    }
  };
}

const handle = createRiverIndexWorker((message) => self.postMessage(message));
self.onmessage = handle;

export {createRiverIndexWorker};
