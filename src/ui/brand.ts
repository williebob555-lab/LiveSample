// The LiveSample mark, inline, for places in the UI that show it.
//
// Geometry is copied from brand/ — mark-square.svg for large uses and
// mark-square-small.svg below ~48 px, whose thicker stroke survives the
// downscale. brand/README.md is the source of truth; keep these in step.

const LARGE = {
  sw: 24,
  s: 'M120 188 H160 C186 188 202 176 202 156 C202 136 186 129 164 125 C142 121 128 112 128 94 C128 78 142 70 162 70 H196',
  l: 'M62 70 V188 H120',
};
const SMALL = {
  sw: 32,
  s: 'M118 192 H162 C190 192 206 178 206 156 C206 134 188 127 164 123 C140 119 124 110 124 92 C124 74 140 64 162 64 H198',
  l: 'M58 64 V192 H118',
};

/** Square mark on its tile, as an SVG element `size` px across. */
export function markSvg(size: number): SVGSVGElement {
  const g = size < 48 ? SMALL : LARGE;
  const holder = document.createElement('div');
  holder.innerHTML =
    `<svg viewBox="0 0 256 256" width="${size}" height="${size}" aria-hidden="true">` +
    '<rect width="256" height="256" rx="56" fill="#14161a"/>' +
    `<path d="${g.s}" fill="none" stroke="#5fb2ff" stroke-width="${g.sw}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${g.l}" fill="none" stroke="#e8a13d" stroke-width="${g.sw}" stroke-linecap="round" stroke-linejoin="round"/>` +
    '</svg>';
  return holder.firstElementChild as SVGSVGElement;
}
