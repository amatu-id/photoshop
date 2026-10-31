// Free Transform: scale / rotate / skew / distort / perspective with on-canvas handles

import { App, commit, invalidate, toast } from './state.js';
import { canvas, ctx2d, cloneCanvas, deg } from './util.js';
import { contentSurface } from './composite.js';
import { Selection } from './selection.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

// Homography mapping unit square → quad (p0..p3 = TL, TR, BR, BL)
function squareToQuad(q) {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  let g = 0, hh = 0;
  if (dx3 || dy3) { const den = dx1 * dy2 - dx2 * dy1; g = (dx3 * dy2 - dx2 * dy3) / den; hh = (dx1 * dy3 - dx3 * dy1) / den; }
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + hh * p3.x, c = p0.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + hh * p3.y, f = p0.y;
  return (u, v) => { const w = g * u + hh * v + 1; return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w }; };
}
// Draw src (w×h) into ctx mapped onto quad via triangle subdivision
export function drawQuad(ctx, src, quad, N = 16) {
  const H = squareToQuad(quad), W = src.width, Hh = src.height;
  const pts = [];
  for (let j = 0; j <= N; j++) { pts[j] = []; for (let i = 0; i <= N; i++) pts[j][i] = H(i / N, j / N); }
  const tri = (s0, s1, s2, d0, d1, d2) => {
    ctx.save(); ctx.beginPath();
    // expand the clip triangle slightly to hide seams
    const cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3, ex = p => ({ x: p.x + (p.x - cx) * .02 + Math.sign(p.x - cx) * .3, y: p.y + (p.y - cy) * .02 + Math.sign(p.y - cy) * .3 });
    const e0 = ex(d0), e1 = ex(d1), e2 = ex(d2);
    ctx.moveTo(e0.x, e0.y); ctx.lineTo(e1.x, e1.y); ctx.lineTo(e2.x, e2.y); ctx.closePath(); ctx.clip();
    const den = s0.x * (s2.y - s1.y) - s1.x * s2.y + s2.x * s1.y + (s1.x - s2.x) * s0.y;
    if (!den) { ctx.restore(); return; }
    const a = -(s0.y * (d2.x - d1.x) - s1.y * d2.x + s2.y * d1.x + (s1.y - s2.y) * d0.x) / den;
    const b = (s1.y * d2.y + s0.y * (d1.y - d2.y) - s2.y * d1.y + (s2.y - s1.y) * d0.y) / den;
    const c = (s0.x * (d2.x - d1.x) - s1.x * d2.x + s2.x * d1.x + (s1.x - s2.x) * d0.x) / den;
    const d = -(s1.x * d2.y + s0.x * (d1.y - d2.y) - s2.x * d1.y + (s2.x - s1.x) * d0.y) / den;
    const e = (s0.x * (s2.y * d1.x - s1.y * d2.x) + s0.y * (s1.x * d2.x - s2.x * d1.x) + (s2.x * s1.y - s1.x * s2.y) * d0.x) / den;
    const f = (s0.x * (s2.y * d1.y - s1.y * d2.y) + s0.y * (s1.x * d2.y - s2.x * d1.y) + (s2.x * s1.y - s1.x * s2.y) * d0.y) / den;
    ctx.transform(a, b, c, d, e, f); ctx.drawImage(src, 0, 0); ctx.restore();
  };
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const s00 = { x: i / N * W, y: j / N * Hh }, s10 = { x: (i + 1) / N * W, y: j / N * Hh }, s01 = { x: i / N * W, y: (j + 1) / N * Hh }, s11 = { x: (i + 1) / N * W, y: (j + 1) / N * Hh };
    tri(s00, s10, s11, pts[j][i], pts[j][i + 1], pts[j + 1][i + 1]);
    tri(s00, s11, s01, pts[j][i], pts[j + 1][i + 1], pts[j + 1][i]);
  }
}

class Transformer {
  constructor() { this.st = null; }
  get active() { return !!this.st; }

  // Bounding info of layer for "Show Transform Controls"
  boundsOf(L) {
    if (!L) return null;
    if (L.type === 'raster' || L.isGroup) return L.contentBounds();
    const s = contentSurface(L, App.doc); if (!s) return null;
    return L._bbox?.rev === L.rev ? L._bbox.b : (L._bbox = { rev: L.rev, b: boundsOfCanvas(s.canvas, s.x, s.y) }).b;
  }

  async start(mode = 'free') {
    const d = App.doc; if (!d) return;
    if (this.st) return;
    const L = d.active;
    if (!L || L.isGroup) { toast('Pilih satu layer untuk ditransformasi'); return; }
    if (L.locks.all || L.locks.position) { toast('Layer terkunci'); return; }
    if (L.type === 'adjust' || L.type === 'fill') { toast('Layer ini tidak dapat ditransformasi'); return; }
    if (L.isBackground) App.convertBackground?.(L);
    let src, rect, cut = null, sel = null;
    if (L.type === 'raster') {
      L.coverDoc(d.w, d.h);
      if (d.selection && !d.selection.empty) {
        sel = d.selection; const b = sel.bounds();
        rect = { x: b.x, y: b.y, w: b.w, h: b.h };
        src = canvas(b.w, b.h); const sx = ctx2d(src);
        sx.drawImage(L.canvas, L.x - b.x, L.y - b.y); sx.globalCompositeOperation = 'destination-in'; sx.drawImage(sel.canvas, -b.x, -b.y);
        cut = cloneCanvas(L.canvas); const cx = ctx2d(cut); cx.globalCompositeOperation = 'destination-out'; cx.drawImage(sel.canvas, -L.x, -L.y);
      } else {
        const b = L.contentBounds(); if (!b) { toast('Layer kosong'); return; }
        rect = b; src = canvas(b.w, b.h); ctx2d(src).drawImage(L.canvas, L.x - b.x, L.y - b.y);
        cut = canvas(L.w, L.h);
      }
    } else {
      const s = contentSurface(L, d); const b = boundsOfCanvas(s.canvas, s.x, s.y); if (!b) return;
      rect = b; src = canvas(b.w, b.h); ctx2d(src).drawImage(s.canvas, s.x - b.x, s.y - b.y);
    }
    this.st = { L, mode, src, rect, cut, sel, M: new DOMMatrix().translate(rect.x, rect.y), corners: null, pivot: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, interp: 'bicubic' };
    App.hideAnts = true;
    this.preview();
    App.emit('transform', true);
  }
  corners() {
    const s = this.st; if (s.corners) return s.corners;
    const { w, h } = s.rect, M = s.M;
    return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => { const p = M.transformPoint(new DOMPoint(x, y)); return { x: p.x, y: p.y }; });
  }
  handles() {
    const c = this.corners(), mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    return { nw: c[0], n: mid(c[0], c[1]), ne: c[1], e: mid(c[1], c[2]), se: c[2], s: mid(c[2], c[3]), sw: c[3], w: mid(c[3], c[0]) };
  }
  hit(ev) {
    if (!this.st) return false;
    const v = App.view, hs = this.handles();
    for (const k of HANDLES) { const p = v.toScreen(hs[k].x, hs[k].y); if (Math.hypot(p.x - ev.sx, p.y - ev.sy) < 8) return k; }
    const pv = v.toScreen(this.st.pivot.x, this.st.pivot.y); if (Math.hypot(pv.x - ev.sx, pv.y - ev.sy) < 7) return 'pivot';
    const c = this.corners(), path = new Path2D(); c.forEach((p, i) => i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)); path.closePath();
    if (ctx2d(canvas(1, 1)).isPointInPath(path, ev.x, ev.y)) return 'move';
    return 'rotate';
  }
  cursorFor(k) {
    if (k === 'move') return 'move'; if (k === 'rotate') return 'alias'; if (k === 'pivot') return 'crosshair';
    const a = { n: 90, s: 90, e: 0, w: 0, ne: 45, sw: 45, nw: 135, se: 135 }[k] + (App.doc.view.rot || 0) + this.angle();
    const n = ((Math.round(a / 45) % 4) + 4) % 4; return ['ew-resize', 'nesw-resize', 'ns-resize', 'nwse-resize'][n];
  }
  angle() { const s = this.st; if (!s) return 0; const c = this.corners(); return deg(Math.atan2(c[1].y - c[0].y, c[1].x - c[0].x)); }

  down(ev) {
    const k = this.hit(ev); if (!k) return;
    const s = this.st;
    this.drag = { k, x0: ev.x, y0: ev.y, M0: DOMMatrix.fromMatrix(s.M), c0: this.corners().map(p => ({ ...p })), piv0: { ...s.pivot } };
  }
  move(ev) {
    const dr = this.drag, s = this.st; if (!dr || !s) return;
    const dx = ev.x - dr.x0, dy = ev.y - dr.y0, k = dr.k;
    const mode = s.mode;
    if (k === 'pivot') { s.pivot = { x: dr.piv0.x + dx, y: dr.piv0.y + dy }; App.view.redraw(); return; }
    if (k === 'move') {
      if (s.corners) s.corners = dr.c0.map(p => ({ x: p.x + dx, y: p.y + dy }));
      else s.M = new DOMMatrix().translate(dx, dy).multiply(dr.M0);
      s.pivot = { x: dr.piv0.x + dx, y: dr.piv0.y + dy };
    } else if (k === 'rotate' || mode === 'rotate') {
      const p = s.pivot, a0 = Math.atan2(dr.y0 - p.y, dr.x0 - p.x), a1 = Math.atan2(ev.y - p.y, ev.x - p.x);
      let a = deg(a1 - a0); if (ev.shift) a = Math.round(a / 15) * 15;
      const R = new DOMMatrix().translate(p.x, p.y).rotate(a).translate(-p.x, -p.y);
      if (s.corners) s.corners = dr.c0.map(q => { const r = R.transformPoint(new DOMPoint(q.x, q.y)); return { x: r.x, y: r.y }; });
      else s.M = R.multiply(dr.M0);
    } else if ((ev.mod && k.length === 2) || mode === 'distort' || mode === 'perspective' || s.corners) {
      // corner-free modes
      const idx = { nw: 0, ne: 1, se: 2, sw: 3 }[k];
      const c = dr.c0.map(p => ({ ...p }));
      if (idx !== undefined) {
        c[idx] = { x: dr.c0[idx].x + dx, y: dr.c0[idx].y + dy };
        if (mode === 'perspective' || (ev.mod && ev.alt && ev.shift)) {
          // mirror the adjacent corner along the dominant edge
          const pair = Math.abs(dx) > Math.abs(dy) ? { 0: 3, 3: 0, 1: 2, 2: 1 }[idx] : { 0: 1, 1: 0, 2: 3, 3: 2 }[idx];
          if (Math.abs(dx) > Math.abs(dy)) c[pair] = { x: dr.c0[pair].x - dx, y: dr.c0[pair].y }; else c[pair] = { x: dr.c0[pair].x, y: dr.c0[pair].y - dy };
        }
      } else {
        const e = { n: [0, 1], e: [1, 2], s: [2, 3], w: [3, 0] }[k];
        for (const i of e) c[i] = { x: dr.c0[i].x + dx, y: dr.c0[i].y + dy };
      }
      s.corners = c;
    } else if (ev.mod || mode === 'skew') {
      // skew along an edge (in local space)
      const inv = dr.M0.inverse(), p0 = inv.transformPoint(new DOMPoint(dr.x0, dr.y0)), p1 = inv.transformPoint(new DOMPoint(ev.x, ev.y));
      const { w, h } = s.rect; let S = new DOMMatrix();
      if (k === 'n' || k === 's' || k.length === 2) { const kx = (p1.x - p0.x) / h * (k.includes('n') ? -1 : 1); S = new DOMMatrix([1, 0, kx, 1, 0, 0]); const oy = k.includes('n') ? h : 0; S = new DOMMatrix().translate(0, oy).multiply(S).translate(0, -oy); }
      else { const ky = (p1.y - p0.y) / w * (k === 'w' ? -1 : 1); S = new DOMMatrix([1, ky, 0, 1, 0, 0]); const ox = k === 'w' ? w : 0; S = new DOMMatrix().translate(ox, 0).multiply(S).translate(-ox, 0); }
      s.M = DOMMatrix.fromMatrix(dr.M0).multiply(S);
    } else {
      // scale in local space around the opposite handle (or centre with Alt)
      const inv = dr.M0.inverse(), lp = inv.transformPoint(new DOMPoint(ev.x, ev.y)), { w, h } = s.rect;
      const anchor = ev.alt ? { x: w / 2, y: h / 2 } : { x: k.includes('w') ? w : k.includes('e') ? 0 : w / 2, y: k.includes('n') ? h : k.includes('s') ? 0 : h / 2 };
      const handle = { x: k.includes('w') ? 0 : k.includes('e') ? w : w / 2, y: k.includes('n') ? 0 : k.includes('s') ? h : h / 2 };
      let sx = k === 'n' || k === 's' ? 1 : (lp.x - anchor.x) / ((handle.x - anchor.x) || 1);
      let sy = k === 'e' || k === 'w' ? 1 : (lp.y - anchor.y) / ((handle.y - anchor.y) || 1);
      const proportional = k.length === 2 ? !ev.shift : ev.shift;
      if (proportional) { if (k.length === 2) { const m = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = Math.sign(sx || 1) * Math.abs(m); sy = Math.sign(sy || 1) * Math.abs(m); } else if (k === 'n' || k === 's') sx = Math.abs(sy); else sy = Math.abs(sx); }
      s.M = DOMMatrix.fromMatrix(dr.M0).translate(anchor.x, anchor.y).scale(sx, sy).translate(-anchor.x, -anchor.y);
      const c = this.corners(); s.pivot = { x: (c[0].x + c[2].x) / 2, y: (c[0].y + c[2].y) / 2 };
    }
    this.preview(); App.emit('transform', true);
  }
  up() { this.drag = null; }

  // numeric edits from the options bar
  setNumeric(k, v) {
    const s = this.st; if (!s || s.corners) return;
    const c = this.corners(), cx = (c[0].x + c[2].x) / 2, cy = (c[0].y + c[2].y) / 2;
    const cur = this.numeric();
    if (k === 'x') s.M = new DOMMatrix().translate(v - cur.x, 0).multiply(s.M);
    if (k === 'y') s.M = new DOMMatrix().translate(0, v - cur.y).multiply(s.M);
    if (k === 'w' || k === 'h') {
      const f = v / (k === 'w' ? cur.w : cur.h); if (!isFinite(f) || f === 0) return;
      const { w, h } = s.rect;
      s.M = DOMMatrix.fromMatrix(s.M).translate(w / 2, h / 2).scale(k === 'w' ? f : 1, k === 'h' ? f : 1).translate(-w / 2, -h / 2);
    }
    if (k === 'a') s.M = new DOMMatrix().translate(cx, cy).rotate(v - cur.a).translate(-cx, -cy).multiply(s.M);
    this.preview(); App.emit('transform', true);
  }
  numeric() {
    const s = this.st, c = this.corners();
    const w = Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y), h = Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y);
    return { x: (c[0].x + c[2].x) / 2, y: (c[0].y + c[2].y) / 2, w: w / s.rect.w * 100, h: h / s.rect.h * 100, a: this.angle() };
  }
  flip(axis) {
    const s = this.st; if (!s) return;
    const { w, h } = s.rect;
    if (s.corners) { const c = s.corners; s.corners = axis === 'h' ? [c[1], c[0], c[3], c[2]] : [c[3], c[2], c[1], c[0]]; }
    else s.M = DOMMatrix.fromMatrix(s.M).translate(w / 2, h / 2).scale(axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1).translate(-w / 2, -h / 2);
    this.preview();
  }
  rotateBy(a) {
    const s = this.st; if (!s) return; const p = s.pivot;
    const R = new DOMMatrix().translate(p.x, p.y).rotate(a).translate(-p.x, -p.y);
    if (s.corners) s.corners = s.corners.map(q => { const r = R.transformPoint(new DOMPoint(q.x, q.y)); return { x: r.x, y: r.y }; });
    else s.M = R.multiply(s.M);
    this.preview();
  }

  render(N) {
    const s = this.st, d = App.doc, out = canvas(d.w, d.h), x = ctx2d(out);
    x.imageSmoothingEnabled = s.interp !== 'nearest'; x.imageSmoothingQuality = 'high';
    if (s.corners) drawQuad(x, s.src, s.corners, N);
    else { x.setTransform(s.M); x.drawImage(s.src, 0, 0); x.setTransform(1, 0, 0, 1, 0, 0); }
    return out;
  }
  preview() {
    const s = this.st, d = App.doc; if (!s) return;
    const tr = this.render(12);
    let comp = tr;
    if (s.cut) { comp = canvas(d.w, d.h); const cx = ctx2d(comp); cx.drawImage(s.cut, s.L.x, s.L.y); cx.drawImage(tr, 0, 0); }
    App.live = App.live || new Map();
    App.live.set(s.L.id, { canvas: comp, x: 0, y: 0 });
    s.L._styled = null; invalidate();
  }
  commit() {
    const s = this.st; if (!s) return;
    const d = App.doc, L = s.L, tr = this.render(32);
    if (L.type === 'raster') {
      const c = canvas(d.w, d.h), x = ctx2d(c);
      if (s.cut) x.drawImage(s.cut, L.x, L.y);
      x.drawImage(tr, 0, 0);
      L.canvas = c; L.x = 0; L.y = 0;
      if (s.sel) {
        const ns = new Selection(d.w, d.h), nx = ns.ctx;
        if (s.corners) drawQuad(nx, cropSel(s.sel, s.rect), s.corners, 32); else { nx.setTransform(s.M); nx.drawImage(cropSel(s.sel, s.rect), 0, 0); }
        ns.touch(); d.selection = ns.empty ? null : ns;
      }
    } else if (L.type === 'shape') {
      const map = this.pointMapper();
      for (const sp of L.shape.subpaths) for (const p of sp.pts) for (const [a, b] of [['x', 'y'], ['ix', 'iy'], ['ox', 'oy']]) if (p[a] !== undefined) { const q = map(p[a] + L.x, p[b] + L.y); p[a] = q.x - L.x; p[b] = q.y - L.y; }
      if (L.shape.params?.kind === 'rect' || L.shape.params) L.shape.params = null;
      if (L.shape.stroke && !s.corners) { const sc = Math.sqrt(Math.abs(s.M.a * s.M.d - s.M.b * s.M.c) / 1); L.shape.stroke.width *= Math.max(.05, sc); }
      L._cache = null;
    } else if (L.type === 'text') {
      if (s.corners) { // non-affine on text → rasterize
        App.rasterize(L); L.canvas = canvas(d.w, d.h); ctx2d(L.canvas).drawImage(tr, 0, 0); L.x = 0; L.y = 0;
      } else {
        const rel = DOMMatrix.fromMatrix(s.M).multiply(new DOMMatrix().translate(s.rect.x, s.rect.y).inverse());
        const old = L.text.matrix ? new DOMMatrix(L.text.matrix) : new DOMMatrix();
        const off = new DOMMatrix().translate(L.x, L.y);
        const m = off.inverse().multiply(rel).multiply(off).multiply(old);
        L.text.matrix = [m.a, m.b, m.c, m.d, m.e, m.f]; L._cache = null;
      }
    }
    if (L.mask && L.mask.linked && !s.sel) {
      const mc = canvas(d.w, d.h), mx = ctx2d(mc); mx.fillStyle = L.mask.def === 255 ? '#fff' : '#000'; mx.fillRect(0, 0, d.w, d.h);
      const ms = canvas(s.rect.w, s.rect.h); ctx2d(ms).drawImage(L.mask.canvas, L.mask.x - s.rect.x, L.mask.y - s.rect.y);
      if (s.corners) drawQuad(mx, ms, s.corners, 32); else { mx.setTransform(s.M); mx.drawImage(ms, 0, 0); }
      L.mask.canvas = mc; L.mask.x = 0; L.mask.y = 0; L.mask.rev++;
    }
    L.touch(); this.end(); invalidate();
    commit('Free Transform', 'transform');
  }
  pointMapper() {
    const s = this.st;
    if (!s.corners) { const rel = DOMMatrix.fromMatrix(s.M).multiply(new DOMMatrix().translate(s.rect.x, s.rect.y).inverse()); return (x, y) => { const p = rel.transformPoint(new DOMPoint(x, y)); return { x: p.x, y: p.y }; }; }
    const H = squareToQuad(s.corners); return (x, y) => H((x - s.rect.x) / s.rect.w, (y - s.rect.y) / s.rect.h);
  }
  cancel() { if (!this.st) return; this.end(); invalidate(); }
  end() { const L = this.st.L; App.live?.delete(L.id); L._styled = null; this.st = null; this.drag = null; App.hideAnts = false; App.emit('transform', false); }

  overlay(x, v) {
    if (!this.st) return;
    const c = this.corners().map(p => v.toScreen(p.x, p.y));
    x.strokeStyle = '#2f8cff'; x.lineWidth = 1; x.beginPath(); c.forEach((p, i) => i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)); x.closePath(); x.stroke();
    const hs = this.handles();
    for (const k of HANDLES) { const p = v.toScreen(hs[k].x, hs[k].y); x.fillStyle = '#fff'; x.fillRect(p.x - 4, p.y - 4, 8, 8); x.strokeRect(p.x - 4, p.y - 4, 8, 8); }
    const pv = v.toScreen(this.st.pivot.x, this.st.pivot.y);
    x.beginPath(); x.arc(pv.x, pv.y, 5, 0, Math.PI * 2); x.moveTo(pv.x - 8, pv.y); x.lineTo(pv.x + 8, pv.y); x.moveTo(pv.x, pv.y - 8); x.lineTo(pv.x, pv.y + 8); x.stroke();
    if (this.drag) {
      const n = this.numeric(), q = v.toScreen(n.x, n.y);
      App.hud?.(x, q.x + 16, q.y + 16, this.drag.k === 'rotate' ? [`${n.a.toFixed(1)}°`] : this.drag.k === 'move' ? [`X: ${Math.round(n.x)} px`, `Y: ${Math.round(n.y)} px`] : [`W: ${n.w.toFixed(1)}%`, `H: ${n.h.toFixed(1)}%`]);
    }
  }
  // dotted bounding box used by "Show Transform Controls"
  drawBox(x, v, L) {
    const b = this.boundsOf(L); if (!b) return;
    const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([a, c]) => v.toScreen(a, c));
    x.strokeStyle = '#2f8cff'; x.lineWidth = 1; x.beginPath(); pts.forEach((p, i) => i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)); x.closePath(); x.stroke();
    for (const p of pts) { x.fillStyle = '#fff'; x.fillRect(p.x - 3.5, p.y - 3.5, 7, 7); x.strokeRect(p.x - 3.5, p.y - 3.5, 7, 7); }
  }
}
function cropSel(sel, r) { const c = canvas(r.w, r.h); ctx2d(c).drawImage(sel.canvas, -r.x, -r.y); return c; }
export function boundsOfCanvas(c, ox = 0, oy = 0) {
  const { width: w, height: h } = c, d = ctx2d(c).getImageData(0, 0, w, h).data;
  let x1 = w, y1 = h, x2 = -1, y2 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 2) { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; y2 = y; }
  return x2 < 0 ? null : { x: x1 + ox, y: y1 + oy, w: x2 - x1 + 1, h: y2 - y1 + 1 };
}

export const transformer = new Transformer();
App.transform = transformer;
