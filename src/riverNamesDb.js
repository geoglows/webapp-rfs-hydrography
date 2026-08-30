/**
 * IndexedDB storage for the river names table, and the clock it expires on.
 *
 * TWIN FILE: webapp-rfs-v3/src/data/riverNamesDb.js. Both apps read this record out of the same
 * database, so the keys and SCHEMA_VERSION below are a contract between them, not a private detail.
 *
 * Small enough — a few hundred rows — to be one record holding a plain array, so unlike the river
 * ID lookup there is nothing to gain from a typed-array layout and nothing expensive about reading
 * it. It still gets the same shadow meta record, for the same reason: the Settings row and the
 * freshness check want to know what is held and when it was fetched without pulling the rows.
 *
 * Both records go in the shared store from data/db.js under keys of their own — a store per dataset
 * would mean an upgrade, and see that file for why an upgrade is not worth what it can cost.
 *
 * The names are the one dataset here with no publishing schedule behind it. They are hand curated
 * upstream and republished whenever edits have accumulated, which may be twice in a week or not
 * for months, so there is no update time to wait for and no version to watch. What replaces that
 * is a clock the client keeps on its own: a copy is good until the next 5th of the month at 00:00
 * UTC, and after that it is revalidated. The 5th is not arbitrary — it is the boundary the monthly
 * retrospective products already publish on, so a device that wakes up to refresh one is refreshing
 * both.
 *
 * Expiry is not invalidation. An expired copy is still shown while the revalidation runs, and a
 * server that answers "not modified" only moves the date forward — the rows never leave, so name
 * search does not stop working on the 5th of the month or on a device that is offline that day.
 */
import {runTransaction} from "./db.js";

const RECORD_KEY = "riverNames";
const META_KEY = "riverNames:meta";

// The version of the cached table, as the date it was last invalidated: yyyymmdd, with .0, .1, .2
// appended when more than one revision lands in a day. Bump it when the record layout changes, so
// a cache written by an older build is discarded rather than read into fields that have moved.
const SCHEMA_VERSION = "20260830.1";

// The day of the month a cached copy stops being fresh on, at 00:00 UTC.
const EXPIRY_DAY = 5;

/**
 * The first expiry boundary strictly after `from` — the next 5th of the month at 00:00 UTC.
 *
 * Strictly after, so a copy fetched at 00:00:01 on the 5th is good until the 5th of *next* month
 * rather than being born stale. A copy fetched on the 3rd is good for two days, which is the
 * honest answer: the boundary is a date, not an age.
 *
 * Date.UTC normalises a month index of 12 into January of the next year, so the year rollover
 * needs no case of its own.
 */
function nextExpiry(from) {
  const d = new Date(from);
  const thisMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), EXPIRY_DAY);
  return thisMonth > from
    ? thisMonth
    : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, EXPIRY_DAY);
}

/** The published file and everything the cache knows about it. */
const readRecord = () => runTransaction("readonly", (store) => store.get(RECORD_KEY));

/** The record's descriptive fields without its rows: what's cached, from where, when, until when. */
const readMeta = () => runTransaction("readonly", (store) => store.get(META_KEY));

/**
 * Both records in one transaction, with the meta derived from the record rather than passed in
 * beside it — the two cannot describe different things, and cannot half-commit.
 */
function writeRecord(record) {
  const {payload, ...meta} = record;
  return runTransaction("readwrite", (store) => {
    store.put(meta, META_KEY);
    return store.put(record, RECORD_KEY);
  });
}

/**
 * Move the expiry forward without rewriting the payload. This is what a "not modified" answer earns:
 * the copy on the device is the current one, so it should not be asked about again until the next
 * boundary.
 */
async function restamp(at = Date.now()) {
  const record = await readRecord().catch(() => null);
  if (!record) return;
  await writeRecord({...record, checkedAt: at, expiresAt: nextExpiry(at)});
}

const deleteRecord = () => runTransaction("readwrite", (store) => {
  store.delete(META_KEY);
  return store.delete(RECORD_KEY);
});

/**
 * Whether a cached table can be read at all: written by this version of the code, from the data
 * root this app is pointed at, and not empty. Nothing here is about age — an old table is still a
 * true table, and refusing to read it would take name search away from anyone who happens to be
 * offline on the wrong day.
 *
 * Takes either record: the meta carries the same fields, which is the point of it.
 */
function isUsableMeta(meta, source) {
  return !!meta
    && meta.schema === SCHEMA_VERSION
    && meta.source === source
    && Number.isInteger(meta.n) && meta.n > 0;
}

/** The above plus the rows actually being there and being as many as the record claims. */
function isUsable(record, source) {
  return isUsableMeta(record, source)
    && Array.isArray(record.payload?.rivers)
    && record.payload.rivers.length === record.n;
}

/** Whether the copy is still inside its window, i.e. whether there is any reason to ask the server. */
const isFresh = (meta, now = Date.now()) => !!meta && now < meta.expiresAt;

export {
  META_KEY,
  RECORD_KEY,
  SCHEMA_VERSION,
  deleteRecord,
  isFresh,
  isUsable,
  isUsableMeta,
  nextExpiry,
  readMeta,
  readRecord,
  restamp,
  writeRecord
};
