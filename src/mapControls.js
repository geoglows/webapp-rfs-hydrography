/**
 * What is drawn on the map, and what says so: the layer switches in the column, the basemap picker
 * floating over the map, and the legend in its bottom corner.
 *
 * The basemap is a picker over the map because that is where RFS v3 puts it, and because choosing
 * one is a glance at the map rather than a trip to the column. The layer switches are in the column
 * with the rest of the controls — they are read against the section under them, not against the
 * tiles.
 *
 * The layer list is here rather than in the markup because three things read it: the row that
 * switches a layer on, the legend row that names its colour, and the sync that greys out both when
 * the open dataset does not publish those tiles.
 */
import {BASEMAPS, currentBasemap, layersPresent, layersVisible, setBasemap, setLayersVisible,
  setStreamsVisible, streamLayerIds} from './map.js';
import {calciteIcon} from './icons.js';

const LAYERS = [
  {
    // First, because it is the layer the app is about: everything else is drawn to be read against
    // it. `layers` is a function here rather than a list - the styled network is recompiled on
    // every rule edit and selection, so its layer ids are only knowable at the moment of asking -
    // and `onToggle` goes through map.js so the choice outlives those rebuilds.
    label: 'Streams',
    layers: streamLayerIds,
    onToggle: setStreamsVisible,
    swatch: 'stream',
    title: 'The river network itself. Turning it off leaves the polygons and the selection ' +
      'behind, for reading a catchment or a group boundary without lines over it.',
  },
  {
    label: 'Group boundaries',
    layers: ['group-fill', 'group-line'],
    swatch: 'poly',
  },
  {
    label: 'HydroBASINS level 2',
    layers: ['basin-fill', 'basin-line'],
    swatch: 'poly basin',
    title: 'HydroBASINS level 2 — the 62 continental drainage regions. Click inside one to read ' +
      'its HYBAS_ID.',
  },
  {
    label: 'Catchments',
    layers: ['catchment-fill', 'catchment-outlet', 'catchment-line'],
    swatch: 'catchment',
    title: 'The land draining to each reach. Merged into basins below z10; one polygon per reach, ' +
      'and coloured with the selection, from z10 up.',
  },
];

const MISSING = 'These tiles are not published in this dataset, so the layer is not on the map.';

const BASEMAP_TITLE = 'Light Gray is the muted cartographic base the stream colours were picked ' +
  'against, and Dark Gray is the same map inverted for a dark room. The imagery bases are aerial ' +
  'photography, for checking a line against the water on the ground — with Esri boundaries and ' +
  'place names over it, or bare so nothing is drawn over the banks.';

const $ = id => document.getElementById(id);

/** A layer entry's ids, which for the styled network can only be asked for, not stored. */
const layerIds = layer => (typeof layer.layers === 'function' ? layer.layers() : layer.layers);

/**
 * The dropdown: the button toggles its menu and a click anywhere else closes it. Returns the close,
 * so the picker can also close on a choice.
 *
 * The menu sits over the map with room to open into, so there is none of RFS v3's re-anchoring
 * here — the CSS hangs it off its button and that is the end of it.
 */
function wireMenu(btn, menu) {
  const close = () => {
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', () => {
    // toggle returns whether the class went on, so `hidden` true means the menu just closed
    const hidden = menu.classList.toggle('hidden');
    btn.setAttribute('aria-expanded', String(!hidden));
  });
  document.addEventListener('click', e => {
    if (!menu.contains(e.target) && !btn.contains(e.target)) close();
  });
  return close;
}

/** Independent on/off switches — any number of the overlays can be drawn at once. */
function initLayerPicker() {
  const body = $('layers-body');
  const legend = $('legend-items');

  for (const layer of LAYERS) {
    // The switch: a checkbox, the name of the layer, and the colour it is drawn in. The whole row
    // is the label, so the name is as clickable as the box.
    const row = document.createElement('label');
    row.className = 'legend-item';
    const box = document.createElement('input');
    box.type = 'checkbox';
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = layer.label;
    const swatch = document.createElement('span');
    swatch.className = `swatch ${layer.swatch}`;
    row.append(box, name, swatch);
    box.addEventListener('change', () => {
      if (layer.onToggle) layer.onToggle(box.checked);
      else setLayersVisible(layerIds(layer), box.checked);
      syncLayerPicker();
    });
    body.append(row);

    // The legend row for the same layer, hidden until the layer is on: a colour is worth naming
    // only while there is something on the map wearing it.
    const legendRow = document.createElement('div');
    legendRow.className = 'legend-item hidden';
    const legendSwatch = document.createElement('span');
    legendSwatch.className = `swatch ${layer.swatch}`;
    legendRow.append(legendSwatch, document.createTextNode(layer.label));
    if (layer.title) legendRow.title = layer.title;
    legend.append(legendRow);

    layer.box = box;
    layer.row = row;
    layer.legendRow = legendRow;
  }
}

/**
 * Point the switches and the legend at what the map is actually drawing. Called once the map is up,
 * and again after every switch, because a layer the open dataset does not publish cannot be
 * switched on however many times it is clicked.
 */
export function syncLayerPicker() {
  for (const layer of LAYERS) {
    const ids = layerIds(layer);
    const present = layersPresent(ids);
    const on = present && layersVisible(ids);
    layer.box.checked = on;
    layer.box.disabled = !present;
    layer.row.classList.toggle('unavailable', !present);
    layer.row.title = [layer.title, present ? null : MISSING].filter(Boolean).join('\n\n');
    layer.legendRow.classList.toggle('hidden', !on);
  }
}

const basemapOptions = new Map();

/** A single choice — one basemap at a time — so the rows are radios and a click closes the menu. */
function initBasemapPicker() {
  const btn = $('basemap-btn');
  const menu = $('basemap-menu');
  btn.replaceChildren(calciteIcon('basemap'));
  btn.title = `Basemap\n\n${BASEMAP_TITLE}`;
  const close = wireMenu(btn, menu);

  for (const bm of BASEMAPS) {
    const opt = document.createElement('button');
    opt.className = 'opt';
    opt.setAttribute('role', 'menuitemradio');
    opt.textContent = bm.label;
    opt.addEventListener('click', () => {
      setBasemap(bm.id);
      syncBasemapPicker();
      close();
    });
    menu.append(opt);
    basemapOptions.set(bm.id, opt);
  }
  syncBasemapPicker();
}

function syncBasemapPicker() {
  const active = currentBasemap();
  for (const [id, opt] of basemapOptions) {
    opt.classList.toggle('active', id === active);
    opt.setAttribute('aria-checked', String(id === active));
  }
}

export function initMapControls() {
  initLayerPicker();
  initBasemapPicker();
}
