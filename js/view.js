// Viewport: zoom/pan/rotate, rulers, guides, grid, marching ants, pointer dispatch

import { App, savePrefs } from './state.js';
import { canvas, ctx2d, clamp, h, rectUnion, rectClip, isMac } from './util.js';
import { compositeDoc } from './composite.js';

const ZOOMS = [.01, .02, .03, .04, .05, .0625, .0833, .125, .1667, .25, .3333, .5, .6667, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
const RULER = 20;

export class View {
  constructor(host) {
    this.host = host;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.stage = h('div.stage');
    this.cv = h('canvas.view');
    this.rulerTop = h('canvas.ruler.ruler-top');
    this.rulerLeft = h('canvas.ruler.ruler-left');
    this.corner = h('div.ruler-corner', { title: 'Asal penggaris' });
    this.stage.append(this.cv);
    host.append(this.rulerTop, this.rulerLeft, this.corner, this.stage);
    this.ctx = this.cv.getContext('2d');
    this.dirty = null; this.needComp = false; this.needPaint = false;
    this.antsPhase = 0; this.pointers = new Map(); this.mouse = null;
    this.checker = this.makeChecker();
    new ResizeObserver(() => this.resize()).observe(this.stage);
    this.bindEvents();
    setInterval(() => { if (App.doc?.selection && !App.doc.selection.empty && App.prefs.extras && !App.hideAnts) { this.antsPhase = (this.antsPhase + 1) % 8; this.redraw(); } }, 110);
  }
  get doc() { return App.doc; }
  get v() { return this.doc?.view; }

  makeChecker() {
    const s = { small: 4, medium: 8, large: 16, none: 0 }[App.prefs.checker] || 8;
    const c = canvas(s * 2 || 2, s * 2 || 2), x = ctx2d(c);
    const st = getComputedStyle(document.documentElement);
    x.fillStyle = st.getPropertyValue('--checker-a').trim() || '#fff'; x.fillRect(0, 0, c.width, c.height);
    if (s) { x.fillStyle = st.getPropertyValue('--checker-b').trim() || '#ccc'; x.fillRect(s, 0, s, s); x.fillRect(0, s, s, s); }
    return this.ctx.createPattern(c, 'repeat');
  }
  refreshTheme() { this.checker = this.makeChecker(); this.redraw(); }

  resize() {
    const r = this.stage.getBoundingClientRect();
    this.W = Math.max(1, r.width); this.H = Math.max(1, r.height);
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    const same = this.cv.width === Math.round(this.W * this.dpr) && this.cv.height === Math.round(this.H * this.dpr);
    if (same) { if (this.doc && !this.v.fitted) this.fit(); this.redraw(); return; }
    this.cv.width = Math.round(this.W * this.dpr); this.cv.height = Math.round(this.H * this.dpr);
    this.cv.style.width = this.W + 'px'; this.cv.style.height = this.H + 'px';
    for (const [c, w, hh] of [[this.rulerTop, this.W, RULER], [this.rulerLeft, RULER, this.H]]) {
      c.width = Math.round(w * this.dpr); c.height = Math.round(hh * this.dpr); c.style.width = w + 'px'; c.style.height = hh + 'px';
    }
    if (this.doc && !this.v.fitted) this.fit();
    this.paint();   // the resize cleared the canvases: repaint now, not a frame later (no empty flash)
  }

  setDoc(doc) {
    if (doc && !doc._comp) { doc._comp = canvas(doc.w, doc.h); this.needComp = true; this.dirty = null; }
    this.dirty = null; this.needComp = true;
    if (doc && !doc.view.fitted) this.fit();
    this.redraw();
  }

  // ── Coordinates ──────────────────────────────────────────────────────
  matrix() {
    const v = this.v; return new DOMMatrix().translate(v.px, v.py).rotate(v.rot).scale(v.zoom);
  }
  toDoc(sx, sy) { const p = this.matrix().inverse().transformPoint(new DOMPoint(sx, sy)); return { x: p.x, y: p.y }; }
  toScreen(x, y) { const p = this.matrix().transformPoint(new DOMPoint(x, y)); return { x: p.x, y: p.y }; }
  get zoom() { return this.v?.zoom || 1; }

  fit(fill = false) {
    const d = this.doc; if (!d || !this.W) return;
    const pad = 40;
    const z = fill ? Math.max((this.W) / d.w, (this.H) / d.h) : Math.min((this.W - pad * 2) / d.w, (this.H - pad * 2) / d.h);
    d.view.zoom = clamp(z, .01, fill ? 64 : 16); d.view.rot = 0;
    d.view.px = (this.W - d.w * d.view.zoom) / 2; d.view.py = (this.H - d.h * d.view.zoom) / 2;
    d.view.fitted = true;
    this.changed();
  }
  zoomTo(z, sx = this.W / 2, sy = this.H / 2) {
    const d = this.doc; if (!d) return;
    z = clamp(z, .01, 64);
    const p = this.toDoc(sx, sy);
    d.view.zoom = z;
    const q = this.toScreen(p.x, p.y);
    d.view.px += sx - q.x; d.view.py += sy - q.y; d.view.fitted = true;
    this.changed();
  }
  zoomStep(dir, sx, sy) {
    const z = this.zoom;
    const next = dir > 0 ? ZOOMS.find(v => v > z * 1.001) || 64 : [...ZOOMS].reverse().find(v => v < z / 1.001) || .01;
    this.zoomTo(next, sx, sy);
  }
  actual() { this.zoomTo(1); }
  centerOn(x, y) { const q = this.toScreen(x, y); this.v.px += this.W / 2 - q.x; this.v.py += this.H / 2 - q.y; this.changed(); }
  changed() { this.redraw(); App.emit('viewchange'); }

  // ── Invalidation ─────────────────────────────────────────────────────
  invalidate(rect) {
    if (!this.doc) return;
    if (!rect) this.dirty = { x: 0, y: 0, w: this.doc.w, h: this.doc.h };
    else this.dirty = rectUnion(this.dirty, rect);
    this.needComp = true; this.redraw();
  }
  redraw() {
    if (this.needPaint) return;
    this.needPaint = true;
    requestAnimationFrame(() => { this.needPaint = false; this.paint(); });
  }
  compositeNow() {
    const d = this.doc; if (!d || !this.needComp) return;
    if (!d._comp || d._comp.width !== d.w || d._comp.height !== d.h) { d._comp = canvas(d.w, d.h); this.dirty = null; }
    const r = this.dirty ? rectClip(this.dirty, d.w, d.h) : { x: 0, y: 0, w: d.w, h: d.h };
    this.needComp = false; this.dirty = null;
    if (r) compositeDoc(d, d._comp, r, { live: App.live, hidden: App.hidden, solo: App.solo });
    App.emit('composited', r);
  }

  // ── Paint ────────────────────────────────────────────────────────────
  paint() {
    const x = this.ctx, d = this.doc;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, this.cv.width, this.cv.height);
    if (!d) { this.paintRulers(); return; }
    this.compositeNow();
    const M = new DOMMatrix().scale(this.dpr).multiply(this.matrix());
    const z = this.zoom;
    // drop shadow + transparency checker
    x.save();
    x.setTransform(M);
    x.shadowColor = 'rgba(0,0,0,.35)'; x.shadowBlur = 18 * this.dpr; x.shadowOffsetY = 4 * this.dpr;
    x.fillStyle = '#000'; x.fillRect(0, 0, d.w, d.h);
    x.restore();
    x.save();
    x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const corners = [[0, 0], [d.w, 0], [d.w, d.h], [0, d.h]].map(([a, b]) => this.toScreen(a, b));
    x.beginPath(); corners.forEach((p, i) => i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)); x.closePath();
    x.fillStyle = this.checker; x.fill();
    x.restore();
    // composite
    x.save(); x.setTransform(M);
    x.imageSmoothingEnabled = z < 1.5; x.imageSmoothingQuality = 'high';
    const src = App.viewSource?.() || d._comp;
    x.drawImage(src, 0, 0);
    // quick mask overlay (red where unselected)
    if (App.quickMask && App.qm) {
      const q = App.qm;
      if (!App._qmCanvas || App._qmRev !== q.rev || App._qmCanvas.width !== d.w) {
        const c = App._qmCanvas && App._qmCanvas.width === d.w && App._qmCanvas.height === d.h ? App._qmCanvas : canvas(d.w, d.h), qx = ctx2d(c);
        const img = ctx2d(q.canvas).getImageData(0, 0, d.w, d.h), px = img.data;
        for (let i = 0; i < px.length; i += 4) { const a = (255 - px[i]) * .5; px[i] = 255; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = a; }
        qx.putImageData(img, 0, 0); App._qmCanvas = c; App._qmRev = q.rev;
      }
      x.drawImage(App._qmCanvas, 0, 0);
    }
    x.restore();

    // pixel grid
    if (App.prefs.pixelGrid && z >= 10 && App.prefs.extras) {
      x.save(); x.setTransform(M); x.lineWidth = 1 / z; x.strokeStyle = 'rgba(128,128,128,.35)';
      const a = this.toDoc(0, 0), b = this.toDoc(this.W, this.H);
      const x0 = clamp(Math.floor(Math.min(a.x, b.x)), 0, d.w), x1 = clamp(Math.ceil(Math.max(a.x, b.x)), 0, d.w);
      const y0 = clamp(Math.floor(Math.min(a.y, b.y)), 0, d.h), y1 = clamp(Math.ceil(Math.max(a.y, b.y)), 0, d.h);
      x.beginPath();
      for (let i = x0; i <= x1; i++) { x.moveTo(i, y0); x.lineTo(i, y1); }
      for (let j = y0; j <= y1; j++) { x.moveTo(x0, j); x.lineTo(x1, j); }
      x.stroke(); x.restore();
    }
    if (App.prefs.grid && App.prefs.extras) this.paintGrid(x, M);
    if (App.prefs.guides && App.prefs.extras) this.paintGuides(x, M);
    // selection
    const sel = d.selection;
    if (sel && !sel.empty && App.prefs.extras && !App.quickMask && !App.hideAnts) {
      x.save(); x.setTransform(M);
      const p = sel.outline();
      x.lineWidth = 1 / z;
      x.strokeStyle = '#fff'; x.setLineDash([]); x.stroke(p);
      x.strokeStyle = '#000'; x.setLineDash([4 / z, 4 / z]); x.lineDashOffset = -this.antsPhase / z; x.stroke(p);
      x.restore();
    }
    // tool overlay (in screen space with helpers)
    x.save(); x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    try { App.activeTool()?.overlay?.(x, this); } catch (e) { console.error(e); }
    App.overlays?.forEach(fn => { try { fn(x, this); } catch (e) { console.error(e); } });
    // brush cursor
    const tool = App.activeTool();
    if (this.mouse && tool?.brushSize && App.prefs.brushCursor !== 'precise' && this.mouse.inside) {
      const r = tool.brushSize() * z / 2;
      if (r > 2) {
        x.beginPath(); x.arc(this.mouse.sx, this.mouse.sy, r, 0, Math.PI * 2);
        x.lineWidth = 1; x.strokeStyle = 'rgba(0,0,0,.7)'; x.stroke();
        x.beginPath(); x.arc(this.mouse.sx, this.mouse.sy, Math.max(1, r - 1), 0, Math.PI * 2); x.strokeStyle = 'rgba(255,255,255,.85)'; x.stroke();
        const hd = tool.brushHardness?.();
        if (hd !== undefined && hd < 100 && r > 8) { x.setLineDash([2, 3]); x.beginPath(); x.arc(this.mouse.sx, this.mouse.sy, r * Math.max(.1, hd / 100), 0, Math.PI * 2); x.strokeStyle = 'rgba(255,255,255,.5)'; x.stroke(); x.setLineDash([]); }
      } else this.crosshair(x, this.mouse.sx, this.mouse.sy);
    }
    x.restore();
    this.paintRulers();
  }
  crosshair(x, sx, sy) {
    x.strokeStyle = '#000'; x.lineWidth = 3; x.beginPath(); x.moveTo(sx - 6, sy); x.lineTo(sx + 6, sy); x.moveTo(sx, sy - 6); x.lineTo(sx, sy + 6); x.stroke();
    x.strokeStyle = '#fff'; x.lineWidth = 1; x.stroke();
  }
  paintGrid(x, M) {
    const d = this.doc, z = this.zoom, step = App.prefs.gridSize, sub = Math.max(1, App.prefs.gridSub);
    x.save(); x.setTransform(M); x.lineWidth = 1 / z;
    const col = App.prefs.gridColor;
    if (step / sub * z >= 6) {
      x.strokeStyle = col + '40'; x.beginPath();
      for (let i = 0; i <= d.w; i += step / sub) { x.moveTo(i, 0); x.lineTo(i, d.h); }
      for (let j = 0; j <= d.h; j += step / sub) { x.moveTo(0, j); x.lineTo(d.w, j); }
      x.stroke();
    }
    x.strokeStyle = col + 'aa'; x.beginPath();
    for (let i = 0; i <= d.w; i += step) { x.moveTo(i, 0); x.lineTo(i, d.h); }
    for (let j = 0; j <= d.h; j += step) { x.moveTo(0, j); x.lineTo(d.w, j); }
    x.stroke(); x.restore();
  }
  paintGuides(x, M) {
    const d = this.doc, z = this.zoom; if (!d.guides.length && !this.guideDrag) return;
    x.save(); x.setTransform(M); x.lineWidth = 1 / z;
    const big = 1e6;
    for (const g of [...d.guides, ...(this.guideDrag?.temp ? [this.guideDrag.g] : [])]) {
      x.strokeStyle = g === this.guideDrag?.g ? '#ff4fd8' : App.prefs.guideColor;
      x.beginPath();
      if (g.o === 'v') { x.moveTo(g.p, -big); x.lineTo(g.p, big); } else { x.moveTo(-big, g.p); x.lineTo(big, g.p); }
      x.stroke();
    }
    x.restore();
  }
  paintRulers() {
    const show = App.prefs.rulers && this.doc;
    this.host.classList.toggle('no-rulers', !show);
    if (!show) return;
    const st = getComputedStyle(document.documentElement);
    const bg = st.getPropertyValue('--ruler-bg').trim(), fg = st.getPropertyValue('--ruler-fg').trim(), ln = st.getPropertyValue('--ruler-line').trim();
    const unit = App.prefs.units, ppi = this.doc.ppi || 72;
    const toU = unit === 'cm' ? 2.54 / ppi : unit === 'mm' ? 25.4 / ppi : unit === 'in' ? 1 / ppi : unit === '%' ? 100 / this.doc.w : 1;
    const z = this.zoom;
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000].map(s => s / toU);
    const unitSteps = unit === 'px' ? steps : [.1, .25, .5, 1, 2, 5, 10, 20, 50, 100].map(s => s / toU);
    const step = unitSteps.find(s => s * z >= 56) || unitSteps[unitSteps.length - 1];
    const fmt = v => { const u = v * toU; return Math.abs(u) < 1e-6 ? '0' : (Math.round(u * 100) / 100).toString(); };
    const draw = (cv, horiz) => {
      const x = cv.getContext('2d'); x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const len = horiz ? this.W : this.H;
      x.fillStyle = bg; x.fillRect(0, 0, horiz ? len : RULER, horiz ? RULER : len);
      x.strokeStyle = ln; x.fillStyle = fg; x.font = '9px Inter, system-ui, sans-serif'; x.lineWidth = 1;
      const o = horiz ? this.v.px : this.v.py;
      const startDoc = Math.floor((-o / z) / step) * step, endDoc = (len - o) / z;
      x.beginPath();
      for (let p = startDoc; p <= endDoc; p += step) {
        const s = Math.round(o + p * z) + .5;
        for (let k = 1; k < 10; k++) {
          const ss = Math.round(o + (p + step * k / 10) * z) + .5, tl = k === 5 ? 7 : 4;
          if (horiz) { x.moveTo(ss, RULER); x.lineTo(ss, RULER - tl); } else { x.moveTo(RULER, ss); x.lineTo(RULER - tl, ss); }
        }
        if (horiz) { x.moveTo(s, 0); x.lineTo(s, RULER); x.fillText(fmt(p), s + 3, 9); }
        else { x.moveTo(0, s); x.lineTo(RULER, s); x.save(); x.translate(9, s + 3); x.rotate(-Math.PI / 2); x.textAlign = 'right'; x.fillText(fmt(p), 0, 0); x.restore(); }
      }
      x.stroke();
      if (this.mouse?.inside) {
        x.strokeStyle = st.getPropertyValue('--accent').trim(); x.beginPath();
        const s = (horiz ? this.mouse.sx : this.mouse.sy) + .5;
        if (horiz) { x.moveTo(s, 0); x.lineTo(s, RULER); } else { x.moveTo(0, s); x.lineTo(RULER, s); }
        x.stroke();
      }
      x.strokeStyle = ln; x.beginPath();
      if (horiz) { x.moveTo(0, RULER - .5); x.lineTo(len, RULER - .5); } else { x.moveTo(RULER - .5, 0); x.lineTo(RULER - .5, len); }
      x.stroke();
    };
    draw(this.rulerTop, true); draw(this.rulerLeft, false);
  }

  // ── Snapping ─────────────────────────────────────────────────────────
  snap(x, y, { guides = true, edges = true } = {}) {
    if (!App.prefs.snap || !this.doc) return { x, y };
    const tol = 7 / this.zoom, d = this.doc;
    let bx = x, by = y, dx = tol, dy = tol;
    const cand = [];
    if (edges) cand.push(['v', 0], ['v', d.w], ['h', 0], ['h', d.h], ['v', d.w / 2], ['h', d.h / 2]);
    if (guides && App.prefs.guides) for (const g of d.guides) cand.push([g.o, g.p]);
    for (const [o, p] of cand) {
      if (o === 'v' && Math.abs(x - p) < dx) { dx = Math.abs(x - p); bx = p; }
      if (o === 'h' && Math.abs(y - p) < dy) { dy = Math.abs(y - p); by = p; }
    }
    return { x: bx, y: by };
  }

  // ── Events ───────────────────────────────────────────────────────────
  evt(e) {
    const r = this.stage.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top, p = this.toDoc(sx, sy);
    return {
      x: p.x, y: p.y, sx, sy, native: e,
      pressure: e.pointerType === 'pen' ? (e.pressure || .5) : 1, pen: e.pointerType === 'pen',
      shift: e.shiftKey, alt: e.altKey, mod: isMac ? e.metaKey : e.ctrlKey, ctrl: e.ctrlKey, button: e.button,
      inside: sx >= 0 && sy >= 0 && sx <= this.W && sy <= this.H,
    };
  }
  guideAt(sx, sy) {
    const d = this.doc; if (!d || !App.prefs.guides || d.guidesLocked) return null;
    for (const g of d.guides) {
      const s = this.toScreen(g.o === 'v' ? g.p : 0, g.o === 'h' ? g.p : 0);
      if (g.o === 'v' && Math.abs(s.x - sx) < 4) return g;
      if (g.o === 'h' && Math.abs(s.y - sy) < 4) return g;
    }
    return null;
  }
  bindEvents() {
    const st = this.stage;
    st.addEventListener('contextmenu', e => { e.preventDefault(); App.emit('stagemenu', e); });
    st.addEventListener('pointerdown', e => {
      if (!this.doc) return;
      st.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (e.pointerType === 'touch' && this.pointers.size === 2) { this.startPinch(); return; }
      if (this.pinch) return;
      const ev = this.evt(e);
      if (e.button === 1) { this.panDrag = { sx: ev.sx, sy: ev.sy, px: this.v.px, py: this.v.py }; return; }
      if (e.button === 2) return;
      const tool = App.activeTool();
      const g = tool?.id === 'move' || ev.mod ? this.guideAt(ev.sx, ev.sy) : null;
      if (g && !App.tempTool) { this.guideDrag = { g, temp: false }; return; }
      this.downEv = ev; this.active = true;
      tool?.down?.(ev);
    });
    st.addEventListener('pointermove', e => {
      if (!this.doc) return;
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pinch) { this.movePinch(); return; }
      const evs = e.getCoalescedEvents?.() || [e];
      const ev = this.evt(e);
      this.mouse = { sx: ev.sx, sy: ev.sy, x: ev.x, y: ev.y, inside: true };
      App.emit('cursor', ev);
      if (this.panDrag) { this.v.px = this.panDrag.px + ev.sx - this.panDrag.sx; this.v.py = this.panDrag.py + ev.sy - this.panDrag.sy; this.changed(); return; }
      if (this.guideDrag) {
        const g = this.guideDrag.g, p = this.snap(ev.x, ev.y, { guides: false });
        g.p = Math.round(g.o === 'v' ? p.x : p.y); this.redraw(); return;
      }
      const tool = App.activeTool();
      if (this.active) { for (const ce of (evs.length ? evs : [e])) tool?.move?.(this.evt(ce)); }
      else tool?.hover?.(ev);
      this.updateCursor(ev);
      this.redraw();
    });
    const end = e => {
      this.pointers.delete(e.pointerId);
      if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; return; }
      if (this.panDrag) { this.panDrag = null; return; }
      if (this.guideDrag) {
        const ev = this.evt(e), g = this.guideDrag.g, d = this.doc;
        const out = g.o === 'v' ? ev.sx < 0 || ev.sx > this.W : ev.sy < 0 || ev.sy > this.H;
        if (this.guideDrag.temp) { if (!out) d.guides.push(g); }
        else if (out) d.guides.splice(d.guides.indexOf(g), 1);
        this.guideDrag = null; d.history.push(out ? 'Hapus Guide' : 'Guide', 'border_vertical'); this.redraw(); return;
      }
      if (!this.active) return;
      this.active = false;
      App.activeTool()?.up?.(this.evt(e));
      this.redraw();
    };
    st.addEventListener('pointerup', end);
    st.addEventListener('pointercancel', end);
    st.addEventListener('pointerleave', () => { if (this.mouse) this.mouse.inside = false; this.redraw(); App.emit('cursor', null); });
    st.addEventListener('dblclick', e => { if (this.doc) App.activeTool()?.dblclick?.(this.evt(e)); });
    st.addEventListener('wheel', e => {
      if (!this.doc) return;
      e.preventDefault();
      const ev = this.evt(e);
      const zoomGesture = e.ctrlKey || e.altKey || (App.prefs.zoomWheel && !e.shiftKey);
      if (zoomGesture) {
        const k = Math.exp(-e.deltaY * (e.ctrlKey && !e.altKey ? .012 : .0025));
        this.zoomTo(this.zoom * k, ev.sx, ev.sy);
      } else {
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        this.v.px -= dx; this.v.py -= dy; this.changed();
      }
    }, { passive: false });
    // drag a guide from a ruler
    const fromRuler = o => e => {
      if (!this.doc) return;
      e.preventDefault();
      const g = { o, p: 0 }; this.guideDrag = { g, temp: true };
      const mv = ev => { const p = this.evt(ev), s = this.snap(p.x, p.y, { guides: false }); g.p = Math.round(o === 'v' ? s.x : s.y); this.mouse = { ...p, inside: true }; this.redraw(); };
      const up = ev => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); end({ ...ev, pointerId: -1, clientX: ev.clientX, clientY: ev.clientY }); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    };
    this.rulerTop.addEventListener('pointerdown', fromRuler('h'));
    this.rulerLeft.addEventListener('pointerdown', fromRuler('v'));
    this.corner.addEventListener('dblclick', () => { App.prefs.rulers = !App.prefs.rulers; savePrefs(); this.resize(); });
  }
  startPinch() {
    const [a, b] = [...this.pointers.values()];
    this.active = false;
    this.pinch = { d: Math.hypot(b.x - a.x, b.y - a.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, z: this.zoom, px: this.v.px, py: this.v.py };
  }
  movePinch() {
    const [a, b] = [...this.pointers.values()]; if (!b) return;
    const r = this.stage.getBoundingClientRect(), p = this.pinch;
    const dd = Math.hypot(b.x - a.x, b.y - a.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    this.v.px = p.px + (cx - p.cx); this.v.py = p.py + (cy - p.cy);
    this.zoomTo(p.z * dd / p.d, cx - r.left, cy - r.top);
  }
  updateCursor(ev) {
    const tool = App.activeTool();
    let c = tool?.cursor ? (typeof tool.cursor === 'function' ? tool.cursor(ev) : tool.cursor) : 'default';
    if (!this.active && (tool?.id === 'move' || ev.mod) && this.guideAt(ev.sx, ev.sy)) c = 'move';
    if (tool?.brushSize && App.prefs.brushCursor !== 'precise' && tool.brushSize() * this.zoom > 4) c = 'none';
    else if (tool?.brushSize) c = 'crosshair';
    if (this.stage.style.cursor !== c) this.stage.style.cursor = c;
  }
}
