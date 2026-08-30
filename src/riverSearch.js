import {resolve} from './riverIndex.js';
import {load as loadNames, search as searchNames} from './riverNamesData.js';
import {locate} from './riverLocation.js';
import {dataProgress} from './ui.js';

const $ = id => document.getElementById(id);

// Long enough that a burst of typing is one search, short enough to feel like none. The search
// itself is a scan of a few hundred rows in memory, so this is about how often the list is rebuilt
// under the user's eyes, not about cost.
const TYPING_MS = 120;

/**
 * TWIN FILE: webapp-rfs-v3/src/ui/riverSearch.js — the same dialog, doing the same two searches
 * over the same two datasets. That app runs its text through i18n and this one has none, so the
 * strings are inline here; everything else should stay in step.
 *
 * Find a reach by name, or by ID — two boxes, because they are two different questions.
 *
 * They are kept apart rather than merged into one field that guesses from what was typed, because
 * almost nothing about them is the same. A name is answered from a ~100 kB table the app keeps on
 * the device, matches loosely, can return a dozen rivers, and needs a list to choose from. An ID is
 * exact, returns one reach or none, and has to be resolved against the riverId axis — a one-time
 * ~17 MB download on a device without the lookup. One box would have to be a name box that
 * sometimes takes 17 MB, with a results list that sometimes appears, under a label that could only
 * describe both vaguely.
 *
 * The split is also what lets each say the right thing when it fails: "no named river matches that"
 * and "no river has that ID" are different answers, and neither belongs under the other's box. So
 * each half has its own status line.
 *
 * Only the name box is worth typing into as you go — its answers are already on the device, and
 * every row carries the span of riverIndex the river covers, so a name hit needs no lookup at all.
 *
 * onFound(reach, named) hands the result on. `reach` is the reach and nothing else — riverId,
 * riverIndex, upstreamCount, and where it is — in the shape a map click would have produced, since
 * that is what the selection is built from. `named` is only sent for a river found by name: its
 * `span` is the whole named river to select, and `bbox` is what the camera frames instead of the
 * mouth.
 *
 * onClear() takes the selection back off. It needs asking for: the selection deliberately outlives
 * this dialog, which is the point of making one, so nothing else is going to notice the user is
 * done with it.
 */
function createRiverSearch({onFound, onClear}) {
  const modal = $('search-modal');
  const nameForm = $('search-name-form');
  const nameInput = $('search-river-name');
  const nameLine = $('search-name-status');
  const idForm = $('search-id-form');
  const idInput = $('search-river-id');
  const idLine = $('search-id-status');
  const results = $('search-results');
  const clearBtn = $('search-clear');
  if (!modal || !nameForm || !nameInput || !nameLine || !idForm || !idInput || !idLine || !results) return;

  let busy = false;
  // Which lines are currently showing a rejection, so typing clears only the box's own.
  const errored = new Set();
  let typing = null;
  // The rows on screen now, so Enter can take the first one without reading them back out of the DOM.
  let shown = [];
  // Whether a river found here is currently selected. The selection deliberately outlives this
  // dialog — you close it to look at the river — so the only thing that knows it is still there is
  // this flag, and the Clear button is off until there is something to clear.
  let highlighted = false;

  /**
   * A status line carries everything its box has to say, so a rejection has to look different from
   * "Searching…" — same element, same dim hint styling otherwise, and a "no such river" that reads
   * as progress text is a message the user does not register.
   *
   * `error` is for answers the user has to act on: a malformed ID, an ID the network doesn't have.
   * A slow first search is not one — it is progress, and it says so in the same place.
   */
  function say(line, input, text, {error = false} = {}) {
    line.textContent = text;
    line.classList.toggle('error', error);
    input.setAttribute('aria-invalid', String(error));
    if (error) errored.add(line);
    else errored.delete(line);
  }

  const sayName = (text, opts) => say(nameLine, nameInput, text, opts);
  const sayId = (text, opts) => say(idLine, idInput, text, opts);

  const close = () => modal.classList.add('hidden');

  /**
   * Take the found river off the map, and empty the box that put it there.
   *
   * Both, because a cleared map under a box still showing "Severn" and its results looks like the
   * search failed rather than like the selection was removed.
   */
  function clearHighlight() {
    highlighted = false;
    nameInput.value = '';
    renderResults([]);
    sayName('');
    if (clearBtn) clearBtn.disabled = true;
    onClear?.();
  }

  function open() {
    modal.classList.remove('hidden');
    // The name box, not the ID box: it is the one most people want, and the one that costs nothing.
    nameInput.focus();
    nameInput.select();
    sayName('');
    sayId('');
    if (clearBtn) clearBtn.disabled = !highlighted;
    // The names are wanted the moment this box is opened. The colouring mode next door asks for the
    // same table, and whichever asks first is the one that fetches it.
    void loadNames().then(() => {
      if (!modal.classList.contains('hidden')) runNameSearch();
    }).catch(e => console.warn(`[names] the river names could not be loaded: ${e.message}`));
  }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  /**
   * The line under a name that says which river this one is.
   *
   * Two Severns and three Verdes are in the table, so the name alone is not an answer. What
   * separates them, in the order a person actually reads: the country it is in, then the river it
   * flows into if it is a tributary, then the system it belongs to. The watershed is dropped when
   * it only repeats one of the other two, which is the common case for a river that names its own
   * basin — "Severn · United Kingdom" rather than "Severn · United Kingdom · Severn".
   */
  function describe(river) {
    const parts = [river.country, river.parentName && `flows into the ${river.parentName}`];
    if (river.watershed && river.watershed !== river.name && river.watershed !== river.parentName) {
      parts.push(river.watershed);
    }
    return parts.filter(Boolean).join(' · ');
  }

  /**
   * Go to a river the user picked out of the list.
   *
   * The row already carries the whole span — `lo`, `hi` and the mouth's riverId — so a named river
   * is selected without reading anything: the span is what the highlight, the catchment shading and
   * the export all take. Nothing is looked up on this path at all.
   */
  function pick(river) {
    close();
    // Two arguments, not one object. The first is the reach, in the shape a click on the mouth would
    // have produced; the extent and the span are instructions about the whole river, and go beside
    // it rather than inside a record that is read as one reach's attributes.
    onFound?.(
      {riverId: river.riverId, riverIndex: river.riverIndex, upstreamCount: river.hi - river.lo},
      {bbox: river.bbox, span: {lo: river.lo, hi: river.hi}, name: river.name},
    );
    highlighted = true;
    if (clearBtn) clearBtn.disabled = false;
  }

  function renderResults(rivers) {
    shown = rivers;
    results.replaceChildren(...rivers.map(river => {
      const row = el('button', 'search-hit');
      row.type = 'button';
      row.append(el('b', null, river.name), el('span', 'hint', describe(river)));
      row.addEventListener('click', () => pick(river));
      return row;
    }));
    results.classList.toggle('hidden', !rivers.length);
    nameInput.setAttribute('aria-expanded', String(rivers.length > 0));
  }

  /** Names, on every keystroke. Silent about an empty box; explicit about a query that found nothing. */
  function runNameSearch() {
    const raw = nameInput.value.trim();
    if (!raw) {
      renderResults([]);
      sayName('');
      return;
    }
    const hits = searchNames(raw);
    renderResults(hits);
    if (!hits.length) {
      sayName(`No named river matches “${raw}”. Only major rivers are named; every reach can still `
        + 'be found by ID.', {error: true});
    } else sayName('');
  }

  /** IDs, on submit, because this is the half that may have to download 17 MB first. */
  async function searchById(raw) {
    if (busy) return;
    if (!/^\d+$/.test(raw)) {
      sayId('Enter a river ID — digits only.', {error: true});
      return;
    }
    busy = true;
    // The first search of a session pulls ~44 MB of typed arrays out of IndexedDB; later ones are a
    // binary search over memory. Only the first is slow enough to need saying, but saying it always
    // is simpler than deciding.
    sayId('Searching…');
    try {
      // Downloads the lookup if this device hasn't got it — the status line turns into a progress
      // reading for as long as that takes, and the search finishes on the far side of it.
      const riverIndex = await resolve(raw, {onProgress: p => sayId(dataProgress(p))});
      if (riverIndex < 0) {
        sayId(`No river with ID ${raw} is in the network.`, {error: true});
        return;
      }
      // The reach is found either way; where it is and how much drains into it is a second, smaller
      // read — and the selection cannot be built without the upstream count.
      const at = await locate(riverIndex).catch(e => {
        console.error(`could not locate river ${raw}: ${e.message}`);
        return null;
      });
      if (!at) {
        sayId('That river is in the network, but the metadata store would not say where it is.',
          {error: true});
        return;
      }
      close();
      onFound?.({
        riverId: Number(raw), riverIndex, upstreamCount: at.upstreamCount, lat: at.lat, lon: at.lon,
      });
      highlighted = true;
      if (clearBtn) clearBtn.disabled = false;
    } catch (e) {
      sayId(`Search failed: ${e.message}`, {error: true});
    } finally {
      busy = false;
    }
  }

  // Forms rather than click handlers: Enter submits for free, which is how a search box is used, and
  // Enter in one box cannot submit the other.
  nameForm.addEventListener('submit', e => {
    e.preventDefault();
    const raw = nameInput.value.trim();
    // Enter takes the top row, which is the one the ranking put there. Typing a name and pressing
    // Enter is how this box is used when the answer is obvious, and reaching for the mouse to
    // confirm a single result is not.
    if (shown.length) return void pick(shown[0]);
    if (raw) {
      sayName(`No named river matches “${raw}”. Only major rivers are named; every reach can still `
        + 'be found by ID.', {error: true});
    }
  });

  idForm.addEventListener('submit', e => {
    e.preventDefault();
    void searchById(idInput.value.trim());
  });

  nameInput.addEventListener('input', () => {
    // A rejection of the last thing typed, sitting under the thing being typed now, reads as a
    // rejection of this one.
    if (errored.has(nameLine)) sayName('');
    clearTimeout(typing);
    typing = setTimeout(runNameSearch, TYPING_MS);
  });

  // Only clears errors, so an in-flight download's progress isn't wiped by typing beside it.
  idInput.addEventListener('input', () => {
    if (errored.has(idLine)) sayId('');
  });

  clearBtn?.addEventListener('click', () => clearHighlight());

  $('btn-search')?.addEventListener('click', () => open());

  return {open, close};
}

export {createRiverSearch};
