// Image adjustments (used destructively via Image › Adjustments and as adjustment layers)

import { clamp } from './util.js';
import { rgbToHsl, hslToRgb, hexToRgb, gradientLUT, resolveStops, luma } from './color.js';
import { blurPlane } from './blur.js';

const lvl = () => ({ ib: 0, iw: 255, g: 1, ob: 0, ow: 255 });
const curve = () => [[0, 0], [255, 255]];
const HUE_RANGES = ['master', 'reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'];
const RANGE_CENTER = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 };

export const PHOTO_FILTERS = [
  ['Warming Filter (85)', '#ec8a00'], ['Warming Filter (LBA)', '#fa9600'], ['Warming Filter (81)', '#ebb113'],
  ['Cooling Filter (80)', '#006dff'], ['Cooling Filter (LBB)', '#005dff'], ['Cooling Filter (82)', '#00b5ff'],
  ['Red', '#ea1a1a'], ['Orange', '#f28a1a'], ['Yellow', '#f9e31c'], ['Green', '#19c919'], ['Cyan', '#1dcbea'],
  ['Blue', '#1d35ea'], ['Violet', '#9b1dea'], ['Magenta', '#e31ae3'], ['Sepia', '#ac7a33'], ['Deep Red', '#ff0000'],
  ['Deep Blue', '#0022cd'], ['Deep Emerald', '#008c00'], ['Deep Yellow', '#ffd500'], ['Underwater', '#00c1b1'],
];

export const LOOKS = ['Film Hangat', 'Teal & Orange', 'Bleach Bypass', 'Cross Process', 'Matte Fade', 'Vintage', 'Dingin Moody', 'Monokrom Kontras', 'Pastel', 'Malam Biru'];

export const ADJUSTMENTS = {
  'brightness-contrast': { name: 'Brightness/Contrast', icon: 'brightness_6', defaults: { brightness: 0, contrast: 0, legacy: false } },
  levels: { name: 'Levels', icon: 'stacked_bar_chart', defaults: { channel: 'rgb', rgb: lvl(), r: lvl(), g: lvl(), b: lvl() } },
  curves: { name: 'Curves', icon: 'show_chart', defaults: { channel: 'rgb', rgb: curve(), r: curve(), g: curve(), b: curve() } },
  exposure: { name: 'Exposure', icon: 'exposure', defaults: { exposure: 0, offset: 0, gamma: 1 } },
  vibrance: { name: 'Vibrance', icon: 'change_history', defaults: { vibrance: 0, saturation: 0 } },
  'hue-saturation': { name: 'Hue/Saturation', icon: 'tonality', defaults: { range: 'master', colorize: false, ...Object.fromEntries(HUE_RANGES.map(r => [r, { h: 0, s: 0, l: 0 }])), cz: { h: 0, s: 25, l: 0 } } },
  'color-balance': { name: 'Color Balance', icon: 'balance', defaults: { tone: 'mid', shadows: [0, 0, 0], mid: [0, 0, 0], highlights: [0, 0, 0], preserve: true } },
  'black-white': { name: 'Black & White', icon: 'contrast', defaults: { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, th: 42, ts: 20 } },
  'photo-filter': { name: 'Photo Filter', icon: 'camera', defaults: { color: '#ec8a00', density: 25, preserve: true } },
  'channel-mixer': { name: 'Channel Mixer', icon: 'tune', defaults: { out: 'r', mono: false, r: [100, 0, 0, 0], g: [0, 100, 0, 0], b: [0, 0, 100, 0], k: [40, 40, 20, 0] } },
  'color-lookup': { name: 'Color Lookup', icon: 'filter_vintage', defaults: { look: 'Film Hangat', amount: 100 } },
  invert: { name: 'Invert', icon: 'invert_colors', defaults: {} },
  posterize: { name: 'Posterize', icon: 'gradient', defaults: { levels: 4 } },
  threshold: { name: 'Threshold', icon: 'filter_b_and_w', defaults: { level: 128 } },
  'gradient-map': { name: 'Gradient Map', icon: 'linear_scale', defaults: { stops: [[0, '#000000', 1], [1, '#ffffff', 1]], reverse: false } },
  'selective-color': { name: 'Selective Color', icon: 'colorize', defaults: { target: 'reds', method: 'relative', ...Object.fromEntries(['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'].map(k => [k, [0, 0, 0, 0]])) } },
};
export const ADJ_ORDER = [['brightness-contrast', 'levels', 'curves', 'exposure'], ['vibrance', 'hue-saturation', 'color-balance', 'black-white', 'photo-filter', 'channel-mixer', 'color-lookup'], ['invert', 'posterize', 'threshold', 'gradient-map', 'selective-color']];
export const defaultsFor = kind => structuredClone(ADJUSTMENTS[kind].defaults);

// ── LUT helpers ──────────────────────────────────────────────────────────
function levelsLUT({ ib, iw, g, ob, ow }) {
  const t = new Uint8ClampedArray(256), span = Math.max(1, iw - ib);
  for (let i = 0; i < 256; i++) {
    let v = clamp((i - ib) / span, 0, 1);
    v = Math.pow(v, 1 / g);
    t[i] = ob + v * (ow - ob);
  }
  return t;
}
// Monotone cubic (Fritsch–Carlson) spline through curve points → 256 LUT
export function curveLUT(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const t = new Uint8ClampedArray(256);
  if (p.length < 2) { for (let i = 0; i < 256; i++) t[i] = i; return t; }
  const n = p.length, xs = p.map(q => q[0]), ys = p.map(q => q[1]);
  const dx = [], m = [], d = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = (xs[i + 1] - xs[i]) || 1e-6; d[i] = (ys[i + 1] - ys[i]) / dx[i]; }
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (!d[i]) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) { t[x] = ys[0]; continue; }
    if (x >= xs[n - 1]) { t[x] = ys[n - 1]; continue; }
    let i = 0; while (x > xs[i + 1]) i++;
    const hh = dx[i], u = (x - xs[i]) / hh, u2 = u * u, u3 = u2 * u;
    t[x] = (2 * u3 - 3 * u2 + 1) * ys[i] + (u3 - 2 * u2 + u) * hh * m[i] + (-2 * u3 + 3 * u2) * ys[i + 1] + (u3 - u2) * hh * m[i + 1];
  }
  return t;
}
function applyLUT3(d, lr, lg, lb) {
  for (let i = 0; i < d.length; i += 4) { d[i] = lr[d[i]]; d[i + 1] = lg[d[i + 1]]; d[i + 2] = lb[d[i + 2]]; }
}
const compose = (a, b) => { const t = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) t[i] = b[a[i]]; return t; };

// Weight of hue h (deg) within a Photoshop-style colour range with soft falloff
function rangeWeight(h, center) {
  let d = Math.abs(h - center); if (d > 180) d = 360 - d;
  return d <= 15 ? 1 : d >= 45 ? 0 : 1 - (d - 15) / 30;
}

function looksFn(name) {
  const S = v => clamp(v, 0, 255);
  const sc = (x, lo, hi) => lo + (hi - lo) * x / 255;
  switch (name) {
    case 'Film Hangat': return (r, g, b) => [S(sc(r, 18, 250) * 1.04), S(sc(g, 12, 240)), S(sc(b, 8, 215))];
    case 'Teal & Orange': return (r, g, b) => { const l = luma(r, g, b) / 255; return [S(r + (l - .5) * 50), S(g + (l - .5) * 8), S(b - (l - .5) * 60)]; };
    case 'Bleach Bypass': return (r, g, b) => { const l = luma(r, g, b); const k = .55; const c = v => S(128 + (v - 128) * 1.35); return [c(r * (1 - k) + l * k), c(g * (1 - k) + l * k), c(b * (1 - k) + l * k)]; };
    case 'Cross Process': return (r, g, b) => { const s = v => 255 / (1 + Math.exp(-(v - 128) / 30)); return [S(s(r)), S(g * 1.05 + 6), S(sc(b, 40, 200))]; };
    case 'Matte Fade': return (r, g, b) => [sc(r, 32, 236), sc(g, 30, 232), sc(b, 34, 228)];
    case 'Vintage': return (r, g, b) => { const l = luma(r, g, b); return [S(sc(l * .3 + r * .7, 40, 240) + 10), S(sc(l * .3 + g * .7, 30, 225)), S(sc(l * .3 + b * .7, 40, 190))]; };
    case 'Dingin Moody': return (r, g, b) => { const l = luma(r, g, b); return [S(sc(r * .8 + l * .2, 10, 225)), S(sc(g * .85 + l * .15, 14, 235)), S(sc(b, 30, 250))]; };
    case 'Monokrom Kontras': return (r, g, b) => { const l = luma(r, g, b); const v = S(255 / (1 + Math.exp(-(l - 128) / 34))); return [v, v, v]; };
    case 'Pastel': return (r, g, b) => { const l = luma(r, g, b); return [S(sc(r * .7 + l * .3, 50, 255)), S(sc(g * .7 + l * .3, 50, 250)), S(sc(b * .7 + l * .3, 60, 255))]; };
    case 'Malam Biru': return (r, g, b) => [S(r * .55), S(g * .7), S(b * .95 + 20)];
    default: return (r, g, b) => [r, g, b];
  }
}

// ── Apply ────────────────────────────────────────────────────────────────
export function applyAdjustment(kind, p, img) {
  const d = img.data;
  switch (kind) {
    case 'brightness-contrast': {
      const t = new Uint8ClampedArray(256), B = p.brightness, C = p.contrast;
      if (p.legacy) {
        const f = (259 * (C * 2.55 + 255)) / (255 * (259 - C * 2.55));
        for (let i = 0; i < 256; i++) t[i] = f * (i + B - 128) + 128;
      } else {
        // brightness as a gamma-like midtone lift, contrast as an S around mid grey
        const g = B >= 0 ? 1 + B / 100 : 1 / (1 - B / 100);
        const c = C >= 0 ? 1 + C / 50 : 1 + C / 100;
        for (let i = 0; i < 256; i++) {
          let v = Math.pow(i / 255, 1 / g);
          v = (v - .5) * c + .5;
          t[i] = v * 255;
        }
      }
      applyLUT3(d, t, t, t); break;
    }
    case 'levels': {
      const m = levelsLUT(p.rgb);
      applyLUT3(d, compose(levelsLUT(p.r), m), compose(levelsLUT(p.g), m), compose(levelsLUT(p.b), m)); break;
    }
    case 'curves': {
      const m = curveLUT(p.rgb);
      applyLUT3(d, compose(curveLUT(p.r), m), compose(curveLUT(p.g), m), compose(curveLUT(p.b), m)); break;
    }
    case 'exposure': {
      const t = new Uint8ClampedArray(256), k = Math.pow(2, p.exposure);
      for (let i = 0; i < 256; i++) {
        let v = Math.pow(i / 255, 2.2) * k + p.offset;
        v = Math.pow(Math.max(0, v), 1 / 2.2);
        v = Math.pow(clamp(v, 0, 1), 1 / p.gamma);
        t[i] = v * 255;
      }
      applyLUT3(d, t, t, t); break;
    }
    case 'vibrance': {
      const vib = p.vibrance / 100, sat = p.saturation / 100;
      for (let i = 0; i < d.length; i += 4) {
        let r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = Math.max(r, g, b), avg = (r + g + b) / 3;
        const amt = ((Math.abs(mx - avg) * 2 / 255) * -3 * vib) + vib;   // protect saturated colours
        const skin = r > g && g > b ? .6 : 1;
        const k = 1 + sat + amt * skin;
        const l = luma(r, g, b);
        d[i] = l + (r - l) * k; d[i + 1] = l + (g - l) * k; d[i + 2] = l + (b - l) * k;
      }
      break;
    }
    case 'hue-saturation': {
      if (p.colorize) {
        const H = ((p.cz.h % 360) + 360) % 360 / 360, Sat = p.cz.s / 100, L0 = p.cz.l / 100;
        for (let i = 0; i < d.length; i += 4) {
          let l = luma(d[i], d[i + 1], d[i + 2]) / 255;
          l = L0 >= 0 ? l + (1 - l) * L0 : l * (1 + L0);
          const [r, g, b] = hslToRgb(H, Sat, l);
          d[i] = r; d[i + 1] = g; d[i + 2] = b;
        }
        break;
      }
      const ranges = HUE_RANGES.slice(1).filter(k => p[k].h || p[k].s || p[k].l);
      const M = p.master;
      if (!ranges.length && !M.h && !M.s && !M.l) break;
      for (let i = 0; i < d.length; i += 4) {
        let [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
        let dh = M.h, ds = M.s, dl = M.l;
        if (ranges.length && s > 0.02) {
          const hd = h * 360;
          for (const k of ranges) { const w = rangeWeight(hd, RANGE_CENTER[k]); if (w) { dh += p[k].h * w; ds += p[k].s * w; dl += p[k].l * w; } }
        }
        h = (h + dh / 360 + 1) % 1;
        const sk = ds / 100; s = sk >= 0 ? s + (1 - s) * sk * (s > 0 ? 1 : 0) : s * (1 + sk);
        const lk = dl / 100; l = lk >= 0 ? l + (1 - l) * lk : l * (1 + lk);
        const [r, g, b] = hslToRgb(h, clamp(s, 0, 1), clamp(l, 0, 1));
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
      }
      break;
    }
    case 'color-balance': {
      const tone = (l, c) => {  // weights for shadows / mid / highlights
        const sh = clamp(1 - l / 0.45, 0, 1), hi = clamp((l - .55) / .45, 0, 1), mid = 1 - sh - hi;
        return [sh, mid, hi][c];
      };
      for (let i = 0; i < d.length; i += 4) {
        const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2], l = luma(r0, g0, b0) / 255;
        let r = r0, g = g0, b = b0;
        ['shadows', 'mid', 'highlights'].forEach((k, ti) => {
          const w = tone(l, ti) * 1.1; const v = p[k];
          if (!w || (!v[0] && !v[1] && !v[2])) return;
          r += v[0] * w; g += v[1] * w; b += v[2] * w;
        });
        if (p.preserve) { const l2 = luma(r, g, b), k = l2 > 0 ? luma(r0, g0, b0) / l2 : 1; r *= k; g *= k; b *= k; }
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
      }
      break;
    }
    case 'black-white': {
      const W = { reds: p.reds, yellows: p.yellows, greens: p.greens, cyans: p.cyans, blues: p.blues, magentas: p.magentas };
      const tint = p.tint ? hslToRgb(p.th / 360, p.ts / 100, .5) : null;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const mn = Math.min(r, g, b);
        // Photoshop-style: decompose into grey + primary + secondary components
        let rr = r - mn, gg = g - mn, bb = b - mn;
        let v = mn;
        if (rr && gg) { const y = Math.min(rr, gg); v += y * W.yellows / 100; rr -= y; gg -= y; }
        else if (gg && bb) { const c = Math.min(gg, bb); v += c * W.cyans / 100; gg -= c; bb -= c; }
        else if (rr && bb) { const m = Math.min(rr, bb); v += m * W.magentas / 100; rr -= m; bb -= m; }
        v += rr * W.reds / 100 + gg * W.greens / 100 + bb * W.blues / 100;
        v = clamp(v, 0, 255);
        if (tint) {
          const l = v / 255;
          d[i] = clamp(v + (tint[0] - 128) * (1 - Math.abs(2 * l - 1)), 0, 255);
          d[i + 1] = clamp(v + (tint[1] - 128) * (1 - Math.abs(2 * l - 1)), 0, 255);
          d[i + 2] = clamp(v + (tint[2] - 128) * (1 - Math.abs(2 * l - 1)), 0, 255);
        } else d[i] = d[i + 1] = d[i + 2] = v;
      }
      break;
    }
    case 'photo-filter': {
      const c = hexToRgb(p.color), k = p.density / 100;
      for (let i = 0; i < d.length; i += 4) {
        const r0 = d[i], g0 = d[i + 1], b0 = d[i + 2];
        // multiply-like filter blended by density
        let r = r0 * (1 - k) + (r0 * c.r / 255) * k * 1.45, g = g0 * (1 - k) + (g0 * c.g / 255) * k * 1.45, b = b0 * (1 - k) + (b0 * c.b / 255) * k * 1.45;
        if (p.preserve) { const l2 = luma(r, g, b), f = l2 > 0 ? luma(r0, g0, b0) / l2 : 1; r *= f; g *= f; b *= f; }
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
      }
      break;
    }
    case 'channel-mixer': {
      if (p.mono) {
        const [kr, kg, kb, kc] = p.k;
        for (let i = 0; i < d.length; i += 4) { const v = (d[i] * kr + d[i + 1] * kg + d[i + 2] * kb) / 100 + kc * 2.55; d[i] = d[i + 1] = d[i + 2] = v; }
      } else {
        const R = p.r, G = p.g, B = p.b;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          d[i] = (r * R[0] + g * R[1] + b * R[2]) / 100 + R[3] * 2.55;
          d[i + 1] = (r * G[0] + g * G[1] + b * G[2]) / 100 + G[3] * 2.55;
          d[i + 2] = (r * B[0] + g * B[1] + b * B[2]) / 100 + B[3] * 2.55;
        }
      }
      break;
    }
    case 'color-lookup': {
      const f = looksFn(p.look), k = p.amount / 100;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2], o = f(r, g, b);
        d[i] = r + (o[0] - r) * k; d[i + 1] = g + (o[1] - g) * k; d[i + 2] = b + (o[2] - b) * k;
      }
      break;
    }
    case 'invert': for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } break;
    case 'posterize': {
      const n = clamp(p.levels | 0, 2, 255), t = new Uint8ClampedArray(256);
      for (let i = 0; i < 256; i++) t[i] = Math.round(Math.round(i / 255 * (n - 1)) / (n - 1) * 255);
      applyLUT3(d, t, t, t); break;
    }
    case 'threshold': for (let i = 0; i < d.length; i += 4) { const v = luma(d[i], d[i + 1], d[i + 2]) >= p.level ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; } break;
    case 'gradient-map': {
      let stops = resolveStops(p.stops);
      if (p.reverse) stops = stops.map(([q, c, a]) => [1 - q, c, a]).reverse();
      const lut = gradientLUT(stops);
      for (let i = 0; i < d.length; i += 4) { const v = Math.round(luma(d[i], d[i + 1], d[i + 2])) * 4; d[i] = lut[v]; d[i + 1] = lut[v + 1]; d[i + 2] = lut[v + 2]; }
      break;
    }
    case 'selective-color': {
      const keys = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'].filter(k => p[k].some(v => v));
      if (!keys.length) break;
      const rel = p.method === 'relative';
      for (let i = 0; i < d.length; i += 4) {
        let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), mid = r + g + b - mx - mn;
        const [hh] = rgbToHsl(d[i], d[i + 1], d[i + 2]); const hue = hh * 360;
        let dc = 0, dm = 0, dy = 0;
        for (const k of keys) {
          let w;
          if (k === 'whites') w = mn > .5 ? (mn - .5) * 2 : 0;
          else if (k === 'blacks') w = mx < .5 ? (.5 - mx) * 2 : 0;
          else if (k === 'neutrals') w = 1 - (Math.abs(mx - .5) + Math.abs(mn - .5));
          else w = (k === 'reds' || k === 'greens' || k === 'blues' ? mx - mid : mid - mn) * rangeWeight(hue, RANGE_CENTER[k]);
          if (w <= 0) continue;
          const [c, m, y, kk] = p[k];
          const f = v => rel ? v : 1;
          dc += w * (c / 100) * f(1 - r) + w * (kk / 100) * f(1 - r) * .5;
          dm += w * (m / 100) * f(1 - g) + w * (kk / 100) * f(1 - g) * .5;
          dy += w * (y / 100) * f(1 - b) + w * (kk / 100) * f(1 - b) * .5;
        }
        d[i] = (r - dc) * 255; d[i + 1] = (g - dm) * 255; d[i + 2] = (b - dy) * 255;
      }
      break;
    }
  }
  return img;
}

// ── Destructive-only adjustments ─────────────────────────────────────────
export function histogram(img) {
  const d = img.data, H = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), l: new Uint32Array(256), n: 0 };
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    H.r[d[i]]++; H.g[d[i + 1]]++; H.b[d[i + 2]]++; H.l[Math.round(luma(d[i], d[i + 1], d[i + 2]))]++; H.n++;
  }
  return H;
}
function pct(hist, n, p) { let acc = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * p) return i; } return 255; }
function pctHi(hist, n, p) { let acc = 0; for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * p) return i; } return 0; }

export function autoTone(img, perChannel = true, clip = .001) {
  const H = histogram(img); if (!H.n) return img;
  const lut = ch => levelsLUT({ ib: pct(ch, H.n, clip), iw: Math.max(pct(ch, H.n, clip) + 1, pctHi(ch, H.n, clip)), g: 1, ob: 0, ow: 255 });
  if (perChannel) applyLUT3(img.data, lut(H.r), lut(H.g), lut(H.b));
  else { const ib = Math.min(pct(H.r, H.n, clip), pct(H.g, H.n, clip), pct(H.b, H.n, clip)), iw = Math.max(pctHi(H.r, H.n, clip), pctHi(H.g, H.n, clip), pctHi(H.b, H.n, clip)); const t = levelsLUT({ ib, iw: Math.max(ib + 1, iw), g: 1, ob: 0, ow: 255 }); applyLUT3(img.data, t, t, t); }
  return img;
}
export function autoColor(img) {
  autoTone(img, false, .001);
  // neutralise midtones (grey-world)
  const d = img.data; let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 8) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  if (!n) return img;
  r /= n; g /= n; b /= n; const avg = (r + g + b) / 3;
  const gr = Math.log(.5) / Math.log(clamp(r / 255 * .5 / (avg / 255), .05, .95)), gg = Math.log(.5) / Math.log(clamp(g / 255 * .5 / (avg / 255), .05, .95)), gb = Math.log(.5) / Math.log(clamp(b / 255 * .5 / (avg / 255), .05, .95));
  const mk = gm => { const t = new Uint8ClampedArray(256); const gmm = clamp(gm, .6, 1.6); for (let i = 0; i < 256; i++) t[i] = 255 * Math.pow(i / 255, gmm); return t; };
  applyLUT3(d, mk(gr), mk(gg), mk(gb));
  return img;
}
export function desaturate(img) { const d = img.data; for (let i = 0; i < d.length; i += 4) { const v = luma(d[i], d[i + 1], d[i + 2]); d[i] = d[i + 1] = d[i + 2] = v; } return img; }
export function equalize(img) {
  const H = histogram(img); if (!H.n) return img;
  const cdf = new Float64Array(256); let acc = 0;
  for (let i = 0; i < 256; i++) { acc += H.l[i]; cdf[i] = acc / H.n; }
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = luma(d[i], d[i + 1], d[i + 2]); const nl = cdf[Math.round(l)] * 255; const k = l > 0 ? nl / l : 0;
    d[i] = l > 0 ? d[i] * k : nl; d[i + 1] = l > 0 ? d[i + 1] * k : nl; d[i + 2] = l > 0 ? d[i + 2] * k : nl;
  }
  return img;
}
export function shadowsHighlights(img, { shadows = 35, highlights = 0, radius = 30, color = 20 }) {
  const { width: w, height: h, data: d } = img, n = w * h;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = luma(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) / 255;
  const B = blurPlane(Float32Array.from(L), w, h, radius / 2);
  const s = shadows / 100, hl = highlights / 100, cc = 1 + color / 100;
  for (let i = 0; i < n; i++) {
    const base = B[i];
    const lift = s * Math.pow(1 - base, 2) * 1.2;
    const drop = hl * Math.pow(base, 2) * 1.0;
    const l0 = L[i], l1 = clamp(l0 + lift * (1 - l0) - drop * l0, 0, 1);
    const k = l0 > .001 ? l1 / l0 : 1;
    for (let c = 0; c < 3; c++) {
      const v = d[i * 4 + c] * k, gl = l1 * 255;
      d[i * 4 + c] = gl + (v - gl) * (k > 1 ? Math.min(cc, 1 + (k - 1) * (cc - 1) + 1e-9) : 1);
    }
  }
  return img;
}
// Replace Color: select by colour similarity then shift HSL
export function replaceColor(img, { color = '#ff0000', fuzziness = 40, h = 0, s = 0, l = 0 }) {
  const c = hexToRgb(color), d = img.data, f = fuzziness * 2;
  for (let i = 0; i < d.length; i += 4) {
    const dist = Math.hypot(d[i] - c.r, d[i + 1] - c.g, d[i + 2] - c.b);
    const w = dist <= f / 2 ? 1 : dist >= f ? 0 : 1 - (dist - f / 2) / (f / 2);
    if (!w) continue;
    let [hh, ss, ll] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    hh = (hh + h / 360 + 1) % 1; ss = clamp(ss + s / 100 * (s > 0 ? 1 - ss : ss), 0, 1); ll = clamp(ll + l / 100 * (l > 0 ? 1 - ll : ll), 0, 1);
    const [r, g, b] = hslToRgb(hh, ss, ll);
    d[i] += (r - d[i]) * w; d[i + 1] += (g - d[i + 1]) * w; d[i + 2] += (b - d[i + 2]) * w;
  }
  return img;
}
