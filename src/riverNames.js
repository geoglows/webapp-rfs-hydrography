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
 * regenerated whenever a name is added, so a fetch is the cheap half of that trade. The fetch and
 * the copy kept on the device belong to riverNamesData.js, which the search box reads too.
 *
 * The colours live here, not in the file. What arrives from the generator is a slot number per
 * river; what a slot looks like is this app's business, which is what lets the palette be redrawn
 * without regenerating anything.
 */
import {load as loadNamesTable, payload} from './riverNamesData.js';
/**
 * Four of a six-colour set specified by hand — the palette as of commit c3084fb. The other two are
 * spoken for: the blue is the rivers' own colour, which is what unnamed water keeps below, and the
 * purple belongs to the group boundaries, so neither can also mean "a named river".
 *
 * Slot 3 is a near-white. It measures 1.24:1 against a light basemap and 1.20:1 against the dark one
 * the app opens on, where unnamed water sits at 3.09:1 — so a river painted in it reads as less
 * marked than an unnamed one. That is a known defect of this set, not a subtlety; see the README for
 * what the alternatives cost. It is here because it is what is committed.
 */
export const PALETTE = ['#FBBF24', '#34D399', '#FCA5A5', '#E5E7EB'];

/**
 * Unnamed reaches keep exactly what the network already draws itself in, at its own width. Named
 * water is the only thing the mode adds, which is what makes it read.
 */
export const UNNAMED = '#3B82F6';

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
 * The one `step` expression the mode is built on: reach in, **bin number** out, exactly the numbers
 * the generator assigned — 0..slots-1 for a named river, -1 for unnamed water.
 *
 * The bin is the thing that comes from the data, and it is the only large array here. Colour and
 * width are then read *off* the bin by two small expressions that name it as their input, so a
 * palette change rewrites seven entries rather than a thousand stops, and the two channels cannot
 * disagree about which reaches are named. Built once when the file arrives: it is identical every
 * time the mode goes on, and reassembling it on each restyle would be the one expensive thing in a
 * path that runs on every zoom, every rule edit and every click.
 */
function compile(d) {
  const bin = ['step', ['get', 'riverIndex'], d.first];
  for (let i = 0; i < d.bounds.length; i++) bin.push(d.bounds[i], d.stops[i]);
  return {
    slots: d.slots,
    bin,
    // Smallest span first, which is the order `nameAt` needs: the winner on a reach is the
    // innermost named river containing it, the same rule the colouring paints by.
    bySize: [...d.rivers].sort((a, b) => (a.hi - a.lo) - (b.hi - b.lo)),
    riverCount: d.rivers.length,
    namedReaches: d.namedReaches,
    watershedCount: new Set(d.rivers.map(r => r.outletRiverId)).size,
    rivers: d.rivers,
    // Everything named is everything the bin did not send to -1.
    named: ['>=', bin, 0],
  };
}

/**
 * The palette applied to the bins: `match` the bin number, one arm per slot, and let the fallback
 * take -1.
 *
 * Truncated to the bins actually in play rather than trusted to be the right length. A palette
 * shorter than the generator's SLOTS would otherwise resolve a real bin to `undefined` and paint
 * that reach the fallback colour, which is the one reserved for meaning "no name" — a wrong answer
 * that looks like a correct one.
 */
function colorExpr() {
  const expr = ['match', names.bin];
  for (let i = 0; i < Math.min(PALETTE.length, names.slots); i++) expr.push(i, PALETTE[i]);
  expr.push(UNNAMED);
  return expr;
}

/**
 * Compile the table, fetching it if nothing has yet. Throws if it is missing or malformed — a data
 * root published before this file existed simply has no names, and the caller turns the mode off
 * rather than the app failing to start over a layer nobody has asked for yet.
 */
export async function loadRiverNames() {
  if (names) return names;
  // riverNamesData.js owns the fetch and the copy on the device, because the search box next door
  // reads the same file — whichever asks first is the one that fetches it, and neither refetches it
  // on the next reload. The rows it prepares are for searching; the parts this file paints from sit
  // beside them in the payload.
  await loadNamesTable();
  const d = payload();
  if (!Array.isArray(d?.bounds) || !Array.isArray(d?.stops) || !Array.isArray(d?.rivers)) {
    throw new Error('riverNames.json is not the shape this app reads');
  }
  names = compile(d);
  return names;
}

/**
 * The named river a reach belongs to, or null if no name covers it.
 *
 * The answer is the *smallest* named span containing the reach, which is what makes it read as "the
 * name of the exact segment you clicked, or the river you are an unnamed tributary of". A reach on
 * the Bighorn answers Bighorn River rather than Missouri River, because the Bighorn's span is the
 * tighter of the two containing it — and an unnamed creek off the Bighorn also answers Bighorn
 * River, because that is the nearest thing the table can say about it.
 *
 * A linear scan of ~540 spans per click, which is nothing against the tile query that produced the
 * click. It reads the same array the panel and the search box already hold, rather than another
 * index that could disagree with them.
 */
export function nameAt(riverIndex) {
  if (names == null || !Number.isFinite(riverIndex)) return null;
  return names.bySize.find(r => r.lo <= riverIndex && riverIndex <= r.hi) ?? null;
}

/** What compileLayers() takes to paint the mode, or null while there is nothing to paint with. */
export const namesStyle = () =>
  names && {color: colorExpr(), named: names.named, scale: NAMED_WIDTH_SCALE};
