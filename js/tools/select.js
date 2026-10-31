// Selection, Move, Crop, Eyedropper family, Gradient, Paint Bucket, navigation tools

import { App, commit, invalidate, toast } from '../state.js';
import { canvas, ctx2d, clamp, cloneCanvas, rectFromPts, deg, rad } from '../util.js';
import { defineTool, opts, editTarget, touchTarget, sampleCanvas, pixelAt, LiveEdit, selectionWeights } from './base.js';
import { Selection, colorRegion } from '../selection.js';
import { rgbCss, rgbToHex, resolveStops, GRADIENT_PRESETS, gradientLUT } from '../color.js';
import { PAINT_MODES } from './paint.js';
import { contentSurface } from '../composite.js';

// ── helpers ──────────────────────────────────────────────────────────────
export function inDoc(x, v, fn, lw = 1) {
  x.save(); x.setTransform(new DOMMatrix().scale(v.dpr).multiply(v.matrix()));
  x.lineWidth = lw / v.zoom; fn(x, 1 / v.zoom); x.restore();
}
export function ants(x, v, pathFn) {
  inDoc(x, v, (c, px) => {
    c.beginPath(); pathFn(c); c.strokeStyle = '#fff'; c.stroke();
    c.setLineDash([4 * px, 4 * px]); c.lineDashOffset = -v.antsPhase * px; c.strokeStyle = '#000'; c.stroke();
  });
}
function modeFrom(ev, o) {
  if (ev.shift && ev.alt) return 'int';
  if (ev.shift) return 'add';
  if (ev.alt) return 'sub';
  return o.selMode || 'new';
}
export function applySelection(sel, mode, label = 'Seleksi') {
  const d = App.doc;
  let s = sel;
  if (mode !== 'new' && d.selection) s = d.selection.combine(sel, mode);
  else if (mode === 'sub' || mode === 'int') s = null;
  d.selection = s && !s.empty ? s : null;
  invalidate(); App.view.redraw();
  commit(d.selection ? label : 'Batalkan Seleksi', 'select');
  App.emit('selection');
}
const SEL_BAR = [{ type: 'selmode' }, { type: 'range', key: 'feather', label: 'Feather', min: 0, max: 250, unit: 'px' }];

// ── Move ─────────────────────────────────────────────────────────────────
function moveLayerBy(L, dx, dy) {
  if (L.isGroup) { L.children.forEach(c => moveLayerBy(c, dx, dy)); return; }
  if (L.type === 'adjust' || L.type === 'fill') { if (L.mask) { L.mask.x += dx; L.mask.y += dy; L.mask.rev++; } L.touch(); return; }
  L.x += dx; L.y += dy;
  if (L.mask && L.mask.linked) { L.mask.x += dx; L.mask.y += dy; L.mask.rev++; }
  L._cache = null; L.touch();
}
export { moveLayerBy };
defineTool({
  id: 'move', name: 'Move Tool', key: 'V', group: 'move', icon: 'move', cursor: 'default',
  defaults: { autoSelect: false, autoTarget: 'layer', showTransform: false },
  bar: [{ type: 'check', key: 'autoSelect', label: 'Auto-Select:' }, { type: 'select', key: 'autoTarget', options: [['layer', 'Layer'], ['group', 'Group']] }, { type: 'check', key: 'showTransform', label: 'Show Transform Controls' }, { type: 'sep' }, { type: 'align' }],
  pickLayer(x, y) {
    const d = App.doc, comp = (L) => {
      if (!L.visible || L.locks.all) return false;
      if (L.isGroup) return null;
      const s = contentSurface(L, d); if (!s) return false;
      const px = Math.floor(x - s.x), py = Math.floor(y - s.y);
      if (px < 0 || py < 0 || px >= s.canvas.width || py >= s.canvas.height) return false;
      return ctx2d(s.canvas).getImageData(px, py, 1, 1).data[3] > 10;
    };
    const walk = (node) => {
      for (let i = node.children.length - 1; i >= 0; i--) {
        const L = node.children[i]; if (!L.visible) continue;
        if (L.isGroup) { const r = walk(L); if (r) return opts('move').autoTarget === 'group' ? L : r; }
        else if (comp(L)) return L;
      }
      return null;
    };
    return walk(d.root);
  },
  async down(ev) {
    const d = App.doc, o = opts('move');
    if (o.showTransform && App.transform?.hit?.(ev)) return App.transform.begin(ev);
    if (o.autoSelect !== ev.mod) { const L = this.pickLayer(ev.x, ev.y); if (L) d.setActive(L.id); }
    let layers = d.selectedLayers().filter(l => !l.locks.position && !l.locks.all && !l.isBackground);
    const L = d.active;
    if (!L) return;
    if (ev.alt) {
      // Alt-drag duplicates
      if (d.selection && L.type === 'raster') { /* handled as float copy below */ }
      else { App.duplicateLayers?.(); layers = d.selectedLayers(); }
    }
    if (d.selection && !d.selection.empty && L.type === 'raster' && !L.locks.all) {
      const t = await editTarget({ allowMask: true }); if (!t) return;
      const sel = d.selection, live = new LiveEdit(t);
      const fl = canvas(t.canvas.width, t.canvas.height), fx = ctx2d(fl);
      fx.drawImage(t.canvas, 0, 0); fx.globalCompositeOperation = 'destination-in'; fx.drawImage(sel.canvas, -t.x, -t.y);
      if (!ev.alt) {
        const wx = live.wx; wx.save(); wx.globalCompositeOperation = 'destination-out'; wx.drawImage(sel.canvas, -t.x, -t.y); wx.restore();
        if (L.isBackground) { wx.save(); wx.globalCompositeOperation = 'destination-over'; wx.fillStyle = rgbCss(App.bg); wx.fillRect(0, 0, fl.width, fl.height); wx.restore(); }
      }
      this.st = { kind: 'float', t, live, fl, cut: cloneCanvas(live.work), x0: ev.x, y0: ev.y, dx: 0, dy: 0, sel: sel.clone() };
      App.hideAnts = true;
      return;
    }
    if (!layers.length) { if (L.isBackground) toast('Layer Background terkunci. Klik dua kali untuk membukanya.'); return; }
    this.st = { kind: 'layers', layers, x0: ev.x, y0: ev.y, dx: 0, dy: 0 };
  },
  move(ev) {
    const st = this.st; if (!st) return;
    let dx = Math.round(ev.x - st.x0), dy = Math.round(ev.y - st.y0);
    if (ev.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    const ddx = dx - st.dx, ddy = dy - st.dy; if (!ddx && !ddy) return;
    st.dx = dx; st.dy = dy;
    if (st.kind === 'layers') { st.layers.forEach(L => moveLayerBy(L, ddx, ddy)); invalidate(); App.emit('layermoved'); }
    else {
      const wx = st.live.wx; wx.clearRect(0, 0, st.fl.width, st.fl.height); wx.drawImage(st.cut, 0, 0); wx.drawImage(st.fl, dx, dy);
      st.live.flush({ x: 0, y: 0, w: App.doc.w, h: App.doc.h });
      App.view.redraw();
    }
  },
  up() {
    const st = this.st; this.st = null; App.hideAnts = false; if (!st) return;
    if (st.kind === 'layers') { if (st.dx || st.dy) commit('Move', 'open_with'); return; }
    st.live.commit();
    if (st.dx || st.dy) { App.doc.selection = st.sel.translate(st.dx, st.dy); commit('Move', 'open_with'); }
    invalidate();
  },
  onKey(e) {
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]; if (!k) return false;
    const d = App.doc, n = e.shiftKey ? 10 : 1;
    const layers = d.selectedLayers().filter(l => !l.locks.position && !l.isBackground);
    if (!layers.length) return true;
    layers.forEach(L => moveLayerBy(L, k[0] * n, k[1] * n)); invalidate();
    clearTimeout(this.nudgeT); this.nudgeT = setTimeout(() => commit('Nudge', 'open_with'), 350);
    return true;
  },
  overlay(x, v) {
    const o = opts('move'), d = App.doc;
    if (this.st?.kind === 'float') { const st = this.st; inDoc(x, v, c => { c.translate(st.dx, st.dy); c.setLineDash([4 / v.zoom, 4 / v.zoom]); c.strokeStyle = '#fff'; c.stroke(st.sel.outline()); }); }
    if (o.showTransform && d?.active && !this.st) App.transform?.drawBox?.(x, v, d.active);
  },
});

defineTool({
  id: 'artboard', name: 'Artboard Tool', key: 'V', group: 'move', icon: 'artboard', cursor: 'crosshair', defaults: {},
  bar: [{ type: 'note', text: 'Seret untuk mengubah ukuran kanvas seperti artboard (Image › Canvas Size)' }],
  down(ev) { this.s = { x: ev.x, y: ev.y }; this.c = { x: ev.x, y: ev.y }; },
  move(ev) { if (this.s) { this.c = { x: ev.x, y: ev.y }; App.view.redraw(); } },
  up() { const r = this.s && rectFromPts(this.s.x, this.s.y, this.c.x, this.c.y); this.s = null; if (r && r.w > 4 && r.h > 4) App.cropDoc({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }, false); },
  overlay(x, v) { if (!this.s) return; const r = rectFromPts(this.s.x, this.s.y, this.c.x, this.c.y); inDoc(x, v, c => { c.strokeStyle = '#2f8cff'; c.lineWidth = 2 / v.zoom; c.strokeRect(r.x, r.y, r.w, r.h); }); },
});

// ── Marquees ─────────────────────────────────────────────────────────────
function marquee(id, name, icon, shape) {
  defineTool({
    id, name, key: shape === 'rect' || shape === 'ellipse' ? 'M' : undefined, group: 'marquee', icon, cursor: 'crosshair',
    defaults: { selMode: 'new', feather: 0, antialias: true, style: 'normal', ratioW: 1, ratioH: 1, fixW: 64, fixH: 64 },
    bar: shape === 'rect' || shape === 'ellipse' ? [...SEL_BAR, ...(shape === 'ellipse' ? [{ type: 'check', key: 'antialias', label: 'Anti-alias' }] : []), { type: 'select', key: 'style', label: 'Style', options: [['normal', 'Normal'], ['ratio', 'Fixed Ratio'], ['size', 'Fixed Size']] }, { type: 'wh' }, { type: 'sep' }, { type: 'button', label: 'Select and Mask…', action: 'selectAndMask' }] : SEL_BAR,
    down(ev) {
      const d = App.doc, o = opts(id), sel = d.selection;
      this.mode = modeFrom(ev, o); this.modsAtDown = ev.shift || ev.alt;
      if (this.mode === 'new' && sel && !sel.empty && sel.get(ev.x, ev.y) > 128 && shape !== 'row' && shape !== 'col') {
        this.moving = { x0: ev.x, y0: ev.y, dx: 0, dy: 0, sel }; App.hideAnts = true; return;
      }
      const p = App.view.snap(ev.x, ev.y);
      this.s = p; this.c = p;
      if (shape === 'row' || shape === 'col') this.c = { ...p };
      if (o.style === 'size' && (shape === 'rect' || shape === 'ellipse')) this.c = { x: p.x + o.fixW, y: p.y + o.fixH };
    },
    move(ev) {
      if (this.moving) { this.moving.dx = Math.round(ev.x - this.moving.x0); this.moving.dy = Math.round(ev.y - this.moving.y0); App.view.redraw(); return; }
      if (!this.s) return;
      const o = opts(id); let p = App.view.snap(ev.x, ev.y);
      if (o.style === 'size') { this.s = { x: p.x - (this.c.x - this.s.x), y: p.y - (this.c.y - this.s.y) }; this.c = { x: p.x, y: p.y }; this.s = { x: p.x - o.fixW, y: p.y - o.fixH }; this.c = p; App.view.redraw(); return; }
      let dx = p.x - this.s.x, dy = p.y - this.s.y;
      if (o.style === 'ratio') { const r = o.ratioW / o.ratioH; if (Math.abs(dx) / r > Math.abs(dy)) dy = Math.sign(dy || 1) * Math.abs(dx) / r; else dx = Math.sign(dx || 1) * Math.abs(dy) * r; }
      else if (ev.shift && !this.modsAtDown) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; }
      this.c = { x: this.s.x + dx, y: this.s.y + dy };
      this.fromCenter = ev.alt && !this.modsAtDown;
      App.view.redraw(); App.emit('marquee', this.rect());
    },
    rect() {
      if (!this.s) return null;
      if (shape === 'row') return { x: 0, y: Math.floor(this.c.y), w: App.doc.w, h: 1 };
      if (shape === 'col') return { x: Math.floor(this.c.x), y: 0, w: 1, h: App.doc.h };
      if (this.fromCenter) { const dx = this.c.x - this.s.x, dy = this.c.y - this.s.y; return rectFromPts(this.s.x - dx, this.s.y - dy, this.c.x, this.c.y); }
      return rectFromPts(this.s.x, this.s.y, this.c.x, this.c.y);
    },
    up() {
      const d = App.doc;
      if (this.moving) {
        const m = this.moving; this.moving = null; App.hideAnts = false;
        if (m.dx || m.dy) { d.selection = m.sel.clone().translate(m.dx, m.dy); commit('Pindahkan Seleksi', 'select'); App.emit('selection'); }
        invalidate(); return;
      }
      const r = this.rect(); this.s = null; if (!r) return;
      const o = opts(id);
      if ((r.w < 1 || r.h < 1) && shape !== 'row' && shape !== 'col') { if (this.mode === 'new' && d.selection) applySelection(null, 'new', 'Batalkan Seleksi'); App.view.redraw(); return; }
      const rr = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w) || 1, h: Math.round(r.h) || 1 };
      const sel = shape === 'ellipse' ? Selection.ellipse(d.w, d.h, r, { feather: o.feather, antialias: o.antialias }) : Selection.rect(d.w, d.h, rr, { feather: o.feather });
      applySelection(sel, this.mode, shape === 'ellipse' ? 'Elliptical Marquee' : 'Rectangular Marquee');
    },
    overlay(x, v) {
      if (this.moving) { const m = this.moving; inDoc(x, v, c => { c.translate(m.dx, m.dy); c.strokeStyle = '#fff'; c.stroke(m.sel.outline()); c.setLineDash([4 / v.zoom, 4 / v.zoom]); c.strokeStyle = '#000'; c.stroke(m.sel.outline()); }); return; }
      const r = this.rect(); if (!r) return;
      ants(x, v, c => { if (shape === 'ellipse') c.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(.1, r.w / 2), Math.max(.1, r.h / 2), 0, 0, Math.PI * 2); else c.rect(r.x, r.y, r.w, r.h); });
      const p = v.toScreen(r.x + r.w, r.y + r.h);
      App.hud?.(x, p.x + 14, p.y + 14, [`W: ${Math.round(r.w)} px`, `H: ${Math.round(r.h)} px`]);
    },
  });
}
marquee('marquee-rect', 'Rectangular Marquee Tool', 'marquee-rect', 'rect');
marquee('marquee-ellipse', 'Elliptical Marquee Tool', 'marquee-ellipse', 'ellipse');
marquee('marquee-row', 'Single Row Marquee Tool', 'marquee-row', 'row');
marquee('marquee-col', 'Single Column Marquee Tool', 'marquee-col', 'col');

// ── Lassos ───────────────────────────────────────────────────────────────
defineTool({
  id: 'lasso', name: 'Lasso Tool', key: 'L', group: 'lasso', icon: 'lasso', cursor: 'crosshair',
  defaults: { selMode: 'new', feather: 0, antialias: true },
  bar: [...SEL_BAR, { type: 'check', key: 'antialias', label: 'Anti-alias' }, { type: 'sep' }, { type: 'button', label: 'Select and Mask…', action: 'selectAndMask' }],
  down(ev) { this.mode = modeFrom(ev, opts('lasso')); this.pts = [{ x: ev.x, y: ev.y }]; },
  move(ev) {
    if (!this.pts) return;
    if (ev.alt && !this.polyMode) { this.polyMode = true; }
    const l = this.pts[this.pts.length - 1];
    if (Math.hypot(ev.x - l.x, ev.y - l.y) * App.view.zoom > 1.5) this.pts.push({ x: ev.x, y: ev.y });
    App.view.redraw();
  },
  up() {
    const pts = this.pts; this.pts = null; this.polyMode = false; if (!pts) return;
    const d = App.doc, o = opts(this.id || 'lasso');
    if (pts.length < 3) { if (this.mode === 'new') applySelection(null, 'new'); return; }
    applySelection(Selection.polygon(d.w, d.h, pts, { feather: o.feather, antialias: o.antialias }), this.mode, 'Lasso');
  },
  overlay(x, v) { const pts = this.pts; if (!pts) return; ants(x, v, c => { pts.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); }); },
});
defineTool({
  id: 'polygon-lasso', name: 'Polygonal Lasso Tool', key: 'L', group: 'lasso', icon: 'polygon-lasso', cursor: 'crosshair',
  defaults: { selMode: 'new', feather: 0, antialias: true },
  bar: [...SEL_BAR, { type: 'check', key: 'antialias', label: 'Anti-alias' }],
  down(ev) {
    let p = { x: ev.x, y: ev.y };
    if (!this.pts) { this.mode = modeFrom(ev, opts('polygon-lasso')); this.pts = [p]; this.hoverPt = p; return; }
    const f = this.pts[0];
    if (ev.shift && this.pts.length) p = constrain45(this.pts[this.pts.length - 1], p);
    if (this.pts.length > 2 && Math.hypot(f.x - p.x, f.y - p.y) * App.view.zoom < 8) return this.close();
    this.pts.push(p);
  },
  hover(ev) { if (this.pts) { let p = { x: ev.x, y: ev.y }; if (ev.shift) p = constrain45(this.pts[this.pts.length - 1], p); this.hoverPt = p; } },
  move(ev) { this.hover(ev); },
  dblclick() { if (this.pts) this.close(); },
  close() {
    const pts = this.pts; this.pts = null; const d = App.doc, o = opts('polygon-lasso');
    if (pts.length >= 3) applySelection(Selection.polygon(d.w, d.h, pts, { feather: o.feather, antialias: o.antialias }), this.mode, 'Polygonal Lasso');
    App.view.redraw();
  },
  onKey(e) {
    if (!this.pts) return false;
    if (e.key === 'Enter') { this.close(); return true; }
    if (e.key === 'Escape') { this.pts = null; App.view.redraw(); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') { this.pts.pop(); if (!this.pts.length) this.pts = null; App.view.redraw(); return true; }
    return false;
  },
  deactivate() { this.pts = null; },
  overlay(x, v) {
    const pts = this.pts; if (!pts) return;
    ants(x, v, c => { pts.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); if (this.hoverPt) c.lineTo(this.hoverPt.x, this.hoverPt.y); });
    const f = v.toScreen(pts[0].x, pts[0].y); x.strokeStyle = '#fff'; x.beginPath(); x.arc(f.x, f.y, 4, 0, Math.PI * 2); x.stroke();
  },
});
const constrain45 = (a, b) => { const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * Math.PI / 4, d = Math.hypot(b.x - a.x, b.y - a.y); return { x: a.x + Math.cos(ang) * d, y: a.y + Math.sin(ang) * d }; };
export { constrain45 };

defineTool({
  id: 'magnetic-lasso', name: 'Magnetic Lasso Tool', key: 'L', group: 'lasso', icon: 'magnetic-lasso', cursor: 'crosshair',
  defaults: { selMode: 'new', feather: 0, antialias: true, width: 10, contrast: 10, frequency: 57 },
  bar: [...SEL_BAR, { type: 'check', key: 'antialias', label: 'Anti-alias' }, { type: 'range', key: 'width', label: 'Width', min: 1, max: 256, unit: 'px' }, { type: 'range', key: 'contrast', label: 'Contrast', min: 1, max: 100, unit: '%' }, { type: 'range', key: 'frequency', label: 'Frequency', min: 0, max: 100 }],
  gradient() {
    const d = App.doc;
    if (this.grad && this.grad.rev === d.history.index) return this.grad;
    const c = sampleCanvas('all'), img = ctx2d(c).getImageData(0, 0, d.w, d.h).data, G = new Float32Array(d.w * d.h);
    const L = i => img[i * 4] * .3 + img[i * 4 + 1] * .59 + img[i * 4 + 2] * .11;
    for (let y = 1; y < d.h - 1; y++) for (let x = 1; x < d.w - 1; x++) { const i = y * d.w + x; G[i] = Math.hypot(L(i + 1) - L(i - 1), L(i + d.w) - L(i - d.w)); }
    this.grad = { G, rev: d.history.index }; return this.grad;
  },
  snapPt(x, y) {
    const d = App.doc, o = opts('magnetic-lasso'), { G } = this.gradient(), r = Math.round(o.width / 2);
    let best = { x, y }, bv = o.contrast * .8;
    for (let yy = Math.max(1, Math.round(y) - r); yy <= Math.min(d.h - 2, Math.round(y) + r); yy++) for (let xx = Math.max(1, Math.round(x) - r); xx <= Math.min(d.w - 2, Math.round(x) + r); xx++) {
      const v = G[yy * d.w + xx] - Math.hypot(xx - x, yy - y) * .6; if (v > bv) { bv = v; best = { x: xx + .5, y: yy + .5 }; }
    }
    return best;
  },
  down(ev) {
    if (!this.pts) { this.mode = modeFrom(ev, opts('magnetic-lasso')); this.gradient(); const p = this.snapPt(ev.x, ev.y); this.pts = [p]; this.anchors = [p]; return; }
    const f = this.pts[0];
    if (this.pts.length > 4 && Math.hypot(f.x - ev.x, f.y - ev.y) * App.view.zoom < 9) return this.close();
    const p = this.snapPt(ev.x, ev.y); this.pts.push(p); this.anchors.push(p);
  },
  hover(ev) {
    if (!this.pts) return;
    const p = this.snapPt(ev.x, ev.y), l = this.pts[this.pts.length - 1], o = opts('magnetic-lasso');
    const spacing = Math.max(3, 40 - o.frequency * .35);
    if (Math.hypot(p.x - l.x, p.y - l.y) > spacing / Math.max(.25, App.view.zoom) * .5) { this.pts.push(p); if (this.pts.length % 4 === 0) this.anchors.push(p); }
    this.hoverPt = p;
  },
  move(ev) { this.hover(ev); },
  dblclick() { if (this.pts) this.close(); },
  close() { const pts = this.pts; this.pts = null; const d = App.doc, o = opts('magnetic-lasso'); if (pts.length > 2) applySelection(Selection.polygon(d.w, d.h, pts, { feather: o.feather, antialias: o.antialias }), this.mode, 'Magnetic Lasso'); App.view.redraw(); },
  onKey(e) { if (!this.pts) return false; if (e.key === 'Enter') { this.close(); return true; } if (e.key === 'Escape') { this.pts = null; App.view.redraw(); return true; } if (e.key === 'Backspace') { this.pts.splice(-6); if (!this.pts.length) this.pts = null; App.view.redraw(); return true; } return false; },
  overlay(x, v) {
    if (!this.pts) return;
    ants(x, v, c => { this.pts.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); if (this.hoverPt) c.lineTo(this.hoverPt.x, this.hoverPt.y); });
    x.fillStyle = '#fff'; x.strokeStyle = '#000';
    for (const a of this.anchors) { const p = v.toScreen(a.x, a.y); x.fillRect(p.x - 2.5, p.y - 2.5, 5, 5); x.strokeRect(p.x - 2.5, p.y - 2.5, 5, 5); }
  },
});

// ── Smart selections ─────────────────────────────────────────────────────
defineTool({
  id: 'magic-wand', name: 'Magic Wand Tool', key: 'W', group: 'quicksel', icon: 'magic-wand', cursor: 'crosshair',
  defaults: { selMode: 'new', tolerance: 32, antialias: true, contiguous: true, sampleAll: false, sampleSize: 1 },
  bar: [{ type: 'selmode' }, { type: 'select', key: 'sampleSize', label: 'Sample Size', options: [[1, 'Point Sample'], [3, '3 by 3 Average'], [5, '5 by 5 Average'], [11, '11 by 11 Average']] }, { type: 'range', key: 'tolerance', label: 'Tolerance', min: 0, max: 255 }, { type: 'check', key: 'antialias', label: 'Anti-alias' }, { type: 'check', key: 'contiguous', label: 'Contiguous' }, { type: 'check', key: 'sampleAll', label: 'Sample All Layers' }, { type: 'sep' }, { type: 'button', label: 'Select Subject', action: 'selectSubject' }, { type: 'button', label: 'Select and Mask…', action: 'selectAndMask' }],
  down(ev) {
    const d = App.doc, o = opts('magic-wand');
    if (ev.x < 0 || ev.y < 0 || ev.x >= d.w || ev.y >= d.h) return;
    const src = sampleCanvas(o.sampleAll ? 'all' : 'current');
    const img = ctx2d(src).getImageData(0, 0, d.w, d.h);
    const a = colorRegion(img, ev.x, ev.y, { tolerance: o.tolerance, contiguous: o.contiguous, antialias: o.antialias });
    applySelection(Selection.fromAlpha(d.w, d.h, a), modeFrom(ev, o), 'Magic Wand');
  },
});
defineTool({
  id: 'quick-select', name: 'Quick Selection Tool', key: 'W', group: 'quicksel', icon: 'quick-select', cursor: 'crosshair',
  defaults: { selMode: 'add', size: 30, sampleAll: true, enhance: true },
  bar: [{ type: 'seg', key: 'selMode', options: [['new', 'sel-new', 'Seleksi baru'], ['add', 'sel-add', 'Tambah ke seleksi'], ['sub', 'sel-sub', 'Kurangi dari seleksi']] }, { type: 'range', key: 'size', label: 'Ukuran', min: 1, max: 500, unit: 'px' }, { type: 'check', key: 'sampleAll', label: 'Sample All Layers' }, { type: 'check', key: 'enhance', label: 'Enhance Edge' }, { type: 'sep' }, { type: 'button', label: 'Select Subject', action: 'selectSubject' }, { type: 'button', label: 'Select and Mask…', action: 'selectAndMask' }],
  brushSize() { return opts('quick-select').size; },
  down(ev) {
    const d = App.doc, o = opts('quick-select');
    let mode = ev.alt ? 'sub' : ev.shift ? 'add' : o.selMode;
    if (mode === 'new' && d.selection) mode = 'new';
    this.st = { mode, img: ctx2d(sampleCanvas(o.sampleAll ? 'all' : 'current')).getImageData(0, 0, d.w, d.h), acc: new Uint8ClampedArray(d.w * d.h), base: mode === 'new' ? null : d.selection, last: null };
    this.grow(ev);
  },
  move(ev) { if (this.st) { const l = this.st.last; if (!l || Math.hypot(ev.x - l.x, ev.y - l.y) > opts('quick-select').size / 4) this.grow(ev); } },
  grow(ev) {
    const st = this.st, d = App.doc, o = opts('quick-select'), { width: w, height: h, data: px } = st.img;
    st.last = { x: ev.x, y: ev.y };
    const r = o.size / 2, cx = ev.x, cy = ev.y;
    // colour model from pixels under the brush
    let n = 0, mr = 0, mg = 0, mb = 0, vr = 0;
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(h, cy + r); y++) for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(w, cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue; const i = (y * w + x) * 4; mr += px[i]; mg += px[i + 1]; mb += px[i + 2]; n++;
    }
    if (!n) return;
    mr /= n; mg /= n; mb /= n;
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(h, cy + r); y++) for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(w, cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue; const i = (y * w + x) * 4; vr += (px[i] - mr) ** 2 + (px[i + 1] - mg) ** 2 + (px[i + 2] - mb) ** 2;
    }
    const tol = Math.min(140, Math.sqrt(vr / n) * 2.4 + 22), R = r * 5;
    const stack = [], seen = new Uint8Array(w * h), acc = st.acc;
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(h, cy + r); y++) for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(w, cx + r); x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { stack.push(y * w + x); seen[y * w + x] = 1; }
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0, i = p * 4;
      const dd = Math.hypot(px[i] - mr, px[i + 1] - mg, px[i + 2] - mb);
      if (dd > tol && (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      acc[p] = 255;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= w * h || seen[q]) continue; const qx = q % w, qy = (q / w) | 0;
        if (Math.abs(qx - x) > 1 || (qx - cx) ** 2 + (qy - cy) ** 2 > R * R) continue;
        seen[q] = 1; stack.push(q);
      }
    }
    let sel = Selection.fromAlpha(d.w, d.h, acc);
    if (o.enhance) sel.smooth(1.2);
    if (st.mode === 'sub') sel = (st.base || new Selection(d.w, d.h)).combine(sel, 'sub');
    else if (st.base) sel = st.base.combine(sel, 'add');
    d.selection = sel.empty ? null : sel; App.view.redraw();
  },
  up() { if (!this.st) return; this.st = null; commit('Quick Selection', 'select'); App.emit('selection'); },
});
defineTool({
  id: 'object-select', name: 'Object Selection Tool', key: 'W', group: 'quicksel', icon: 'object-select', cursor: 'crosshair',
  defaults: { selMode: 'new' }, bar: [{ type: 'selmode' }, { type: 'note', text: 'Seret kotak di sekitar objek' }, { type: 'sep' }, { type: 'button', label: 'Select Subject', action: 'selectSubject' }],
  down(ev) { this.mode = modeFrom(ev, opts('object-select')); this.s = { x: ev.x, y: ev.y }; this.c = this.s; },
  move(ev) { if (this.s) { this.c = { x: ev.x, y: ev.y }; App.view.redraw(); } },
  up() {
    if (!this.s) return; const r = rectFromPts(this.s.x, this.s.y, this.c.x, this.c.y); this.s = null;
    if (r.w < 4 || r.h < 4) return;
    const sel = App.subjectMask?.({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
    if (sel) applySelection(sel, this.mode, 'Object Selection');
  },
  overlay(x, v) { if (!this.s) return; const r = rectFromPts(this.s.x, this.s.y, this.c.x, this.c.y); ants(x, v, c => c.rect(r.x, r.y, r.w, r.h)); },
});

// ── Crop ─────────────────────────────────────────────────────────────────
const CROP_RATIOS = [['free', 'Rasio'], ['orig', 'Rasio asli'], ['1:1', '1 : 1 (Persegi)'], ['4:5', '4 : 5 (8 : 10)'], ['5:7', '5 : 7'], ['2:3', '2 : 3 (4 : 6)'], ['16:9', '16 : 9'], ['9:16', '9 : 16'], ['3:2', '3 : 2']];
defineTool({
  id: 'crop', name: 'Crop Tool', key: 'C', group: 'crop', icon: 'crop', cursor: 'crosshair',
  defaults: { ratio: 'free', overlay: 'thirds', deleteCropped: false, contentAware: false },
  bar: [{ type: 'select', key: 'ratio', options: CROP_RATIOS }, { type: 'button', icon: 'swap_horiz', tip: 'Tukar lebar dan tinggi', action: 'cropSwap' }, { type: 'button', label: 'Clear', action: 'cropClear' }, { type: 'sep' }, { type: 'select', key: 'overlay', label: 'Overlay', options: [['thirds', 'Rule of Thirds'], ['grid', 'Grid'], ['golden', 'Golden Ratio'], ['diagonal', 'Diagonal'], ['none', 'Tidak ada']] }, { type: 'check', key: 'deleteCropped', label: 'Delete Cropped Pixels' }, { type: 'sep' }, { type: 'button', icon: 'close', tip: 'Batal (Esc)', action: 'cropCancel' }, { type: 'button', icon: 'check', tip: 'Terapkan (Enter)', action: 'cropCommit', primary: true }],
  activate() { const d = App.doc; if (d) { this.r = { x: 0, y: 0, w: d.w, h: d.h }; App.view.redraw(); } },
  deactivate() { this.r = null; App.view?.redraw(); },
  ratio() {
    const o = opts('crop'), d = App.doc;
    if (o.ratio === 'free') return null;
    if (o.ratio === 'orig') return d.w / d.h;
    const [a, b] = o.ratio.split(':').map(Number); return o.swapped ? b / a : a / b;
  },
  handleAt(ev) {
    const r = this.r; if (!r) return null;
    const pts = { nw: [r.x, r.y], n: [r.x + r.w / 2, r.y], ne: [r.x + r.w, r.y], e: [r.x + r.w, r.y + r.h / 2], se: [r.x + r.w, r.y + r.h], s: [r.x + r.w / 2, r.y + r.h], sw: [r.x, r.y + r.h], w: [r.x, r.y + r.h / 2] };
    for (const [k, [x, y]] of Object.entries(pts)) { const p = App.view.toScreen(x, y); if (Math.hypot(p.x - ev.sx, p.y - ev.sy) < 9) return k; }
    if (ev.x > r.x && ev.y > r.y && ev.x < r.x + r.w && ev.y < r.y + r.h) return 'move';
    return null;
  },
  cursor(ev) { const h = this.handleAt(ev); return { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' }[h] || 'crosshair'; },
  down(ev) {
    if (!this.r) this.activate();
    const hnd = this.handleAt(ev);
    this.drag = { hnd: hnd || 'new', x0: ev.x, y0: ev.y, r0: { ...this.r } };
    if (!hnd) this.r = { x: ev.x, y: ev.y, w: 0, h: 0 };
  },
  move(ev) {
    const dr = this.drag; if (!dr) return;
    const p = App.view.snap(ev.x, ev.y), r0 = dr.r0, ratio = this.ratio();
    let { x, y, w, h } = r0;
    const dx = p.x - dr.x0, dy = p.y - dr.y0;
    if (dr.hnd === 'move') { x += dx; y += dy; }
    else if (dr.hnd === 'new') { x = dr.x0; y = dr.y0; w = p.x - dr.x0; h = p.y - dr.y0; if (ratio) h = Math.sign(h || 1) * Math.abs(w) / ratio; else if (ev.shift) h = Math.sign(h || 1) * Math.abs(w); }
    else {
      if (dr.hnd.includes('w')) { x += dx; w -= dx; } if (dr.hnd.includes('e')) w += dx;
      if (dr.hnd.includes('n')) { y += dy; h -= dy; } if (dr.hnd.includes('s')) h += dy;
      if (ratio || ev.shift) { const k = ratio || r0.w / r0.h; if (dr.hnd === 'n' || dr.hnd === 's') { const nw = h * k; x -= (nw - w) / 2; w = nw; } else { const nh = w / k; if (dr.hnd.includes('n')) y -= nh - h; h = nh; } }
    }
    const R = rectFromPts(x, y, x + w, y + h); this.r = R; App.view.redraw();
  },
  up() { this.drag = null; },
  dblclick() { this.commitCrop(); },
  onKey(e) { if (e.key === 'Enter') { this.commitCrop(); return true; } if (e.key === 'Escape') { this.activate(); return true; } return false; },
  commitCrop() {
    const r = this.r; if (!r || r.w < 1 || r.h < 1) return;
    App.cropDoc({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }, opts('crop').deleteCropped);
    this.activate();
  },
  overlay(x, v) {
    const r = this.r, d = App.doc; if (!r || !d) return;
    inDoc(x, v, (c, px) => {
      c.fillStyle = 'rgba(0,0,0,.55)';
      c.beginPath(); c.rect(-1e5, -1e5, 2e5, 2e5); c.rect(r.x, r.y, r.w, r.h); c.fill('evenodd');
      c.strokeStyle = 'rgba(255,255,255,.55)'; c.lineWidth = px;
      const o = opts('crop').overlay;
      c.beginPath();
      if (o === 'thirds' || o === 'grid') { const n = o === 'grid' ? 6 : 3; for (let i = 1; i < n; i++) { c.moveTo(r.x + r.w * i / n, r.y); c.lineTo(r.x + r.w * i / n, r.y + r.h); c.moveTo(r.x, r.y + r.h * i / n); c.lineTo(r.x + r.w, r.y + r.h * i / n); } }
      if (o === 'golden') { const g = .382; for (const t of [g, 1 - g]) { c.moveTo(r.x + r.w * t, r.y); c.lineTo(r.x + r.w * t, r.y + r.h); c.moveTo(r.x, r.y + r.h * t); c.lineTo(r.x + r.w, r.y + r.h * t); } }
      if (o === 'diagonal') { c.moveTo(r.x, r.y); c.lineTo(r.x + r.w, r.y + r.h); c.moveTo(r.x + r.w, r.y); c.lineTo(r.x, r.y + r.h); }
      c.stroke();
      c.strokeStyle = '#fff'; c.lineWidth = px; c.strokeRect(r.x, r.y, r.w, r.h);
    });
    x.fillStyle = '#fff';
    const L = 14;
    for (const [hx, hy, ax, ay] of [[r.x, r.y, 1, 1], [r.x + r.w, r.y, -1, 1], [r.x + r.w, r.y + r.h, -1, -1], [r.x, r.y + r.h, 1, -1]]) {
      const p = v.toScreen(hx, hy); x.fillRect(p.x, p.y, L * ax, 3 * ay); x.fillRect(p.x, p.y, 3 * ax, L * ay);
    }
    for (const [hx, hy, horiz] of [[r.x + r.w / 2, r.y, 1], [r.x + r.w / 2, r.y + r.h, 1], [r.x, r.y + r.h / 2, 0], [r.x + r.w, r.y + r.h / 2, 0]]) {
      const p = v.toScreen(hx, hy); if (horiz) x.fillRect(p.x - 8, p.y - 1.5, 16, 3); else x.fillRect(p.x - 1.5, p.y - 8, 3, 16);
    }
    if (this.drag) { const p = v.toScreen(r.x + r.w, r.y + r.h); App.hud?.(x, p.x + 12, p.y + 12, [`W: ${Math.round(r.w)} px`, `H: ${Math.round(r.h)} px`]); }
  },
});

// ── Eyedropper family ────────────────────────────────────────────────────
defineTool({
  id: 'eyedropper', name: 'Eyedropper Tool', key: 'I', group: 'eyedropper', icon: 'eyedropper', cursor: 'crosshair',
  defaults: { size: 1, sample: 'all', ring: true },
  bar: [{ type: 'select', key: 'size', label: 'Sample Size', options: [[1, 'Point Sample'], [3, '3 by 3 Average'], [5, '5 by 5 Average'], [11, '11 by 11 Average'], [31, '31 by 31 Average'], [51, '51 by 51 Average'], [101, '101 by 101 Average']] }, { type: 'select', key: 'sample', label: 'Sample', options: [['all', 'Semua Layer'], ['current', 'Layer Saat Ini']] }, { type: 'check', key: 'ring', label: 'Show Sampling Ring' }],
  pick(ev, setBg = ev.alt && App.activeTool()?.id === 'eyedropper') {
    const o = opts('eyedropper'), src = sampleCanvas(o.sample), c = pixelAt(src, ev.x, ev.y, o.size);
    if (!c || (!c.a && o.sample === 'current')) return null;
    const col = { r: c.r, g: c.g, b: c.b };
    if (setBg) App.setBg(col); else App.setFg(col);
    this.ring = { prev: setBg ? App.bg : App.fg, cur: col, ev };
    return col;
  },
  down(ev) { this.prevColor = { ...(ev.alt ? App.bg : App.fg) }; this.pick(ev); this.active = true; },
  move(ev) { if (this.active) this.pick(ev); },
  up() { this.active = false; this.ring = null; App.view.redraw(); },
  overlay(x) {
    if (!this.active || !this.ring || !opts('eyedropper').ring) return;
    const { ev, cur } = this.ring, R = 52;
    x.save(); x.lineWidth = 18;
    x.beginPath(); x.arc(ev.sx, ev.sy, R, -Math.PI, 0); x.strokeStyle = rgbCss(cur); x.stroke();
    x.beginPath(); x.arc(ev.sx, ev.sy, R, 0, Math.PI); x.strokeStyle = rgbCss(this.prevColor || cur); x.stroke();
    x.lineWidth = 1; x.strokeStyle = 'rgba(128,128,128,.9)'; x.beginPath(); x.arc(ev.sx, ev.sy, R + 9, 0, Math.PI * 2); x.stroke(); x.beginPath(); x.arc(ev.sx, ev.sy, R - 9, 0, Math.PI * 2); x.stroke();
    x.restore();
  },
});
defineTool({
  id: 'color-sampler', name: 'Color Sampler Tool', key: 'I', group: 'eyedropper', icon: 'color-sampler', cursor: 'crosshair',
  defaults: { size: 1 }, bar: [{ type: 'select', key: 'size', label: 'Sample Size', options: [[1, 'Point Sample'], [3, '3 by 3 Average'], [5, '5 by 5 Average']] }, { type: 'button', label: 'Clear All', action: 'clearSamplers' }],
  down(ev) {
    const d = App.doc; d.samplers ||= [];
    const hit = d.samplers.findIndex(s => Math.hypot(s.x - ev.x, s.y - ev.y) * App.view.zoom < 8);
    if (ev.alt && hit >= 0) { d.samplers.splice(hit, 1); App.emit('samplers'); App.view.redraw(); return; }
    if (hit >= 0) { this.drag = d.samplers[hit]; return; }
    if (d.samplers.length >= 10) { toast('Maksimal 10 titik sampler'); return; }
    this.drag = { x: Math.floor(ev.x) + .5, y: Math.floor(ev.y) + .5 }; d.samplers.push(this.drag); App.emit('samplers');
  },
  move(ev) { if (this.drag) { this.drag.x = Math.floor(ev.x) + .5; this.drag.y = Math.floor(ev.y) + .5; App.emit('samplers'); App.view.redraw(); } },
  up() { this.drag = null; },
});
App.on('composited', () => App.doc?.samplers?.length && App.emit('samplers'));
App.overlays = App.overlays || [];
App.overlays.push((x, v) => {
  const d = App.doc; if (!d?.samplers?.length || !App.prefs.extras) return;
  d.samplers.forEach((s, i) => {
    const p = v.toScreen(s.x, s.y); x.strokeStyle = '#000'; x.lineWidth = 3;
    x.beginPath(); x.arc(p.x, p.y, 5, 0, Math.PI * 2); x.moveTo(p.x - 9, p.y); x.lineTo(p.x + 9, p.y); x.moveTo(p.x, p.y - 9); x.lineTo(p.x, p.y + 9); x.stroke();
    x.strokeStyle = '#fff'; x.lineWidth = 1; x.stroke();
    x.font = '600 10px Inter, sans-serif'; x.fillStyle = '#000'; x.fillText(String(i + 1), p.x + 7, p.y + 15); x.fillStyle = '#fff'; x.fillText(String(i + 1), p.x + 6, p.y + 14);
  });
});
defineTool({
  id: 'ruler', name: 'Ruler Tool', key: 'I', group: 'eyedropper', icon: 'ruler', cursor: 'crosshair',
  defaults: {}, bar: [{ type: 'rulerinfo' }, { type: 'button', label: 'Straighten Layer', action: 'rulerStraighten' }, { type: 'button', label: 'Clear', action: 'rulerClear' }],
  down(ev) { this.a = { x: ev.x, y: ev.y }; this.b = { ...this.a }; App.emit('ruler'); },
  move(ev) { if (this.a) { let p = { x: ev.x, y: ev.y }; if (ev.shift) p = constrain45(this.a, p); this.b = p; App.emit('ruler'); App.view.redraw(); } },
  up() { },
  info() { if (!this.a) return null; const dx = this.b.x - this.a.x, dy = this.b.y - this.a.y; return { x: this.a.x, y: this.a.y, w: dx, h: dy, a: -deg(Math.atan2(dy, dx)), l: Math.hypot(dx, dy) }; },
  overlay(x, v) {
    if (!this.a) return; const p = v.toScreen(this.a.x, this.a.y), q = v.toScreen(this.b.x, this.b.y);
    x.strokeStyle = '#000'; x.lineWidth = 3; x.beginPath(); x.moveTo(p.x, p.y); x.lineTo(q.x, q.y); x.stroke(); x.strokeStyle = '#fff'; x.lineWidth = 1; x.stroke();
    for (const s of [p, q]) { x.beginPath(); x.moveTo(s.x - 5, s.y); x.lineTo(s.x + 5, s.y); x.moveTo(s.x, s.y - 5); x.lineTo(s.x, s.y + 5); x.stroke(); }
  },
});

// ── Gradient & Paint Bucket ──────────────────────────────────────────────
export function currentGradientStops(o) {
  const pre = o.custom || GRADIENT_PRESETS[o.preset ?? 0]?.stops;
  let st = resolveStops(pre, App.fg, App.bg);
  if (o.reverse) st = st.map(([p, c, a]) => [1 - p, c, a]).reverse();
  if (!o.transparency) st = st.map(([p, c]) => [p, c, 1]);
  return st;
}
export function drawGradient(img, a, b, type, stops, dither = true) {
  const { width: w, height: h, data: d } = img, lut = gradientLUT(stops);
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1, len = Math.sqrt(len2), ang = Math.atan2(dy, dx);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = x - a.x, py = y - a.y; let t;
    if (type === 'linear') t = (px * dx + py * dy) / len2;
    else if (type === 'reflected') t = Math.abs((px * dx + py * dy) / len2);
    else if (type === 'radial') t = Math.hypot(px, py) / len;
    else if (type === 'angle') { let q = Math.atan2(py, px) - ang; q = ((q % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2); t = 1 - q / (Math.PI * 2); }
    else { const u = (px * Math.cos(ang) + py * Math.sin(ang)), v = (-px * Math.sin(ang) + py * Math.cos(ang)); t = (Math.abs(u) + Math.abs(v)) / len; }
    t = clamp(t, 0, 1); let k = t * 255; if (dither) k += (Math.random() - .5) * .9;
    const i = (y * w + x) * 4, j = clamp(Math.round(k), 0, 255) * 4;
    d[i] = lut[j]; d[i + 1] = lut[j + 1]; d[i + 2] = lut[j + 2]; d[i + 3] = lut[j + 3];
  }
  return img;
}
defineTool({
  id: 'gradient', name: 'Gradient Tool', key: 'G', group: 'gradient', icon: 'gradient', cursor: 'crosshair',
  defaults: { preset: 0, type: 'linear', mode: 'normal', opacity: 100, reverse: false, dither: true, transparency: true },
  bar: [{ type: 'gradient' }, { type: 'seg', key: 'type', options: [['linear', 'grad-linear', 'Linear Gradient'], ['radial', 'grad-radial', 'Radial Gradient'], ['angle', 'grad-angle', 'Angle Gradient'], ['reflected', 'grad-reflected', 'Reflected Gradient'], ['diamond', 'grad-diamond', 'Diamond Gradient']] }, { type: 'select', key: 'mode', label: 'Mode', options: PAINT_MODES }, { type: 'range', key: 'opacity', label: 'Opacity', min: 1, max: 100, unit: '%' }, { type: 'check', key: 'reverse', label: 'Reverse' }, { type: 'check', key: 'dither', label: 'Dither' }, { type: 'check', key: 'transparency', label: 'Transparency' }],
  down(ev) { this.a = { x: ev.x, y: ev.y }; this.b = { ...this.a }; },
  move(ev) { if (!this.a) return; let p = { x: ev.x, y: ev.y }; if (ev.shift) p = constrain45(this.a, p); this.b = p; App.view.redraw(); },
  async up() {
    const a = this.a, b = this.b; this.a = null; App.view.redraw();
    if (!a || Math.hypot(b.x - a.x, b.y - a.y) < 1) return;
    const t = await editTarget(); if (!t) return;
    const o = opts('gradient'), d = App.doc;
    const g = canvas(d.w, d.h), gx = ctx2d(g), img = gx.createImageData(d.w, d.h);
    let stops = currentGradientStops(o);
    if (t.kind === 'mask') stops = stops.map(([p, c, al]) => { const v = Math.round(c.r * .3 + c.g * .59 + c.b * .11); return [p, { r: v, g: v, b: v }, al]; });
    drawGradient(img, a, b, o.type, stops, o.dither); gx.putImageData(img, 0, 0);
    if (d.selection && !d.selection.empty) { gx.globalCompositeOperation = 'destination-in'; gx.drawImage(d.selection.canvas, 0, 0); }
    const x = ctx2d(t.canvas); x.save(); x.globalAlpha = o.opacity / 100;
    let mode = { normal: 'source-over', behind: 'destination-over', clear: 'destination-out', dissolve: 'source-over' }[o.mode] || o.mode;
    if (t.kind === 'layer' && t.layer.locks.alpha && mode === 'source-over') mode = 'source-atop';
    x.globalCompositeOperation = mode; x.drawImage(g, -t.x, -t.y); x.restore();
    touchTarget(t); invalidate(); commit('Gradient', 'gradient');
  },
  overlay(x, v) {
    if (!this.a) return; const p = v.toScreen(this.a.x, this.a.y), q = v.toScreen(this.b.x, this.b.y);
    x.strokeStyle = '#000'; x.lineWidth = 3; x.beginPath(); x.moveTo(p.x, p.y); x.lineTo(q.x, q.y); x.stroke(); x.strokeStyle = '#fff'; x.lineWidth = 1; x.stroke();
    for (const s of [p, q]) { x.fillStyle = '#fff'; x.beginPath(); x.arc(s.x, s.y, 4, 0, Math.PI * 2); x.fill(); x.stroke(); }
  },
});
defineTool({
  id: 'bucket', name: 'Paint Bucket Tool', key: 'G', group: 'gradient', icon: 'bucket', cursor: 'crosshair',
  defaults: { source: 'fg', pattern: 0, mode: 'normal', opacity: 100, tolerance: 32, antialias: true, contiguous: true, sampleAll: false },
  bar: [{ type: 'select', key: 'source', options: [['fg', 'Foreground'], ['pattern', 'Pattern']] }, { type: 'pattern', key: 'pattern' }, { type: 'select', key: 'mode', label: 'Mode', options: PAINT_MODES }, { type: 'range', key: 'opacity', label: 'Opacity', min: 1, max: 100, unit: '%' }, { type: 'range', key: 'tolerance', label: 'Tolerance', min: 0, max: 255 }, { type: 'check', key: 'antialias', label: 'Anti-alias' }, { type: 'check', key: 'contiguous', label: 'Contiguous' }, { type: 'check', key: 'sampleAll', label: 'All Layers' }],
  async down(ev) {
    const d = App.doc; if (ev.x < 0 || ev.y < 0 || ev.x >= d.w || ev.y >= d.h) return;
    const t = await editTarget(); if (!t) return;
    const o = opts('bucket');
    const src = o.sampleAll ? sampleCanvas('all') : (() => { const c = canvas(d.w, d.h); ctx2d(c).drawImage(t.canvas, t.x, t.y); return c; })();
    const region = colorRegion(ctx2d(src).getImageData(0, 0, d.w, d.h), ev.x, ev.y, { tolerance: o.tolerance, contiguous: o.contiguous, antialias: o.antialias });
    const m = Selection.fromAlpha(d.w, d.h, region);
    if (d.selection && !d.selection.empty) { const x = m.ctx; x.globalCompositeOperation = 'destination-in'; x.drawImage(d.selection.canvas, 0, 0); }
    const f = canvas(d.w, d.h), fx = ctx2d(f);
    if (o.source === 'pattern' && App.patterns[o.pattern]) { fx.fillStyle = fx.createPattern(App.patterns[o.pattern].canvas, 'repeat'); }
    else { let c = App.fg; if (t.kind === 'mask') { const vv = Math.round(c.r * .3 + c.g * .59 + c.b * .11); c = { r: vv, g: vv, b: vv }; } fx.fillStyle = rgbCss(c); }
    fx.fillRect(0, 0, d.w, d.h); fx.globalCompositeOperation = 'destination-in'; fx.drawImage(m.canvas, 0, 0);
    const x = ctx2d(t.canvas); x.save(); x.globalAlpha = o.opacity / 100;
    let mode = { normal: 'source-over', behind: 'destination-over', clear: 'destination-out', dissolve: 'source-over' }[o.mode] || o.mode;
    if (t.kind === 'layer' && t.layer.locks.alpha && mode === 'source-over') mode = 'source-atop';
    x.globalCompositeOperation = mode; x.drawImage(f, -t.x, -t.y); x.restore();
    touchTarget(t); invalidate(); commit('Paint Bucket', 'format_color_fill');
  },
});

// ── Navigation ───────────────────────────────────────────────────────────
defineTool({
  id: 'hand', name: 'Hand Tool', key: 'H', group: 'hand', icon: 'hand', cursor: 'grab', defaults: {},
  bar: [{ type: 'button', label: '100%', action: 'zoom100' }, { type: 'button', label: 'Fit Screen', action: 'zoomFit' }, { type: 'button', label: 'Fill Screen', action: 'zoomFill' }],
  down(ev) { this.d = { sx: ev.sx, sy: ev.sy, px: App.doc.view.px, py: App.doc.view.py }; App.view.stage.style.cursor = 'grabbing'; },
  move(ev) { if (!this.d) return; const v = App.doc.view; v.px = this.d.px + ev.sx - this.d.sx; v.py = this.d.py + ev.sy - this.d.sy; App.view.changed(); },
  up() { this.d = null; App.view.stage.style.cursor = 'grab'; },
  dblclick() { App.view.fit(); },
});
defineTool({
  id: 'rotate-view', name: 'Rotate View Tool', key: 'R', group: 'hand', icon: 'rotate-view', cursor: 'grab', defaults: {},
  bar: [{ type: 'rotinfo' }, { type: 'button', label: 'Reset View', action: 'resetRotation' }],
  down(ev) { const v = App.view; this.d = { a0: Math.atan2(ev.sy - v.H / 2, ev.sx - v.W / 2), r0: App.doc.view.rot, c: v.toDoc(v.W / 2, v.H / 2) }; },
  move(ev) {
    if (!this.d) return; const v = App.view, a = Math.atan2(ev.sy - v.H / 2, ev.sx - v.W / 2);
    let r = this.d.r0 + deg(a - this.d.a0); if (ev.shift) r = Math.round(r / 15) * 15;
    App.doc.view.rot = ((r + 540) % 360) - 180; v.centerOn(this.d.c.x, this.d.c.y); App.emit('viewchange');
  },
  up() { this.d = null; },
  overlay(x, v) {
    if (!this.d) return; const cx = v.W / 2, cy = v.H / 2, r = App.doc.view.rot;
    x.strokeStyle = '#ff3b30'; x.lineWidth = 2; x.beginPath(); x.arc(cx, cy, 40, 0, Math.PI * 2); x.stroke();
    x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.sin(rad(r)) * 40, cy - Math.cos(rad(r)) * 40); x.stroke();
  },
});
defineTool({
  id: 'zoom', name: 'Zoom Tool', key: 'Z', group: 'zoom', icon: 'zoom', cursor: ev => (ev?.alt ? 'zoom-out' : 'zoom-in'), defaults: { scrubby: true },
  bar: [{ type: 'button', icon: 'zoom_in', tip: 'Perbesar', action: 'zoomIn' }, { type: 'button', icon: 'zoom_out', tip: 'Perkecil', action: 'zoomOut' }, { type: 'check', key: 'scrubby', label: 'Scrubby Zoom' }, { type: 'sep' }, { type: 'button', label: '100%', action: 'zoom100' }, { type: 'button', label: 'Fit Screen', action: 'zoomFit' }, { type: 'button', label: 'Fill Screen', action: 'zoomFill' }],
  down(ev) { this.d = { sx: ev.sx, sy: ev.sy, z: App.view.zoom, alt: ev.alt, moved: false }; },
  move(ev) {
    if (!this.d) return; const dx = ev.sx - this.d.sx;
    if (Math.abs(dx) > 3 && opts('zoom').scrubby) { this.d.moved = true; App.view.zoomTo(this.d.z * Math.exp(dx / 150), this.d.sx, this.d.sy); }
  },
  up(ev) { const d = this.d; this.d = null; if (d && !d.moved) App.view.zoomStep(d.alt || ev.alt ? -1 : 1, ev.sx, ev.sy); },
});

export { selectionWeights };
