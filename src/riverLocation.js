import {fetchMetadataAt} from "riverforecastsystem/v3/hydrography";

/**
 * TWIN FILE: webapp-rfs-v3/src/data/riverLocation.js — the same module, keep the two in step.
 *
 * Where a reach is, by riverIndex: `{lat, lon, upstreamCount}` read straight off the hydrography
 * metadata store.
 *
 * The point is the reach's downstream end, which is what the saved rivers in src/constants.js were
 * baked from — so a searched river and a saved one send the camera to the same kind of place.
 *
 * Three chunk reads, ~40 KB each, and no artifact to build or keep: the arrays sit on the same axis
 * as the riverIds, so an index is all it takes to read one. That is why this is looked up when a
 * reach needs it rather than downloaded up front like the id lookup next door — one reach costs a
 * fraction of a percent of what the whole axis would.
 *
 * `upstreamCount` rides along for the explorer, whose selection is the run of riverIndex above the
 * reach and cannot be built without it. This app ignores it. One read either way.
 */
// Searching the same reach twice, or flying to one whose charts are already open, must not go back
// to the network. Bounded only by how many reaches a session visits, at two numbers each.
const known = new Map();

async function locate(riverIndex) {
  const index = Number(riverIndex);
  if (!Number.isInteger(index) || index < 0) return null;
  const cached = known.get(index);
  if (cached) return cached;
  const {lat, lon, upstreamCount} = await fetchMetadataAt({variables: ["lat", "lon", "upstreamCount"], index});
  // A store that answers with something other than a coordinate is not a place to fly to. Better to
  // leave the camera where it is than to send it to (0, 0).
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const at = {lat, lon, upstreamCount};
  known.set(index, at);
  return at;
}

export {locate};
