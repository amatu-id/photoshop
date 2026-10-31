// Workspace-style dialogs: Liquify and Select and Mask

import { App, commit, invalidate } from '../state.js';
import { h, canvas, ctx2d, clamp } from '../util.js';
import { dialog, sliderRow, select, ibtn, check } from './controls.js';
import { editTarget } from '../tools/base.js';
import { applyPixels, setSel, addMask, addLayerFromCanvas } from '../ops.js';
import { flattenDoc } from '../composite.js';
import { Selection } from '../selection.js';
import { blurPlane } from '../blur.js';
import { makeMask } from '../doc.js';

function sampleInto(src, fx, fy, w, hh, out, k = 1, offX = 0, offY = 0) {
  const s = src.data, o = out.data, W = src.width, H = src.height;
  for (let yy = 0; yy < out.height; yy++) for (let xx = 0; xx < out.width; xx++) {
    const x = xx + offX, y = yy + offY;
    const fxv = k === 1 ? fx[y * w + x] : bil(fx, w, hh, x * k, y * k) / k;
    const fyv = k === 1 ? fy[y * w + x] : bil(fy, w, hh, x * k, y * k) / k;
    const sx = clamp(x + fxv, 0, W - 1.001), sy = clamp(y + fyv, 0, H - 1.001);
    const x0 = sx | 0, y0 = sy | 0, ax = sx - x0, ay = sy - y0, i = (y0 * W + x0) * 4, j = (yy * out.width + xx) * 4;
    for (let c = 0; c < 4; c++) o[j + c] = (s[i + c] * (1 - ax) + s[i + 4 + c] * ax) * (1 - ay) + (s[i + W * 4 + c] * (1 - ax) + s[i + W * 4 + 4 + c] * ax) * ay;
  }
}
function bil(f, w, hh, x, y) {
  x = clamp(x, 0, w - 1.001); y = clamp(y, 0, hh - 1.001);
  const x0 = x | 0, y0 = y | 0, ax = x - x0, ay = y - y0, i = y0 * w + x0;
  return (f[i] * (1 - ax) + f[i + 1] * ax) * (1 - ay) + (f[i + w] * (1 - ax) + f[i + w + 1] * ax) * ay;
}

export async function liquifyDialog() {
  const t = await editTarget({ allowMask: false }); if (!t) return;
  const src = t.canvas, k = Math.min(1, 1200 / Math.max(src.width, src.height));
  const w = Math.max(2, Math.round(src.width * k)), hh = Math.max(2, Math.round(src.height * k));
  const sc = canvas(w, hh); ctx2d(sc).drawImage(src, 0, 0, w, hh);
  const base = ctx2d(sc).getImageData(0, 0, w, hh), out = new ImageData(w, hh);
  const fx = new Float32Array(w * hh), fy = new Float32Array(w * hh);
  const s = { tool: 'warp', size: 120, pressure: 50, density: 50, rate: 80, mesh: false };
  const view = canvas(w, hh), vx = ctx2d(view), overlay = canvas(w, hh);
  const box = h('div.stagebox'); box.append(view, overlay);
  let zoom = 1, ox = 0, oy = 0;
  const layout = () => { const r = box.getBoundingClientRect(); zoom = Math.min(r.width / w, r.height / hh, 2); ox = (r.width - w * zoom) / 2; oy = (r.height - hh * zoom) / 2; for (const c of [view, overlay]) Object.assign(c.style, { left: ox + 'px', top: oy + 'px', width: w * zoom + 'px', height: hh * zoom + 'px' }); };
  const render = () => { sampleInto(base, fx, fy, w, hh, out); vx.putImageData(out, 0, 0); if (s.mesh) drawMesh(); };
  const drawMesh = () => { vx.strokeStyle = 'rgba(120,180,255,.5)'; vx.lineWidth = 1; const st = 24; vx.beginPath(); for (let y = 0; y < hh; y += st) { for (let x = 0; x < w; x += 4) { const i = y * w + x; x ? vx.lineTo(x - fx[i], y - fy[i]) : vx.moveTo(x - fx[i], y - fy[i]); } } for (let x = 0; x < w; x += st) { for (let y = 0; y < hh; y += 4) { const i = y * w + x; y ? vx.lineTo(x - fx[i], y - fy[i]) : vx.moveTo(x - fx[i], y - fy[i]); } } vx.stroke(); };
  const brush = (cx, cy, mx, my) => {
    const R = s.size / 2, R2 = R * R, str = s.pressure / 100, dens = s.density / 100;
    for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(hh, cy + R); y++) for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(w, cx + R); x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2; if (d2 > R2) continue;
      const lin = 1 - Math.sqrt(d2) / R, wgt = (lin * (1 - dens) + lin * lin * (3 - 2 * lin) * dens) * str, i = y * w + x;
      const px = x - cx, py = y - cy;
      switch (s.tool) {
        case 'warp': fx[i] -= mx * wgt; fy[i] -= my * wgt; break;
        case 'push': fx[i] -= -my * wgt; fy[i] -= mx * wgt; break;
        case 'twirl': case 'twirlccw': { const a = (s.tool === 'twirl' ? 1 : -1) * wgt * .08 * s.rate / 50, c = Math.cos(a), sn = Math.sin(a); fx[i] += (px * c - py * sn) - px; fy[i] += (px * sn + py * c) - py; break; }
        case 'pucker': fx[i] += px * wgt * .04 * s.rate / 50; fy[i] += py * wgt * .04 * s.rate / 50; break;
        case 'bloat': fx[i] -= px * wgt * .04 * s.rate / 50; fy[i] -= py * wgt * .04 * s.rate / 50; break;
        case 'reconstruct': fx[i] *= 1 - wgt * .25; fy[i] *= 1 - wgt * .25; break;
        case 'smooth': { const j = Math.min(w * hh - 1, i + 1), l = Math.max(0, i - 1); fx[i] += ((fx[j] + fx[l]) / 2 - fx[i]) * wgt; fy[i] += ((fy[j] + fy[l]) / 2 - fy[i]) * wgt; break; }
      }
    }
  };
  let last = null, timer = null, cur = null;
  const pos = e => { const r = view.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * w, y: (e.clientY - r.top) / r.height * hh }; };
  const ring = p => { const x = ctx2d(overlay); x.clearRect(0, 0, w, hh); if (!p) return; x.beginPath(); x.arc(p.x, p.y, s.size / 2, 0, Math.PI * 2); x.strokeStyle = '#fff'; x.lineWidth = 1.5 / zoom; x.stroke(); x.beginPath(); x.arc(p.x, p.y, s.size / 2 * (1 - s.density / 200), 0, Math.PI * 2); x.setLineDash([3, 3]); x.stroke(); x.setLineDash([]); };
  overlay.addEventListener('pointerdown', e => {
    overlay.setPointerCapture(e.pointerId); last = cur = pos(e);
    if (s.tool !== 'warp' && s.tool !== 'push') timer = setInterval(() => { brush(cur.x, cur.y, 0, 0); render(); }, 40);
  });
  overlay.addEventListener('pointermove', e => {
    const p = pos(e); cur = p; ring(p); if (!last) return;
    const mx = p.x - last.x, my = p.y - last.y; if (Math.hypot(mx, my) < .5) return;
    brush(p.x, p.y, mx, my); last = p; render();
  });
  const stop = () => { last = null; clearInterval(timer); };
  overlay.addEventListener('pointerup', stop); overlay.addEventListener('pointerleave', () => { ring(null); });
  const tools = [['warp', 'gesture', 'Forward Warp (W)'], ['reconstruct', 'history', 'Reconstruct (R)'], ['smooth', 'waves', 'Smooth (E)'], ['twirl', 'rotate_right', 'Twirl Clockwise (C)'], ['twirlccw', 'rotate_left', 'Twirl Counter-Clockwise'], ['pucker', 'compress', 'Pucker (S)'], ['bloat', 'expand', 'Bloat (B)'], ['push', 'swipe_left', 'Push Left (O)']];
  const tb = h('div.tools');
  const drawTools = () => tb.replaceChildren(...tools.map(([id, ic, tip]) => { const b = ibtn(ic, tip, () => { s.tool = id; drawTools(); }); if (s.tool === id) b.classList.add('on'); return b; }));
  drawTools();
  const side = h('div.side', h('div.sect', { text: 'Brush Tool Options' }),
    sliderRow({ label: 'Size', value: s.size, min: 1, max: 600, onInput: v => { s.size = v; } }), sliderRow({ label: 'Density', value: s.density, min: 0, max: 100, onInput: v => { s.density = v; } }),
    sliderRow({ label: 'Pressure', value: s.pressure, min: 1, max: 100, onInput: v => { s.pressure = v; } }), sliderRow({ label: 'Rate', value: s.rate, min: 1, max: 100, onInput: v => { s.rate = v; } }),
    h('div.sect', { text: 'View Options' }), check('Show Mesh', false, v => { s.mesh = v; render(); }),
    h('div.sect', { text: 'Rekonstruksi' }), h('button.btn', { type: 'button', onclick: () => { fx.fill(0); fy.fill(0); render(); } }, 'Restore All'));
  const keys = e => { const m = { w: 'warp', r: 'reconstruct', e: 'smooth', c: 'twirl', s: 'pucker', b: 'bloat', o: 'push' }[e.key.toLowerCase()]; if (m && !e.metaKey && !e.ctrlKey) { s.tool = m; drawTools(); e.stopPropagation(); } if (e.key === '[' || e.key === ']') { s.size = clamp(s.size + (e.key === ']' ? 10 : -10), 1, 600); ring(cur); } };
  document.addEventListener('keydown', keys, true);
  dialog({
    title: 'Liquify', cls: '.xwide', body: h('div.liquify', tb, box, side),
    buttons: ['grow', { label: 'Batal' }, { label: 'OK', primary: true, run: async () => {
      App.emit('busy', true); await new Promise(r => setTimeout(r, 20));
      await applyPixels('Liquify', (img, tt, r) => {
        const full = ctx2d(tt.canvas).getImageData(0, 0, tt.canvas.width, tt.canvas.height), res = new ImageData(img.width, img.height);
        sampleInto(full, fx, fy, w, hh, res, w / tt.canvas.width, r.x, r.y);
        return res;
      }, { icon: 'water_drop', allowMask: false });
      App.emit('busy', false);
    } }],
    onClose: () => document.removeEventListener('keydown', keys, true),
  });
  requestAnimationFrame(() => { layout(); render(); });
  new ResizeObserver(layout).observe(box);
}

// ── Select and Mask ──────────────────────────────────────────────────────
export function selectAndMaskDialog() {
  const d = App.doc; if (!d) return;
  const k = Math.min(1, 1000 / Math.max(d.w, d.h)), w = Math.round(d.w * k), hh = Math.round(d.h * k);
  const img = canvas(w, hh); ctx2d(img).drawImage(flattenDoc(d), 0, 0, w, hh);
  const baseSel = d.selection ? d.selection.clone() : new Selection(d.w, d.h);
  const s = { view: 'overlay', radius: 0, smooth: 0, feather: 0, contrast: 0, shift: 0, output: 'selection', opacity: 50, brush: 30 };
  const view = canvas(w, hh), vx = ctx2d(view);
  const mk = canvas(w, hh); // working mask at preview scale
  const mkx = ctx2d(mk); mkx.drawImage(baseSel.canvas, 0, 0, w, hh);
  let painted = canvas(d.w, d.h); ctx2d(painted).drawImage(baseSel.canvas, 0, 0);
  const process = (alphaCanvas, W, H, scale) => {
    const a = ctx2d(alphaCanvas).getImageData(0, 0, W, H).data; let A = new Float32Array(W * H);
    for (let i = 0; i < A.length; i++) A[i] = a[i * 4 + 3];
    if (s.smooth > 0) { A = blurPlane(A, W, H, s.smooth * scale / 2 + .3); for (let i = 0; i < A.length; i++) A[i] = A[i] >= 128 ? 255 : 0; }
    if (s.radius > 0) A = blurPlane(A, W, H, s.radius * scale / 3);
    if (s.shift) { const blurred = blurPlane(Float32Array.from(A), W, H, Math.max(1, Math.abs(s.shift) / 10 * scale)); const th = 128 - s.shift * 1.2; for (let i = 0; i < A.length; i++) A[i] = clamp((blurred[i] - th) * 4 + 128, 0, 255); }
    if (s.feather > 0) A = blurPlane(A, W, H, s.feather * scale / 2);
    if (s.contrast > 0) { const c = 1 + s.contrast / 12; for (let i = 0; i < A.length; i++) A[i] = clamp((A[i] - 128) * c + 128, 0, 255); }
    return A;
  };
  const render = () => {
    const A = process(mk, w, hh, k);
    const m = vx.createImageData(w, hh), src = ctx2d(img).getImageData(0, 0, w, hh).data, o = m.data, op = s.opacity / 100;
    for (let i = 0; i < A.length; i++) {
      const a = A[i] / 255, j = i * 4;
      if (s.view === 'bw') { o[j] = o[j + 1] = o[j + 2] = A[i]; o[j + 3] = 255; continue; }
      let bg = s.view === 'black' ? [0, 0, 0] : s.view === 'white' ? [255, 255, 255] : s.view === 'overlay' ? [src[j] * (1 - op) + 255 * op, src[j + 1] * (1 - op), src[j + 2] * (1 - op)] : [src[j] * .5 + 128 * .5, src[j + 1] * .5 + 128 * .5, src[j + 2] * .5 + 128 * .5];
      for (let c = 0; c < 3; c++) o[j + c] = src[j + c] * a + bg[c] * (1 - a);
      o[j + 3] = 255;
    }
    vx.putImageData(m, 0, 0);
  };
  const box = h('div.sm-view', view); view.style.cursor = 'crosshair';
  let painting = false;
  const paint = e => {
    const r = view.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * w, y = (e.clientY - r.top) / r.height * hh;
    const add = !e.altKey;
    for (const [c, sc] of [[mkx, 1], [ctx2d(painted), 1 / k]]) { c.save(); c.globalCompositeOperation = add ? 'source-over' : 'destination-out'; c.fillStyle = '#fff'; c.beginPath(); c.arc(x * sc, y * sc, s.brush / 2 * sc * k, 0, Math.PI * 2); c.fill(); c.restore(); }
    render();
  };
  view.addEventListener('pointerdown', e => { painting = true; view.setPointerCapture(e.pointerId); paint(e); });
  view.addEventListener('pointermove', e => { if (painting) paint(e); });
  view.addEventListener('pointerup', () => { painting = false; });
  const S = (label, key, min, max, step = 1, unit = 'px') => sliderRow({ label, value: s[key], min, max, step, unit, onInput: v => { s[key] = v; render(); } });
  const side = h('div.side',
    h('div.sect', { text: 'View Mode' }), h('div.prow', select([['overlay', 'Overlay'], ['onion', 'Onion Skin'], ['black', 'On Black'], ['white', 'On White'], ['bw', 'Black & White']], s.view, v => { s.view = v; render(); })), S('Opacity', 'opacity', 0, 100, 1, '%'),
    h('div.sect', { text: 'Brush (Alt = kurangi)' }), S('Ukuran brush', 'brush', 2, 400),
    h('div.sect', { text: 'Edge Detection' }), S('Radius', 'radius', 0, 250, .5),
    h('div.sect', { text: 'Global Refinements' }), S('Smooth', 'smooth', 0, 100), S('Feather', 'feather', 0, 250, .5), S('Contrast', 'contrast', 0, 100, 1, '%'), S('Shift Edge', 'shift', -100, 100, 1, '%'),
    h('div.prow', h('button.btn.sm', { type: 'button', onclick: () => { const sel = App.subjectMask?.(); if (sel) { mkx.clearRect(0, 0, w, hh); mkx.drawImage(sel.canvas, 0, 0, w, hh); painted = canvas(d.w, d.h); ctx2d(painted).drawImage(sel.canvas, 0, 0); render(); } } }, 'Select Subject')),
    h('div.sect', { text: 'Output Settings' }), h('div.prow', h('label', { text: 'Output To' }), select([['selection', 'Selection'], ['mask', 'Layer Mask'], ['layer', 'New Layer'], ['layermask', 'New Layer with Layer Mask']], s.output, v => { s.output = v; })));
  render();
  dialog({
    title: 'Select and Mask', cls: '.xwide', body: h('div.sm-split', box, side),
    buttons: ['grow', { label: 'Batal' }, { label: 'OK', primary: true, run: () => {
      const A = process(painted, d.w, d.h, 1), sel = Selection.fromAlpha(d.w, d.h, Uint8ClampedArray.from(A));
      if (s.output === 'selection') return setSel(sel, 'Select and Mask');
      d.selection = sel;
      if (s.output === 'mask') { const L = d.active; if (L?.mask) { L.mask = null; } addMask('reveal'); return; }
      const c = canvas(d.w, d.h), x = ctx2d(c), L0 = d.active;
      const srcC = L0?.type === 'raster' ? (() => { const t = canvas(d.w, d.h); ctx2d(t).drawImage(L0.canvas, L0.x, L0.y); return t; })() : flattenDoc(d);
      x.drawImage(srcC, 0, 0);
      if (s.output === 'layer') { x.globalCompositeOperation = 'destination-in'; x.drawImage(sel.canvas, 0, 0); d.selection = null; addLayerFromCanvas(c, `${L0?.name || 'Layer'} copy`, 0, 0, { commitLabel: 'Select and Mask' }); return; }
      d.selection = null; const L = addLayerFromCanvas(c, `${L0?.name || 'Layer'} copy`, 0, 0, { commitLabel: null });
      L.mask = makeMask(d.w, d.h, false); const mx = ctx2d(L.mask.canvas); const tt = canvas(d.w, d.h), tx = ctx2d(tt); tx.fillStyle = '#fff'; tx.fillRect(0, 0, d.w, d.h); tx.globalCompositeOperation = 'destination-in'; tx.drawImage(sel.canvas, 0, 0); mx.drawImage(tt, 0, 0);
      if (L0) L0.visible = false;
      App.emit('layers'); invalidate(); commit('Select and Mask', 'select');
    } }],
  });
}
