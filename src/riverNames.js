/**
 * Which reaches carry a river name, and what colour that makes them.
 *
 * `network_data/river_names.csv` in the hydrography repo names rivers by the riverId of the reach
 * each name ends on. The rule it encodes is that a name covers everything upstream of that reach,
 * and a tributary named further up overwrites it there — so the name on a reach is the one from the
 * *smallest* named span containing it, and it reads as "the name of the exact segment you clicked,
 * or you are in an unnamed tributary of that name".
 *
 * Everything upstream of a reach is one contiguous run of riverIndex (the same fact the watershed
 * selector is built on), and riverIndex is unique across the whole network, so all of that reduces
 * to intervals on one global axis. `extras_river_name_ranges.py` flattens them to disjoint runs and
 * resolves the colours — which depend on the arrangement, not on the river, since two spans that
 * touch must not share one. What arrives here is the answer, not the inputs to it: a sorted list of
 * boundaries and the palette slot in force after each.
 *
 * It is **fetched from group=0, beside the tiles**, not bundled. The spans are riverIndex values,
 * which mean nothing except against the exact network `streams.pmtiles` was cut from — so the two
 * have to travel together. A copy compiled into this app would keep painting confidently after the
 * network was rebuilt underneath it, pointing at reach numbers that had moved. It is also small and
 * regenerated whenever a name is added, so a fetch is the cheap half of that trade.
 *
 * Two of the six colours the palette was drawn from never reach this file: the blue belongs to the
 * rivers themselves, which is what unnamed water keeps, and the purple belongs to the group
 * boundaries. A colour that already means something on this map cannot also mean "a named river".
 */
import {URLS} from './config.js';

/**
 * How much heavier a named reach is drawn. A multiple rather than a fixed number of pixels, so the
 * weight holds across whatever zoom ramp the styling panel sets — at z9 the default 1.4px base
 * becomes 3.5px. Width is doing real work here, not decoration: it is the second channel the
 * named/unnamed split is carried on, so the split survives being printed, being looked at by
 * someone who cannot separate the hues, and being glanced at from across a room.
 */
export const NAMED_WIDTH_SCALE = 2.5;

let names = null;

/** What the app knows about the names, or null until the fetch lands. */
export const riverNames = () => names;

/**
 * The two `step` expressions, built once when the file arrives: one over every reach on the map for
 * the colour, and the same boundaries again as a predicate for the width ramp. Kept rather than
 * rebuilt, because they are identical every time the mode goes on and reassembling an 800-stop
 * array on each restyle would be the one expensive thing in a path that runs on every zoom, every
 * rule edit and every click.
 */
function compile(d) {
  const slot = i => (i < 0 ? d.unnamed : d.palette[i]);
  const color = ['step', ['get', 'riverIndex'], slot(d.first)];
  const named = ['step', ['get', 'riverIndex'], d.first >= 0];
  for (let i = 0; i < d.bounds.length; i++) {
    color.push(d.bounds[i], slot(d.stops[i]));
    named.push(d.bounds[i], d.stops[i] >= 0);
  }
  return {
    palette: d.palette,
    unnamed: d.unnamed,
    riverCount: d.rivers.length,
    namedReaches: d.namedReaches,
    watershedCount: new Set(d.rivers.map(r => r.outletRiverId)).size,
    rivers: d.rivers,
    color,
    named,
  };
}

/**
 * Fetch and compile the table. Throws if it is missing or malformed — a data root published before
 * this file existed simply has no names, and the caller turns the mode off rather than the app
 * failing to start over a layer nobody has asked for yet.
 */
export async function loadRiverNames() {
  if (names) return names;
  const res = await fetch(URLS.riverNames);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const d = await res.json();
  if (!Array.isArray(d?.bounds) || !Array.isArray(d?.palette) || !Array.isArray(d?.rivers)) {
    throw new Error('riverNames.json is not the shape this app reads');
  }
  names = compile(d);
  return names;
}

/** What compileLayers() takes to paint the mode, or null while there is nothing to paint with. */
export const namesStyle = () =>
  names && {color: names.color, named: names.named, scale: NAMED_WIDTH_SCALE};
