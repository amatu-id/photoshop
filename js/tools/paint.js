// Painting & retouching tools: Brush, Pencil, Color Replacement, Mixer, Eraser family,
// Clone/Pattern Stamp, History Brush, Healing family, Blur/Sharpen/Smudge, Dodge/Burn/Sponge

import { App, commit, invalidate, toast } from '../state.js';
import { canvas, ctx2d, clamp, rectUnion, cloneCanvas } from '../util.js';
import { defineTool, opts, editTarget, LiveEdit, selectionWeights, sampleCanvas, pixelAt, touchTarget } from './base.js';
import { Stroker, tipFor, pixelTip, roundTip } from '../brush.js';
import { rgbCss, luma, rgbToHsl, hslToRgb } from '../color.js';
import { colorRegion } from '../selection.js';
import { gaussianImageData } from '../blur.js';
import { inpaint } from '../inpaint.js';

export const PAINT_MODES = [['normal', 'Normal'], ['dissolve', 'Dissolve'], ['behind', 'Behind'], ['clear', 'Clear'], null, ['darken', 'Darken'], ['multiply', 'Multiply'], ['color-burn', 'Color Burn'], null, ['lighten', 'Lighten'], ['screen', 'Screen'], ['color-dodge', 'Color Dodge'], ['lighter', 'Linear Dodge (Add)'], null, ['overlay', 'Overlay'], ['soft-light', 'Soft Light'], ['hard-light', 'Hard Light'], null, ['difference', 'Difference'], ['exclusion', 'Exclusion'], null, ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity']];
const gco = m => ({ normal: 'source-over', behind: 'destination-over', clear: 'destination-out', dissolve: 'source-over' }[m] || m);

const BRUSH_DEF = { preset: 'soft', tip: 'round', size: 40, hardness: 0, opacity: 100, flow: 100, mode: 'normal', smoothing: 10, spacing: 10, pSize: false, pOpacity: false, air: false, angle: 0, roundness: 100, sizeJitter: 0, angleJitter: 0, scatter: 0, opacityJitter: 0, colorJitter: 0 };
const brushBar = (extra = []) => [{ type: 'brush' }, { type: 'select', key: 'mode', label: 'Mode', options: PAINT_MODES }, { type: 'range', key: 'opacity', label: 'Opacity', min: 1, max: 100, unit: '%' }, { type: 'toggle', key: 'pOpacity', icon: 'pressure-o', tip: 'Tekanan selalu mengatur opacity' }, { type: 'range', key: 'flow', label: 'Flow', min: 1, max: 100, unit: '%' }, { type: 'toggle', key: 'air', icon: 'airbrush', tip: 'Aktifkan kemampuan airbrush' }, { type: 'range', key: 'smoothing', label: 'Smoothing', min: 0, max: 100, unit: '%' }, { type: 'range', key: 'angle', label: '∠', min: -180, max: 180, unit: '°', width: 44 }, { type: 'toggle', key: 'pSize', icon: 'pressure-s', tip: 'Tekanan selalu mengatur ukuran' }, ...extra];

// ── Generic stroke session ───────────────────────────────────────────────
class StrokeSession {
  constructor(tool, t, o, ev) {
    this.tool = tool; this.t = t; this.o = o; this.live = new LiveEdit(t);
    this.buf = canvas(t.canvas.width, t.canvas.height); this.bx = ctx2d(this.buf);
    this.dirty = null; this.pending = null;
    const sp = (o.spacing ?? 10) / 100;
    this.stroker = new Stroker({ spacing: sp, smoothing: (o.smoothing || 0) / 100, onDab: (p) => this.dab(p) });
    this.isMask = t.kind === 'mask';
    this.lastAngle = 0;
    tool.prepare?.(this, ev);
  }
  size(p) { const o = this.o; let s = o.size * (o.pSize && p.pressure !== undefined ? clamp(p.pressure, .05, 1) : 1); if (o.sizeJitter) s *= 1 - Math.random() * o.sizeJitter / 100; return Math.max(1, s); }
  dab(p) {
    const o = this.o, s = this.size(p);
    if (this.tool.directDab) { const r = this.tool.directDab(this, p, s); if (r) this.mark(r); return; }
    let x = p.x - this.t.x, y = p.y - this.t.y;
    if (o.scatter) { const k = s * o.scatter / 100; x += (Math.random() - .5) * 2 * k; y += (Math.random() - .5) * 2 * k; }
    const pixel = this.tool.pixel || o._pixel;
    const tip = pixel ? pixelTip(s, o.square) : tipFor(o, s);
    let a = (o.flow ?? 100) / 100 * (o.pOpacity ? clamp(p.pressure ?? 1, .02, 1) : 1);
    if (o.opacityJitter) a *= 1 - Math.random() * o.opacityJitter / 100;
    const bx = this.bx; bx.save(); bx.globalAlpha = a; bx.imageSmoothingEnabled = !pixel;
    let ang = 0;
    if (o.angleJitter) ang += (Math.random() - .5) * 2 * Math.PI * o.angleJitter / 100;
    if (o.angleFollow) ang += p.angle || 0;
    if (o.tip && o.tip !== 'round') ang -= (o.angle || 0) * Math.PI / 180;
    if (pixel) { const ds = Math.round(s); bx.drawImage(tip, Math.round(x - ds / 2), Math.round(y - ds / 2), ds, ds); }
    else if (ang) { bx.translate(x, y); bx.rotate(ang); bx.drawImage(tip, -s / 2, -s / 2, s, s); }
    else bx.drawImage(tip, x - s / 2, y - s / 2, s, s);
    bx.restore();
    const pad = s * (1 + (o.scatter || 0) / 50) / 2 + 2;
    this.mark({ x: p.x - pad, y: p.y - pad, w: pad * 2, h: pad * 2 });
  }
  mark(r) { this.pending = rectUnion(this.pending, r); }
  render() {
    const r = this.pending; if (!r) return;
    this.pending = null; this.dirty = rectUnion(this.dirty, r);
    if (this.tool.directDab) { this.live.flush(r); return; }
    const lr = this.live.restoreRect(r); if (!lr) return;
    const tmp = canvas(lr.w, lr.h), tx = ctx2d(tmp);
    tx.drawImage(this.buf, lr.x, lr.y, lr.w, lr.h, 0, 0, lr.w, lr.h);
    tx.globalCompositeOperation = 'source-in';
    this.tool.fillSource(this, tx, lr);
    const sw = selectionWeights({ x: lr.x + this.t.x, y: lr.y + this.t.y, w: lr.w, h: lr.h });
    if (sw) { const m = canvas(lr.w, lr.h); ctx2d(m).putImageData(new ImageData(sw.data, lr.w, lr.h), 0, 0); tx.globalCompositeOperation = 'destination-in'; tx.drawImage(m, 0, 0); }
    const wx = this.live.wx; wx.save();
    wx.globalAlpha = (this.o.opacity ?? 100) / 100;
    let mode = this.tool.compMode ? this.tool.compMode(this) : gco(this.o.mode || 'normal');
    if (!this.isMask && this.t.layer.locks.alpha && mode === 'source-over') mode = 'source-atop';
    if (this.isMask && mode !== 'destination-out') mode = 'source-over';
    wx.globalCompositeOperation = mode;
    if (this.o.mode === 'dissolve') {
      const id = tx.getImageData(0, 0, lr.w, lr.h), dd = id.data, op = (this.o.opacity ?? 100) / 100;
      for (let i = 3; i < dd.length; i += 4) dd[i] = Math.random() < dd[i] / 255 * op ? 255 : 0;
      tx.putImageData(id, 0, 0); wx.globalAlpha = 1;
    }
    wx.drawImage(tmp, lr.x, lr.y);
    wx.restore();
    this.live.flush(r);
  }
  finish(label) {
    this.render();
    if (this.tool.finalize) this.tool.finalize(this);
    this.live.commit();
    if (this.t.kind === 'layer' && this.t.layer.isBackground === false) { /* keep */ }
    invalidate(this.dirty);
    commit(label, this.tool.histIcon || 'brush');
    App.lastStrokePoint = this.lastPoint;
  }
}

function paintColor(sess) {
  const c = sess.isMask ? (() => { const v = Math.round(luma(App.fg.r, App.fg.g, App.fg.b)); return { r: v, g: v, b: v }; })() : App.fg;
  if (sess.o.colorJitter) {
    const [h, s, l] = rgbToHsl(c.r, c.g, c.b), j = sess.o.colorJitter / 100;
    const [r, g, b] = hslToRgb((h + (Math.random() - .5) * j + 1) % 1, s, l); return { r, g, b };
  }
  return c;
}

// Tool factory for stroke-based tools
function strokeTool(def) {
  const tool = defineTool({
    cursor: 'crosshair', ...def,
    brushSize() { return opts(def.id).size; },
    brushHardness() { return opts(def.id).hardness; },
    async down(ev) {
      if (ev.alt && def.altSample) return def.altSample(ev);
      if (ev.alt && def.altEyedrop !== false && !def.directDab && !def.noAltPick) { App.tools.eyedropper.pick(ev); return; }
      const t = await editTarget({ allowMask: def.allowMask !== false }); if (!t) return;
      const o = { ...opts(def.id) };
      if (def.beforeStroke && def.beforeStroke(o, t, ev) === false) return;
      const s = this.sess = new StrokeSession(tool, t, o, ev);
      const p = { x: ev.x, y: ev.y, pressure: ev.pressure };
      if (ev.shift && App.lastStrokePoint && App.lastStrokeDoc === App.doc.id) { s.stroker.begin(App.lastStrokePoint, o.size); s.stroker.to(p, o.size); }
      else s.stroker.begin(p, o.size);
      s.lastPoint = p;
      s.render();
      if (o.air) this.airTimer = setInterval(() => { if (this.sess && s.lastPoint) { s.dab({ ...s.lastPoint }); s.render(); } }, 60);
    },
    move(ev) {
      const s = this.sess; if (!s) return;
      const p = { x: ev.x, y: ev.y, pressure: ev.pressure };
      s.stroker.to(p, s.o.size); s.lastPoint = p; s.render();
    },
    up() {
      const s = this.sess; if (!s) return;
      clearInterval(this.airTimer); this.sess = null;
      s.stroker.end(s.lastPoint, s.o.size);
      App.lastStrokeDoc = App.doc.id;
      s.finish(def.histName || def.name);
    },
  });
  return tool;
}

// ── Brush family ─────────────────────────────────────────────────────────
strokeTool({
  id: 'brush', name: 'Brush Tool', key: 'B', group: 'brush', icon: 'brush', defaults: { ...BRUSH_DEF },
  bar: brushBar(), histName: 'Brush Tool',
  fillSource(s, tx, lr) { tx.fillStyle = rgbCss(paintColor(s)); tx.fillRect(0, 0, lr.w, lr.h); },
});
strokeTool({
  id: 'pencil', name: 'Pencil Tool', key: 'B', group: 'brush', icon: 'pencil', pixel: true,
  defaults: { ...BRUSH_DEF, preset: 'hard', size: 1, hardness: 100, smoothing: 0, spacing: 5, autoErase: false, square: false },
  bar: [{ type: 'brush' }, { type: 'select', key: 'mode', label: 'Mode', options: PAINT_MODES }, { type: 'range', key: 'opacity', label: 'Opacity', min: 1, max: 100, unit: '%' }, { type: 'range', key: 'smoothing', label: 'Smoothing', min: 0, max: 100, unit: '%' }, { type: 'check', key: 'autoErase', label: 'Auto Erase' }, { type: 'check', key: 'square', label: 'Ujung kotak' }],
  beforeStroke(o, t, ev) {
    if (o.autoErase && t.kind === 'layer') {
      const c = pixelAt(t.canvas, ev.x - t.x, ev.y - t.y);
      o._erase = c && c.a > 0 && Math.abs(c.r - App.fg.r) + Math.abs(c.g - App.fg.g) + Math.abs(c.b - App.fg.b) < 6;
    }
  },
  fillSource(s, tx, lr) { const c = s.o._erase ? App.bg : paintColor(s); tx.fillStyle = rgbCss(c); tx.fillRect(0, 0, lr.w, lr.h); },
});
strokeTool({
  id: 'color-replace', name: 'Color Replacement Tool', key: 'B', group: 'brush', icon: 'color-replace', allowMask: false,
  defaults: { ...BRUSH_DEF, preset: 'hard', hardness: 100, size: 40, cmode: 'color', sampling: 'continuous', limits: 'contiguous', tolerance: 30 },
  bar: [{ type: 'brush' }, { type: 'select', key: 'cmode', label: 'Mode', options: [['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity']] }, { type: 'seg', key: 'sampling', options: [['continuous', 'sample-cont', 'Sampling: Kontinu'], ['once', 'sample-once', 'Sampling: Sekali'], ['bgswatch', 'sample-bg', 'Sampling: Swatch Latar']] }, { type: 'select', key: 'limits', label: 'Batas', options: [['discontiguous', 'Discontiguous'], ['contiguous', 'Contiguous']] }, { type: 'range', key: 'tolerance', label: 'Tolerance', min: 1, max: 100, unit: '%' }],
  directDab(s, p, size) {
    const o = s.o, t = s.t, r = Math.ceil(size / 2), x0 = Math.floor(p.x - t.x - r), y0 = Math.floor(p.y - t.y - r), w = r * 2, hh = r * 2;
    const wx = s.live.wx, img = wx.getImageData(x0, y0, w, hh), d = img.data;
    if (o.sampling === 'continuous' || !s.sample) {
      s.sample = o.sampling === 'bgswatch' ? App.bg : pixelAt(s.live.work, p.x - t.x, p.y - t.y) || App.bg;
    }
    const tip = ctx2d(roundTip(w, o.hardness)).getImageData(0, 0, w + 2, hh + 2).data;
    const [fh, fs] = rgbToHsl(App.fg.r, App.fg.g, App.fg.b), tol = o.tolerance * 2.55;
    const sw = selectionWeights({ x: x0 + t.x, y: y0 + t.y, w, h: hh });
    for (let yy = 0; yy < hh; yy++) for (let xx = 0; xx < w; xx++) {
      const i = (yy * w + xx) * 4, ta = tip[((yy + 1) * (w + 2) + xx + 1) * 4 + 3] / 255 * (sw ? sw.data[i + 3] / 255 : 1);
      if (ta <= 0 || !d[i + 3]) continue;
      const diff = Math.max(Math.abs(d[i] - s.sample.r), Math.abs(d[i + 1] - s.sample.g), Math.abs(d[i + 2] - s.sample.b));
      if (diff > tol) continue;
      let [hh2, ss, ll] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
      if (o.cmode === 'hue' || o.cmode === 'color') hh2 = fh;
      if (o.cmode === 'saturation' || o.cmode === 'color') ss = fs;
      if (o.cmode === 'luminosity') ll = luma(App.fg.r, App.fg.g, App.fg.b) / 255;
      const [nr, ng, nb] = hslToRgb(hh2, ss, ll);
      d[i] += (nr - d[i]) * ta; d[i + 1] += (ng - d[i + 1]) * ta; d[i + 2] += (nb - d[i + 2]) * ta;
    }
    wx.putImageData(img, x0, y0);
    return { x: x0 + t.x, y: y0 + t.y, w, h: hh };
  },
});
strokeTool({
  id: 'mixer', name: 'Mixer Brush Tool', key: 'B', group: 'brush', icon: 'mixer', allowMask: false,
  defaults: { ...BRUSH_DEF, size: 50, hardness: 30, wet: 50, load: 50, mix: 50, clean: true },
  bar: [{ type: 'brush' }, { type: 'range', key: 'wet', label: 'Basah', min: 0, max: 100, unit: '%' }, { type: 'range', key: 'load', label: 'Muat', min: 1, max: 100, unit: '%' }, { type: 'range', key: 'mix', label: 'Campur', min: 0, max: 100, unit: '%' }, { type: 'range', key: 'flow', label: 'Flow', min: 1, max: 100, unit: '%' }, { type: 'check', key: 'clean', label: 'Bersihkan tiap goresan' }],
  prepare(s) { s.reservoir = { ...App.fg }; s.paint = 1; },
  directDab(s, p, size) {
    const o = s.o, t = s.t, r = Math.ceil(size / 2), x0 = Math.floor(p.x - t.x - r), y0 = Math.floor(p.y - t.y - r), w = r * 2;
    const wx = s.live.wx, img = wx.getImageData(x0, y0, w, w), d = img.data;
    const tip = ctx2d(roundTip(w, o.hardness)).getImageData(0, 0, w + 2, w + 2).data;
    // pick up canvas colour under the brush
    let R = 0, G = 0, B = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { R += d[i]; G += d[i + 1]; B += d[i + 2]; n++; }
    const wet = o.wet / 100, mix = o.mix / 100;
    if (n) { const k = wet * mix * .5; s.reservoir = { r: s.reservoir.r + (R / n - s.reservoir.r) * k, g: s.reservoir.g + (G / n - s.reservoir.g) * k, b: s.reservoir.b + (B / n - s.reservoir.b) * k }; }
    s.paint = Math.max(0, s.paint - (1 - o.load / 100) * .02);
    const flow = o.flow / 100 * (s.paint * .8 + .2);
    for (let yy = 0; yy < w; yy++) for (let xx = 0; xx < w; xx++) {
      const i = (yy * w + xx) * 4, ta = tip[((yy + 1) * (w + 2) + xx + 1) * 4 + 3] / 255 * flow;
      if (ta <= 0) continue;
      d[i] += (s.reservoir.r - d[i]) * ta; d[i + 1] += (s.reservoir.g - d[i + 1]) * ta; d[i + 2] += (s.reservoir.b - d[i + 2]) * ta; d[i + 3] = Math.max(d[i + 3], ta * 255 * (1 - wet * .5));
    }
    wx.putImageData(img, x0, y0);
    return { x: x0 + t.x, y: y0 + t.y, w, h: w };
  },
});

// ── Eraser family ────────────────────────────────────────────────────────
strokeTool({
  id: 'eraser', name: 'Eraser Tool', key: 'E', group: 'eraser', icon: 'eraser', histName: 'Eraser',
  defaults: { ...BRUSH_DEF, preset: 'hard', hardness: 100, size: 40, emode: 'brush', history: false },
  bar: [{ type: 'brush' }, { type: 'select', key: 'emode', label: 'Mode', options: [['brush', 'Brush'], ['pencil', 'Pencil'], ['block', 'Block']] }, { type: 'range', key: 'opacity', label: 'Opacity', min: 1, max: 100, unit: '%' }, { type: 'range', key: 'flow', label: 'Flow', min: 1, max: 100, unit: '%' }, { type: 'range', key: 'smoothing', label: 'Smoothing', min: 0, max: 100, unit: '%' }, { type: 'check', key: 'history', label: 'Erase to History' }],
  beforeStroke(o) { if (o.emode === 'block') { o.tip = 'square'; o.size = 16 / (App.view.zoom || 1); o.flow = 100; } if (o.emode === 'pencil') { o.hardness = 100; o._pixel = true; } },
  compMode(s) { return s.isMask || s.o.history || (s.t.layer.isBackground || s.t.layer.locks.alpha) ? 'source-over' : 'destination-out'; },
  fillSource(s, tx, lr) {
    if (s.o.history) return historyFill(s, tx, lr);
    const c = s.isMask ? (() => { const v = Math.round(luma(App.bg.r, App.bg.g, App.bg.b)); return { r: v, g: v, b: v }; })() : App.bg;
    tx.fillStyle = rgbCss(c); tx.fillRect(0, 0, lr.w, lr.h);
  },
});
strokeTool({
  id: 'bg-eraser', name: 'Background Eraser Tool', key: 'E', group: 'eraser', icon: 'bg-eraser', allowMask: false,
  defaults: { ...BRUSH_DEF, preset: 'hard', size: 60, hardness: 100, sampling: 'continuous', limits: 'contiguous', tolerance: 50, protectFg: false },
  bar: [{ type: 'brush' }, { type: 'seg', key: 'sampling', options: [['continuous', 'sample-cont', 'Sampling: Kontinu'], ['once', 'sample-once', 'Sampling: Sekali'], ['bgswatch', 'sample-bg', 'Sampling: Swatch Latar']] }, { type: 'select', key: 'limits', label: 'Batas', options: [['discontiguous', 'Discontiguous'], ['contiguous', 'Contiguous'], ['edges', 'Find Edges']] }, { type: 'range', key: 'tolerance', label: 'Tolerance', min: 1, max: 100, unit: '%' }, { type: 'check', key: 'protectFg', label: 'Lindungi warna depan' }],
  beforeStroke(o, t) { if (t.layer.isBackground) App.convertBackground?.(t.layer); },
  directDab(s, p, size) {
    const o = s.o, t = s.t, r = Math.ceil(size / 2), x0 = Math.floor(p.x - t.x - r), y0 = Math.floor(p.y - t.y - r), w = r * 2;
    const wx = s.live.wx, img = wx.getImageData(x0, y0, w, w), d = img.data;
    if (o.sampling === 'continuous' || !s.sample) s.sample = o.sampling === 'bgswatch' ? App.bg : pixelAt(s.live.work, p.x - t.x, p.y - t.y) || App.bg;
    const tip = ctx2d(roundTip(w, o.hardness)).getImageData(0, 0, w + 2, w + 2).data, tol = o.tolerance * 2.55;
    let inside = null;
    if (o.limits === 'contiguous') inside = colorRegion(img, r, r, { tolerance: tol, contiguous: true, antialias: false });
    const sw = selectionWeights({ x: x0 + t.x, y: y0 + t.y, w, h: w });
    for (let yy = 0; yy < w; yy++) for (let xx = 0; xx < w; xx++) {
      const i = (yy * w + xx) * 4, ta = tip[((yy + 1) * (w + 2) + xx + 1) * 4 + 3] / 255 * (sw ? sw.data[i + 3] / 255 : 1);
      if (ta <= 0 || !d[i + 3]) continue;
      if (inside && !inside[yy * w + xx]) continue;
      const diff = Math.max(Math.abs(d[i] - s.sample.r), Math.abs(d[i + 1] - s.sample.g), Math.abs(d[i + 2] - s.sample.b));
      if (diff > tol) continue;
      if (o.protectFg && Math.max(Math.abs(d[i] - App.fg.r), Math.abs(d[i + 1] - App.fg.g), Math.abs(d[i + 2] - App.fg.b)) < tol / 2) continue;
      d[i + 3] *= 1 - ta * (1 - diff / (tol + 1) * .5);
    }
    wx.putImageData(img, x0, y0);
    return { x: x0 + t.x, y: y0 + t.y, w, h: w };
  },
});
defineTool({
  id: 'magic-eraser', name: 'Magic Eraser Tool', key: 'E', group: 'eraser', icon: 'magic-eraser', cursor: 'crosshair',
  defaults: { tolerance: 32, antialias: true, contiguous: true, sampleAll: false, opacity: 100 },
  bar: [{ type: 'range', key: 'tolerance', label: 'Tolerance', min: 0, max: 255 }, { type: 'check', key: 'antialias', label: 'Anti-alias' }, { type: 'check', key: 'contiguous', label: 'Contiguous' }, { type: 'check', key: 'sampleAll', label: 'Sample All Layers' }, { type: 'range', key: 'opacity', label: 'Opacity', min: 1, max: 100, unit: '%' }],
  async down(ev) {
    const t = await editTarget({ allowMask: false }); if (!t) return;
    if (t.layer.isBackground) App.convertBackground?.(t.layer);
    const o = opts('magic-eraser'), d = App.doc;
    const src = o.sampleAll ? sampleCanvas('all') : t.canvas;
    const ox = o.sampleAll ? 0 : t.x, oy = o.sampleAll ? 0 : t.y;
    const img = ctx2d(src).getImageData(0, 0, src.width, src.height);
    const region = colorRegion(img, ev.x - ox, ev.y - oy, { tolerance: o.tolerance, contiguous: o.contiguous, antialias: o.antialias });
    const x = ctx2d(t.canvas), li = x.getImageData(0, 0, t.canvas.width, t.canvas.height), ld = li.data, k = o.opacity / 100;
    const sw = d.selection && !d.selection.empty ? d.selection.alpha() : null;
    for (let yy = 0; yy < t.canvas.height; yy++) for (let xx = 0; xx < t.canvas.width; xx++) {
      const sx = xx + t.x - ox, sy = yy + t.y - oy; if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
      let a = region[sy * src.width + sx] / 255 * k; if (!a) continue;
      if (sw) { const dx = xx + t.x, dy = yy + t.y; a *= dx >= 0 && dy >= 0 && dx < d.w && dy < d.h ? sw[dy * d.w + dx] / 255 : 0; }
      const i = (yy * t.canvas.width + xx) * 4; ld[i + 3] *= 1 - a;
    }
    x.putImageData(li, 0, 0); touchTarget(t); invalidate(); commit('Magic Eraser', 'auto_fix_normal');
  },
});

// ── Stamps & history ─────────────────────────────────────────────────────
function historyFill(s, tx, lr) {
  const d = App.doc, ref = App.historySource || d.history.states[0];
  const src = d.history.sourceCanvasFor(s.t.layer.id, ref);
  if (!src) { tx.clearRect(0, 0, lr.w, lr.h); return; }
  tx.drawImage(src.canvas, src.x - s.t.x - lr.x, src.y - s.t.y - lr.y);
}
strokeTool({
  id: 'history-brush', name: 'History Brush Tool', key: 'Y', group: 'history', icon: 'history-brush', allowMask: false,
  defaults: { ...BRUSH_DEF }, bar: brushBar(), histIcon: 'history',
  beforeStroke(o, t) { const src = App.doc.history.sourceCanvasFor(t.layer.id, App.historySource || App.doc.history.states[0]); if (!src) { toast('Layer ini tidak ada di status sumber riwayat'); return false; } },
  fillSource: historyFill,
});
strokeTool({
  id: 'art-history', name: 'Art History Brush Tool', key: 'Y', group: 'history', icon: 'art-history', allowMask: false,
  defaults: { ...BRUSH_DEF, size: 10, hardness: 80, style: 'tight', area: 50, spacing: 60 }, bar: [{ type: 'brush' }, { type: 'range', key: 'opacity', label: 'Opacity', min: 1, max: 100, unit: '%' }, { type: 'select', key: 'style', label: 'Gaya', options: [['tight', 'Tight Short'], ['loose', 'Loose Medium'], ['curl', 'Tight Curl'], ['dab', 'Dab']] }, { type: 'range', key: 'area', label: 'Area', min: 5, max: 200, unit: 'px' }],
  directDab(s, p, size) {
    const d = App.doc, src = d.history.sourceCanvasFor(s.t.layer.id, App.historySource || d.history.states[0]); if (!src) return null;
    const o = s.o, wx = s.live.wx, n = 6; let box = null;
    for (let k = 0; k < n; k++) {
      const x = p.x + (Math.random() - .5) * o.area, y = p.y + (Math.random() - .5) * o.area;
      const c = pixelAt(src.canvas, x - src.x, y - src.y); if (!c || !c.a) continue;
      const len = { tight: size * 1.5, loose: size * 3, curl: size * 2, dab: size * .6 }[o.style], ang = Math.random() * Math.PI * 2;
      wx.save(); wx.globalAlpha = o.opacity / 100 * .8; wx.strokeStyle = rgbCss(c); wx.lineWidth = size / 2; wx.lineCap = 'round';
      wx.beginPath(); const lx = x - s.t.x, ly = y - s.t.y; wx.moveTo(lx, ly);
      if (o.style === 'curl') wx.arc(lx, ly, len / 2, ang, ang + 2.5); else wx.lineTo(lx + Math.cos(ang) * len, ly + Math.sin(ang) * len);
      wx.stroke(); wx.restore();
      box = rectUnion(box, { x: x - len - size, y: y - len - size, w: (len + size) * 2, h: (len + size) * 2 });
    }
    return box;
  },
});
strokeTool({
  id: 'clone', name: 'Clone Stamp Tool', key: 'S', group: 'stamp', icon: 'clone', allowMask: false, altEyedrop: false,
  defaults: { ...BRUSH_DEF, hardness: 50, size: 60, aligned: true, sample: 'current' }, histName: 'Clone Stamp',
  bar: brushBar([{ type: 'check', key: 'aligned', label: 'Aligned' }, { type: 'select', key: 'sample', label: 'Sample', options: [['current', 'Layer Saat Ini'], ['below', 'Saat Ini & Di Bawah'], ['all', 'Semua Layer']] }]),
  altSample(ev) { App.cloneSrc = { x: ev.x, y: ev.y, docId: App.doc.id }; App.cloneOffset = null; toast('Titik sumber kloning ditetapkan'); },
  beforeStroke(o, t, ev) {
    if (!App.cloneSrc || App.cloneSrc.docId !== App.doc.id) { toast(`Tahan ${navigator.platform.includes('Mac') ? 'Option' : 'Alt'} lalu klik untuk menentukan titik sumber`); return false; }
    if (!o.aligned || !App.cloneOffset) App.cloneOffset = { dx: App.cloneSrc.x - ev.x, dy: App.cloneSrc.y - ev.y };
    o._src = o.sample === 'current' ? cloneCanvas(t.canvas) : sampleCanvas('all');
    o._srcXY = o.sample === 'current' ? { x: t.x, y: t.y } : { x: 0, y: 0 };
  },
  fillSource(s, tx, lr) {
    const o = s.o, off = App.cloneOffset;
    tx.drawImage(o._src, o._srcXY.x - s.t.x - lr.x + off.dx, o._srcXY.y - s.t.y - lr.y + off.dy);
  },
  overlay(x, v) {
    const s = this.sess; if (!s || !App.cloneOffset || !v.mouse) return;
    const p = v.toScreen(s.lastPoint.x + App.cloneOffset.dx, s.lastPoint.y + App.cloneOffset.dy); v.crosshair(x, p.x, p.y);
  },
});
strokeTool({
  id: 'pattern-stamp', name: 'Pattern Stamp Tool', key: 'S', group: 'stamp', icon: 'pattern-stamp', allowMask: false,
  defaults: { ...BRUSH_DEF, size: 80, pattern: 0, aligned: true },
  bar: brushBar([{ type: 'pattern', key: 'pattern' }, { type: 'check', key: 'aligned', label: 'Aligned' }]),
  fillSource(s, tx, lr) {
    const pat = App.patterns[s.o.pattern] || App.patterns[0]; if (!pat) return;
    const p = tx.createPattern(pat.canvas, 'repeat'); tx.save(); tx.translate(-(lr.x + s.t.x) % pat.canvas.width, -(lr.y + s.t.y) % pat.canvas.height);
    tx.fillStyle = p; tx.fillRect(0, 0, lr.w + pat.canvas.width, lr.h + pat.canvas.height); tx.restore();
  },
});

// ── Healing family ───────────────────────────────────────────────────────
function healRegion(work, orig, mask, r, radius) {
  // Blend low frequencies of the destination into the patched pixels (fast "healing")
  const x = ctx2d(work), patched = x.getImageData(r.x, r.y, r.w, r.h), base = ctx2d(orig).getImageData(r.x, r.y, r.w, r.h);
  const pb = gaussianImageData(new ImageData(new Uint8ClampedArray(patched.data), r.w, r.h), radius);
  const bb = gaussianImageData(new ImageData(new Uint8ClampedArray(base.data), r.w, r.h), radius);
  const m = mask ? ctx2d(mask).getImageData(r.x, r.y, r.w, r.h).data : null, d = patched.data, o = base.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = m ? m[i + 3] / 255 : 1; if (!a) continue;
    for (let c = 0; c < 3; c++) {
      const healed = d[i + c] + (bb.data[i + c] - pb.data[i + c]);
      d[i + c] = o[i + c] + (healed - o[i + c]) * a;
    }
    d[i + 3] = o[i + 3] + (d[i + 3] - o[i + 3]) * a;
  }
  x.putImageData(patched, r.x, r.y);
}
strokeTool({
  id: 'healing', name: 'Healing Brush Tool', key: 'J', group: 'heal', icon: 'healing', allowMask: false, altEyedrop: false,
  defaults: { ...BRUSH_DEF, hardness: 70, size: 40, aligned: true, sample: 'current' }, histName: 'Healing Brush',
  bar: [{ type: 'brush' }, { type: 'select', key: 'mode', label: 'Mode', options: [['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['darken', 'Darken'], ['lighten', 'Lighten'], ['color', 'Color'], ['luminosity', 'Luminosity']] }, { type: 'check', key: 'aligned', label: 'Aligned' }, { type: 'select', key: 'sample', label: 'Sample', options: [['current', 'Layer Saat Ini'], ['all', 'Semua Layer']] }],
  altSample(ev) { App.cloneSrc = { x: ev.x, y: ev.y, docId: App.doc.id }; App.cloneOffset = null; toast('Titik sumber healing ditetapkan'); },
  beforeStroke(o, t, ev) { return TOOLS_REF().clone.beforeStroke(o, t, ev); },
  fillSource(s, tx, lr) { TOOLS_REF().clone.fillSource(s, tx, lr); },
  finalize(s) {
    const r = s.dirty && { x: Math.floor(s.dirty.x - s.t.x), y: Math.floor(s.dirty.y - s.t.y), w: Math.ceil(s.dirty.w), h: Math.ceil(s.dirty.h) };
    const rr = r && clipLocal(r, s.live.work); if (!rr) return;
    healRegion(s.live.work, s.live.base, s.buf, rr, Math.max(2, s.o.size / 3));
  },
});
const TOOLS_REF = () => App.tools;
const clipLocal = (r, c) => { const x = Math.max(0, r.x), y = Math.max(0, r.y), x2 = Math.min(c.width, r.x + r.w), y2 = Math.min(c.height, r.y + r.h); return x2 > x && y2 > y ? { x, y, w: x2 - x, h: y2 - y } : null; };

// Spot Healing & Remove: paint a mask, then fill it from surroundings on release
function spotTool(id, name, icon, key, extraDefaults, bar, useInpaint) {
  return strokeTool({
    id, name, key, group: 'heal', icon, allowMask: false, altEyedrop: false, noAltPick: true,
    defaults: { ...BRUSH_DEF, hardness: 100, size: 30, ...extraDefaults }, bar,
    fillSource(s, tx, lr) { tx.fillStyle = 'rgba(255,40,40,1)'; tx.fillRect(0, 0, lr.w, lr.h); },
    compMode() { return 'source-over'; },
    beforeStroke(o) { o.opacity = 55; o.flow = 100; o.mode = 'normal'; },
    finalize(s) {
      const pad = Math.ceil(s.o.size);
      const r = s.dirty && clipLocal({ x: Math.floor(s.dirty.x - s.t.x) - pad, y: Math.floor(s.dirty.y - s.t.y) - pad, w: Math.ceil(s.dirty.w) + pad * 2, h: Math.ceil(s.dirty.h) + pad * 2 }, s.live.work);
      // restore the original pixels (the red stroke was only a preview)
      const wx = s.live.wx; wx.clearRect(0, 0, s.live.work.width, s.live.work.height); wx.drawImage(s.live.base, 0, 0);
      if (!r) return;
      const maskImg = ctx2d(s.buf).getImageData(r.x, r.y, r.w, r.h);
      if (useInpaint || s.o.type === 'content') {
        const img = wx.getImageData(r.x, r.y, r.w, r.h), m = new Uint8Array(r.w * r.h);
        for (let i = 0; i < m.length; i++) m[i] = maskImg.data[i * 4 + 3] > 20 ? 1 : 0;
        inpaint(img, m, { quality: 'fast' });
        // soft blend at edges
        const orig = ctx2d(s.live.base).getImageData(r.x, r.y, r.w, r.h).data, d = img.data;
        for (let i = 0; i < m.length; i++) { const a = Math.min(1, maskImg.data[i * 4 + 3] / 200); for (let c = 0; c < 4; c++) d[i * 4 + c] = orig[i * 4 + c] + (d[i * 4 + c] - orig[i * 4 + c]) * a; }
        wx.putImageData(img, r.x, r.y);
      } else {
        // proximity match: best neighbouring patch by border similarity, then heal
        const b = ctx2d(s.live.base), bw = s.live.work.width, bh = s.live.work.height;
        const ring = b.getImageData(r.x, r.y, r.w, r.h).data;
        let best = null, bestScore = Infinity;
        const cands = []; for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2; for (const f of [1, 1.5]) cands.push([Math.round(Math.cos(a) * r.w * f * .7), Math.round(Math.sin(a) * r.h * f * .7)]); }
        for (const [dx, dy] of cands) {
          const sx = r.x + dx, sy = r.y + dy; if (sx < 0 || sy < 0 || sx + r.w > bw || sy + r.h > bh) continue;
          const cand = b.getImageData(sx, sy, r.w, r.h).data; let sc = 0, n = 0;
          for (let i = 0; i < cand.length; i += 16) { const a = maskImg.data[i + 3]; if (a > 10) { sc += 50; continue; } sc += Math.abs(cand[i] - ring[i]) + Math.abs(cand[i + 1] - ring[i + 1]) + Math.abs(cand[i + 2] - ring[i + 2]); n++; }
          sc /= n || 1; if (sc < bestScore) { bestScore = sc; best = [sx, sy]; }
        }
        if (!best) return;
        const mc = canvas(r.w, r.h), mx = ctx2d(mc); mx.putImageData(maskImg, 0, 0);
        const fb = gaussianImageData(mx.getImageData(0, 0, r.w, r.h), 2); mx.putImageData(fb, 0, 0);
        const patch = canvas(r.w, r.h), px = ctx2d(patch);
        px.drawImage(s.live.base, best[0], best[1], r.w, r.h, 0, 0, r.w, r.h);
        px.globalCompositeOperation = 'destination-in'; px.drawImage(mc, 0, 0);
        wx.drawImage(patch, r.x, r.y);
        const fullMask = canvas(bw, bh); ctx2d(fullMask).drawImage(mc, r.x, r.y);
        healRegion(s.live.work, s.live.base, fullMask, r, Math.max(3, s.o.size / 2.5));
      }
    },
  });
}
spotTool('spot-healing', 'Spot Healing Brush Tool', 'spot-healing', 'J', { type: 'content' }, [{ type: 'brush' }, { type: 'seg', key: 'type', label: 'Tipe', options: [['content', 'auto_awesome', 'Content-Aware'], ['proximity', 'texture', 'Proximity Match']] }, { type: 'check', key: 'sampleAll', label: 'Sample All Layers' }]);
spotTool('remove', 'Remove Tool', 'remove-tool', 'J', { size: 60 }, [{ type: 'brush' }, { type: 'note', text: 'Sapukan pada objek yang ingin dihapus' }], true);

defineTool({
  id: 'patch', name: 'Patch Tool', key: 'J', group: 'heal', icon: 'patch', cursor: 'crosshair',
  defaults: { pmode: 'source', diffusion: 5 },
  bar: [{ type: 'selmode' }, { type: 'seg', key: 'pmode', label: 'Patch', options: [['source', 'login', 'Source'], ['dest', 'logout', 'Destination']] }, { type: 'range', key: 'diffusion', label: 'Difusi', min: 1, max: 7 }],
  down(ev) {
    const d = App.doc, sel = d.selection;
    if (sel && !sel.empty && sel.get(ev.x, ev.y) > 100) { this.drag = { x0: ev.x, y0: ev.y, dx: 0, dy: 0 }; return; }
    App.tools.lasso.down(ev); this.lassoing = true;
  },
  move(ev) {
    if (this.lassoing) return App.tools.lasso.move(ev);
    if (this.drag) { this.drag.dx = ev.x - this.drag.x0; this.drag.dy = ev.y - this.drag.y0; App.view.redraw(); }
  },
  async up(ev) {
    if (this.lassoing) { this.lassoing = false; return App.tools.lasso.up(ev); }
    const dr = this.drag; this.drag = null; if (!dr || (!dr.dx && !dr.dy)) return;
    const t = await editTarget({ allowMask: false }); if (!t) return;
    const d = App.doc, o = opts('patch'), sel = d.selection, b = sel.bounds();
    const dx = Math.round(dr.dx), dy = Math.round(dr.dy);
    const base = cloneCanvas(t.canvas), x = ctx2d(t.canvas);
    const srcOff = o.pmode === 'source' ? [dx, dy] : [0, 0], dstOff = o.pmode === 'source' ? [0, 0] : [dx, dy];
    const patch = canvas(d.w, d.h), px = ctx2d(patch);
    px.drawImage(base, t.x - srcOff[0] + dstOff[0], t.y - srcOff[1] + dstOff[1]);
    const m = canvas(d.w, d.h), mx = ctx2d(m); mx.drawImage(sel.canvas, dstOff[0], dstOff[1]);
    const mi = mx.getImageData(0, 0, d.w, d.h); gaussianImageData(mi, o.diffusion / 2, { alphaOnly: true }); mx.putImageData(mi, 0, 0);
    px.globalCompositeOperation = 'destination-in'; px.drawImage(m, 0, 0);
    x.drawImage(patch, -t.x, -t.y);
    const lm = canvas(t.canvas.width, t.canvas.height); ctx2d(lm).drawImage(m, -t.x, -t.y);
    const r = clipLocal({ x: b.x + dstOff[0] - t.x - 20, y: b.y + dstOff[1] - t.y - 20, w: b.w + 40, h: b.h + 40 }, t.canvas);
    if (r) healRegion(t.canvas, base, lm, r, 4 + o.diffusion * 2);
    touchTarget(t); invalidate(); commit('Patch', 'healing');
  },
  overlay(x, v) {
    const dr = this.drag, sel = App.doc?.selection; if (!dr || !sel) return;
    x.save(); x.setTransform(new DOMMatrix().scale(v.dpr).multiply(v.matrix()).translate(dr.dx, dr.dy));
    x.lineWidth = 1 / v.zoom; x.setLineDash([4 / v.zoom, 4 / v.zoom]); x.strokeStyle = '#fff'; x.stroke(sel.outline()); x.restore();
  },
});
defineTool({
  id: 'red-eye', name: 'Red Eye Tool', key: 'J', group: 'heal', icon: 'red-eye', cursor: 'crosshair',
  defaults: { pupil: 50, darken: 50 },
  bar: [{ type: 'range', key: 'pupil', label: 'Ukuran Pupil', min: 1, max: 100, unit: '%' }, { type: 'range', key: 'darken', label: 'Gelapkan', min: 1, max: 100, unit: '%' }],
  down(ev) { this.start = { x: ev.x, y: ev.y }; this.cur = { x: ev.x, y: ev.y }; },
  move(ev) { if (this.start) { this.cur = { x: ev.x, y: ev.y }; App.view.redraw(); } },
  async up() {
    const s = this.start, c = this.cur; this.start = null; if (!s) return;
    const t = await editTarget({ allowMask: false }); if (!t) return;
    const o = opts('red-eye'), rad = Math.max(12, Math.hypot(c.x - s.x, c.y - s.y) || 24);
    const cx = (s.x + c.x) / 2 - t.x, cy = (s.y + c.y) / 2 - t.y, R = c.x === s.x && c.y === s.y ? 30 : rad;
    const x0 = Math.max(0, Math.floor(cx - R)), y0 = Math.max(0, Math.floor(cy - R)), w = Math.min(t.canvas.width - x0, Math.ceil(R * 2)), hh = Math.min(t.canvas.height - y0, Math.ceil(R * 2));
    if (w <= 0 || hh <= 0) return;
    const x = ctx2d(t.canvas), img = x.getImageData(x0, y0, w, hh), d = img.data, dk = 1 - o.darken / 100 * .8;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2], redness = r - Math.max(g, b);
      if (redness > 30 * (1 - o.pupil / 200) && r > 60) { const v = Math.max(g, b) * dk; d[i] = v; d[i + 1] = g * dk; d[i + 2] = b * dk; }
    }
    x.putImageData(img, x0, y0); touchTarget(t); invalidate(); commit('Red Eye', 'visibility');
  },
});

// ── Focus & toning ───────────────────────────────────────────────────────
function localDab(s, p, size, fn) {
  const o = s.o, t = s.t, r = Math.ceil(size / 2) + 1, x0 = Math.floor(p.x - t.x - r), y0 = Math.floor(p.y - t.y - r), w = r * 2;
  const wx = s.live.wx, img = wx.getImageData(x0, y0, w, w);
  const tip = ctx2d(roundTip(w - 2, o.hardness ?? 0)).getImageData(0, 0, w, w).data;
  const sw = selectionWeights({ x: x0 + t.x, y: y0 + t.y, w, h: w });
  const weights = new Float32Array(w * w);
  for (let i = 0; i < weights.length; i++) weights[i] = tip[i * 4 + 3] / 255 * (sw ? sw.data[i * 4 + 3] / 255 : 1);
  fn(img, weights, w, s, p);
  wx.putImageData(img, x0, y0);
  return { x: x0 + t.x, y: y0 + t.y, w, h: w };
}
const FOCUS_DEF = { ...BRUSH_DEF, size: 40, hardness: 0, strength: 50, mode: 'normal', sampleAll: false, spacing: 20 };
strokeTool({
  id: 'blur', name: 'Blur Tool', group: 'focus', icon: 'blur-tool', allowMask: false, defaults: FOCUS_DEF,
  bar: [{ type: 'brush' }, { type: 'select', key: 'mode', label: 'Mode', options: [['normal', 'Normal'], ['darken', 'Darken'], ['lighten', 'Lighten'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity']] }, { type: 'range', key: 'strength', label: 'Strength', min: 1, max: 100, unit: '%' }],
  directDab: (s, p, size) => localDab(s, p, size, (img, W, w, ss) => {
    const k = ss.o.strength / 100, src = new Uint8ClampedArray(img.data), b = gaussianImageData(new ImageData(new Uint8ClampedArray(img.data), w, w), 1 + k * 2).data, d = img.data;
    for (let i = 0; i < W.length; i++) { const a = W[i] * k; if (!a) continue; for (let c = 0; c < 4; c++) d[i * 4 + c] = src[i * 4 + c] + (b[i * 4 + c] - src[i * 4 + c]) * a; }
  }),
});
strokeTool({
  id: 'sharpen', name: 'Sharpen Tool', group: 'focus', icon: 'sharpen-tool', allowMask: false, defaults: { ...FOCUS_DEF, protect: true },
  bar: [{ type: 'brush' }, { type: 'range', key: 'strength', label: 'Strength', min: 1, max: 100, unit: '%' }, { type: 'check', key: 'protect', label: 'Protect Detail' }],
  directDab: (s, p, size) => localDab(s, p, size, (img, W, w, ss) => {
    const k = ss.o.strength / 100 * (ss.o.protect ? .5 : 1), src = new Uint8ClampedArray(img.data), b = gaussianImageData(new ImageData(new Uint8ClampedArray(img.data), w, w), 1).data, d = img.data;
    for (let i = 0; i < W.length; i++) { const a = W[i] * k; if (!a) continue; for (let c = 0; c < 3; c++) d[i * 4 + c] = src[i * 4 + c] + (src[i * 4 + c] - b[i * 4 + c]) * a * 1.5; }
  }),
});
strokeTool({
  id: 'smudge', name: 'Smudge Tool', group: 'focus', icon: 'smudge', allowMask: false, defaults: { ...FOCUS_DEF, spacing: 8, finger: false },
  bar: [{ type: 'brush' }, { type: 'range', key: 'strength', label: 'Strength', min: 1, max: 100, unit: '%' }, { type: 'check', key: 'finger', label: 'Finger Painting' }],
  directDab: (s, p, size) => localDab(s, p, size, (img, W, w, ss) => {
    const d = img.data, k = ss.o.strength / 100;
    if (!ss.carry || ss.carry.length !== d.length) {
      ss.carry = new Float32Array(d.length);
      for (let i = 0; i < d.length; i++) ss.carry[i] = ss.o.finger && (i & 3) !== 3 ? [App.fg.r, App.fg.g, App.fg.b][i & 3] : d[i];
      return;
    }
    const cr = ss.carry;
    for (let i = 0; i < W.length; i++) {
      const a = W[i]; if (!a) continue;
      for (let c = 0; c < 4; c++) { const j = i * 4 + c, out = d[j] + (cr[j] - d[j]) * a * k; cr[j] = cr[j] + (out - cr[j]) * (1 - k) ; d[j] = out; }
    }
  }),
});
const TONE_DEF = { ...BRUSH_DEF, size: 60, hardness: 0, range: 'mid', exposure: 50, protect: true, spacing: 20 };
function toneFn(burn) {
  return (img, W, w, ss) => {
    const d = img.data, o = ss.o, e = o.exposure / 100 * .25;
    for (let i = 0; i < W.length; i++) {
      const a = W[i] * e; if (!a) continue;
      const j = i * 4, l = luma(d[j], d[j + 1], d[j + 2]) / 255;
      const wgt = o.range === 'shadows' ? (1 - l) ** 2 : o.range === 'highlights' ? l * l : 1 - Math.abs(l - .5) * 2;
      const k = a * Math.max(.05, wgt);
      for (let c = 0; c < 3; c++) {
        const v = d[j + c] / 255;
        let nv = burn ? v * (1 - k) : v + (1 - v) * k;
        if (o.protect) { const ratio = l > 0 ? v / Math.max(.001, l) : 1; nv = burn ? v - (v * k) * Math.min(1.2, ratio) * .9 : nv; }
        d[j + c] = nv * 255;
      }
    }
  };
}
strokeTool({
  id: 'dodge', name: 'Dodge Tool', key: 'O', group: 'tone', icon: 'dodge', allowMask: false, defaults: TONE_DEF,
  bar: [{ type: 'brush' }, { type: 'select', key: 'range', label: 'Range', options: [['shadows', 'Shadows'], ['mid', 'Midtones'], ['highlights', 'Highlights']] }, { type: 'range', key: 'exposure', label: 'Exposure', min: 1, max: 100, unit: '%' }, { type: 'toggle', key: 'air', icon: 'airbrush', tip: 'Airbrush' }, { type: 'check', key: 'protect', label: 'Protect Tones' }],
  directDab: (s, p, size) => localDab(s, p, size, toneFn(false)),
});
strokeTool({
  id: 'burn', name: 'Burn Tool', key: 'O', group: 'tone', icon: 'burn', allowMask: false, defaults: TONE_DEF,
  bar: [{ type: 'brush' }, { type: 'select', key: 'range', label: 'Range', options: [['shadows', 'Shadows'], ['mid', 'Midtones'], ['highlights', 'Highlights']] }, { type: 'range', key: 'exposure', label: 'Exposure', min: 1, max: 100, unit: '%' }, { type: 'toggle', key: 'air', icon: 'airbrush', tip: 'Airbrush' }, { type: 'check', key: 'protect', label: 'Protect Tones' }],
  directDab: (s, p, size) => localDab(s, p, size, toneFn(true)),
});
strokeTool({
  id: 'sponge', name: 'Sponge Tool', key: 'O', group: 'tone', icon: 'sponge', allowMask: false, defaults: { ...TONE_DEF, smode: 'desaturate', flow: 50, vibrance: true },
  bar: [{ type: 'brush' }, { type: 'select', key: 'smode', label: 'Mode', options: [['desaturate', 'Desaturate'], ['saturate', 'Saturate']] }, { type: 'range', key: 'flow', label: 'Flow', min: 1, max: 100, unit: '%' }, { type: 'check', key: 'vibrance', label: 'Vibrance' }],
  directDab: (s, p, size) => localDab(s, p, size, (img, W, w, ss) => {
    const d = img.data, k = ss.o.flow / 100 * .2 * (ss.o.smode === 'saturate' ? 1 : -1);
    for (let i = 0; i < W.length; i++) {
      const a = W[i]; if (!a) continue; const j = i * 4, l = luma(d[j], d[j + 1], d[j + 2]);
      let kk = k * a; if (ss.o.vibrance && kk > 0) { const sat = (Math.max(d[j], d[j + 1], d[j + 2]) - Math.min(d[j], d[j + 1], d[j + 2])) / 255; kk *= 1 - sat; }
      for (let c = 0; c < 3; c++) d[j + c] = l + (d[j + c] - l) * (1 + kk);
    }
  }),
});

export { StrokeSession };
