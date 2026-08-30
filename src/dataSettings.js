import {heroIcon, iconButton} from './icons.js';
import {byKey, removeAll, surveyAll} from './datasets.js';
import {dataProgress, mb} from './ui.js';

const $ = id => document.getElementById(id);

/**
 * TWIN FILE: webapp-rfs-v3/src/ui/dataSettings.js — the same list over the same registry, with the
 * strings inline because this app has no i18n.
 *
 * The Settings data list: one row per entry in the dataset registry — name, size once held, a
 * download button and a trash button — over a pair of sweeping actions.
 *
 * The row buttons are each other's inverse and say so by being disabled: you cannot download what
 * is already here, or bin what isn't. That, rather than a status word, is what tells the user the
 * state of a row at a glance.
 *
 * This module names no dataset. Everything it renders comes from datasets.js, so a new cache
 * appears here by being registered there.
 */
function createDataSettings() {
  const list = $('data-list');
  const btnAll = $('btn-download-all');
  const btnNone = $('btn-delete-all');
  const footLine = $('data-foot-status');
  if (!list || !btnAll || !btnNone) return;

  // Keyed by dataset: the row's elements, plus whether a download is in flight on it.
  const rows = new Map();
  let armed = false;

  function buildRow(entry) {
    const el = document.createElement('div');
    el.className = 'data-row';
    const name = document.createElement('b');
    const size = document.createElement('span');
    size.className = 'data-size';
    const actions = document.createElement('span');
    actions.className = 'row';
    const download = iconButton('arrow-down-tray', 'Download');
    const remove = iconButton('trash', 'Delete', 'danger');
    actions.append(download, remove);
    const line = document.createElement('div');
    line.className = 'hint status';
    el.append(name, size, actions, line);

    const row = {el, name, size, download, remove, line, busy: false, held: null};
    rows.set(entry.key, row);

    download.addEventListener('click', () => (row.busy ? cancelOne(entry.key) : void downloadOne(entry.key)));
    remove.addEventListener('click', () => void removeOne(entry.key));
    return row;
  }

  /** Paint one row from its last known state. The single place row enablement is decided. */
  function paintRow(entry, row) {
    row.name.textContent = entry.label;
    row.name.title = entry.hint;
    // The size is the whole readout for a held dataset — absent means not downloaded, which is why
    // there is no "Not downloaded" text to go stale beside it.
    row.size.textContent = row.held ? `(${mb(row.held.bytes)})` : '';
    if (row.busy) {
      // Mid-download the button is the way out of it, so it must stay enabled and stop claiming
      // to be a download.
      row.download.replaceChildren(heroIcon('x-mark'));
      row.download.title = 'Cancel';
      row.download.setAttribute('aria-label', 'Cancel');
      row.download.disabled = false;
      row.remove.disabled = true;
      return;
    }
    row.download.replaceChildren(heroIcon('arrow-down-tray'));
    row.download.title = 'Download';
    row.download.setAttribute('aria-label', 'Download');
    row.download.disabled = !!row.held;
    row.remove.disabled = !row.held;
  }

  /** Re-read every dataset's state from storage and repaint. */
  async function refresh() {
    disarm();
    const survey = await surveyAll().catch(() => []);
    for (const entry of survey) {
      const row = rows.get(entry.key) ?? buildRow(entry);
      if (!row.el.isConnected) list.append(row.el);
      // A row mid-download owns its own status line; don't stomp its progress with a stale reading.
      if (!row.busy) row.line.textContent = '';
      row.held = entry.status;
      paintRow(entry, row);
      // A download this panel didn't start — the search box asking for the river IDs — is still
      // this row's download. Join it rather than showing a Download button for something already
      // downloading; downloadOne() coalesces onto the build in flight.
      if (!row.busy && entry.busy) void downloadOne(entry.key);
    }
    const held = survey.filter(e => e.status);
    btnAll.disabled = held.length === survey.length;
    btnNone.disabled = held.length === 0;
    if (footLine) {
      footLine.textContent = held.length
        ? `${held.length}/${survey.length} · ${mb(held.reduce((sum, e) => sum + e.status.bytes, 0))}`
        : 'Nothing downloaded.';
    }
    return survey;
  }

  async function downloadOne(key) {
    const entry = byKey(key);
    const row = rows.get(key);
    if (!entry || !row || row.busy) return;
    row.busy = true;
    row.line.classList.remove('error');
    row.line.textContent = 'Starting…';
    paintRow(entry, row);
    try {
      await entry.download({onProgress: p => {row.line.textContent = dataProgress(p);}});
      row.line.textContent = '';
    } catch (e) {
      row.line.textContent = e?.name === 'AbortError' ? 'Cancelled.' : `Failed: ${e.message}`;
      row.line.classList.toggle('error', e?.name !== 'AbortError');
    } finally {
      row.busy = false;
      await refresh();
    }
  }

  const cancelOne = key => byKey(key)?.cancel();

  async function removeOne(key) {
    const entry = byKey(key);
    const row = rows.get(key);
    if (!entry || !row || row.busy || !row.held) return;
    try {
      await entry.remove();
    } catch (e) {
      row.line.textContent = `Failed: ${e.message}`;
      row.line.classList.add('error');
    }
    await refresh();
  }

  function disarm() {
    armed = false;
    btnNone.textContent = 'Delete everything';
  }

  // Download everything still absent, one after another rather than at once: each is hundreds of
  // chunk requests, and overlapping them would have them fighting for the same connections.
  btnAll.addEventListener('click', async () => {
    btnAll.disabled = true;
    for (const entry of await refresh()) {
      if (!entry.status) await downloadOne(entry.key);
    }
    await refresh();
  });

  btnNone.addEventListener('click', async () => {
    // The sweeping erase is the one action here that can throw away more than the user was looking
    // at, so it takes a second click. A single row's trash does not — it is one re-download.
    if (!armed) {
      armed = true;
      btnNone.textContent = 'Click again to delete everything';
      return;
    }
    disarm();
    btnNone.disabled = true;
    await removeAll().catch(() => {});
    await refresh();
  });

  // The sizes are read when the dialog is opened rather than watched: nothing else on this page
  // shows them, and a download started elsewhere is caught by the survey's `busy` above.
  $('btn-settings')?.addEventListener('click', () => void refresh());

  void refresh();
  return {refresh};
}

export {createDataSettings};
