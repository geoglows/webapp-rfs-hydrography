/**
 * What one clicked reach actually says.
 *
 * The click that picks an outlet hands back the feature's whole property bag, and until now only
 * the four fields the subset needs were ever shown. This renders the rest of it: every attribute
 * the tiles carry for that reach, under the same labels, units and notes the styling panel's field
 * list uses, in the same order — measures first, then categories, then the identifiers. The order
 * is the grouping: no headings are drawn over the runs, because the rows themselves are the list
 * you scan and a heading every few rows is what breaks that scan up.
 *
 * Everything is built as nodes. The values come out of the tiles, so none of them gets to be markup.
 */
import {compact, fieldInfo, roleRank} from './streamAttributes.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const isNum = v => typeof v === 'number' && isFinite(v);

/** The exact number, grouped — what the compact form is standing in for. */
const full = v => (isNum(v) ? v.toLocaleString(undefined, {maximumFractionDigits: 3}) : String(v));

/**
 * An id is never abbreviated and never grouped: 760282970 is the thing you paste somewhere else,
 * and "760.3 M" is not. A measure is abbreviated, because 5384105885696 m² tells you nothing at a
 * glance — the exact figure is on the row's tooltip.
 */
function valueOf(name, v, info) {
  if (v == null || v === '') return {text: '—', title: `${name} is not set on this reach`};
  if (!isNum(v)) return {text: String(v), title: `${name} = ${v}`};
  const unit = info.unit ? ` ${info.unit}` : '';
  if (info.role === 'identity') return {text: String(v), title: `${name} = ${v}`};
  return {text: `${compact(v)}${unit}`, title: `${name} = ${full(v)}${unit}`};
}

function row(name, v) {
  const info = fieldInfo(name, typeof v === 'string' ? 'string' : 'number');
  const {text, title} = valueOf(name, v, info);
  const r = el('div', `river-row river-${info.role}`);
  const key = el('span', 'river-k', info.label);
  key.title = info.note ? `${name} — ${info.note}` : name;
  const val = el('span', 'river-v', text);
  val.title = title;
  r.append(key, val);
  return r;
}

/**
 * Repaint the panel for one feature's properties. Fields are ordered exactly as the styling panel
 * orders them, so the same attribute sits in the same place in both.
 *
 * `props` is null when nothing has been clicked yet: the section stays on the page, and its body is
 * empty until there is a reach to describe.
 */
export function renderRiverAttributes(mount, props) {
  if (props == null) return mount.replaceChildren();
  const names = Object.keys(props).sort((a, b) => {
    const ia = fieldInfo(a, typeof props[a] === 'string' ? 'string' : 'number');
    const ib = fieldInfo(b, typeof props[b] === 'string' ? 'string' : 'number');
    return (roleRank(ia.role) - roleRank(ib.role)) || ia.label.localeCompare(ib.label);
  });
  const out = [];
  for (const name of names) out.push(row(name, props[name]));
  mount.replaceChildren(...out);
}
