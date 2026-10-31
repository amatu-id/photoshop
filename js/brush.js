// Brush tips, presets and the dab-spacing stroke interpolator

import { canvas, ctx2d, clamp } from './util.js';

// Tip = grayscale alpha canvas at a reference size; scaled per dab.
const tipCache = new Map();

function hash(i) { let n = i * 2654435761 >>> 0; n ^= n >>> 15; n = Math.imul(n, 2246822519) >>> 0; return (n >>> 0) / 4294967295; }

export function roundTip(size, hardness, roundness = 100, angle = 0) {
  const key = `r|${size}|${hardness}|${roundness}|${angle}`;
  if (tipCache.has(key)) return tipCache.get(key);
  const s = Math.max(1, Math.ceil(size)), c = canvas(s + 2, s + 2), x = ctx2d(c), r = s / 2, cx = (s + 2) / 2;
  x.translate(cx, cx); x.rotate(-angle * Math.PI / 180); x.scale(1, roundness / 100);
  const hd = clamp(hardness / 100, 0, .999);
  if (s <= 2) { x.fillStyle = '#fff'; x.beginPath(); x.arc(0, 0, Math.max(.5, r), 0, Math.PI * 2); x.fill(); }
  else {
    const g = x.createRadialGradient(0, 0, r * hd, 0, 0, r);
    // smooth falloff similar to Photoshop's soft round
    const N = 8;
    for (let i = 0; i <= N; i++) { const t = i / N, a = Math.pow(1 - t, 1.6) * (1 - .15 * t); g.addColorStop(t, `rgba(255,255,255,${clamp(a + (i === 0 ? 0 : 0), 0, 1)})`); }
    x.fillStyle = g; x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2); x.fill();
  }
  if (tipCache.size > 300) tipCache.clear();
  tipCache.set(key, c);
  return c;
}
// Aliased tip for the Pencil
export function pixelTip(size, square = false) {
  const key = `p|${size}|${square}`;
  if (tipCache.has(key)) return tipCache.get(key);
  const s = Math.max(1, Math.round(size)), c = canvas(s, s), x = ctx2d(c), img = x.createImageData(s, s), r = s / 2;
  for (let y = 0; y < s; y++) for (let xx = 0; xx < s; xx++) {
    const dx = xx + .5 - r, dy = y + .5 - r;
    if (square || dx * dx + dy * dy <= r * r) { const i = (y * s + xx) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = img.data[i + 3] = 255; }
  }
  x.putImageData(img, 0, 0); tipCache.set(key, c); return c;
}
// Procedural textured tips (size 128 reference)
function sampled(kind) {
  const key = 's|' + kind;
  if (tipCache.has(key)) return tipCache.get(key);
  const S = 128, c = canvas(S, S), x = ctx2d(c), img = x.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let xx = 0; xx < S; xx++) {
    const dx = (xx - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2), r = Math.hypot(dx, dy), i = (y * S + xx) * 4, n = hash(y * S + xx);
    let a = 0;
    if (kind === 'chalk') a = r < 1 ? (n > .45 + r * .35 ? 1 : 0) * (1 - r * r) : 0;
    else if (kind === 'spatter') a = 0;
    else if (kind === 'charcoal') a = r < 1 ? ((Math.sin(xx * .9 + n * 2) * .5 + .5) > .55 ? .9 : .15) * (n > r * .7 ? 1 : 0) : 0;
    else if (kind === 'dry') a = Math.abs(dx) < 1 && Math.abs(dy) < .35 ? ((hash(xx * 7) > .35 ? 1 : .1) * (1 - Math.abs(dx) ** 6)) : 0;
    else if (kind === 'square') a = Math.abs(dx) < .95 && Math.abs(dy) < .95 ? 1 : 0;
    else if (kind === 'flat') a = Math.abs(dx) < .95 && Math.abs(dy) < .22 ? 1 - Math.abs(dx) ** 8 : 0;
    else if (kind === 'grain') a = r < 1 ? (1 - r) * (.5 + n * .5) : 0;
    d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = clamp(a, 0, 1) * 255;
  }
  x.putImageData(img, 0, 0);
  if (kind === 'spatter') {
    x.fillStyle = '#fff';
    for (let k = 0; k < 140; k++) {
      const ang = hash(k) * Math.PI * 2, rr = Math.sqrt(hash(k + 999)) * 58, s = 1 + hash(k + 77) * 5;
      x.globalAlpha = .4 + hash(k + 5) * .6; x.beginPath(); x.arc(64 + Math.cos(ang) * rr, 64 + Math.sin(ang) * rr, s, 0, Math.PI * 2); x.fill();
    }
  }
  if (kind === 'star') {
    x.fillStyle = '#fff'; x.beginPath();
    for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? 24 : 60; x.lineTo(64 + Math.cos(a) * rr, 64 + Math.sin(a) * rr); }
    x.fill();
  }
  if (kind === 'leaf') {
    x.fillStyle = '#fff'; x.beginPath(); x.moveTo(64, 6); x.quadraticCurveTo(122, 64, 64, 122); x.quadraticCurveTo(6, 64, 64, 6); x.fill();
  }
  if (kind === 'grass') {
    x.strokeStyle = '#fff'; x.lineCap = 'round';
    for (let k = 0; k < 9; k++) { x.lineWidth = 2 + hash(k) * 3; x.beginPath(); const bx = 30 + hash(k + 3) * 68; x.moveTo(bx, 126); x.quadraticCurveTo(bx + (hash(k + 9) - .5) * 30, 70, bx + (hash(k + 11) - .5) * 60, 4 + hash(k) * 40); x.stroke(); }
  }
  tipCache.set(key, c); return c;
}

export const BRUSH_PRESETS = [
  { id: 'soft', name: 'Soft Round', tip: 'round', hardness: 0, size: 60, spacing: 10 },
  { id: 'hard', name: 'Hard Round', tip: 'round', hardness: 100, size: 30, spacing: 10 },
  { id: 'soft-pressure', name: 'Soft Round Pressure', tip: 'round', hardness: 0, size: 45, spacing: 10, pSize: true, pOpacity: true },
  { id: 'hard-pressure', name: 'Hard Round Pressure Size', tip: 'round', hardness: 100, size: 20, spacing: 8, pSize: true },
  { id: 'airbrush', name: 'Airbrush Soft', tip: 'round', hardness: 0, size: 120, spacing: 5, flow: 8, air: true },
  { id: 'chalk', name: 'Chalk', tip: 'chalk', hardness: 100, size: 40, spacing: 18, angleJitter: 100 },
  { id: 'charcoal', name: 'Charcoal', tip: 'charcoal', hardness: 100, size: 36, spacing: 15, angleJitter: 30 },
  { id: 'dry', name: 'Dry Brush', tip: 'dry', hardness: 100, size: 50, spacing: 6, angleFollow: true },
  { id: 'flat', name: 'Flat Kaligrafi', tip: 'flat', hardness: 100, size: 40, spacing: 4, angle: 45 },
  { id: 'spatter', name: 'Spatter', tip: 'spatter', hardness: 100, size: 70, spacing: 40, angleJitter: 100, sizeJitter: 30 },
  { id: 'grain', name: 'Grainy Soft', tip: 'grain', hardness: 100, size: 60, spacing: 12 },
  { id: 'square', name: 'Square', tip: 'square', hardness: 100, size: 24, spacing: 10 },
  { id: 'star', name: 'Bintang', tip: 'star', hardness: 100, size: 40, spacing: 140, scatter: 120, sizeJitter: 60, angleJitter: 100 },
  { id: 'leaf', name: 'Daun Tersebar', tip: 'leaf', hardness: 100, size: 50, spacing: 90, scatter: 150, sizeJitter: 50, angleJitter: 100, colorJitter: 20 },
  { id: 'grass', name: 'Rumput', tip: 'grass', hardness: 100, size: 80, spacing: 25, sizeJitter: 40, angleJitter: 12, scatter: 20 },
];

export function tipFor(o, size) {
  if (o.custom) return o.custom;
  if (!o.tip || o.tip === 'round') return roundTip(Math.max(1, Math.round(size * 2) / 2), o.hardness ?? 100, o.roundness ?? 100, o.angle ?? 0);
  return sampled(o.tip);
}
export function tipPreview(o, w = 44, hgt = 44) {
  const c = canvas(w, hgt), x = ctx2d(c);
  const t = tipFor(o, Math.min(w, hgt) - 6), s = Math.min(w, hgt) - 6;
  x.drawImage(t, (w - s) / 2, (hgt - s) / 2, s, s);
  x.globalCompositeOperation = 'source-in'; x.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#ddd'; x.fillRect(0, 0, w, hgt);
  return c;
}

// Stroke interpolator: produces evenly spaced dabs along the (smoothed) pointer path
export class Stroker {
  constructor({ spacing = .25, smoothing = 0, onDab }) {
    this.spacing = spacing; this.smoothing = smoothing; this.onDab = onDab;
    this.last = null; this.rem = 0; this.pos = null;
  }
  begin(p, size) { this.pos = { ...p }; this.last = { ...p }; this.onDab(p, 0); this.rem = 0; this.size = size; }
  to(raw, size) {
    if (!this.last) return this.begin(raw, size);
    let p = raw;
    if (this.smoothing > 0) {
      const k = 1 - clamp(this.smoothing, 0, .95);
      p = { ...raw, x: this.pos.x + (raw.x - this.pos.x) * k, y: this.pos.y + (raw.y - this.pos.y) * k };
    }
    this.pos = p;
    const step = Math.max(.5, size * this.spacing);
    const dx = p.x - this.last.x, dy = p.y - this.last.y, dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return;
    let t = step - this.rem;
    const ang = Math.atan2(dy, dx);
    while (t <= dist) {
      const k = t / dist;
      this.onDab({ x: this.last.x + dx * k, y: this.last.y + dy * k, pressure: this.last.pressure + (p.pressure - this.last.pressure) * k, angle: ang }, t);
      t += step;
    }
    this.rem = dist - (t - step);
    this.last = { ...p };
  }
  end(raw, size) { if (this.smoothing > 0 && raw) { this.smoothing = 0; this.to(raw, size); } }
}
