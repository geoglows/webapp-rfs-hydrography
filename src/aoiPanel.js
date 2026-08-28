/**
 * The AOI subsetter's card: where the outlet is, what the inlets took off, and how much is left.
 *
 * Two steps, in the order they are done, so the card reads as instructions until it is a summary.
 * Every row is a reason to take an inlet back off — which reach it is, and how much of the AOI it
 * is holding back — because that is the only decision left once the outlet is placed.
 *
 * Built as nodes; the ids come out of the tiles, so nothing from the data becomes markup.
 */
import {inletCut} from './aoi.js';
import {fmt} from './ui.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const button = (cls, text, title, onclick) => {
  const b = el('button', cls, text);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onclick);
  return b;
};

/** How many reaches this inlet is keeping out, on its own terms — before any overlap with others. */
const cutSize = inlet => {
  const cut = inletCut(inlet);
  return cut.hi - cut.lo + 1;
};

function inletRow(inlet, {onRemove, onZoom}) {
  const row = el('div', 'pick-row');
  const main = el('div', 'pick-main');
  main.append(
    el('span', 'pick-id', String(inlet.outletId)),
    el('span', 'pick-meta', [
      `−${fmt(cutSize(inlet))} reaches`,
      inlet.strahlerOrder != null ? `ord ${inlet.strahlerOrder}` : null,
    ].filter(Boolean).join(' · ')),
  );
  row.append(el('span', 'pick-n', '↧'), main);
  if (inlet.lon != null && inlet.lat != null) {
    row.append(button('mini', '⤢', `Centre the map on ${inlet.outletId}`, () => onZoom(inlet)));
  }
  row.append(button('mini danger', '×', `Put ${inlet.outletId} and the ground above it back in the AOI`,
    () => onRemove(inlet)));
  return row;
}

/** Repaint the whole body for the current state. */
export function renderAoi(mount, state, {onRemove, onZoom, onClear}) {
  const {outlet, inlets, count, trimmed} = state;
  const out = [];

  // The hint is the instruction for the step you are actually on, not both steps at once.
  out.push(el('div', 'picks-hint', outlet
    ? 'Now click each inlet. The inlet and everything draining into it are cut out of the AOI. ' +
      'Click an inlet again to put it back.'
    : 'Click the reach at the outlet of your area of interest — everything upstream of it is ' +
      'selected, the same as a watershed selection.'));

  out.push(button('mini danger', 'Clear AOI', 'Drop the outlet and every inlet', onClear));

  if (!outlet) {
    out.push(el('div', 'picks-empty', 'No outlet yet.'));
    mount.replaceChildren(...out);
    return;
  }

  const head = el('div', 'aoi-head');
  head.append(
    el('span', 'aoi-k', 'outlet'),
    el('span', 'aoi-outlet', String(outlet.outletId)),
    el('span', 'pick-meta', `${fmt(count)} of ${fmt(outlet.count)} reaches kept`),
  );
  out.push(head);

  if (!inlets.length) {
    out.push(el('div', 'picks-empty', 'No inlets yet — the AOI is the whole watershed.'));
  } else {
    const rows = el('div', 'picks-list');
    for (const inlet of inlets) rows.append(inletRow(inlet, {onRemove, onZoom}));
    out.push(rows);
    out.push(el('div', 'picks-empty',
      `${fmt(inlets.length)} inlet${inlets.length === 1 ? '' : 's'} · ${fmt(trimmed)} reaches trimmed off.`));
  }

  mount.replaceChildren(...out);
}
