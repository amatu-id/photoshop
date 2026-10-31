// Color model conversions. RGB channels are 0..255, H 0..360, S/V/L 0..100.

import { clamp } from './util.js';

export function hexToRgb(hex) {
  let s = String(hex).replace('#', '').trim();
  if (s.length === 3) s = s.split('').map(c => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16);
  if (Number.isNaN(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export const rgbToHex = ({ r, g, b }) => '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
export const rgbCss = ({ r, g, b }, a = 1) => a >= 1 ? `rgb(${r | 0},${g | 0},${b | 0})` : `rgba(${r | 0},${g | 0},${b | 0},${a})`;

export function rgbToHsv({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6; else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: max ? d / max * 100 : 0, v: max * 100 };
}
export function hsvToRgb({ h, s, v }) {
  s /= 100; v /= 100;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > .5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0); else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hue2rgb(p, q, t) {
  if (t < 0) t += 1; if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
export function hslToRgb(h, s, l) {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

// sRGB <-> CIE Lab (D65)
const lin = c => (c /= 255) <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
const gam = c => 255 * (c <= .0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - .055);
export function rgbToLab({ r, g, b }) {
  const R = lin(r), G = lin(g), B = lin(b);
  let x = (R * .4124 + G * .3576 + B * .1805) / .95047;
  let y = (R * .2126 + G * .7152 + B * .0722);
  let z = (R * .0193 + G * .1192 + B * .9505) / 1.08883;
  const f = t => t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  x = f(x); y = f(y); z = f(z);
  return { L: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
}
export function labToRgb({ L, a, b }) {
  let y = (L + 16) / 116, x = a / 500 + y, z = y - b / 200;
  const f = t => t ** 3 > .008856 ? t ** 3 : (t - 16 / 116) / 7.787;
  x = f(x) * .95047; y = f(y); z = f(z) * 1.08883;
  const R = x * 3.2406 + y * -1.5372 + z * -.4986;
  const G = x * -.9689 + y * 1.8758 + z * .0415;
  const B = x * .0557 + y * -.2040 + z * 1.0570;
  return { r: clamp(Math.round(gam(R)), 0, 255), g: clamp(Math.round(gam(G)), 0, 255), b: clamp(Math.round(gam(B)), 0, 255) };
}
export function rgbToCmyk({ r, g, b }) {
  const k = 1 - Math.max(r, g, b) / 255;
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  return { c: (1 - r / 255 - k) / (1 - k) * 100, m: (1 - g / 255 - k) / (1 - k) * 100, y: (1 - b / 255 - k) / (1 - k) * 100, k: k * 100 };
}
export function cmykToRgb({ c, m, y, k }) {
  return { r: Math.round(255 * (1 - c / 100) * (1 - k / 100)), g: Math.round(255 * (1 - m / 100) * (1 - k / 100)), b: Math.round(255 * (1 - y / 100) * (1 - k / 100)) };
}
export const luma = (r, g, b) => .299 * r + .587 * g + .114 * b;

export const DEFAULT_SWATCHES = [
  '#000000', '#3a3a3a', '#6b6b6b', '#9c9c9c', '#cfcfcf', '#ffffff',
  '#ff0000', '#ff8000', '#ffff00', '#80ff00', '#00ff00', '#00ff80', '#00ffff', '#0080ff', '#0000ff', '#8000ff', '#ff00ff', '#ff0080',
  '#7f1d1d', '#9a3412', '#a16207', '#3f6212', '#166534', '#115e59', '#155e75', '#1e40af', '#3730a3', '#6b21a8', '#9d174d',
  '#f87171', '#fb923c', '#facc15', '#a3e635', '#4ade80', '#2dd4bf', '#22d3ee', '#60a5fa', '#818cf8', '#c084fc', '#f472b6',
  '#fde2e4', '#fff1e6', '#fefae0', '#e2ece9', '#dfe7fd', '#ede7f6', '#c8b6a6', '#a98467', '#6c584c', '#3d2c2e',
];

export const GRADIENT_PRESETS = [
  { name: 'Depan ke Latar', stops: null },
  { name: 'Hitam, Putih', stops: [[0, '#000000', 1], [1, '#ffffff', 1]] },
  { name: 'Depan ke Transparan', stops: 'fg-transparent' },
  { name: 'Spektrum', stops: [[0, '#ff0000', 1], [.17, '#ffff00', 1], [.33, '#00ff00', 1], [.5, '#00ffff', 1], [.67, '#0000ff', 1], [.83, '#ff00ff', 1], [1, '#ff0000', 1]] },
  { name: 'Senja', stops: [[0, '#1b1036', 1], [.45, '#b3365b', 1], [.75, '#f08a4b', 1], [1, '#ffd38a', 1]] },
  { name: 'Laut', stops: [[0, '#031a3d', 1], [.5, '#0a6c8f', 1], [1, '#8ee3e0', 1]] },
  { name: 'Embun', stops: [[0, '#a1c4fd', 1], [1, '#c2e9fb', 1]] },
  { name: 'Peach', stops: [[0, '#ffecd2', 1], [1, '#fcb69f', 1]] },
  { name: 'Hutan', stops: [[0, '#0b3d20', 1], [.5, '#3c8d2f', 1], [1, '#d4e157', 1]] },
  { name: 'Logam', stops: [[0, '#4b4b4b', 1], [.3, '#d8d8d8', 1], [.5, '#8a8a8a', 1], [.7, '#f2f2f2', 1], [1, '#5a5a5a', 1]] },
  { name: 'Emas', stops: [[0, '#6b4a10', 1], [.35, '#e8c36a', 1], [.55, '#fff2c2', 1], [.75, '#c9952e', 1], [1, '#7a5512', 1]] },
  { name: 'Neon', stops: [[0, '#ff00cc', 1], [1, '#3333ff', 1]] },
];

// Build an ordered stop list [[pos, {r,g,b}, a]] for a gradient preset
export function resolveStops(stops, fg, bg) {
  if (!stops) return [[0, fg, 1], [1, bg, 1]];
  if (stops === 'fg-transparent') return [[0, fg, 1], [1, fg, 0]];
  return stops.map(([p, c, a]) => [p, typeof c === 'string' ? hexToRgb(c) : c, a]);
}
export function sampleStops(stops, t) {
  if (t <= stops[0][0]) return [stops[0][1], stops[0][2]];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [p0, c0, a0] = stops[i - 1], [p1, c1, a1] = stops[i];
      const k = (t - p0) / ((p1 - p0) || 1);
      return [{ r: c0.r + (c1.r - c0.r) * k, g: c0.g + (c1.g - c0.g) * k, b: c0.b + (c1.b - c0.b) * k }, a0 + (a1 - a0) * k];
    }
  }
  const l = stops[stops.length - 1]; return [l[1], l[2]];
}
// 256-entry RGBA lookup for a gradient
export function gradientLUT(stops) {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const [c, a] = sampleStops(stops, i / 255);
    lut[i * 4] = c.r; lut[i * 4 + 1] = c.g; lut[i * 4 + 2] = c.b; lut[i * 4 + 3] = a * 255;
  }
  return lut;
}
export function stopsCss(stops, angle = 90) {
  return `linear-gradient(${angle}deg, ${stops.map(([p, c, a]) => `${rgbCss(c, a)} ${(p * 100).toFixed(1)}%`).join(', ')})`;
}
