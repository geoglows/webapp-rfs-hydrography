/**
 * The multi-select list: what has been collected.
 *
 * The rows are the working set — newest first, because the one you just clicked is the one you are
 * checking. Everything a row shows is the reason you would take it back off the list: which Group
 * it is in, how big the watershed is, what order the outlet is.
 *
 * Copying, downloading and clearing are not here: those are one button each at the head of the
 * column, shared by all four selection methods, because they mean the same thing in each of them.
 *
 * Built as nodes; the ids come out of the tiles, so nothing from the data becomes markup.
 */
import {MAX_PICKS, picks} from './picks.js';
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

function pickRow(p, i, total, {onRemove, onZoom}) {
  const row = el('div', 'pick-row');
  const n = el('span', 'pick-n', String(total - i));
  const id = el('span', 'pick-id', String(p.outletId));
  const meta = el('span', 'pick-meta', [
    p.groupId != null ? `group ${p.groupId}` : null,
    `${fmt(p.count)} reach${p.count === 1 ? '' : 'es'}`,
    p.strahlerOrder != null ? `ord ${p.strahlerOrder}` : null,
  ].filter(Boolean).join(' · '));
  const box = el('div', 'pick-main');
  box.append(id, meta);
  row.append(n, box);
  if (p.lon != null && p.lat != null) {
    row.append(button('mini', '⤢', `Centre the map on ${p.outletId}`, () => onZoom(p)));
  }
  row.append(button('mini danger', '×', `Take ${p.outletId} off the list`, () => onRemove(p)));
  return row;
}

/** Repaint the whole body for the current list. */
export function renderPicks(mount, {onRemove, onZoom}) {
  const list = picks.all();
  const out = [];
  if (!list.length) {
    out.push(el('div', 'picks-empty', 'Nothing collected yet.'));
  } else {
    const rows = el('div', 'picks-list');
    list.forEach((p, i) => rows.append(pickRow(p, i, list.length, {onRemove, onZoom})));
    out.push(rows);
  }
  if (picks.full()) {
    out.push(el('div', 'picks-empty',
      `The list is at its ${fmt(MAX_PICKS)}-pick ceiling — export it and clear it to keep going.`));
  }
  mount.replaceChildren(...out);
}
