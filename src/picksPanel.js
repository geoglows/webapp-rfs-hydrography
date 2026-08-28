/**
 * The multi-select list: what has been collected, and how it leaves the app.
 *
 * The rows are the working set — newest first, because the one you just clicked is the one you are
 * checking. Everything a row shows is the reason you would take it back off the list: which Group
 * it is in, how big the watershed is, what order the outlet is.
 *
 * Built as nodes; the ids come out of the tiles, so nothing from the data becomes markup.
 */
import {csv, idsJson, idsText, MAX_PICKS, picks} from './picks.js';
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

/** A file the browser saves without a round trip — the list never leaves the machine. */
function download(text, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type}));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function copy(text, label, report) {
  if (!text) return report('Nothing collected yet, so there is nothing to copy.', 'error');
  try {
    await navigator.clipboard.writeText(text);
    report(`${label} copied to the clipboard.`, 'success');
  } catch (err) {
    // Clipboard access is denied on an insecure origin and in some embeddings; the list is still
    // reachable, so say where it is rather than just failing.
    console.warn('[picks] clipboard write refused', err);
    report(`Could not reach the clipboard (${err.message}) — use the CSV download instead.`, 'error');
  }
}

function actions({report, onClear}) {
  const row = el('div', 'picks-actions');
  row.append(
    button('mini', 'Copy ids', 'One outlet riverId per line, oldest pick first',
      () => copy(idsText(), `${picks.count()} outlet ids`, report)),
    button('mini', 'Copy JSON', 'The outlet ids as a JSON array',
      () => copy(idsJson(), `${picks.count()} outlet ids as JSON`, report)),
    button('mini', 'CSV', 'Every column the app knows about each pick, as a file',
      () => {
        if (!picks.count()) return report('Nothing collected yet, so there is nothing to save.', 'error');
        download(csv(), `rfs_v3_outlets_${picks.count()}.csv`, 'text/csv');
        report(`Saved rfs_v3_outlets_${picks.count()}.csv`, 'success');
      }),
    button('mini danger', 'Clear', 'Empty the collection', onClear),
  );
  return row;
}

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
export function renderPicks(mount, {onRemove, onZoom, onClear, report}) {
  const list = picks.all();
  const out = [
    el('div', 'picks-hint',
      'Click a river to collect the watershed above it. Shift-click (or ⌘-click) collects one ' +
      'without leaving single-select, and M toggles the mode.'),
    actions({report, onClear}),
  ];
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
