/**
 * The handful of Heroicons this app draws, inlined.
 *
 * The RFS v3 app builds its header buttons out of Heroicons (24/outline) through a package import;
 * four icons is not worth a dependency here, so the same four are pasted in as markup. They are the
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
  'chevron-right': 'm8.25 4.5 7.5 7.5-7.5 7.5',
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
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}
