// Document model: layer tree, guides, paths, channels and snapshot history

import { canvas, ctx2d, cloneCanvas, uid, Emitter } from './util.js';
import { Selection } from './selection.js';

export const BLEND_MODES = [
  ['pass', 'Pass Through', 'group'],
  ['normal', 'Normal'], ['dissolve', 'Dissolve'], null,
  ['darken', 'Darken'], ['multiply', 'Multiply'], ['color-burn', 'Color Burn'], ['linear-burn', 'Linear Burn'], ['darker-color', 'Darker Color'], null,
  ['lighten', 'Lighten'], ['screen', 'Screen'], ['color-dodge', 'Color Dodge'], ['lighter', 'Linear Dodge (Add)'], ['lighter-color', 'Lighter Color'], null,
  ['overlay', 'Overlay'], ['soft-light', 'Soft Light'], ['hard-light', 'Hard Light'], ['vivid-light', 'Vivid Light'], ['linear-light', 'Linear Light'], ['pin-light', 'Pin Light'], ['hard-mix', 'Hard Mix'], null,
  ['difference', 'Difference'], ['exclusion', 'Exclusion'], ['subtract', 'Subtract'], ['divide', 'Divide'], null,
  ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity'],
];
export const NATIVE_BLEND = new Set(['normal', 'darken', 'multiply', 'color-burn', 'lighten', 'screen', 'color-dodge', 'lighter', 'overlay', 'soft-light', 'hard-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity']);
export const blendLabel = m => (BLEND_MODES.find(b => b && b[0] === m) || [0, m])[1];

export class Layer {
  constructor(o = {}) {
    this.id = o.id || uid('L');
    this.name = o.name || 'Layer';
    this.type = o.type || 'raster';         // raster | text | shape | adjust | fill | group
    this.visible = o.visible ?? true;
    this.opacity = o.opacity ?? 1;
    this.fillOpacity = o.fillOpacity ?? 1;
    this.blend = o.blend || (this.type === 'group' ? 'pass' : 'normal');
    this.locks = { ...{ pixels: false, position: false, alpha: false, all: false }, ...(o.locks || {}) };
    this.clip = o.clip || false;
    this.isBackground = o.isBackground || false;
    this.color = o.color || null;            // label color in Layers panel
    this.x = o.x || 0; this.y = o.y || 0;   // canvas offset in document space
    this.canvas = o.canvas || null;
    this.mask = o.mask || null;             // {canvas, x, y, def, enabled, linked, density, feather}
    this.styles = o.styles || null;
    this.text = o.text || null;
    this.shape = o.shape || null;
    this.adjust = o.adjust || null;
    this.fill = o.fill || null;
    this.children = o.children || (this.type === 'group' ? [] : null);
    this.collapsed = o.collapsed || false;
    this.rev = 1;
  }
  get isGroup() { return this.type === 'group'; }
  get hasPixels() { return this.type === 'raster'; }
  get ctx() { return ctx2d(this.canvas); }
  get w() { return this.canvas ? this.canvas.width : 0; }
  get h() { return this.canvas ? this.canvas.height : 0; }
  touch() { this.rev++; this._thumbRev = -1; }
  get locked() { return this.locks.all; }

  // Make sure the pixel canvas covers [0,0,W,H] (and keep existing pixels that hang outside)
  coverDoc(W, H) { return this.cover(0, 0, W, H); }
  cover(x, y, w, h) {
    if (!this.canvas) { this.canvas = canvas(w, h); this.x = x; this.y = y; return this; }
    const x1 = Math.min(this.x, x), y1 = Math.min(this.y, y);
    const x2 = Math.max(this.x + this.w, x + w), y2 = Math.max(this.y + this.h, y + h);
    if (x1 === this.x && y1 === this.y && x2 === this.x + this.w && y2 === this.y + this.h) return this;
    const c = canvas(x2 - x1, y2 - y1);
    ctx2d(c).drawImage(this.canvas, this.x - x1, this.y - y1);
    this.canvas = c; this.x = x1; this.y = y1;
    return this;
  }
  // Tight bounds of non-transparent pixels in document space
  contentBounds() {
    if (this.type === 'group') {
      let r = null;
      for (const c of this.children) { const b = c.contentBounds(); if (b) r = r ? union(r, b) : b; }
      return r;
    }
    if (!this.canvas) return null;
    const { width: w, height: h } = this.canvas;
    const d = this.ctx.getImageData(0, 0, w, h).data;
    let x1 = w, y1 = h, x2 = -1, y2 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) if (d[row + x * 4 + 3]) {
        if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; y2 = y;
      }
    }
    if (x2 < 0) return null;
    return { x: x1 + this.x, y: y1 + this.y, w: x2 - x1 + 1, h: y2 - y1 + 1 };
  }
  maskAlpha() {
    const m = this.mask; if (!m) return null;
    if (m._alphaRev === m.rev && m._alpha) return m._alpha;
    const c = canvas(m.canvas.width, m.canvas.height);
    const src = ctx2d(m.canvas).getImageData(0, 0, c.width, c.height), d = src.data;
    const dens = m.density ?? 1;
    for (let i = 0; i < d.length; i += 4) { const v = d[i]; d[i + 3] = 255 - (255 - v) * dens; d[i] = d[i + 1] = d[i + 2] = 0; }
    ctx2d(c).putImageData(src, 0, 0);
    m._alpha = c; m._alphaRev = m.rev;
    return c;
  }
}
const union = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };

export function makeMask(W, H, reveal = true) {
  const c = canvas(W, H), x = ctx2d(c);
  x.fillStyle = reveal ? '#fff' : '#000'; x.fillRect(0, 0, W, H);
  return { canvas: c, x: 0, y: 0, def: reveal ? 255 : 0, enabled: true, linked: true, density: 1, feather: 0, rev: 1 };
}

export class Doc extends Emitter {
  constructor({ w, h, name = 'Tanpa Judul-1', bg = '#ffffff', ppi = 72, transparent = false }) {
    super();
    this.id = uid('D');
    this.name = name; this.w = w; this.h = h; this.ppi = ppi;
    this.root = new Layer({ type: 'group', name: 'root' });
    this.selection = null;        // Selection (see selection.js) or null
    this.guides = [];             // {o:'h'|'v', p}
    this.paths = [];              // {id,name,subpaths:[{closed, pts:[{x,y,ix,iy,ox,oy}]}]}
    this.activePathId = null;
    this.channels = [];           // saved selections {id,name,canvas}
    this.history = new History(this);
    this.view = { zoom: 1, px: 0, py: 0, rot: 0, fitted: false };
    this.dirty = false;
    this.fileName = null;
    this.colorMode = 'RGB';
    this.bits = 8;
    if (bg !== null && !transparent) {
      const L = new Layer({ name: 'Background', isBackground: true, locks: { position: true, alpha: true } });
      L.canvas = canvas(w, h);
      const x = L.ctx; x.fillStyle = bg; x.fillRect(0, 0, w, h);
      this.root.children.push(L); this.activeId = L.id;
    } else {
      const L = new Layer({ name: 'Layer 1' }); L.canvas = canvas(w, h);
      this.root.children.push(L); this.activeId = L.id;
    }
    this.selectedIds = new Set([this.activeId]);
    this.layerCounter = 1;
  }

  get active() { return this.find(this.activeId) || this.flat()[0] || null; }
  setActive(id, additive = false) {
    this.activeId = id;
    if (!additive) this.selectedIds = new Set([id]); else this.selectedIds.add(id);
    this.emit('layers');
  }
  selectedLayers() { return this.flat().filter(l => this.selectedIds.has(l.id)); }

  // DFS bottom → top (excluding root)
  flat(node = this.root, out = []) {
    for (const c of node.children) { out.push(c); if (c.isGroup) this.flat(c, out); }
    return out;
  }
  find(id) { return this.flat().find(l => l.id === id) || null; }
  parentOf(layer, node = this.root) {
    for (const c of node.children) {
      if (c === layer) return node;
      if (c.isGroup) { const p = this.parentOf(layer, c); if (p) return p; }
    }
    return null;
  }
  nextName(prefix = 'Layer') { return `${prefix} ${++this.layerCounter}`; }
  insertAbove(layer, ref = this.active) {
    let parent = this.root, idx = parent.children.length;
    if (ref) {
      if (ref.isGroup && !ref.collapsed && ref !== layer && ref.children.length === 0) { parent = ref; idx = 0; }
      else { parent = this.parentOf(ref) || this.root; idx = parent.children.indexOf(ref) + 1; }
    }
    parent.children.splice(idx, 0, layer);
    this.setActive(layer.id);
    return layer;
  }
  remove(layer) {
    const p = this.parentOf(layer); if (!p) return;
    const i = p.children.indexOf(layer); p.children.splice(i, 1);
    if (this.selectedIds.has(layer.id)) this.selectedIds.delete(layer.id);
    if (this.activeId === layer.id || (layer.isGroup && !this.find(this.activeId))) {
      const next = p.children[Math.max(0, i - 1)] || p.children[i] || (p !== this.root ? p : this.flat()[0]);
      if (next) this.setActive(next.id); else this.activeId = null;
    }
  }
  moveTo(layer, parent, idx) {
    if (layer === parent || (layer.isGroup && this.isAncestor(layer, parent))) return false;
    const op = this.parentOf(layer); const oi = op.children.indexOf(layer);
    op.children.splice(oi, 1);
    if (op === parent && oi < idx) idx--;
    parent.children.splice(Math.max(0, Math.min(idx, parent.children.length)), 0, layer);
    return true;
  }
  isAncestor(group, node) {
    if (!node || !group.isGroup) return false;
    let p = node;
    while (p && p !== this.root) { if (p === group) return true; p = this.parentOf(p); }
    return false;
  }
  newRasterLayer(name, ref) {
    const L = new Layer({ name: name || this.nextName() });
    L.canvas = canvas(this.w, this.h);
    return this.insertAbove(L, ref);
  }
  get background() { return this.root.children.find(l => l.isBackground) || null; }
  // Layer below inside the same parent (used by clipping and merge down)
  below(layer) {
    const p = this.parentOf(layer); const i = p.children.indexOf(layer);
    return i > 0 ? p.children[i - 1] : null;
  }
  clipBase(layer) {
    const p = this.parentOf(layer); let i = p.children.indexOf(layer);
    while (i > 0 && p.children[i].clip) i--;
    return p.children[i] === layer ? null : p.children[i];
  }
  markDirty() { this.dirty = true; this.emit('dirty'); }
  changed(what = 'pixels', rect) { this.emit('change', what, rect); }
}

// ── History: copy-on-write snapshots of the whole document state ─────────
const MAX_STATES = 50;

function snapLayer(L) {
  const rec = { ...L, locks: { ...L.locks } };
  delete rec._h; delete rec._thumb; delete rec._thumbRev; delete rec._cache;
  if (L.canvas) {
    if (L._snapRev !== L.rev || !L._snapCanvas) { L._snapCanvas = cloneCanvas(L.canvas); L._snapRev = L.rev; }
    rec.canvas = L._snapCanvas;
  }
  if (L.mask) {
    const m = L.mask;
    if (m._snapRev !== m.rev || !m._snapCanvas) { m._snapCanvas = cloneCanvas(m.canvas); m._snapRev = m.rev; }
    rec.mask = { ...m, canvas: m._snapCanvas, _alpha: null };
  }
  rec.styles = L.styles ? structuredClone(L.styles) : null;
  rec.text = L.text ? structuredClone(L.text) : null;
  rec.shape = L.shape ? structuredClone(L.shape) : null;
  rec.adjust = L.adjust ? structuredClone(L.adjust) : null;
  rec.fill = L.fill ? { ...structuredClone({ ...L.fill, pattern: null }), pattern: L.fill.pattern || null } : null;
  rec.children = L.children ? L.children.map(snapLayer) : null;
  rec._snapCanvas = undefined;
  return rec;
}
function restoreLayer(rec) {
  const L = new Layer({ ...rec, children: rec.children ? rec.children.map(restoreLayer) : null });
  L.rev = rec.rev;
  if (rec.canvas) { L.canvas = cloneCanvas(rec.canvas); L._snapCanvas = rec.canvas; L._snapRev = L.rev; }
  if (rec.mask) {
    L.mask = { ...rec.mask, canvas: cloneCanvas(rec.mask.canvas), _alpha: null, _alphaRev: -1 };
    L.mask._snapCanvas = rec.mask.canvas; L.mask._snapRev = rec.mask.rev;
  }
  L.styles = rec.styles ? structuredClone(rec.styles) : null;
  L.text = rec.text ? structuredClone(rec.text) : null;
  L.shape = rec.shape ? structuredClone(rec.shape) : null;
  L.adjust = rec.adjust ? structuredClone(rec.adjust) : null;
  L.fill = rec.fill ? { ...rec.fill } : null;
  return L;
}

export class History {
  constructor(doc) { this.doc = doc; this.states = []; this.index = -1; this.snapshots = []; }
  capture() {
    const d = this.doc;
    if (d.selection && (d.selection._snapRev !== d.selection.rev)) { d.selection._snapCanvas = cloneCanvas(d.selection.canvas); d.selection._snapRev = d.selection.rev; }
    return {
      w: d.w, h: d.h,
      root: snapLayer(d.root),
      activeId: d.activeId,
      selectedIds: [...d.selectedIds],
      selection: d.selection ? { canvas: d.selection._snapCanvas, rev: d.selection.rev } : null,
      guides: d.guides.map(g => ({ ...g })),
      paths: structuredClone(d.paths),
      channels: d.channels.map(c => ({ ...c })),
      layerCounter: d.layerCounter,
    };
  }
  push(label, iconName = 'edit') {
    this.states.splice(this.index + 1);
    this.states.push({ label, icon: iconName, state: this.capture(), time: Date.now() });
    const limit = this.doc.w * this.doc.h > 9e6 ? 20 : MAX_STATES;
    while (this.states.length > limit) this.states.shift();
    this.index = this.states.length - 1;
    if (this.states.length > 1) this.doc.markDirty();
    this.doc.emit('history');
  }
  // Replace the current state's data (used by live-updating operations like dragging opacity)
  amend(label) {
    if (this.index < 0) return this.push(label);
    const s = this.states[this.index]; s.state = this.capture(); if (label) s.label = label;
    this.doc.emit('history');
  }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.states.length - 1; }
  undo() { if (this.canUndo) this.goto(this.index - 1); }
  redo() { if (this.canRedo) this.goto(this.index + 1); }
  goto(i, restoreFn) {
    i = Math.max(0, Math.min(this.states.length - 1, i));
    const st = this.states[i]?.state; if (!st) return;
    this.index = i;
    this.apply(st, restoreFn);
  }
  apply(st, restoreFn) {
    const d = this.doc;
    d.w = st.w; d.h = st.h;
    d.root = restoreLayer(st.root);
    d.activeId = st.activeId; d.selectedIds = new Set(st.selectedIds);
    d.guides = st.guides.map(g => ({ ...g }));
    d.paths = structuredClone(st.paths);
    d.channels = st.channels.map(c => ({ ...c }));
    d.layerCounter = st.layerCounter;
    if (st.selection) {
      d.selection = Selection.fromCanvas(cloneCanvas(st.selection.canvas));
      d.selection.rev = st.selection.rev; d.selection._snapCanvas = st.selection.canvas; d.selection._snapRev = st.selection.rev;
    } else d.selection = null;
    if (restoreFn) restoreFn(st);
    d.emit('restore', st);
    d.emit('history'); d.emit('layers'); d.changed('all');
  }
  snapshot(name) {
    this.snapshots.push({ name: name || `Snapshot ${this.snapshots.length + 1}`, state: this.capture() });
    this.doc.emit('history');
  }
  // Pixel source for the History Brush: the given layer as it was in the source state
  sourceCanvasFor(layerId, stateRef) {
    const st = stateRef?.state; if (!st) return null;
    const walk = n => { if (n.id === layerId) return n; for (const c of n.children || []) { const r = walk(c); if (r) return r; } return null; };
    const rec = walk(st.root);
    return rec?.canvas ? { canvas: rec.canvas, x: rec.x, y: rec.y } : null;
  }
}

export { snapLayer, restoreLayer };
