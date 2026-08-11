/**
 * The subset, as arithmetic. That is the whole of this file, and it makes no request of any kind.
 *
 * v3 numbers reaches in post-order: a reach's `riverIndex` comes after every reach that drains into
 * it, so **the reaches upstream of X are exactly the indices `[X.riverIndex - X.upstreamCount,
 * X.riverIndex]`** — a range, closed at both ends, holding `upstreamCount + 1` reaches counting X
 * itself. There is no graph to build and nothing to traverse. Both numbers are attributes on the
 * stream tiles, so a map click resolves a 234,000-reach watershed with no network request at all.
 *
 * That replaced this file's previous job. It used to fetch `group_index.json`, work out which Group
 * could hold a typed id, range-read several MB of `metadata_<group>.parquet`, build a reverse
 * adjacency over every reach in the Group and walk it. All of it is gone, and with it the app's
 * dependency on `group_index.json` — an artifact this app published for itself, describing per-Group
 * id ranges and bboxes that only existed to answer "which metadata file do I open".
 *
 * `partitions.parquet` went the same way. It mapped riverIndex blocks to Groups, which the app read
 * at boot for one thing that mattered — naming the Group whose geometry file the export opens — and
 * the stream tiles carry `groupId` on every reach, so a click already knows the answer the file was
 * being read to supply.
 *
 * `riverId_riverIndex.parquet` was the last of them. It was a global riverIndex -> riverId table
 * published for one job: the ID list export, which turned a selected index range back into ids.
 * That export is gone — the selection box prints the index range, which is the subset, and the
 * GeoParquet files carry `riverId` on every row for anyone who wants the ids themselves. So the
 * lookup went with it, and nothing on the main thread reads a parquet file any more: the only two
 * this app opens are the two geometry files, in the export worker.
 */

/**
 * The subset of a reach, from its own two numbers. This is the whole selection engine.
 *
 * `upstreamCount` excludes the reach itself, so the range is inclusive at both ends and holds
 * `upstreamCount + 1` reaches. A headwater has `upstreamCount` 0 and selects only itself.
 */
export function upstreamRange({riverIndex, upstreamCount}) {
  const hi = Number(riverIndex);
  const n = Number(upstreamCount);
  if (!Number.isInteger(hi) || hi < 0) throw new Error(`riverIndex ${riverIndex} is not an index`);
  if (!Number.isInteger(n) || n < 0) throw new Error(`upstreamCount ${upstreamCount} is not a count`);
  return {lo: hi - n, hi, count: n + 1};
}
