// Selection = document-sized alpha mask (canvas alpha channel = selection amount)

import { canvas, ctx2d, clamp } from './util.js';
import { blurPlane, distanceTransform } from './blur.js';

export class Selection {
  constructor(w, h, c) {
    this.w = w; this.h = h;
    this.canvas = c || canvas(w, h);
    this.rev = 1;
  }
  get ctx() { return ctx2d(this.canvas); }
  touch() { this.rev++; this._bounds = null; this._outline = null; }
  static fromCanvas(c) { return new Selection(c.width, c.height, c); }
  clone() { const s = new Selection(this.w, this.h); s.ctx.drawImage(this.canvas, 0, 0); return s; }

  static shape(w, h, draw, { feather = 0, antialias = true } = {}) {
    const s = new Selection(w, h), x = s.ctx;
    x.fillStyle = '#fff'; x.imageSmoothingEnabled = antialias;
    draw(x);
    if (!antialias) s.threshold(128);
    if (feather > 0) s.feather(feather);
    s.touch();
    return s;
  }
  static rect(w, h, r, opts) { return Selection.shape(w, h, x => x.fillRect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)), { antialias: false, ...opts, antialias: false }); }
  static ellipse(w, h, r, opts) {
    return Selection.shape(w, h, x => { x.beginPath(); x.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(.5, r.w / 2), Math.max(.5, r.h / 2), 0, 0, Math.PI * 2); x.fill(); }, opts);
  }
  static polygon(w, h, pts, opts) {
    return Selection.shape(w, h, x => { x.beginPath(); pts.forEach((p, i) => i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)); x.closePath(); x.fill('evenodd'); }, opts);
  }
  static path(w, h, path2d, opts) { return Selection.shape(w, h, x => x.fill(path2d, 'nonzero'), opts); }
  static all(w, h) { const s = new Selection(w, h); s.ctx.fillStyle = '#fff'; s.ctx.fillRect(0, 0, w, h); s.touch(); return s; }
  static fromAlpha(w, h, alpha /* Uint8 or Float array of len w*h */) {
    const s = new Selection(w, h), img = new ImageData(w, h), d = img.data;
    for (let i = 0; i < alpha.length; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255; d[i * 4 + 3] = alpha[i]; }
    s.ctx.putImageData(img, 0, 0); s.touch(); return s;
  }
  // Selection from a layer canvas' transparency (Ctrl+click thumbnail)
  static fromLayerAlpha(w, h, src, ox = 0, oy = 0) {
    const s = new Selection(w, h); s.ctx.drawImage(src, ox, oy);
    s.ctx.globalCompositeOperation = 'source-in'; s.ctx.fillStyle = '#fff'; s.ctx.fillRect(0, 0, w, h);
    s.touch(); return s;
  }
  // Grayscale canvas (mask/channel) → selection
  static fromGray(w, h, src, ox = 0, oy = 0, def = 0) {
    const s = new Selection(w, h);
    const tmp = canvas(w, h), tx = ctx2d(tmp);
    tx.fillStyle = `rgb(${def},${def},${def})`; tx.fillRect(0, 0, w, h); tx.drawImage(src, ox, oy);
    const img = tx.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) { d[i + 3] = d[i]; d[i] = d[i + 1] = d[i + 2] = 255; }
    s.ctx.putImageData(img, 0, 0); s.touch(); return s;
  }

  alpha() {
    const d = this.ctx.getImageData(0, 0, this.w, this.h).data, a = new Uint8ClampedArray(this.w * this.h);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
    return a;
  }
  setAlpha(a) {
    const img = new ImageData(this.w, this.h), d = img.data;
    for (let i = 0; i < a.length; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255; d[i * 4 + 3] = a[i]; }
    this.ctx.putImageData(img, 0, 0); this.touch(); return this;
  }
  get(x, y) {
    x |= 0; y |= 0; if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.ctx.getImageData(x, y, 1, 1).data[3];
  }

  // mode: new | add | sub | int
  combine(other, mode) {
    if (mode === 'new' || !mode) return other;
    const s = this.clone(), x = s.ctx;
    x.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'sub' ? 'destination-out' : 'destination-in';
    x.drawImage(other.canvas, 0, 0);
    x.globalCompositeOperation = 'source-over';
    s.touch(); return s;
  }
  invert() {
    const c = canvas(this.w, this.h), x = ctx2d(c);
    x.fillStyle = '#fff'; x.fillRect(0, 0, this.w, this.h);
    x.globalCompositeOperation = 'destination-out'; x.drawImage(this.canvas, 0, 0);
    this.canvas = c; this.touch(); return this;
  }
  threshold(t = 128) {
    const img = this.ctx.getImageData(0, 0, this.w, this.h), d = img.data;
    for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= t ? 255 : 0;
    this.ctx.putImageData(img, 0, 0); this.touch(); return this;
  }
  feather(r) {
    if (r <= 0) return this;
    const a = Float32Array.from(this.alpha());
    const b = blurPlane(a, this.w, this.h, r / 2);
    return this.setAlpha(Uint8ClampedArray.from(b));
  }
  // Morphological expand / contract using a distance transform (round structuring element)
  expand(r) {
    const a = this.alpha(), inside = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) inside[i] = a[i] >= 128;
    const D = distanceTransform(inside, this.w, this.h);
    const out = new Uint8ClampedArray(a.length);
    for (let i = 0; i < a.length; i++) out[i] = D[i] <= r ? 255 : 0;
    return this.setAlpha(out);
  }
  contract(r) {
    const a = this.alpha(), outside = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) outside[i] = a[i] < 128;
    // pixels outside the canvas count as unselected only if not "select all" style; treat edges as outside
    const D = distanceTransform(outside, this.w, this.h);
    const out = new Uint8ClampedArray(a.length), w = this.w, h = this.h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, edge = Math.min(x + 1, y + 1, w - x, h - y);
      out[i] = !outside[i] && D[i] > r && edge > r ? 255 : 0;
    }
    return this.setAlpha(out);
  }
  border(width) {
    const inner = this.clone().contract(Math.ceil(width / 2));
    this.expand(Math.floor(width / 2));
    const x = this.ctx; x.globalCompositeOperation = 'destination-out'; x.drawImage(inner.canvas, 0, 0); x.globalCompositeOperation = 'source-over';
    this.touch(); return this.feather(1);
  }
  smooth(r) {
    const a = Float32Array.from(this.alpha());
    const b = blurPlane(a, this.w, this.h, r);
    const out = new Uint8ClampedArray(a.length);
    for (let i = 0; i < a.length; i++) out[i] = b[i] >= 128 ? 255 : 0;
    return this.setAlpha(out);
  }
  translate(dx, dy) {
    const c = canvas(this.w, this.h); ctx2d(c).drawImage(this.canvas, Math.round(dx), Math.round(dy));
    this.canvas = c; this.touch(); return this;
  }
  bounds() {
    if (this._bounds !== undefined && this._bounds !== null) return this._bounds;
    const d = this.ctx.getImageData(0, 0, this.w, this.h).data, w = this.w, h = this.h;
    let x1 = w, y1 = h, x2 = -1, y2 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) if (d[row + x * 4 + 3] > 0) { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; y2 = y; }
    }
    this._bounds = x2 < 0 ? false : { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
    return this._bounds;
  }
  get empty() { return !this.bounds(); }

  // Marching-ants outline as Path2D in document pixel space (cached)
  outline() {
    if (this._outline) return this._outline;
    const w = this.w, h = this.h, d = this.ctx.getImageData(0, 0, w, h).data;
    const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] >= 128;
    const p = new Path2D();
    const b = this.bounds();
    if (!b) { this._outline = p; return p; }
    // horizontal edges
    for (let y = b.y; y <= b.y + b.h; y++) {
      let run = -1;
      for (let x = b.x; x <= b.x + b.w; x++) {
        const e = x < b.x + b.w && on(x, y) !== on(x, y - 1);
        if (e && run < 0) run = x;
        if (!e && run >= 0) { p.moveTo(run, y); p.lineTo(x, y); run = -1; }
      }
    }
    for (let x = b.x; x <= b.x + b.w; x++) {
      let run = -1;
      for (let y = b.y; y <= b.y + b.h; y++) {
        const e = y < b.y + b.h && on(x, y) !== on(x - 1, y);
        if (e && run < 0) run = y;
        if (!e && run >= 0) { p.moveTo(x, run); p.lineTo(x, y); run = -1; }
      }
    }
    this._outline = p;
    return p;
  }
}

// Flood/global color selection used by Magic Wand, Paint Bucket, Magic Eraser, Color Range
export function colorRegion(img, sx, sy, { tolerance = 32, contiguous = true, antialias = true } = {}) {
  const { width: w, height: h, data: d } = img;
  sx = clamp(sx | 0, 0, w - 1); sy = clamp(sy | 0, 0, h - 1);
  const i0 = (sy * w + sx) * 4;
  const r0 = d[i0], g0 = d[i0 + 1], b0 = d[i0 + 2], a0 = d[i0 + 3];
  const tol = tolerance;
  const diff = i => {
    const a = d[i + 3];
    if (a0 === 0 && a === 0) return 0;
    return Math.max(Math.abs(d[i] - r0), Math.abs(d[i + 1] - g0), Math.abs(d[i + 2] - b0), Math.abs(a - a0));
  };
  const out = new Uint8ClampedArray(w * h);
  if (!contiguous) {
    for (let p = 0; p < w * h; p++) out[p] = diff(p * 4) <= tol ? 255 : 0;
  } else {
    const stack = new Int32Array(w * h); let sp = 0;
    const seen = new Uint8Array(w * h);
    stack[sp++] = sy * w + sx; seen[sy * w + sx] = 1;
    while (sp) {
      const p = stack[--sp];
      if (diff(p * 4) > tol) continue;
      out[p] = 255;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
  }
  if (antialias) {
    // soften the 1px boundary
    const src = out.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (src[p] && (!src[p - 1] || !src[p + 1] || !src[p - w] || !src[p + w])) out[p] = 190;
      else if (!src[p] && (src[p - 1] || src[p + 1] || src[p - w] || src[p + w])) out[p] = 64;
    }
  }
  return out;
}
