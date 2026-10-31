// Shared tool helpers: options storage, edit targets, live previews

import { App, saveToolOpts, invalidate, toast } from '../state.js';
import { canvas, ctx2d, cloneCanvas, rectClip } from '../util.js';
import { flattenDoc } from '../composite.js';

export const TOOLS = {};
export function defineTool(def) { TOOLS[def.id] = def; return def; }

export function opts(id, defaults) {
  const o = App.toolOpts[id] || (App.toolOpts[id] = {});
  for (const [k, v] of Object.entries(defaults || TOOLS[id]?.defaults || {})) if (!(k in o)) o[k] = structuredClone(v);
  return o;
}
export function setOpt(id, k, v) { opts(id)[k] = v; saveToolOpts(); App.emit('toolopts', id, k); }

// Resolve where pixel edits go: the active raster layer or its layer mask
export async function editTarget({ allowMask = true, need = 'pixels' } = {}) {
  const d = App.doc; if (!d) return null;
  const qm = App.quickMaskTarget?.(); if (qm) return qm;
  const L = d.active;
  if (!L) { toast('Tidak ada layer yang dipilih'); return null; }
  if (L.isGroup) { toast('Layer yang dipilih adalah grup. Pilih layer piksel.'); return null; }
  if (allowMask && L.mask && App.maskTarget === L.id) return { kind: 'mask', layer: L, mask: L.mask, canvas: L.mask.canvas, x: L.mask.x, y: L.mask.y };
  if (L.locks.all || (need === 'pixels' && L.locks.pixels)) { toast(`Layer "${L.name}" terkunci`); return null; }
  if (L.type === 'adjust' || (L.type === 'fill' && need === 'pixels')) {
    if (L.mask) { App.maskTarget = L.id; App.emit('layers'); return { kind: 'mask', layer: L, mask: L.mask, canvas: L.mask.canvas, x: L.mask.x, y: L.mask.y }; }
    toast('Layer ini tidak memiliki piksel'); return null;
  }
  if (L.type === 'text' || L.type === 'shape' || L.type === 'fill') {
    const kind = { text: 'teks', shape: 'shape', fill: 'isian' }[L.type];
    const ok = await App.confirm?.(`Layer ${kind} ini harus dirasterisasi sebelum diedit. Rasterisasi sekarang?`, { ok: 'Rasterisasi', title: 'Rasterisasi Layer' });
    if (!ok) return null;
    App.rasterize(L);
  }
  L.coverDoc(d.w, d.h);
  return { kind: 'layer', layer: L, canvas: L.canvas, x: L.x, y: L.y };
}

export function touchTarget(t) {
  if (t.kind === 'mask') { t.mask.rev++; t.mask._alpha = null; t.layer.touch(); }
  else t.layer.touch();
}

// Sample source for eyedropper / wand / clone ('current' layer or 'all' merged)
export function sampleCanvas(mode = 'all') {
  const d = App.doc;
  if (mode === 'current') {
    const L = d.active;
    if (L?.canvas && L.type === 'raster') {
      if (!L.x && !L.y && L.w === d.w && L.h === d.h) return L.canvas;
      const c = canvas(d.w, d.h); ctx2d(c).drawImage(L.canvas, L.x, L.y); return c;
    }
  }
  if (d._comp && !App.live?.size) return d._comp;
  return flattenDoc(d);
}
export function pixelAt(c, x, y, avg = 1) {
  x = Math.floor(x); y = Math.floor(y);
  const r = Math.floor(avg / 2), x0 = Math.max(0, x - r), y0 = Math.max(0, y - r);
  const w = Math.min(c.width, x + r + 1) - x0, h = Math.min(c.height, y + r + 1) - y0;
  if (w <= 0 || h <= 0) return null;
  const dd = ctx2d(c).getImageData(x0, y0, w, h).data; let R = 0, G = 0, B = 0, A = 0, n = 0;
  for (let i = 0; i < dd.length; i += 4) { R += dd[i]; G += dd[i + 1]; B += dd[i + 2]; A += dd[i + 3]; n++; }
  return { r: Math.round(R / n), g: Math.round(G / n), b: Math.round(B / n), a: Math.round(A / n) };
}

// Live preview plumbing: a working copy of the target that the compositor uses instead of the layer
export class LiveEdit {
  constructor(t) {
    this.t = t; this.base = cloneCanvas(t.canvas); this.work = cloneCanvas(t.canvas);
    this.wx = ctx2d(this.work); this.bounds = null;
    if (t.kind === 'layer') { App.live = App.live || new Map(); App.live.set(t.layer.id, { canvas: this.work, x: t.x, y: t.y }); }
  }
  // dirty rect in document coords
  flush(r) {
    if (!r) return;
    if (this.t.kind === 'mask') {
      ctx2d(this.t.canvas).clearRect(0, 0, this.t.canvas.width, this.t.canvas.height);
      ctx2d(this.t.canvas).drawImage(this.work, 0, 0);
      this.t.mask.rev++; this.t.mask._alpha = null; this.t.layer._styled = null;
    } else this.t.layer._styled = null;
    invalidate(r);
  }
  restoreRect(r) {
    const lr = this.local(r); if (!lr) return null;
    this.wx.clearRect(lr.x, lr.y, lr.w, lr.h);
    this.wx.drawImage(this.base, lr.x, lr.y, lr.w, lr.h, lr.x, lr.y, lr.w, lr.h);
    return lr;
  }
  local(r) { return rectClip({ x: r.x - this.t.x, y: r.y - this.t.y, w: r.w, h: r.h }, this.work.width, this.work.height); }
  commit() {
    const c = ctx2d(this.t.canvas); c.clearRect(0, 0, this.t.canvas.width, this.t.canvas.height); c.drawImage(this.work, 0, 0);
    this.end(); touchTarget(this.t);
  }
  cancel() { if (this.t.kind === 'mask') { const c = ctx2d(this.t.canvas); c.clearRect(0, 0, this.t.canvas.width, this.t.canvas.height); c.drawImage(this.base, 0, 0); this.t.mask.rev++; this.t.mask._alpha = null; } this.end(); invalidate(); }
  end() { if (this.t.kind === 'layer') App.live?.delete(this.t.layer.id); this.t.layer._styled = null; }
}

// Selection weight (0..1 per pixel) for a document rect; null when no selection
export function selectionWeights(r) {
  const s = App.doc?.selection; if (!s || s.empty) return null;
  const rr = rectClip(r, s.w, s.h); if (!rr) return { r, data: new Uint8ClampedArray(r.w * r.h * 4) };
  const c = canvas(r.w, r.h), x = ctx2d(c); x.drawImage(s.canvas, -r.x, -r.y);
  return { r, data: x.getImageData(0, 0, r.w, r.h).data };
}
