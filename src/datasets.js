import {build, cancel, clear, isBuilding, status} from './riverIndex.js';
import {clearAll} from './db.js';
import * as names from './riverNamesData.js';

/**
 * TWIN FILE: webapp-rfs-v3/src/data/datasets.js — the same registry over the same two caches. Only
 * the labels differ, because that app runs its text through i18n and this one has none, and because
 * the river IDs are fetched at different moments in the two apps.
 *
 * The catalogue of things the user can download and keep on the device: what each one is called,
 * how big it is right now, and how to fetch, cancel, and erase it.
 *
 * Both entries live in the database the two apps share, so a row here can already be held because
 * the other app downloaded it, and erasing one here erases it for both. That is the honest reading
 * of a shared cache: the bytes are on the device once.
 *
 * Everything here is a cache. Erasing any of it costs a re-download and nothing else, which is why
 * clearing needs no ceremony beyond the sweeping button's confirm.
 *
 * Adding one is a single entry: `status` reporting `{n, bytes}` or null, `download({onProgress})`,
 * a `cancel`, a `remove`, and optionally `busy` for a dataset something outside Settings can start
 * fetching. The Settings list renders whatever is in here and names nothing.
 */
const DATASETS = [
  {
    key: 'riverIds',
    label: 'River IDs',
    hint: 'The river network\'s ID list, which is what lets a river be found by its ID. Fetched the '
      + 'first time an ID is searched for, and kept from then on.',
    /** `{n, bytes}` when held, else null. Reads the meta record, never the arrays it describes. */
    status: async () => {
      const meta = await status();
      // Two typed arrays of n int32s: the ids ascending and the axis position of each.
      return meta ? {n: meta.n, bytes: meta.n * 8} : null;
    },
    download: build,
    cancel,
    remove: clear,
    /** True while a build is in flight — the search box can start one from outside this panel. */
    busy: isBuilding,
  },
  {
    key: 'riverNames',
    label: 'River names',
    hint: 'The names of the major rivers: what the river names layer paints from, and what lets a '
      + 'river be found by name instead of by ID. Small, and fetched the first time either asks for '
      + 'it. Names are edited by hand upstream and republished whenever changes have accumulated, '
      + 'so this copy is rechecked on the 5th of each month.',
    /** `{n, bytes}` when held, else null. The row count and the weight of the file it came from. */
    status: async () => {
      const meta = await names.status();
      return meta ? {n: meta.n, bytes: meta.bytes} : null;
    },
    /**
     * Forced, because this is the button a user presses when they want the newest names — the
     * unforced path is the monthly boundary, and it would answer "already fresh" and do nothing.
     * There is no progress to report: one request for ~100 kB, against the river IDs' hundreds.
     */
    download: () => names.refresh({force: true}),
    // A single small request. Nothing to abort that would finish before the abort did.
    cancel: () => {},
    remove: names.clear,
  },
];

const byKey = key => DATASETS.find(d => d.key === key);

/**
 * Every dataset's current state, in list order: `{key, label, hint, status, busy}` — status null
 * when it isn't held, busy true while a download is in flight, whoever started it.
 */
const surveyAll = () => Promise.all(DATASETS.map(async d => ({
  key: d.key,
  label: d.label,
  hint: d.hint,
  status: await d.status().catch(() => null),
  busy: d.busy?.() ?? false,
})));

/**
 * Erase the lot. Clears every store rather than looping the registry's `remove`s, so a record left
 * behind by a dataset this version no longer lists goes too — otherwise "delete everything" quietly
 * isn't, and the orphan is exactly what a later version would trip over.
 */
async function removeAll() {
  await clearAll();
  // The registry's own invalidation still has to run: clearing the store doesn't drop the copies
  // features are holding in memory.
  await Promise.all(DATASETS.map(d => d.remove().catch(() => {})));
}

export {DATASETS, byKey, removeAll, surveyAll};
