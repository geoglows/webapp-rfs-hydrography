/**
 * The settings modal, and what it remembers.
 *
 * Same shape as the RFS v3 app's: a cog in the header opens a dialog over the page, the Display
 * block is a list of checkboxes, and each one is stored per device under its own key. There is one
 * setting so far — whether the map's legend is drawn — but a second is a line in SETTINGS and a
 * label in the markup, which is the reason this is a table rather than three lines in main.js.
 *
 * Nothing here touches the map directly. A caller subscribes with onSetting() and does the work.
 */

import BUILD_DATE from 'virtual:build-date';

// The app's own namespace. The theme is the one thing deliberately shared with RFS v3 (see main.js);
// everything else is this app's alone, so it is keyed like its picks and its multi-select mode.
const STORAGE_PREFIX = 'rfs-hydrography-setting-';

const SETTINGS = [
  {key: 'legend', el: 'set-legend', fallback: true},
];

const values = new Map();
const listeners = new Map();

const $ = id => document.getElementById(id);

const read = key => {
  try {
    return localStorage.getItem(STORAGE_PREFIX + key);
  } catch {
    return null;
  }
};

const write = (key, value) => {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, String(value));
  } catch { /* private mode — the choice holds for this tab and is not remembered */ }
};

export const getSetting = key => values.get(key) ?? false;

function setSetting(key, value) {
  if (values.get(key) === value) return;
  values.set(key, value);
  write(key, value);
  for (const fn of listeners.get(key) ?? []) fn(value);
}

/**
 * Run fn whenever the setting changes, and once now with what it already is — so a subscriber never
 * has to apply the stored value itself and then remember to keep up with it.
 */
export function onSetting(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  fn(getSetting(key));
}

const openModal = id => $(id).classList.remove('hidden');
const closeModal = id => $(id).classList.add('hidden');

/** Read every setting, wire its checkbox, and open the dialog they live in. Call once, first. */
export function initSettings() {
  for (const setting of SETTINGS) {
    const stored = read(setting.key);
    values.set(setting.key, stored === null ? setting.fallback : stored === 'true');
    const el = $(setting.el);
    if (!el) continue;
    el.checked = values.get(setting.key);
    el.addEventListener('change', () => setSetting(setting.key, el.checked));
  }

  if ($('build-date')) $('build-date').textContent = BUILD_DATE;
  $('btn-settings').addEventListener('click', () => openModal('settings-modal'));
  for (const el of document.querySelectorAll('[data-close]')) {
    el.addEventListener('click', () => closeModal(el.dataset.close));
  }
  // The backdrop is the dialog's own outer element, so a click that lands on the dimmed page rather
  // than on the card is a click outside it.
  for (const modal of document.querySelectorAll('.backdrop')) {
    modal.addEventListener('click', e => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  }
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    for (const modal of document.querySelectorAll('.backdrop')) modal.classList.add('hidden');
  });
}
