/**
 * The handful of Heroicons this app draws, inlined.
 *
 * The RFS v3 app builds its header buttons out of Heroicons (24/outline) through a package import;
 * a handful of icons is not worth a dependency here, so the same ones are pasted in as markup. They are the
 * outline set at stroke-width 1.5, drawn in currentColor, which is what makes a button's hover
 * state reach its icon.
 */
const ICONS = {
  sun: 'M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773' +
    '-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 ' +
    '3.75 0 0 1 7.5 0Z',
  moon: 'M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597' +
    '.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z',
  'chevron-down': 'm19.5 8.25-7.5 7.5-7.5-7.5',
  'magnifying-glass': 'm21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 ' +
    '10.607Z',
  'arrow-down-tray': 'M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16' +
    '.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3',
  'x-mark': 'M6 18 18 6M6 6l12 12',
  trash: 'm14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.1' +
    '6 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a' +
    '48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3' +
    '.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09' +
    ' 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0',
  'chevron-right': 'm8.25 4.5 7.5 7.5-7.5 7.5',
  // The only one of the four drawn from more than one subpath: the toothed ring, then the hub.
  'cog-6-tooth': [
    'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.' +
    '686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37' +
    '.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.7' +
    '23 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.12' +
    '5 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-' +
    '.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.1' +
    '1-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.25' +
    '7-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.43' +
    '1l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992' +
    'l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.' +
    '356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z',
    'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  ],
};

const NS = 'http://www.w3.org/2000/svg';

/** The named icon as an <svg> element, sized by CSS rather than by attributes. */
export function heroIcon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of [ICONS[name]].flat()) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** A button whose face is a heroicon and whose name is its title and its label to a screen reader. */
export function iconButton(icon, title, className = '') {
  const btn = document.createElement('button');
  btn.className = `btn icon ${className}`.trim();
  btn.replaceChildren(heroIcon(icon));
  btn.title = title;
  btn.setAttribute('aria-label', title);
  return btn;
}

/**
 * The Calcite icon the map's basemap picker wears.
 *
 * RFS v3 draws its basemap button with @esri/calcite-ui-icons — the ArcGIS set, which is what a GIS
 * user reaches for that control by. Same reasoning as above: one icon is not worth the dependency,
 * so the 24px path is pasted in. Unlike the Heroicons it is a solid shape, filled in currentColor
 * rather than stroked.
 */
const CALCITE = {
  basemap: 'M23 13H13v10h10zm-9 9v-5h5v2h-2v1h2v2zm8 0h-2v-5h2zm0-6h-8v-2h8zM11 1H1v10h10zm-.519' +
    ' 7.085-.1-.008c-.133-.01-.252-.039-.381-.056V10H5.956c.019.067.043.13.058.2H4.981c-.023-.071' +
    '-.062-.131-.089-.2H2V7.266l-.108-.046-.093-.035-.166-1.129.367.138V2h2.053a7 7 0 0 1-.094-.4' +
    '22l-.016-.1.989-.155.015.1c.007.04.042.254.126.577H10v5.014c.152.024.299.054.46.067l.1.008zm' +
    '-.021-1.004.1.008-.079.996-.1-.008c-.133-.01-.252-.039-.381-.056C5.759 7.455 4.385 3.332 4.0' +
    '53 2a7 7 0 0 1-.094-.422l-.016-.1.989-.155.015.1c.007.04.042.254.126.577C5.42 3.328 6.603 6.' +
    '488 10 7.014c.152.024.299.054.46.067M5.956 10c.019.067.043.13.058.2H4.981c-.023-.071-.062-.1' +
    '31-.089-.2A5.65 5.65 0 0 0 2 7.266l-.108-.046-.093-.035-.166-1.129.611.229c.14.052 2.995 1.1' +
    '68 3.712 3.715M23 9V1H13v10h10zm-1-7v6h-4V7h2V5h1V2zm-3 3v1h-5V4h3v1zm1-3v2h-2V2zm-6 0h3v1h' +
    '-3zm0 8V7h3v2h5v1zM1 23h10V13H1zm1-1v-1.614A4.1 4.1 0 0 0 3.313 20a2.44 2.44 0 0 0 .6-1.413c' +
    '.125-1.22.36-1.595 1.65-1.586a1.98 1.98 0 0 1 1.8 1.003c1.01.879 1.552 1.282 2.292 1.048a3 3' +
    ' 0 0 1 .345-.08V22zm8-8v3.937a9 9 0 0 0-.646.161c-.501.159-.765-.247-1.528-.99a2.74 2.74 0 0' +
    ' 0-2.224-1.066 2.54 2.54 0 0 0-2.39 1.045c-.306.453.01 1.248-.5 2.038a1.2 1.2 0 0 1-.712.192' +
    'V14z',
};

/** The named Calcite icon as an <svg> element, filled in currentColor. */
export function calciteIcon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', CALCITE[name]);
  svg.append(path);
  return svg;
}
