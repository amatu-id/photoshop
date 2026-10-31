// Vector tools: Pen family, Path/Direct Selection, Shape tools, Type tools

import { App, commit, invalidate, toast } from '../state.js';
import { h, clamp, rectFromPts, uid, rad } from '../util.js';
import { defineTool, opts } from './base.js';
import { Layer } from '../doc.js';
import { rgbToHex } from '../color.js';
import { layoutText, shapePath, fontString } from '../composite.js';
import { inDoc, constrain45, applySelection } from './select.js';
import { Selection } from '../selection.js';

// ── Path geometry helpers ────────────────────────────────────────────────
const K = 0.5522847498;
export function rectPath(x, y, w, h2, r = 0) {
  r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h2) / 2));
  if (!r) return [{ closed: true, pts: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h2 }, { x, y: y + h2 }] }];
  const k = r * K, pts = [
    { x: x + r, y, ix: x + r - k, iy: y }, { x: x + w - r, y, ox: x + w - r + k, oy: y },
    { x: x + w, y: y + r, ix: x + w, iy: y + r - k }, { x: x + w, y: y + h2 - r, ox: x + w, oy: y + h2 - r + k },
    { x: x + w - r, y: y + h2, ix: x + w - r + k, iy: y + h2 }, { x: x + r, y: y + h2, ox: x + r - k, oy: y + h2 },
    { x, y: y + h2 - r, ix: x, iy: y + h2 - r + k }, { x, y: y + r, ox: x, oy: y + r - k },
  ];
  return [{ closed: true, pts }];
}
export function ellipsePath(x, y, w, h2) {
  const rx = w / 2, ry = h2 / 2, cx = x + rx, cy = y + ry, kx = rx * K, ky = ry * K;
  return [{ closed: true, pts: [
    { x: cx, y: y, ix: cx - kx, iy: y, ox: cx + kx, oy: y },
    { x: x + w, y: cy, ix: x + w, iy: cy - ky, ox: x + w, oy: cy + ky },
    { x: cx, y: y + h2, ix: cx + kx, iy: y + h2, ox: cx - kx, oy: y + h2 },
    { x, y: cy, ix: x, iy: cy + ky, ox: x, oy: cy - ky },
  ] }];
}
export function polygonPath(x, y, w, h2, sides = 5, star = 0) {
  const cx = x + w / 2, cy = y + h2 / 2, rx = w / 2, ry = h2 / 2, n = Math.max(3, sides | 0), pts = [];
  for (let i = 0; i < n * (star ? 2 : 1); i++) {
    const a = -Math.PI / 2 + i * Math.PI * 2 / (n * (star ? 2 : 1)), k = star && i % 2 ? 1 - star / 100 : 1;
    pts.push({ x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k });
  }
  return [{ closed: true, pts }];
}
export function linePath(a, b, weight = 2, arrowStart = false, arrowEnd = false) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x), nx = -Math.sin(ang) * weight / 2, ny = Math.cos(ang) * weight / 2;
  const sub = [{ closed: true, pts: [{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }] }];
  const head = (p, dir) => { const L = weight * 5, W = weight * 2.5, ux = Math.cos(ang) * dir, uy = Math.sin(ang) * dir; return { closed: true, pts: [{ x: p.x + ux * L * .3, y: p.y + uy * L * .3 }, { x: p.x - ux * L * .7 - uy * W, y: p.y - uy * L * .7 + ux * W }, { x: p.x - ux * L * .7 + uy * W, y: p.y - uy * L * .7 - ux * W }] }; };
  if (arrowEnd) sub.push(head(b, 1)); if (arrowStart) sub.push(head(a, -1));
  return sub;
}
// Minimal SVG path parser → subpaths with cubic handles (absolute M L H V C Q Z only, plus lowercase)
export function svgToSubpaths(d, x, y, w, h2, vb = 100) {
  const toks = d.match(/[MLHVCQZmlhvcqz]|-?[\d.]+(?:e-?\d+)?/g) || [];
  const sx = w / vb, sy = h2 / vb, T = (px, py) => ({ x: x + px * sx, y: y + py * sy });
  const subs = []; let cur = null, cx = 0, cy = 0, i = 0, cmd = '';
  const num = () => parseFloat(toks[i++]);
  while (i < toks.length) {
    if (/[a-z]/i.test(toks[i])) cmd = toks[i++];
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    if (C === 'M') { cx = num() + (rel ? cx : 0); cy = num() + (rel ? cy : 0); cur = { closed: false, pts: [T(cx, cy)] }; subs.push(cur); cmd = rel ? 'l' : 'L'; }
    else if (C === 'L') { cx = num() + (rel ? cx : 0); cy = num() + (rel ? cy : 0); cur.pts.push(T(cx, cy)); }
    else if (C === 'H') { cx = num() + (rel ? cx : 0); cur.pts.push(T(cx, cy)); }
    else if (C === 'V') { cy = num() + (rel ? cy : 0); cur.pts.push(T(cx, cy)); }
    else if (C === 'C') {
      const x1 = num() + (rel ? cx : 0), y1 = num() + (rel ? cy : 0), x2 = num() + (rel ? cx : 0), y2 = num() + (rel ? cy : 0), x3 = num() + (rel ? cx : 0), y3 = num() + (rel ? cy : 0);
      const last = cur.pts[cur.pts.length - 1], a = T(x1, y1), b = T(x2, y2); last.ox = a.x; last.oy = a.y;
      const p = T(x3, y3); p.ix = b.x; p.iy = b.y; cur.pts.push(p); cx = x3; cy = y3;
    } else if (C === 'Q') {
      const x1 = num() + (rel ? cx : 0), y1 = num() + (rel ? cy : 0), x3 = num() + (rel ? cx : 0), y3 = num() + (rel ? cy : 0);
      const last = cur.pts[cur.pts.length - 1], a = T(cx + (x1 - cx) * 2 / 3, cy + (y1 - cy) * 2 / 3), b = T(x3 + (x1 - x3) * 2 / 3, y3 + (y1 - y3) * 2 / 3);
      last.ox = a.x; last.oy = a.y; const p = T(x3, y3); p.ix = b.x; p.iy = b.y; cur.pts.push(p); cx = x3; cy = y3;
    } else if (C === 'Z') {
      cur.closed = true;
      const f = cur.pts[0], l = cur.pts[cur.pts.length - 1];
      if (cur.pts.length > 1 && Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.y - l.y) < 1e-6) { f.ix = l.ix; f.iy = l.iy; cur.pts.pop(); }
    } else i++;
  }
  return subs;
}
export const CUSTOM_SHAPES = [
  ['Hati', 'M50 88 C20 66 4 50 4 30 C4 15 16 6 28 6 C38 6 46 12 50 20 C54 12 62 6 72 6 C84 6 96 15 96 30 C96 50 80 66 50 88 Z'],
  ['Bintang', 'M50 4 L62 38 L97 38 L69 59 L79 94 L50 73 L21 94 L31 59 L3 38 L38 38 Z'],
  ['Panah Kanan', 'M4 36 L60 36 L60 14 L96 50 L60 86 L60 64 L4 64 Z'],
  ['Panah Kiri', 'M96 36 L40 36 L40 14 L4 50 L40 86 L40 64 L96 64 Z'],
  ['Centang', 'M8 52 L22 38 L40 56 L78 14 L92 28 L40 84 Z'],
  ['Silang', 'M20 8 L50 38 L80 8 L92 20 L62 50 L92 80 L80 92 L50 62 L20 92 L8 80 L38 50 L8 20 Z'],
  ['Balon Bicara', 'M10 10 L90 10 C94 10 96 12 96 16 L96 62 C96 66 94 68 90 68 L42 68 L22 90 L26 68 L10 68 C6 68 4 66 4 62 L4 16 C4 12 6 10 10 10 Z'],
  ['Petir', 'M58 4 L18 56 L46 56 L36 96 L82 38 L54 38 Z'],
  ['Daun', 'M10 90 C10 40 40 10 92 8 C90 60 60 90 10 90 Z'],
  ['Segi Enam', 'M50 4 L90 27 L90 73 L50 96 L10 73 L10 27 Z'],
  ['Tetes', 'M50 4 C66 30 84 48 84 66 C84 84 68 96 50 96 C32 96 16 84 16 66 C16 48 34 30 50 4 Z'],
  ['Bulan Sabit', 'M64 6 C38 10 20 30 20 54 C20 78 40 96 64 94 C44 86 34 70 34 50 C34 30 44 14 64 6 Z'],
  ['Awan', 'M26 80 C12 80 4 70 4 60 C4 48 14 40 26 42 C28 26 40 16 54 16 C68 16 78 26 80 38 C92 38 96 50 96 58 C96 70 88 80 76 80 Z'],
  ['Pita', 'M4 30 L20 30 L20 20 L80 20 L80 30 L96 30 L86 46 L96 62 L74 62 L74 54 L26 54 L26 62 L4 62 L14 46 Z'],
  ['Mahkota', 'M8 80 L14 30 L34 52 L50 16 L66 52 L86 30 L92 80 Z'],
  ['Plus', 'M38 6 L62 6 L62 38 L94 38 L94 62 L62 62 L62 94 L38 94 L38 62 L6 62 L6 38 L38 38 Z'],
  ['Lencana', 'M50 4 L60 14 L74 10 L78 24 L92 28 L88 42 L98 52 L88 62 L92 76 L78 80 L74 94 L60 90 L50 100 L40 90 L26 94 L22 80 L8 76 L12 62 L2 52 L12 42 L8 28 L22 24 L26 10 L40 14 Z'],
  ['Rumah', 'M50 6 L94 44 L82 44 L82 92 L60 92 L60 64 L40 64 L40 92 L18 92 L18 44 L6 44 Z'],
];

export function shapeFromParams(p) {
  const { kind, x, y, w, h: hh } = p;
  if (kind === 'rect') return rectPath(x, y, w, hh, p.radius || 0);
  if (kind === 'ellipse') return ellipsePath(x, y, w, hh);
  if (kind === 'triangle') return [{ closed: true, pts: [{ x: x + w / 2, y }, { x: x + w, y: y + hh }, { x, y: y + hh }] }];
  if (kind === 'polygon') return polygonPath(x, y, w, hh, p.sides, p.star);
  if (kind === 'line') return linePath(p.a, p.b, p.weight, p.arrowStart, p.arrowEnd);
  if (kind === 'custom') return svgToSubpaths(CUSTOM_SHAPES[p.custom || 0][1], x, y, w, hh);
  return p.subpaths || [];
}
export function subpathsBounds(subs) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const s of subs) for (const p of s.pts) for (const [a, b] of [[p.x, p.y], [p.ix, p.iy], [p.ox, p.oy]]) {
    if (a === undefined) continue; x1 = Math.min(x1, a); y1 = Math.min(y1, b); x2 = Math.max(x2, a); y2 = Math.max(y2, b);
  }
  return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
export function rebuildShape(L) {
  const sh = L.shape;
  if (sh.params) sh.subpaths = shapeFromParams(sh.params);
  sh.bounds = subpathsBounds(sh.subpaths);
  L._cache = null; L.touch();
}

const fillBar = [{ type: 'shapefill' }, { type: 'range', key: 'strokeW', label: '', min: 0, max: 200, unit: 'px', width: 46, tip: 'Lebar stroke' }, { type: 'select', key: 'strokeAlign', options: [['center', 'Tengah'], ['inside', 'Dalam'], ['outside', 'Luar']], tip: 'Posisi stroke' }, { type: 'select', key: 'dash', options: [['solid', '———'], ['dash', '— — —'], ['dot', '· · · ·']], tip: 'Tipe stroke' }];
const SHAPE_DEF = { pmode: 'shape', fill: null, fillNone: false, stroke: '#000000', strokeNone: true, strokeW: 3, strokeAlign: 'inside', dash: 'solid', radius: 0, sides: 5, star: 0, weight: 4, arrowStart: false, arrowEnd: false, custom: 0, wTyped: '', hTyped: '' };

function newShapeLayer(params, name) {
  const d = App.doc, o = opts(App.toolId), fg = rgbToHex(App.fg);
  const L = new Layer({ type: 'shape', name: name || d.nextName(params.kind === 'rect' ? 'Rectangle' : params.kind === 'ellipse' ? 'Ellipse' : params.kind === 'line' ? 'Line' : params.kind === 'polygon' ? 'Polygon' : params.kind === 'triangle' ? 'Triangle' : 'Shape') });
  L.shape = {
    params,
    fill: o.fillNone ? null : { type: 'solid', color: o.fill || fg },
    stroke: o.strokeNone ? null : { type: 'solid', color: o.stroke || '#000000', width: o.strokeW, align: o.strokeAlign, dash: o.dash },
  };
  rebuildShape(L);
  d.insertAbove(L);
  return L;
}

// ── Shape tools ──────────────────────────────────────────────────────────
function shapeTool(id, name, icon, kind, extra = []) {
  defineTool({
    id, name, key: 'U', group: 'shape', icon, cursor: 'crosshair', defaults: { ...SHAPE_DEF },
    bar: [{ type: 'select', key: 'pmode', options: [['shape', 'Shape'], ['path', 'Path'], ['pixels', 'Pixels']] }, ...fillBar, { type: 'wh' }, ...extra],
    down(ev) { const p = App.view.snap(ev.x, ev.y); this.s = p; this.c = p; },
    move(ev) {
      if (!this.s) return;
      let p = App.view.snap(ev.x, ev.y);
      if (kind === 'line') { if (ev.shift) p = constrain45(this.s, p); this.c = p; App.view.redraw(); return; }
      let dx = p.x - this.s.x, dy = p.y - this.s.y;
      if (ev.shift) { const m = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * m; dy = Math.sign(dy || 1) * m; }
      this.c = { x: this.s.x + dx, y: this.s.y + dy }; this.alt = ev.alt; App.view.redraw();
    },
    params(clickOnly) {
      const o = opts(id);
      if (kind === 'line') return { kind, a: { ...this.s }, b: { ...this.c }, weight: o.weight, arrowStart: o.arrowStart, arrowEnd: o.arrowEnd };
      let r = this.alt ? rectFromPts(2 * this.s.x - this.c.x, 2 * this.s.y - this.c.y, this.c.x, this.c.y) : rectFromPts(this.s.x, this.s.y, this.c.x, this.c.y);
      if (clickOnly) r = { x: this.s.x, y: this.s.y, w: +o.wTyped || 100, h: +o.hTyped || 100 };
      return { kind, x: r.x, y: r.y, w: r.w, h: r.h, radius: o.radius, sides: o.sides, star: o.star, custom: o.custom };
    },
    up() {
      if (!this.s) return;
      const click = Math.hypot(this.c.x - this.s.x, this.c.y - this.s.y) < 2;
      const p = this.params(click); this.s = null; App.view.redraw();
      if (click && kind === 'line') return;
      const o = opts(id), d = App.doc;
      if (o.pmode === 'path') {
        const P = App.workPath(); P.subpaths.push(...shapeFromParams(p)); d.activePathId = P.id; App.emit('paths'); commit(name.replace(' Tool', ''), 'gesture'); App.view.redraw(); return;
      }
      if (o.pmode === 'pixels') {
        App.fillPathOnLayer?.(shapeFromParams(p), App.fg); return;
      }
      newShapeLayer(p); invalidate(); commit(name.replace(' Tool', ''), 'category');
    },
    overlay(x, v) {
      if (!this.s) return;
      const subs = shapeFromParams(this.params(false)), path = shapePath({ subpaths: subs });
      inDoc(x, v, c => { c.strokeStyle = '#2f8cff'; c.lineWidth = 1.5 / v.zoom; c.stroke(path); });
      if (kind !== 'line') { const r = this.params(false), q = v.toScreen(r.x + r.w, r.y + r.h); App.hud?.(x, q.x + 12, q.y + 12, [`W: ${Math.round(r.w)} px`, `H: ${Math.round(r.h)} px`]); }
    },
  });
}
shapeTool('shape-rect', 'Rectangle Tool', 'shape-rect', 'rect', [{ type: 'range', key: 'radius', label: '⌜', min: 0, max: 500, unit: 'px', width: 44, tip: 'Radius sudut' }]);
shapeTool('shape-ellipse', 'Ellipse Tool', 'shape-ellipse', 'ellipse');
shapeTool('shape-triangle', 'Triangle Tool', 'shape-triangle', 'triangle');
shapeTool('shape-polygon', 'Polygon Tool', 'shape-polygon', 'polygon', [{ type: 'range', key: 'sides', label: 'Sisi', min: 3, max: 100, width: 40 }, { type: 'range', key: 'star', label: 'Star', min: 0, max: 99, unit: '%', width: 40, tip: 'Rasio bintang (indent)' }]);
shapeTool('shape-line', 'Line Tool', 'shape-line', 'line', [{ type: 'range', key: 'weight', label: 'Tebal', min: 1, max: 200, unit: 'px', width: 44 }, { type: 'check', key: 'arrowStart', label: 'Panah awal' }, { type: 'check', key: 'arrowEnd', label: 'Panah akhir' }]);
shapeTool('shape-custom', 'Custom Shape Tool', 'shape-custom', 'custom', [{ type: 'customshape', key: 'custom' }]);

// ── Pen family ───────────────────────────────────────────────────────────
App.workPath = () => {
  const d = App.doc;
  let P = d.paths.find(p => p.id === d.activePathId) || d.paths.find(p => p.work);
  if (!P) { P = { id: uid('P'), name: 'Work Path', work: true, subpaths: [] }; d.paths.push(P); }
  d.activePathId = P.id; return P;
};
// Path being edited: active shape layer's path, or active document path
function editablePath() {
  const d = App.doc, L = d.active;
  if (L?.type === 'shape' && App.pathTarget !== 'doc') return { owner: L, subpaths: L.shape.subpaths, ox: L.x, oy: L.y };
  const P = d.paths.find(p => p.id === d.activePathId);
  return P ? { owner: P, subpaths: P.subpaths, ox: 0, oy: 0 } : null;
}
function changedPath(ep) { if (ep.owner instanceof Layer) { ep.owner.shape.params = null; ep.owner.shape.bounds = subpathsBounds(ep.owner.shape.subpaths); ep.owner._cache = null; ep.owner.touch(); invalidate(); } App.emit('paths'); App.view.redraw(); }

function hitPath(ep, ev, tol = 7) {
  if (!ep) return null;
  const v = App.view;
  for (let si = 0; si < ep.subpaths.length; si++) {
    const sp = ep.subpaths[si];
    for (let pi = 0; pi < sp.pts.length; pi++) {
      const p = sp.pts[pi];
      for (const [k, x, y] of [['in', p.ix, p.iy], ['out', p.ox, p.oy], ['anchor', p.x, p.y]]) {
        if (x === undefined) continue;
        if (k !== 'anchor' && !(App.pathSel?.has(p))) continue;
        const s = v.toScreen(x + ep.ox, y + ep.oy);
        if (Math.hypot(s.x - ev.sx, s.y - ev.sy) < tol) return { si, pi, k, sp, p };
      }
    }
  }
  return null;
}
function hitSegment(ep, ev) {
  if (!ep) return null;
  const c = document.createElement('canvas').getContext('2d');
  for (let si = 0; si < ep.subpaths.length; si++) {
    const path = shapePath({ subpaths: [ep.subpaths[si]] });
    c.lineWidth = 8 / App.view.zoom;
    if (c.isPointInStroke(path, ev.x - ep.ox, ev.y - ep.oy) || (ep.subpaths[si].closed && c.isPointInPath(path, ev.x - ep.ox, ev.y - ep.oy))) return si;
  }
  return null;
}
// Insert an anchor on the segment closest to (x,y) using de Casteljau split
function insertAnchor(sp, x, y) {
  let best = null;
  const n = sp.pts.length, segs = sp.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = sp.pts[i], b = sp.pts[(i + 1) % n];
    const P = [[a.x, a.y], [a.ox ?? a.x, a.oy ?? a.y], [b.ix ?? b.x, b.iy ?? b.y], [b.x, b.y]];
    for (let k = 1; k < 40; k++) {
      const t = k / 40, q = bez(P, t), dd = Math.hypot(q[0] - x, q[1] - y);
      if (!best || dd < best.d) best = { i, t, d: dd, P };
    }
  }
  if (!best) return null;
  const { i, t, P } = best, L = (p, q, s) => [p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s];
  const p01 = L(P[0], P[1], t), p12 = L(P[1], P[2], t), p23 = L(P[2], P[3], t), p012 = L(p01, p12, t), p123 = L(p12, p23, t), m = L(p012, p123, t);
  const a = sp.pts[i], b = sp.pts[(i + 1) % n];
  const curved = a.ox !== undefined || b.ix !== undefined;
  if (curved) { a.ox = p01[0]; a.oy = p01[1]; b.ix = p23[0]; b.iy = p23[1]; }
  const np = curved ? { x: m[0], y: m[1], ix: p012[0], iy: p012[1], ox: p123[0], oy: p123[1] } : { x: m[0], y: m[1] };
  sp.pts.splice(i + 1, 0, np);
  return np;
}
const bez = (P, t) => { const u = 1 - t; return [u * u * u * P[0][0] + 3 * u * u * t * P[1][0] + 3 * u * t * t * P[2][0] + t * t * t * P[3][0], u * u * u * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t * t * t * P[3][1]]; };

function drawPathOverlay(x, v, ep, extra) {
  if (!ep) return;
  inDoc(x, v, c => { c.translate(ep.ox, ep.oy); c.strokeStyle = '#2f8cff'; c.lineWidth = 1.2 / v.zoom; c.stroke(shapePath({ subpaths: ep.subpaths })); extra?.(c); });
  const sel = App.pathSel || new Set();
  for (const sp of ep.subpaths) for (const p of sp.pts) {
    const s = v.toScreen(p.x + ep.ox, p.y + ep.oy);
    if (sel.has(p)) {
      x.strokeStyle = '#2f8cff'; x.lineWidth = 1;
      for (const [hx, hy] of [[p.ix, p.iy], [p.ox, p.oy]]) {
        if (hx === undefined) continue; const q = v.toScreen(hx + ep.ox, hy + ep.oy);
        x.beginPath(); x.moveTo(s.x, s.y); x.lineTo(q.x, q.y); x.stroke();
        x.beginPath(); x.arc(q.x, q.y, 3.5, 0, Math.PI * 2); x.fillStyle = '#2f8cff'; x.fill();
      }
      x.fillStyle = '#2f8cff'; x.fillRect(s.x - 3.5, s.y - 3.5, 7, 7);
    } else { x.fillStyle = '#fff'; x.strokeStyle = '#2f8cff'; x.lineWidth = 1; x.fillRect(s.x - 3.5, s.y - 3.5, 7, 7); x.strokeRect(s.x - 3.5, s.y - 3.5, 7, 7); }
  }
}

defineTool({
  id: 'pen', name: 'Pen Tool', key: 'P', group: 'pen', icon: 'pen', cursor: 'crosshair',
  defaults: { ...SHAPE_DEF, pmode: 'path', rubber: true, autoAdd: true },
  bar: [{ type: 'select', key: 'pmode', options: [['shape', 'Shape'], ['path', 'Path']] }, ...fillBar, { type: 'sep' }, { type: 'button', label: 'Selection…', action: 'pathToSelection' }, { type: 'button', label: 'Mask', action: 'pathToMask' }, { type: 'button', label: 'Shape', action: 'pathToShape' }, { type: 'check', key: 'autoAdd', label: 'Auto Add/Delete' }, { type: 'check', key: 'rubber', label: 'Rubber Band' }],
  deactivate() { this.cur = null; },
  ensure(ev) {
    const o = opts('pen'), d = App.doc;
    if (this.cur && this.cur.ep) return this.cur;
    let ep;
    if (o.pmode === 'shape') {
      const L = d.active?.type === 'shape' && this.continueLayer === d.active.id ? d.active : newShapeLayer({ kind: 'path' }, d.nextName('Shape'));
      L.shape.params = null; L.shape.subpaths ||= [];
      this.continueLayer = L.id; App.pathTarget = 'layer';
      ep = { owner: L, subpaths: L.shape.subpaths, ox: L.x, oy: L.y };
    } else { const P = App.workPath(); App.pathTarget = 'doc'; ep = { owner: P, subpaths: P.subpaths, ox: 0, oy: 0 }; }
    const sp = { closed: false, pts: [] }; ep.subpaths.push(sp);
    this.cur = { ep, sp };
    return this.cur;
  },
  down(ev) {
    if (ev.mod) return App.tools['direct-select'].down(ev);
    const o = opts('pen');
    // auto add / delete on existing paths
    if (!this.cur && o.autoAdd) {
      const ep = editablePath(), hit = hitPath(ep, ev);
      if (hit && hit.k === 'anchor') { hit.sp.pts.splice(hit.pi, 1); if (!hit.sp.pts.length) ep.subpaths.splice(hit.si, 1); changedPath(ep); commit('Hapus Anchor', 'remove'); return; }
      const seg = hitSegment(ep, ev);
      if (seg !== null) { const np = insertAnchor(ep.subpaths[seg], ev.x - ep.ox, ev.y - ep.oy); if (np) { App.pathSel = new Set([np]); changedPath(ep); commit('Tambah Anchor', 'add'); } return; }
    }
    const c = this.ensure(ev), { sp, ep } = c;
    let p = { x: ev.x - ep.ox, y: ev.y - ep.oy };
    if (ev.shift && sp.pts.length) p = constrain45(sp.pts[sp.pts.length - 1], p);
    if (sp.pts.length > 1) {
      const f = sp.pts[0], s = App.view.toScreen(f.x + ep.ox, f.y + ep.oy);
      if (Math.hypot(s.x - ev.sx, s.y - ev.sy) < 8) { sp.closed = true; this.dragging = { pt: f, closing: true }; changedPath(ep); return; }
    }
    const pt = { x: p.x, y: p.y }; sp.pts.push(pt);
    this.dragging = { pt };
    App.pathSel = new Set([pt]);
    changedPath(ep);
  },
  move(ev) {
    const dr = this.dragging; if (!dr || !this.cur) return;
    const { ep } = this.cur, pt = dr.pt, x = ev.x - ep.ox, y = ev.y - ep.oy;
    if (Math.hypot(x - pt.x, y - pt.y) * App.view.zoom < 2) return;
    pt.ox = x; pt.oy = y;
    if (!ev.alt) { pt.ix = 2 * pt.x - x; pt.iy = 2 * pt.y - y; }
    changedPath(ep);
  },
  hover(ev) { this.hoverPt = { x: ev.x, y: ev.y }; },
  up() {
    const dr = this.dragging; this.dragging = null;
    if (!this.cur) return;
    if (dr?.closing) { this.finish(); return; }
    App.view.redraw();
  },
  finish() {
    if (!this.cur) return;
    const { ep, sp } = this.cur;
    if (sp.pts.length < 2 && !sp.closed) ep.subpaths.splice(ep.subpaths.indexOf(sp), 1);
    this.cur = null; this.continueLayer = null; changedPath(ep);
    commit(ep.owner instanceof Layer ? 'Shape Baru' : 'Path Baru', 'draw');
  },
  onKey(e) { if (this.cur && (e.key === 'Enter' || e.key === 'Escape')) { this.finish(); return true; } return false; },
  overlay(x, v) {
    const ep = this.cur?.ep || editablePath();
    drawPathOverlay(x, v, ep, c => {
      const sp = this.cur?.sp; if (!sp?.pts.length || !this.hoverPt || this.dragging || !opts('pen').rubber) return;
      const l = sp.pts[sp.pts.length - 1]; c.beginPath(); c.moveTo(l.x, l.y);
      if (l.ox !== undefined) c.bezierCurveTo(l.ox, l.oy, this.hoverPt.x - ep.ox, this.hoverPt.y - ep.oy, this.hoverPt.x - ep.ox, this.hoverPt.y - ep.oy); else c.lineTo(this.hoverPt.x - ep.ox, this.hoverPt.y - ep.oy);
      c.setLineDash([3 / v.zoom, 3 / v.zoom]); c.stroke();
    });
  },
});
defineTool({
  id: 'freeform-pen', name: 'Freeform Pen Tool', key: 'P', group: 'pen', icon: 'freeform-pen', cursor: 'crosshair',
  defaults: { ...SHAPE_DEF, pmode: 'path', fit: 2 },
  bar: [{ type: 'select', key: 'pmode', options: [['shape', 'Shape'], ['path', 'Path']] }, ...fillBar, { type: 'range', key: 'fit', label: 'Curve Fit', min: .5, max: 10, step: .5, unit: 'px' }],
  down(ev) { this.pts = [{ x: ev.x, y: ev.y }]; },
  move(ev) { if (this.pts) { this.pts.push({ x: ev.x, y: ev.y }); App.view.redraw(); } },
  up() {
    const raw = this.pts; this.pts = null; if (!raw || raw.length < 3) return;
    const tol = opts('freeform-pen').fit, simp = rdp(raw, tol);
    const pts = simp.map((p, i) => {
      const a = simp[i - 1], b = simp[i + 1]; const q = { x: p.x, y: p.y };
      if (a && b) { const tx = (b.x - a.x) / 6, ty = (b.y - a.y) / 6; q.ix = p.x - tx; q.iy = p.y - ty; q.ox = p.x + tx; q.oy = p.y + ty; }
      return q;
    });
    const first = raw[0], last = raw[raw.length - 1], closed = Math.hypot(first.x - last.x, first.y - last.y) * App.view.zoom < 10;
    const o = opts('freeform-pen');
    if (o.pmode === 'shape') { const L = newShapeLayer({ kind: 'path' }); L.shape.params = null; L.shape.subpaths = [{ closed, pts }]; rebuildShape(L); invalidate(); commit('Freeform Shape', 'gesture'); }
    else { const P = App.workPath(); P.subpaths.push({ closed, pts }); App.emit('paths'); commit('Freeform Path', 'gesture'); }
    App.view.redraw();
  },
  overlay(x, v) { if (this.pts) inDoc(x, v, c => { c.beginPath(); this.pts.forEach((p, i) => i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)); c.strokeStyle = '#2f8cff'; c.stroke(); }); },
});
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1]; let idx = 0, md = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], dd = Math.abs((b.y - a.y) * p.x - (b.x - a.x) * p.y + b.x * a.y - b.y * a.x) / (Math.hypot(b.y - a.y, b.x - a.x) || 1);
    if (dd > md) { md = dd; idx = i; }
  }
  if (md > eps) return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
  return [a, b];
}
for (const [id, name, icon, fn] of [
  ['add-anchor', 'Add Anchor Point Tool', 'add-anchor', 'add'],
  ['delete-anchor', 'Delete Anchor Point Tool', 'delete-anchor', 'del'],
  ['convert-point', 'Convert Point Tool', 'convert-point', 'conv'],
]) {
  defineTool({
    id, name, group: 'pen', icon, cursor: 'crosshair', defaults: {}, bar: [{ type: 'note', text: { add: 'Klik pada segmen path untuk menambah titik anchor', del: 'Klik titik anchor untuk menghapusnya', conv: 'Klik anchor untuk menjadikan sudut, seret untuk kurva' }[fn] }],
    down(ev) {
      const ep = editablePath(); if (!ep) return;
      const hit = hitPath(ep, ev);
      if (fn === 'add') { const si = hitSegment(ep, ev); if (si !== null) { const np = insertAnchor(ep.subpaths[si], ev.x - ep.ox, ev.y - ep.oy); App.pathSel = new Set([np]); changedPath(ep); commit('Tambah Anchor', 'add'); } return; }
      if (!hit || hit.k !== 'anchor') return;
      if (fn === 'del') { hit.sp.pts.splice(hit.pi, 1); if (!hit.sp.pts.length) ep.subpaths.splice(hit.si, 1); changedPath(ep); commit('Hapus Anchor', 'remove'); return; }
      const p = hit.p; delete p.ix; delete p.iy; delete p.ox; delete p.oy; this.drag = { ep, p }; App.pathSel = new Set([p]); changedPath(ep);
    },
    move(ev) { const dr = this.drag; if (!dr) return; const x = ev.x - dr.ep.ox, y = ev.y - dr.ep.oy; dr.p.ox = x; dr.p.oy = y; dr.p.ix = 2 * dr.p.x - x; dr.p.iy = 2 * dr.p.y - y; changedPath(dr.ep); },
    up() { if (this.drag) { this.drag = null; commit('Convert Point', 'timeline'); } },
    overlay(x, v) { drawPathOverlay(x, v, editablePath()); },
  });
}

// ── Path selection ───────────────────────────────────────────────────────
defineTool({
  id: 'path-select', name: 'Path Selection Tool', key: 'A', group: 'pathsel', icon: 'path-select', cursor: 'default', defaults: {},
  bar: [{ type: 'button', label: 'Make Selection', action: 'pathToSelection' }, { type: 'button', label: 'Fill Path', action: 'fillPath' }, { type: 'button', label: 'Stroke Path', action: 'strokePath' }, { type: 'sep' }, { type: 'align' }],
  down(ev) {
    const ep = editablePath(); if (!ep) return;
    const si = hitSegment(ep, ev);
    if (si === null) { App.pathSel = new Set(); App.view.redraw(); return; }
    const sp = ep.subpaths[si]; App.pathSel = new Set(sp.pts);
    if (ev.alt) { const copy = structuredClone(sp); ep.subpaths.push(copy); App.pathSel = new Set(copy.pts); this.drag = { ep, sp: copy, x0: ev.x, y0: ev.y }; return; }
    this.drag = { ep, sp, x0: ev.x, y0: ev.y };
  },
  move(ev) {
    const dr = this.drag; if (!dr) return;
    const dx = ev.x - dr.x0, dy = ev.y - dr.y0; dr.x0 = ev.x; dr.y0 = ev.y; dr.moved = true;
    for (const p of dr.sp.pts) for (const k of ['x', 'ix', 'ox']) if (p[k] !== undefined) p[k] += dx;
    for (const p of dr.sp.pts) for (const k of ['y', 'iy', 'oy']) if (p[k] !== undefined) p[k] += dy;
    changedPath(dr.ep);
  },
  up() { if (this.drag?.moved) commit('Pindah Path', 'open_with'); this.drag = null; },
  onKey(e) { if ((e.key === 'Delete' || e.key === 'Backspace') && App.pathSel?.size) { const ep = editablePath(); if (!ep) return false; for (let i = ep.subpaths.length - 1; i >= 0; i--) if (ep.subpaths[i].pts.some(p => App.pathSel.has(p))) ep.subpaths.splice(i, 1); App.pathSel = new Set(); changedPath(ep); commit('Hapus Path', 'delete'); return true; } return false; },
  overlay(x, v) { drawPathOverlay(x, v, editablePath()); },
});
defineTool({
  id: 'direct-select', name: 'Direct Selection Tool', key: 'A', group: 'pathsel', icon: 'direct-select', cursor: 'default', defaults: {},
  bar: [{ type: 'note', text: 'Seret anchor atau handle untuk membentuk ulang path. Shift-klik untuk banyak anchor.' }],
  down(ev) {
    const ep = editablePath(); if (!ep) return;
    const hit = hitPath(ep, ev);
    if (!hit) {
      const si = hitSegment(ep, ev); if (si === null) { App.pathSel = new Set(); this.box = { x: ev.x, y: ev.y, x2: ev.x, y2: ev.y, ep }; App.view.redraw(); return; }
      App.pathSel = new Set(); this.drag = null; App.view.redraw(); return;
    }
    if (hit.k === 'anchor') {
      if (ev.shift) { App.pathSel ||= new Set(); App.pathSel.has(hit.p) ? App.pathSel.delete(hit.p) : App.pathSel.add(hit.p); }
      else if (!App.pathSel?.has(hit.p)) App.pathSel = new Set([hit.p]);
    }
    this.drag = { ep, hit, x0: ev.x, y0: ev.y };
  },
  move(ev) {
    if (this.box) { this.box.x2 = ev.x; this.box.y2 = ev.y; App.view.redraw(); return; }
    const dr = this.drag; if (!dr) return;
    const dx = ev.x - dr.x0, dy = ev.y - dr.y0; dr.x0 = ev.x; dr.y0 = ev.y; dr.moved = true;
    const { hit } = dr, p = hit.p;
    if (hit.k === 'anchor') {
      for (const q of App.pathSel) for (const [a, b] of [['x', 'y'], ['ix', 'iy'], ['ox', 'oy']]) if (q[a] !== undefined) { q[a] += dx; q[b] += dy; }
    } else {
      const k = hit.k === 'in' ? ['ix', 'iy'] : ['ox', 'oy'], o = hit.k === 'in' ? ['ox', 'oy'] : ['ix', 'iy'];
      p[k[0]] += dx; p[k[1]] += dy;
      if (!ev.alt && p[o[0]] !== undefined) { const len = Math.hypot(p[o[0]] - p.x, p[o[1]] - p.y), a = Math.atan2(p[k[1]] - p.y, p[k[0]] - p.x) + Math.PI; p[o[0]] = p.x + Math.cos(a) * len; p[o[1]] = p.y + Math.sin(a) * len; }
    }
    changedPath(dr.ep);
  },
  up() {
    if (this.box) {
      const b = this.box, r = rectFromPts(b.x, b.y, b.x2, b.y2), ep = b.ep; this.box = null;
      App.pathSel = new Set(); for (const sp of ep.subpaths) for (const p of sp.pts) if (p.x + ep.ox >= r.x && p.x + ep.ox <= r.x + r.w && p.y + ep.oy >= r.y && p.y + ep.oy <= r.y + r.h) App.pathSel.add(p);
      App.view.redraw(); return;
    }
    if (this.drag?.moved) commit('Edit Anchor', 'timeline'); this.drag = null;
  },
  onKey(e) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && App.pathSel?.size) { const ep = editablePath(); if (!ep) return false; for (const sp of ep.subpaths) sp.pts = sp.pts.filter(p => !App.pathSel.has(p)); ep.subpaths.splice(0, ep.subpaths.length, ...ep.subpaths.filter(s => s.pts.length)); App.pathSel = new Set(); changedPath(ep); commit('Hapus Anchor', 'remove'); return true; }
    return false;
  },
  overlay(x, v) {
    drawPathOverlay(x, v, editablePath());
    if (this.box) { const b = this.box, p = v.toScreen(b.x, b.y), q = v.toScreen(b.x2, b.y2); x.strokeStyle = '#2f8cff'; x.setLineDash([3, 3]); x.strokeRect(p.x, p.y, q.x - p.x, q.y - p.y); x.setLineDash([]); }
  },
});

// ── Type tools ───────────────────────────────────────────────────────────
export const FONTS = {
  system: ['Inter', 'Arial', 'Helvetica', 'Helvetica Neue', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Trebuchet MS', 'Impact', 'Palatino', 'Garamond', 'Futura', 'Avenir Next', 'Gill Sans', 'Menlo', 'Optima', 'Didot', 'Baskerville', 'American Typewriter', 'Snell Roundhand', 'Comic Sans MS'],
  google: ['Roboto', 'Open Sans', 'Montserrat', 'Poppins', 'Lato', 'Raleway', 'Oswald', 'Bebas Neue', 'Anton', 'Archivo Black', 'Playfair Display', 'Merriweather', 'Lora', 'Cinzel', 'Abril Fatface', 'DM Serif Display', 'Space Grotesk', 'Rubik', 'Nunito', 'Josefin Sans', 'Work Sans', 'Barlow Condensed', 'Lobster', 'Pacifico', 'Dancing Script', 'Great Vibes', 'Caveat', 'Permanent Marker', 'Shadows Into Light', 'Righteous', 'Bangers', 'Press Start 2P', 'Source Code Pro', 'JetBrains Mono'],
  local: [],
};
const loaded = new Set(['Inter']);
export async function loadFont(name, weight = 400, italic = false) {
  if (FONTS.google.includes(name) && !loaded.has(name)) {
    loaded.add(name);
    const fam = name.replace(/ /g, '+');
    document.head.append(h('link', { rel: 'stylesheet', href: `https://fonts.googleapis.com/css2?family=${fam}:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,700&display=swap` }));
  }
  try { await document.fonts.load(`${italic ? 'italic ' : ''}${weight} 24px "${name}"`); } catch { /* font may be system-only */ }
}
const TEXT_DEF = { font: 'Inter', weight: 400, italic: false, size: 72, color: null, align: 'left', leading: 0, tracking: 0, underline: false, strike: false, caps: false };

function textLayerAt(x, y) {
  const d = App.doc;
  for (const L of [...d.flat()].reverse()) {
    if (L.type !== 'text' || !L.visible) continue;
    const b = layoutText(L.text).bounds;
    if (x >= b.x + L.x - 6 && x <= b.x + L.x + b.w + 6 && y >= b.y + L.y - 6 && y <= b.y + L.y + b.h + 6) return L;
  }
  return null;
}
function typeTool(id, name, icon, vertical) {
  defineTool({
    id, name, key: 'T', group: 'type', icon, cursor: 'text', defaults: { ...TEXT_DEF },
    bar: [{ type: 'font' }, { type: 'select', key: 'style', options: [['400', 'Regular'], ['300', 'Light'], ['500', 'Medium'], ['600', 'Semibold'], ['700', 'Bold'], ['900', 'Black'], ['400i', 'Italic'], ['700i', 'Bold Italic']], tip: 'Gaya font' }, { type: 'range', key: 'size', label: 'T', min: 1, max: 1296, unit: 'pt', width: 46, tip: 'Ukuran font' }, { type: 'seg', key: 'align', options: [['left', 'format_align_left', 'Rata kiri'], ['center', 'format_align_center', 'Rata tengah'], ['right', 'format_align_right', 'Rata kanan']] }, { type: 'textcolor' }, { type: 'button', icon: 'text_rotation_none', tip: 'Warp Text', action: 'warpText' }, { type: 'button', icon: 'view_sidebar', tip: 'Panel Character & Paragraph', action: 'toggleCharacter' }, { type: 'sep' }, { type: 'textcommit' }],
    down(ev) {
      if (App.textEdit) { const inside = App.textEdit.hitBox?.(ev); if (inside) return; App.textEdit.commit(); return; }
      const L = textLayerAt(ev.x, ev.y);
      if (L) { App.doc.setActive(L.id); this.edit(L); return; }
      this.s = { x: ev.x, y: ev.y }; this.c = this.s;
    },
    move(ev) { if (this.s) { this.c = { x: ev.x, y: ev.y }; App.view.redraw(); } },
    up() {
      if (!this.s) return;
      const s = this.s, c = this.c; this.s = null;
      const box = Math.hypot(c.x - s.x, c.y - s.y) > 6 ? rectFromPts(s.x, s.y, c.x, c.y) : null;
      const o = opts(id), d = App.doc;
      const t = { content: '', font: o.font, weight: o.weight, italic: o.italic, size: o.size, color: o.color || rgbToHex(App.fg), align: o.align, leading: o.leading, tracking: o.tracking, underline: o.underline, strike: o.strike, caps: o.caps, vertical, x: box ? box.x : s.x, y: box ? box.y + o.size : s.y, box: box ? { w: box.w, h: box.h } : null };
      const L = new Layer({ type: 'text', name: 'Layer Teks' }); L.text = t;
      d.insertAbove(L); this.edit(L, true);
    },
    async edit(L, isNew = false) {
      const v = App.view, t = L.text;
      await loadFont(t.font, t.weight, t.italic);
      App.hidden = App.hidden || new Set(); App.hidden.add(L.id); invalidate();
      const ta = h('textarea.type-editor', { spellcheck: false, value: t.content });
      v.stage.append(ta);
      const place = () => {
        const z = v.zoom, lay = layoutText(t), b = lay.bounds;
        const p = v.toScreen(b.x + L.x, b.y + L.y);
        Object.assign(ta.style, {
          left: p.x + 'px', top: p.y + 'px', font: fontString(t, z), color: t.color, lineHeight: (lay.lead * z) + 'px',
          letterSpacing: ((t.tracking || 0) / 1000 * t.size * z) + 'px', textAlign: t.align,
          width: (t.box ? t.box.w * z : Math.max(b.w * z + t.size * z, 40)) + 'px', height: (t.box ? t.box.h * z : b.h * z + 8) + 'px',
          transform: `rotate(${v.v.rot}deg)`, transformOrigin: '0 0', textTransform: t.caps ? 'uppercase' : 'none',
          textDecoration: [t.underline && 'underline', t.strike && 'line-through'].filter(Boolean).join(' ') || 'none',
          writingMode: t.vertical ? 'vertical-rl' : 'horizontal-tb',
        });
        if (!t.box && t.align !== 'left') ta.style.left = (p.x - (t.align === 'center' ? 0 : 0)) + 'px';
      };
      const offView = App.on('viewchange', place);
      const offOpts = App.on('textstyle', () => { place(); });
      ta.addEventListener('input', () => { t.content = ta.value; place(); });
      ta.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); App.textEdit.cancel(); }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); App.textEdit.commit(); }
      });
      const before = { ...t };
      const finish = (keep) => {
        offView(); offOpts(); ta.remove(); App.hidden.delete(L.id); App.textEdit = null; App.emit('textedit', null);
        if (!keep || !t.content.trim()) {
          if (isNew || !t.content.trim()) { App.doc.remove(L); App.emit('layers'); }
          else Object.assign(t, before);
          invalidate(); if (!isNew && !t.content.trim()) commit('Hapus Teks', 'delete'); return;
        }
        L.name = t.content.replace(/\s+/g, ' ').slice(0, 30) || 'Teks';
        L._cache = null; L.touch(); invalidate(); App.emit('layers'); commit(isNew ? 'Type Tool' : 'Edit Type Layer', 'title');
      };
      App.textEdit = {
        layer: L, commit: () => finish(true), cancel: () => finish(false), refresh: place,
        hitBox: (ev) => { const b = layoutText(t).bounds; return ev.x >= b.x + L.x && ev.x <= b.x + L.x + Math.max(b.w, 40) && ev.y >= b.y + L.y && ev.y <= b.y + L.y + b.h; },
      };
      App.emit('textedit', L);
      place(); setTimeout(() => { ta.focus(); ta.select(); }, 0);
    },
    overlay(x, v) {
      if (this.s) { const r = rectFromPts(this.s.x, this.s.y, this.c.x, this.c.y); inDoc(x, v, c => { c.setLineDash([4 / v.zoom, 3 / v.zoom]); c.strokeStyle = '#2f8cff'; c.strokeRect(r.x, r.y, r.w, r.h); }); }
      const te = App.textEdit; if (!te) return;
      const L = te.layer, b = layoutText(L.text).bounds;
      inDoc(x, v, c => { c.strokeStyle = '#2f8cff'; c.lineWidth = 1 / v.zoom; c.strokeRect(b.x + L.x, b.y + L.y, Math.max(b.w, 4), b.h); });
    },
    deactivate() { App.textEdit?.commit(); },
  });
}
typeTool('type', 'Horizontal Type Tool', 'type', false);
typeTool('type-vertical', 'Vertical Type Tool', 'type-vertical', true);
defineTool({
  id: 'type-mask', name: 'Horizontal Type Mask Tool', key: 'T', group: 'type', icon: 'type-mask', cursor: 'text', defaults: { ...TEXT_DEF },
  bar: [{ type: 'font' }, { type: 'range', key: 'size', label: 'T', min: 1, max: 1296, unit: 'pt', width: 46 }, { type: 'note', text: 'Klik, ketik, lalu Enter untuk membuat seleksi berbentuk teks' }],
  async down(ev) {
    const o = opts('type-mask'), text = await App.prompt?.('Teks untuk seleksi:', '', { title: 'Type Mask' });
    if (!text) return;
    await loadFont(o.font, o.weight, o.italic);
    const d = App.doc, t = { content: text, font: o.font, weight: o.weight, italic: o.italic, size: o.size, align: 'left', x: ev.x, y: ev.y, color: '#fff' };
    const sel = Selection.shape(d.w, d.h, c => { c.font = fontString(t); layoutText(t, c).lines.forEach(l => c.fillText(l.s, l.x, l.y)); });
    applySelection(sel, ev.shift ? 'add' : 'new', 'Type Mask');
  },
});

export { editablePath, changedPath, newShapeLayer, textLayerAt };
