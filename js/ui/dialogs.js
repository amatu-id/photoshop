// Dialogs: New, Image/Canvas Size, Adjustments, Filters, Layer Style, Export, Fill/Stroke, Color Range, prefs…

import { App, commit, invalidate, toast, savePrefs } from '../state.js';
import { h, icon, canvas, ctx2d, clamp, debounce, fmtBytes, canvasToBlob, download, fmtKey, round } from '../util.js';
import { dialog, numField, sliderRow, check, select, colorSwatch, ibtn, popover } from './controls.js';
import { adjustUI } from './adjustui.js';
import { ADJUSTMENTS, defaultsFor, applyAdjustment, shadowsHighlights, replaceColor } from '../adjust.js';
import { FILTERS, filterDefaults, CAMRAW_DEFAULTS, cameraRaw } from '../filters.js';
import { STYLE_DEFAULTS, STYLE_NAMES, hasStyles, layerSurface } from '../composite.js';
import { BLEND_MODES } from '../doc.js';
import { editTarget, touchTarget } from '../tools/base.js';
import { GRADIENT_PRESETS, resolveStops, stopsCss, hexToRgb, rgbToHex, rgbCss } from '../color.js';
import * as ops from '../ops.js';
import { exportCanvas, saveToBrowser, downloadProject, exportPSD } from '../io.js';
import { Selection } from '../selection.js';

const D = () => App.doc;
const blendOpts = (group = false) => BLEND_MODES.filter(b => b === null || group || b[2] !== 'group').map(b => b && [b[0], b[1]]);
const field = (label, el) => h('label.field', h('span', { text: label }), el);

// ── Live preview on the active target ────────────────────────────────────
export class Preview {
  static async start(opts = {}) {
    const t = await editTarget({ allowMask: opts.allowMask !== false }); if (!t) return null;
    return new Preview(t);
  }
  constructor(t) {
    this.t = t; const d = D();
    this.base = ctx2d(t.canvas).getImageData(0, 0, t.canvas.width, t.canvas.height);
    this.work = canvas(t.canvas.width, t.canvas.height); this.on = true;
    const sel = d.selection && !d.selection.empty ? d.selection : null;
    if (sel) { const m = canvas(t.canvas.width, t.canvas.height); ctx2d(m).drawImage(sel.canvas, -t.x, -t.y); this.mask = ctx2d(m).getImageData(0, 0, m.width, m.height).data; }
    this.run = debounce(fn => this.apply(fn), 140);
  }
  async apply(fn) {
    App.emit('busy', true); await new Promise(r => setTimeout(r, 0));
    try {
      const img = new ImageData(new Uint8ClampedArray(this.base.data), this.base.width, this.base.height);
      let out = (await fn(img)) || img;
      if (this.mask) { const o = out.data, b = this.base.data, m = this.mask; for (let i = 0; i < o.length; i += 4) { const a = m[i + 3] / 255; if (a >= 1) continue; for (let c = 0; c < 4; c++) o[i + c] = b[i + c] + (o[i + c] - b[i + c]) * a; } }
      this.result = out; this.show();
    } catch (e) { console.error(e); }
    App.emit('busy', false);
  }
  show() {
    const t = this.t;
    if (!this.on || !this.result) { this.clearLive(); return; }
    ctx2d(this.work).putImageData(this.result, 0, 0);
    if (t.kind === 'mask') { ctx2d(t.canvas).putImageData(this.result, 0, 0); t.mask.rev++; t.mask._alpha = null; }
    else { App.live = App.live || new Map(); App.live.set(t.layer.id, { canvas: this.work, x: t.x, y: t.y }); }
    t.layer._styled = null; invalidate();
  }
  clearLive() { const t = this.t; if (t.kind === 'mask') { ctx2d(t.canvas).putImageData(this.base, 0, 0); t.mask.rev++; t.mask._alpha = null; } else App.live?.delete(t.layer.id); t.layer._styled = null; invalidate(); }
  toggle(v) { this.on = v; this.show(); }
  async commit(label, fn, ic = 'tune') {
    if (!this.result) await this.apply(fn);
    App.live?.delete(this.t.layer.id);
    ctx2d(this.t.canvas).putImageData(this.result, 0, 0);
    touchTarget(this.t); invalidate(); commit(label, ic);
  }
  cancel() { this.clearLive(); }
}

// Generic adjustment dialog (destructive)
export async function adjustDialog(kind) {
  const pv = await Preview.start(); if (!pv) return;
  const A = ADJUSTMENTS[kind], p = defaultsFor(kind);
  const fn = img => applyAdjustment(kind, p, img);
  const ui = adjustUI(kind, p, () => pv.run(fn));
  let ok = false;
  dialog({
    title: A.name, width: kind === 'curves' || kind === 'levels' ? 440 : 400, body: ui,
    buttons: [{ el: check('Preview', true, v => pv.toggle(v)) }, 'grow', { label: 'Batal' }, { label: 'OK', primary: true, run: async () => { ok = true; await pv.commit(A.name, fn); } }],
    onClose: () => { if (!ok) pv.cancel(); },
  });
  pv.run(fn);
}

// Filter dialog built from the param schema
export async function filterDialog(id, params) {
  const F = FILTERS[id];
  const p = params || App.filterMemory?.[id] || filterDefaults(id);
  if (!F.params.length) { ops.runFilter(id, {}); return; }
  const pv = await Preview.start(); if (!pv) return;
  const env = ops.filterEnv();
  const fn = img => F.apply(img, p, env);
  const body = h('div');
  for (const q of F.params) {
    if (q.type === 'range') { const r = sliderRow({ label: q.label, value: p[q.key], min: q.min, max: q.max, step: q.step, unit: q.unit, onInput: v => { p[q.key] = v; pv.run(fn); } }); r.dataset.def = q.def; body.append(r); }
    else if (q.type === 'select') body.append(h('div.prow', h('label', { text: q.label }), select(q.options, p[q.key], v => { p[q.key] = v; pv.run(fn); })));
    else if (q.type === 'check') body.append(h('div.prow', check(q.label, p[q.key], v => { p[q.key] = v; pv.run(fn); })));
    else if (q.type === 'kernel') {
      const g = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 56px)', gap: '4px', marginBottom: '10px' } });
      p.kernel.forEach((v, i) => { const inp = h('input.inp', { value: v, style: { textAlign: 'center' } }); inp.addEventListener('keydown', e => e.stopPropagation()); inp.onchange = () => { p.kernel[i] = parseFloat(inp.value) || 0; pv.run(fn); }; g.append(inp); });
      body.append(h('div.sect', { text: q.label }), g);
    }
  }
  let ok = false;
  dialog({
    title: F.name.replace('…', ''), width: 420, body,
    buttons: [{ el: check('Preview', true, v => pv.toggle(v)) }, 'grow', { label: 'Batal' }, { label: 'OK', primary: true, run: async () => { ok = true; (App.filterMemory ||= {})[id] = p; App.lastFilter = { id, params: structuredClone(p) }; App.emit('lastfilter'); await pv.commit(F.name.replace('…', ''), fn, 'filter'); } }],
    onClose: () => { if (!ok) pv.cancel(); },
  });
  pv.run(fn);
}

// Shadows/Highlights & Replace Color (dialog-only adjustments)
export async function shadowsHighlightsDialog() {
  const pv = await Preview.start(); if (!pv) return;
  const p = { shadows: 35, highlights: 0, radius: 30, color: 20 }, fn = img => shadowsHighlights(img, p);
  const body = h('div', ...[['Shadows Amount', 'shadows', 0, 100], ['Highlights Amount', 'highlights', 0, 100], ['Radius', 'radius', 1, 200], ['Color', 'color', -100, 100]].map(([l, k, a, b]) => sliderRow({ label: l, value: p[k], min: a, max: b, onInput: v => { p[k] = v; pv.run(fn); } })));
  let ok = false;
  dialog({ title: 'Shadows/Highlights', width: 400, body, buttons: [{ el: check('Preview', true, v => pv.toggle(v)) }, 'grow', { label: 'Batal' }, { label: 'OK', primary: true, run: async () => { ok = true; await pv.commit('Shadows/Highlights', fn); } }], onClose: () => { if (!ok) pv.cancel(); } });
  pv.run(fn);
}
export async function replaceColorDialog() {
  const pv = await Preview.start(); if (!pv) return;
  const p = { color: rgbToHex(App.fg), fuzziness: 40, h: 0, s: 0, l: 0 }, fn = img => replaceColor(img, p);
  const body = h('div', h('div.prow', h('label', { text: 'Warna' }), colorSwatch(() => p.color, c => { p.color = c; pv.run(fn); }), h('span.note', { text: 'Gunakan Eyedropper (I) lalu tekan warna depan' })),
    ...[['Fuzziness', 'fuzziness', 0, 200], ['Hue', 'h', -180, 180], ['Saturation', 's', -100, 100], ['Lightness', 'l', -100, 100]].map(([l, k, a, b]) => sliderRow({ label: l, value: p[k], min: a, max: b, onInput: v => { p[k] = v; pv.run(fn); } })));
  let ok = false;
  dialog({ title: 'Replace Color', width: 400, body, buttons: [{ el: check('Preview', true, v => pv.toggle(v)) }, 'grow', { label: 'Batal' }, { label: 'OK', primary: true, run: async () => { ok = true; await pv.commit('Replace Color', fn); } }], onClose: () => { if (!ok) pv.cancel(); } });
  pv.run(fn);
}

// ── New document ─────────────────────────────────────────────────────────
export const DOC_PRESETS = {
  'Foto': [['Default Photoshop', 1920, 1080, 72], ['Landscape 4×6', 1800, 1200, 300], ['Portrait 4×6', 1200, 1800, 300], ['Landscape 5×7', 2100, 1500, 300], ['Persegi 8×8', 2400, 2400, 300], ['Kamera 24 MP', 6000, 4000, 300]],
  'Cetak': [['A4', 2480, 3508, 300], ['A3', 3508, 4961, 300], ['A5', 1748, 2480, 300], ['Letter', 2550, 3300, 300], ['Kartu Nama', 1050, 600, 300], ['Poster 18×24', 5400, 7200, 300]],
  'Web': [['Web 1920', 1920, 1080, 72], ['Web 1366', 1366, 768, 72], ['MacBook Pro 14"', 3024, 1964, 72], ['Banner Web', 1200, 400, 72], ['Favicon', 512, 512, 72]],
  'Seluler': [['iPhone 15 Pro', 1179, 2556, 72], ['iPhone SE', 750, 1334, 72], ['Android 1080p', 1080, 1920, 72], ['iPad Pro 12.9"', 2048, 2732, 72]],
  'Media Sosial': [['Instagram Post', 1080, 1080, 72], ['Instagram Portrait', 1080, 1350, 72], ['Instagram Story', 1080, 1920, 72], ['YouTube Thumbnail', 1280, 720, 72], ['Facebook Cover', 1640, 624, 72], ['X Header', 1500, 500, 72], ['LinkedIn Banner', 1584, 396, 72]],
  'Film & Video': [['HD 720p', 1280, 720, 72], ['Full HD 1080p', 1920, 1080, 72], ['4K UHD', 3840, 2160, 72], ['Sinema 2K', 2048, 1080, 72]],
  'Seni & Ilustrasi': [['Kanvas 3000', 3000, 3000, 300], ['Ilustrasi A4', 2480, 3508, 300], ['Komik Halaman', 2700, 4050, 300], ['Pixel Art 64', 64, 64, 72], ['Pixel Art 256', 256, 256, 72]],
};
export function newDocDialog() {
  const s = { name: `Tanpa Judul-${App.untitled + 1}`, w: 1920, h: 1080, ppi: 72, unit: 'px', bg: '#ffffff' };
  let cat = 'Foto', cur = null;
  const cats = h('div.cats'), list = h('div.plist');
  const toU = (px) => s.unit === 'px' ? px : s.unit === 'in' ? px / s.ppi : s.unit === 'cm' ? px / s.ppi * 2.54 : px / s.ppi * 25.4;
  const fromU = (v) => s.unit === 'px' ? v : s.unit === 'in' ? v * s.ppi : s.unit === 'cm' ? v / 2.54 * s.ppi : v / 25.4 * s.ppi;
  const name = h('input.inp', { value: s.name }); name.oninput = () => { s.name = name.value; }; name.addEventListener('keydown', e => e.stopPropagation());
  const wF = numField({ value: s.w, min: .01, step: .01, onChange: v => { s.w = Math.round(fromU(v)); } });
  const hF = numField({ value: s.h, min: .01, step: .01, onChange: v => { s.h = Math.round(fromU(v)); } });
  const syncWH = () => { wF.set(round(toU(s.w), 2)); hF.set(round(toU(s.h), 2)); };
  const unitSel = select([['px', 'Piksel'], ['in', 'Inci'], ['cm', 'Sentimeter'], ['mm', 'Milimeter']], s.unit, v => { s.unit = v; syncWH(); });
  const ppiF = numField({ value: s.ppi, min: 1, max: 1200, unit: 'ppi', onChange: v => { s.ppi = v; } });
  const bgSel = select([['#ffffff', 'Putih'], ['#000000', 'Hitam'], ['transparent', 'Transparan'], ['bgcolor', 'Warna Latar']], s.bg, v => { s.bg = v === 'bgcolor' ? rgbToHex(App.bg) : v; });
  const orient = h('div.seg', ibtn('crop_portrait', 'Potret', () => { if (s.w > s.h) { [s.w, s.h] = [s.h, s.w]; syncWH(); } }), ibtn('crop_landscape', 'Lanskap', () => { if (s.h > s.w) { [s.w, s.h] = [s.h, s.w]; syncWH(); } }));
  const render = () => {
    cats.replaceChildren(...Object.keys(DOC_PRESETS).map(c => { const b = h('button.btn.sm' + (c === cat ? '.on' : ''), { type: 'button', text: c }); b.onclick = () => { cat = c; render(); }; return b; }));
    list.replaceChildren(...DOC_PRESETS[cat].map(p => {
      const k = 46 / Math.max(p[1], p[2]);
      const card = h('div.pcard' + (cur === p ? '.on' : ''), h('div.shape', h('i', { style: { width: p[1] * k + 'px', height: p[2] * k + 'px' } })), h('b', { text: p[0] }), h('small', { text: `${p[1]} × ${p[2]} px @ ${p[3]} ppi` }));
      card.onclick = () => { cur = p; s.w = p[1]; s.h = p[2]; s.ppi = p[3]; ppiF.set(p[3]); syncWH(); render(); };
      card.ondblclick = () => dlg.buttons.Buat.click();
      return card;
    }));
  };
  render();
  const body = h('div.newdoc', h('div', cats, list), h('div', h('div.sect', { text: 'Detail preset' }), field('Nama', name), h('div', { style: { height: '10px' } }),
    h('div.two', field('Lebar', wF), field('Unit', unitSel), field('Tinggi', hF), field('Orientasi', orient), field('Resolusi', ppiF), field('Isi Latar', bgSel)),
    h('div.note', { style: { marginTop: '12px' }, text: 'Mode warna: RGB 8-bit · Profil sRGB' })));
  const dlg = dialog({ title: 'Dokumen Baru', cls: '.wide', body, buttons: ['grow', { label: 'Tutup' }, { label: 'Buat', primary: true, run: () => {
    if (s.w * s.h > 64e6) { toast('Ukuran terlalu besar (maks 64 megapiksel)', 'err'); return false; }
    App.untitled++; ops.makeDocument({ ...s, name: s.name || `Tanpa Judul-${App.untitled}` });
  } }] });
}

// ── Image Size / Canvas Size ─────────────────────────────────────────────
export function imageSizeDialog() {
  const d = D(); if (!d) return;
  const s = { w: d.w, h: d.h, ppi: d.ppi, link: true, resample: true };
  const ratio = d.w / d.h;
  const info = h('div.note');
  const upd = () => { info.textContent = `Ukuran gambar: ${fmtBytes(s.w * s.h * 4)} · Dimensi: ${s.w} × ${s.h} px · ${round(s.w / s.ppi * 2.54, 2)} × ${round(s.h / s.ppi * 2.54, 2)} cm`; };
  const wF = numField({ value: s.w, min: 1, max: 30000, unit: 'px', onChange: v => { s.w = v; if (s.link) { s.h = Math.max(1, Math.round(v / ratio)); hF.set(s.h); } pW.set(round(s.w / d.w * 100, 2)); pH.set(round(s.h / d.h * 100, 2)); upd(); } });
  const hF = numField({ value: s.h, min: 1, max: 30000, unit: 'px', onChange: v => { s.h = v; if (s.link) { s.w = Math.max(1, Math.round(v * ratio)); wF.set(s.w); } pW.set(round(s.w / d.w * 100, 2)); pH.set(round(s.h / d.h * 100, 2)); upd(); } });
  const pW = numField({ value: 100, min: 1, max: 1000, step: .01, unit: '%', onChange: v => { s.w = Math.round(d.w * v / 100); wF.set(s.w); if (s.link) { s.h = Math.round(d.h * v / 100); hF.set(s.h); pH.set(v); } upd(); } });
  const pH = numField({ value: 100, min: 1, max: 1000, step: .01, unit: '%', onChange: v => { s.h = Math.round(d.h * v / 100); hF.set(s.h); if (s.link) { s.w = Math.round(d.w * v / 100); wF.set(s.w); pW.set(v); } upd(); } });
  const ppi = numField({ value: s.ppi, min: 1, max: 9999, unit: 'ppi', onChange: v => { s.ppi = v; upd(); } });
  const link = ibtn('link', 'Kunci rasio aspek', () => { s.link = !s.link; link.classList.toggle('on', s.link); }); link.classList.add('on');
  upd();
  dialog({
    title: 'Image Size', width: 460,
    body: h('div', info, h('div', { style: { height: '12px' } }), h('div.two', field('Lebar', wF), field('Persen lebar', pW), field('Tinggi', hF), field('Persen tinggi', pH), field('Resolusi', ppi), field('Rasio', link)),
      h('div', { style: { height: '10px' } }), check('Resample (ubah jumlah piksel)', s.resample, v => { s.resample = v; })),
    buttons: ['grow', { label: 'Batal' }, { label: 'OK', primary: true, run: () => { d.ppi = s.ppi; if (s.w !== d.w || s.h !== d.h) ops.imageSize(s.w, s.h, { resample: s.resample }); } }],
  });
}
export function canvasSizeDialog() {
  const d = D(); if (!d) return;
  const s = { w: d.w, h: d.h, rel: false, anchor: [1, 1], ext: rgbToHex(App.bg) };
  const wF = numField({ value: s.w, min: 1, max: 30000, unit: 'px', onChange: v => { s.w = v; } });
  const hF = numField({ value: s.h, min: 1, max: 30000, unit: 'px', onChange: v => { s.h = v; } });
  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 28px)', gap: '3px' } });
  const drawGrid = () => grid.replaceChildren(...[0, 1, 2].flatMap(r => [0, 1, 2].map(c => { const on = s.anchor[0] === c && s.anchor[1] === r; const b = h('button.ibtn' + (on ? '.on' : ''), { type: 'button' }, icon(on ? 'radio_button_checked' : 'circle')); b.onclick = () => { s.anchor = [c, r]; drawGrid(); }; return b; })));
  drawGrid();
  dialog({
    title: 'Canvas Size', width: 440,
    body: h('div', h('div.note', { text: `Ukuran saat ini: ${d.w} × ${d.h} px` }), h('div', { style: { height: '12px' } }),
      h('div.two', field('Lebar', wF), field('Tinggi', hF)), h('div', { style: { height: '8px' } }), check('Relatif', false, v => { s.rel = v; wF.set(v ? 0 : d.w); hF.set(v ? 0 : d.h); s.w = v ? 0 : d.w; s.h = v ? 0 : d.h; }),
      h('div.two', { style: { marginTop: '12px' } }, field('Anchor', grid), field('Warna ekstensi kanvas', colorSwatch(() => s.ext, c => { s.ext = c; })))),
    buttons: ['grow', { label: 'Batal' }, { label: 'OK', primary: true, run: () => { const w = s.rel ? d.w + s.w : s.w, hh = s.rel ? d.h + s.h : s.h; if (w < 1 || hh < 1) return false; ops.canvasSize(w, hh, s.anchor, s.ext); } }],
  });
}

// ── Layer Style ──────────────────────────────────────────────────────────
export function layerStyleDialog(focus = 'dropShadow') {
  const d = D(), L = d?.active; if (!L || L.isBackground || L.type === 'adjust') { toast(L?.isBackground ? 'Layer Background tidak mendukung layer style' : 'Pilih layer'); return; }
  const before = { styles: L.styles ? structuredClone(L.styles) : null, opacity: L.opacity, fill: L.fillOpacity, blend: L.blend };
  const st = L.styles ? structuredClone(L.styles) : {};
  for (const k of Object.keys(STYLE_DEFAULTS)) st[k] = { ...STYLE_DEFAULTS[k], ...(st[k] || {}) };
  let cur = focus;
  if (focus !== 'blending' && st[focus]) st[focus].enabled = true;
  const apply = () => { L.styles = structuredClone(st); L._styled = null; L.touch(); invalidate(); drawPrev(); };
  const nav = h('div.ls-nav'), panel = h('div'), prev = h('div.ls-prev'), pc = canvas(120, 80); prev.append(pc);
  const drawPrev = () => {
    const s = layerSurface(L, d); const x = ctx2d(pc); x.clearRect(0, 0, 120, 80); if (!s) return;
    const k = Math.min(110 / s.canvas.width, 70 / s.canvas.height); x.drawImage(s.canvas, (120 - s.canvas.width * k) / 2, (80 - s.canvas.height * k) / 2, s.canvas.width * k, s.canvas.height * k);
  };
  const order = ['blending', 'bevel', 'stroke', 'innerShadow', 'innerGlow', 'satin', 'colorOverlay', 'gradientOverlay', 'outerGlow', 'dropShadow'];
  const renderNav = () => nav.replaceChildren(...order.map(k => {
    if (k === 'blending') { const it = h('div.it' + (cur === k ? '.on' : ''), h('b', { text: 'Blending Options' })); it.onclick = () => { cur = k; renderNav(); renderPanel(); }; return it; }
    const c = h('input', { type: 'checkbox', checked: st[k].enabled }); c.onclick = e => { e.stopPropagation(); st[k].enabled = c.checked; if (c.checked) { cur = k; renderNav(); renderPanel(); } apply(); };
    const it = h('div.it' + (cur === k ? '.on' : ''), h('label.chk', c), h('span', { text: STYLE_NAMES[k] })); it.onclick = () => { cur = k; if (!st[k].enabled) { st[k].enabled = true; apply(); } renderNav(); renderPanel(); }; return it;
  }));
  const S = (s, label, key, min, max, unit = '') => sliderRow({ label, value: s[key], min, max, unit, onInput: v => { s[key] = v; apply(); } });
  const sel = (s, label, key, opts) => h('div.prow', h('label', { text: label }), select(opts, s[key], v => { s[key] = v; apply(); }));
  const col = (s, label, key) => h('div.prow', h('label', { text: label }), colorSwatch(() => s[key], c => { s[key] = c; apply(); }));
  const renderPanel = () => {
    const s = st[cur]; panel.replaceChildren(h('div.sect', { text: cur === 'blending' ? 'Blending Options' : STYLE_NAMES[cur] }));
    const blend = blendOpts();
    switch (cur) {
      case 'blending': panel.append(h('div.prow', h('label', { text: 'Blend Mode' }), select(blend, L.blend, v => { L.blend = v; L.touch(); invalidate(); })), sliderRow({ label: 'Opacity', value: Math.round(L.opacity * 100), min: 0, max: 100, unit: '%', onInput: v => { L.opacity = v / 100; invalidate(); } }), sliderRow({ label: 'Fill Opacity', value: Math.round(L.fillOpacity * 100), min: 0, max: 100, unit: '%', onInput: v => { L.fillOpacity = v / 100; L._styled = null; invalidate(); drawPrev(); } }), h('div.note', { text: 'Fill Opacity hanya memengaruhi piksel layer, bukan efek.' })); break;
      case 'dropShadow': panel.append(sel(s, 'Blend Mode', 'blend', blend), col(s, 'Warna', 'color'), S(s, 'Opacity', 'opacity', 0, 100, '%'), S(s, 'Angle', 'angle', -180, 180, '°'), S(s, 'Distance', 'distance', 0, 300, 'px'), S(s, 'Spread', 'spread', 0, 100, '%'), S(s, 'Size', 'size', 0, 250, 'px')); break;
      case 'innerShadow': panel.append(sel(s, 'Blend Mode', 'blend', blend), col(s, 'Warna', 'color'), S(s, 'Opacity', 'opacity', 0, 100, '%'), S(s, 'Angle', 'angle', -180, 180, '°'), S(s, 'Distance', 'distance', 0, 300, 'px'), S(s, 'Choke', 'choke', 0, 100, '%'), S(s, 'Size', 'size', 0, 250, 'px')); break;
      case 'outerGlow': panel.append(sel(s, 'Blend Mode', 'blend', blend), col(s, 'Warna', 'color'), S(s, 'Opacity', 'opacity', 0, 100, '%'), S(s, 'Spread', 'spread', 0, 100, '%'), S(s, 'Size', 'size', 0, 250, 'px')); break;
      case 'innerGlow': panel.append(sel(s, 'Blend Mode', 'blend', blend), col(s, 'Warna', 'color'), S(s, 'Opacity', 'opacity', 0, 100, '%'), sel(s, 'Source', 'source', [['edge', 'Edge'], ['center', 'Center']]), S(s, 'Choke', 'choke', 0, 100, '%'), S(s, 'Size', 'size', 0, 250, 'px')); break;
      case 'bevel': panel.append(sel(s, 'Style', 'style', [['inner', 'Inner Bevel'], ['outer', 'Outer Bevel'], ['emboss', 'Emboss'], ['pillow', 'Pillow Emboss']]), S(s, 'Depth', 'depth', 1, 1000, '%'), sel(s, 'Direction', 'dir', [['up', 'Up'], ['down', 'Down']]), S(s, 'Size', 'size', 0, 250, 'px'), S(s, 'Soften', 'soften', 0, 16, 'px'), S(s, 'Angle', 'angle', -180, 180, '°'), S(s, 'Altitude', 'altitude', 0, 90, '°'), col(s, 'Highlight', 'hiColor'), S(s, 'Highlight Opacity', 'hiOpacity', 0, 100, '%'), col(s, 'Shadow', 'shColor'), S(s, 'Shadow Opacity', 'shOpacity', 0, 100, '%')); break;
      case 'satin': panel.append(sel(s, 'Blend Mode', 'blend', blend), col(s, 'Warna', 'color'), S(s, 'Opacity', 'opacity', 0, 100, '%'), S(s, 'Angle', 'angle', -180, 180, '°'), S(s, 'Distance', 'distance', 1, 250, 'px'), S(s, 'Size', 'size', 0, 250, 'px')); break;
      case 'colorOverlay': panel.append(sel(s, 'Blend Mode', 'blend', blend), col(s, 'Warna', 'color'), S(s, 'Opacity', 'opacity', 0, 100, '%')); break;
      case 'gradientOverlay': {
        const bar = h('div.grad-bar', { style: { flex: 1 } }); const paint = () => { bar.style.background = stopsCss(resolveStops(s.stops || [[0, '#000000', 1], [1, '#ffffff', 1]])); }; paint();
        bar.onclick = async () => { const r = await editGradient(s.stops || [[0, '#000000', 1], [1, '#ffffff', 1]]); if (r) { s.stops = r; paint(); apply(); } };
        panel.append(sel(s, 'Blend Mode', 'blend', blend), S(s, 'Opacity', 'opacity', 0, 100, '%'), h('div.prow', h('label', { text: 'Gradient' }), bar), check('Reverse', s.reverse, v => { s.reverse = v; apply(); }), sel(s, 'Style', 'style', [['linear', 'Linear'], ['radial', 'Radial'], ['angle', 'Angle'], ['reflected', 'Reflected'], ['diamond', 'Diamond']]), S(s, 'Angle', 'angle', -180, 180, '°'), S(s, 'Scale', 'scale', 10, 150, '%'));
        break;
      }
      case 'stroke': panel.append(S(s, 'Size', 'size', 1, 250, 'px'), sel(s, 'Position', 'position', [['outside', 'Outside'], ['inside', 'Inside'], ['center', 'Center']]), sel(s, 'Blend Mode', 'blend', blend), S(s, 'Opacity', 'opacity', 0, 100, '%'), col(s, 'Warna', 'color')); break;
    }
  };
  renderNav(); renderPanel(); setTimeout(() => (focus !== 'blending' ? apply() : drawPrev()), 30);
  let ok = false;
  dialog({
    title: 'Layer Style', cls: '.wide', body: h('div.layer-style', nav, h('div.side', panel), h('div', prev, h('div.note', { style: { marginTop: '8px' }, text: 'Pratinjau langsung di kanvas.' }))),
    buttons: [{ label: 'Hapus Semua Efek', run: () => { for (const k of Object.keys(st)) st[k].enabled = false; apply(); renderNav(); return false; } }, 'grow', { label: 'Batal' }, { label: 'OK', primary: true, run: () => { ok = true; L.styles = hasStyles({ styles: st }) ? structuredClone(st) : null; L._styled = null; L.touch(); invalidate(); App.emit('layers'); commit('Layer Style', 'auto_awesome'); } }],
    onClose: () => { if (!ok) { L.styles = before.styles; L.opacity = before.opacity; L.fillOpacity = before.fill; L.blend = before.blend; L._styled = null; L.touch(); invalidate(); } },
  });
}

// ── Gradient editor ──────────────────────────────────────────────────────
export function editGradient(stops) {
  return new Promise(res => {
    let st = resolveStops(stops || GRADIENT_PRESETS[1].stops, App.fg, App.bg).map(([p, c, a]) => [p, rgbToHex(c), a]);
    let cur = 0;
    const presets = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '6px', marginBottom: '12px' } });
    const ge = h('div.grad-edit'), gbar = h('div.gbar'); ge.append(gbar);
    const ctl = h('div');
    const render = () => {
      st.sort((a, b) => a[0] - b[0]); cur = clamp(cur, 0, st.length - 1);
      gbar.style.background = `${stopsCss(resolveStops(st))}, repeating-conic-gradient(#fff 0 25%, #ccc 0 50%) 50% / 10px 10px`;
      ge.querySelectorAll('.stop').forEach(e => e.remove());
      st.forEach((s, i) => {
        const el = h('div.stop' + (i === cur ? '.on' : ''), { style: { left: s[0] * 100 + '%', background: s[1] } });
        el.addEventListener('pointerdown', e => {
          e.stopPropagation(); cur = i; el.setPointerCapture(e.pointerId); render();
          const mv = ev => { const r = ge.getBoundingClientRect(); if (ev.clientY > r.bottom + 30 && st.length > 2) { st.splice(cur, 1); cur = 0; render(); el.releasePointerCapture(e.pointerId); return; } s[0] = clamp((ev.clientX - r.left) / r.width, 0, 1); render(); };
          const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
          el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
        });
        ge.append(el);
      });
      const s = st[cur];
      ctl.replaceChildren(h('div.prow', h('label', { text: 'Warna' }), colorSwatch(() => s[1], c => { s[1] = c; render(); }), h('label', { text: 'Lokasi', style: { width: 'auto' } }), numField({ value: Math.round(s[0] * 100), min: 0, max: 100, unit: '%', onChange: v => { s[0] = v / 100; render(); } })),
        sliderRow({ label: 'Opacity', value: Math.round(s[2] * 100), min: 0, max: 100, unit: '%', onInput: v => { s[2] = v / 100; render(); } }),
        h('div.note', { text: 'Klik pada bilah untuk menambah stop, seret ke bawah untuk menghapus.' }));
    };
    ge.addEventListener('pointerdown', e => { const r = ge.getBoundingClientRect(), p = clamp((e.clientX - r.left) / r.width, 0, 1); const [c] = [resolveStops(st)].map(x => x); void c; st.push([p, rgbToHex(App.fg), 1]); cur = st.length - 1; render(); });
    for (const g of GRADIENT_PRESETS) {
      const b = h('button.btn', { type: 'button', style: { height: '30px', padding: 0, background: `${stopsCss(resolveStops(g.stops, App.fg, App.bg))}, repeating-conic-gradient(#fff 0 25%, #ccc 0 50%) 50% / 8px 8px` }, 'data-tip': g.name });
      b.onclick = () => { st = resolveStops(g.stops, App.fg, App.bg).map(([p, c, a]) => [p, rgbToHex(c), a]); cur = 0; render(); }; presets.append(b);
    }
    render();
    let result = null;
    dialog({ title: 'Gradient Editor', width: 520, body: h('div', h('div.sect', { text: 'Preset' }), presets, ge, ctl), buttons: ['grow', { label: 'Batal' }, { label: 'OK', primary: true, run: () => { result = st.map(s => [...s]); } }], onClose: () => res(result) });
  });
}
App.editGradient = editGradient;

// ── Fill / Stroke / Modify ───────────────────────────────────────────────
export function fillDialog() {
  if (!D()) return;
  const s = { use: 'fg', color: '#808080', mode: 'normal', opacity: 100, preserve: false, pattern: 0 };
  const colorRow = h('div.prow', h('label', { text: 'Warna' }), colorSwatch(() => s.color, c => { s.color = c; })); colorRow.style.display = 'none';
  dialog({
    title: 'Fill', width: 400, body: h('div',
      h('div.prow', h('label', { text: 'Isi' }), select([['fg', 'Foreground Color'], ['bg', 'Background Color'], ['color', 'Color…'], ['content', 'Content-Aware'], ['pattern', 'Pattern'], ['history', 'History'], ['black', 'Black'], ['gray', '50% Gray'], ['white', 'White']], s.use, v => { s.use = v; colorRow.style.display = v === 'color' ? '' : 'none'; })), colorRow,
      h('div.sect', { text: 'Blending' }), h('div.prow', h('label', { text: 'Mode' }), select(blendOpts().filter(b => !b || ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color', 'luminosity', 'difference', 'soft-light', 'hard-light', 'hue', 'saturation', 'color-burn', 'color-dodge', 'exclusion'].includes(b[0])), s.mode, v => { s.mode = v; })),
      sliderRow({ label: 'Opacity', value: 100, min: 1, max: 100, unit: '%', onInput: v => { s.opacity = v; } }), check('Preserve Transparency', false, v => { s.preserve = v; })),
    buttons: ['grow', { label: 'Batal' }, { label: 'OK', primary: true, run: () => { ops.fill(s); } }],
  });
}
export function strokeDialog() {
  if (!D()?.selection) { toast('Buat seleksi terlebih dahulu'); return; }
  const s = { width: 3, color: rgbToHex(App.fg), location: 'center', mode: 'normal', opacity: 100 };
  dialog({
    title: 'Stroke', width: 400, body: h('div', h('div.prow', h('label', { text: 'Lebar' }), numField({ value: 3, min: 1, max: 250, unit: 'px', onChange: v => { s.width = v; } })), h('div.prow', h('label', { text: 'Warna' }), colorSwatch(() => s.color, c => { s.color = c; })),
      h('div.prow', h('label', { text: 'Lokasi' }), select([['inside', 'Inside'], ['center', 'Center'], ['outside', 'Outside']], 'center', v => { s.location = v; })),
      h('div.prow', h('label', { text: 'Mode' }), select(blendOpts().slice(1, 12), 'normal', v => { s.mode = v; })), sliderRow({ label: 'Opacity', value: 100, min: 1, max: 100, unit: '%', onInput: v => { s.opacity = v; } })),
    buttons: ['grow', { label: 'Batal' }, { label: 'OK', primary: true, run: () => { ops.stroke(s); } }],
  });
}
export function modifyDialog(kind) {
  if (!D()?.selection) { toast('Tidak ada seleksi'); return; }
  const lab = { feather: 'Feather Radius', expand: 'Expand By', contract: 'Contract By', border: 'Width', smooth: 'Sample Radius' }[kind];
  let v = kind === 'border' ? 10 : kind === 'feather' ? 5 : 4;
  dialog({ title: { feather: 'Feather Selection', expand: 'Expand Selection', contract: 'Contract Selection', border: 'Border Selection', smooth: 'Smooth Selection' }[kind], width: 360, body: h('div.prow', h('label', { text: lab }), numField({ value: v, min: kind === 'feather' ? .2 : 1, max: 500, step: kind === 'feather' ? .1 : 1, unit: 'px', onChange: x => { v = x; } })), buttons: ['grow', { label: 'Batal' }, { label: 'OK', primary: true, run: () => ops.modifySel(kind, v) }] });
}

// ── Color Range ──────────────────────────────────────────────────────────
export function colorRangeDialog() {
  const d = D(); if (!d) return;
  const src = d._comp, k = Math.min(1, 360 / Math.max(d.w, d.h));
  const small = canvas(d.w * k, d.h * k); ctx2d(small).drawImage(src, 0, 0, small.width, small.height);
  const simg = ctx2d(small).getImageData(0, 0, small.width, small.height);
  const s = { preset: 'sampled', samples: [{ ...App.fg }], fuzz: 40, invert: false };
  const pv = canvas(small.width, small.height); pv.style.cursor = 'crosshair';
  const draw = () => { const m = ops.colorRangeMask(simg, s), img = ctx2d(pv).createImageData(pv.width, pv.height); for (let i = 0; i < m.length; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = m[i]; img.data[i * 4 + 3] = 255; } ctx2d(pv).putImageData(img, 0, 0); };
  pv.addEventListener('pointerdown', e => {
    const r = pv.getBoundingClientRect(), x = Math.floor((e.clientX - r.left) / r.width * pv.width), y = Math.floor((e.clientY - r.top) / r.height * pv.height), i = (y * pv.width + x) * 4;
    const c = { r: simg.data[i], g: simg.data[i + 1], b: simg.data[i + 2] };
    if (e.shiftKey) s.samples.push(c); else if (e.altKey) s.samples = s.samples.filter(q => Math.hypot(q.r - c.r, q.g - c.g, q.b - c.b) > 20); else s.samples = [c];
    draw();
  });
  const fuzz = sliderRow({ label: 'Fuzziness', value: 40, min: 0, max: 200, onInput: v => { s.fuzz = v; draw(); } });
  draw();
  dialog({
    title: 'Color Range', width: 460, body: h('div', h('div.prow', h('label', { text: 'Select' }), select([['sampled', 'Sampled Colors'], ['reds', 'Reds'], ['yellows', 'Yellows'], ['greens', 'Greens'], ['cyans', 'Cyans'], ['blues', 'Blues'], ['magentas', 'Magentas'], ['highlights', 'Highlights'], ['midtones', 'Midtones'], ['shadows', 'Shadows'], ['skin', 'Skin Tones']], 'sampled', v => { s.preset = v; draw(); })), fuzz,
      h('div', { style: { display: 'grid', placeItems: 'center', background: '#111', borderRadius: '8px', padding: '6px' } }, pv), h('div.note', { style: { marginTop: '6px' }, text: 'Klik pratinjau untuk sampel warna · Shift = tambah · Alt = kurangi' }), check('Invert', false, v => { s.invert = v; draw(); })),
    buttons: ['grow', { label: 'Batal' }, { label: 'OK', primary: true, run: () => { const full = ctx2d(src).getImageData(0, 0, d.w, d.h); ops.setSel(Selection.fromAlpha(d.w, d.h, ops.colorRangeMask(full, s)), 'Color Range'); } }],
  });
}

// ── Export As / Save As ──────────────────────────────────────────────────
export function exportAsDialog() {
  const d = D(); if (!d) return;
  const s = { fmt: 'png', q: 90, scale: 100, w: d.w, h: d.h, transparent: true };
  const pvBox = h('div.preview'), info = h('div.note');
  let blob = null;
  const run = debounce(async () => {
    const c = exportCanvas(d, { w: s.w, h: s.h, bg: s.fmt === 'jpg' || !s.transparent ? '#ffffff' : null });
    blob = await canvasToBlob(c, { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[s.fmt], s.q / 100);
    const img = h('img', { src: URL.createObjectURL(blob), style: { maxWidth: '100%', maxHeight: '100%' } });
    pvBox.replaceChildren(img); info.textContent = `${s.fmt.toUpperCase()} · ${s.w} × ${s.h} px · ${fmtBytes(blob.size)}`;
  }, 250);
  const qRow = sliderRow({ label: 'Kualitas', value: 90, min: 1, max: 100, unit: '%', onInput: v => { s.q = v; run(); } });
  const wF = numField({ label: 'W', value: s.w, min: 1, max: 30000, unit: 'px', onChange: v => { s.w = v; s.h = Math.round(v * d.h / d.w); hF.set(s.h); run(); } });
  const hF = numField({ label: 'H', value: s.h, min: 1, max: 30000, unit: 'px', onChange: v => { s.h = v; s.w = Math.round(v * d.w / d.h); wF.set(s.w); run(); } });
  const syncFmt = () => { qRow.style.display = s.fmt === 'png' ? 'none' : ''; };
  const side = h('div.side', h('div.sect', { text: 'Pengaturan File' }), h('div.prow', h('label', { text: 'Format' }), select([['png', 'PNG'], ['jpg', 'JPEG'], ['webp', 'WebP']], 'png', v => { s.fmt = v; syncFmt(); run(); })), qRow, check('Transparansi', true, v => { s.transparent = v; run(); }),
    h('div.sect', { text: 'Ukuran Gambar' }), h('div.prow', wF), h('div.prow', hF), h('div.prow', h('label', { text: 'Skala' }), select([[25, '25%'], [50, '50%'], [75, '75%'], [100, '100%'], [150, '150%'], [200, '200%'], [300, '300%'], [400, '400%']], 100, v => { s.w = Math.round(d.w * v / 100); s.h = Math.round(d.h * v / 100); wF.set(s.w); hF.set(s.h); run(); })),
    h('div.sect', { text: 'Ukuran Kanvas' }), h('div.note', { text: `${d.w} × ${d.h} px` }), h('div', { style: { height: '12px' } }), info);
  syncFmt(); run();
  dialog({ title: 'Export As', cls: '.xwide', body: h('div.split', pvBox, side), buttons: ['grow', { label: 'Batal' }, { label: 'Ekspor', primary: true, run: async () => { if (!blob) return false; download(blob, `${d.name}.${s.fmt}`); toast('Diekspor', 'ok'); } }] });
}
export function saveAsDialog() {
  const d = D(); if (!d) return;
  const name = h('input.inp', { value: d.name, style: { width: '100%' } }); name.addEventListener('keydown', e => e.stopPropagation());
  let fmt = 'browser';
  const opts = [['browser', 'Amatu Photo — simpan di browser (Recent)'], ['amp', 'Amatu Photo Project (.amp)'], ['psd', 'Photoshop Document (.psd)'], ['png', 'PNG (.png)'], ['jpg', 'JPEG (.jpg)'], ['webp', 'WebP (.webp)']];
  dialog({
    title: 'Save As', width: 460, body: h('div', field('Nama berkas', name), h('div', { style: { height: '10px' } }), field('Format', select(opts, fmt, v => { fmt = v; }))),
    buttons: ['grow', { label: 'Batal' }, { label: 'Simpan', primary: true, run: async () => {
      d.name = name.value || d.name; App.emit('docs');
      if (fmt === 'browser') await saveToBrowser(d); else if (fmt === 'amp') { await downloadProject(d); d.dirty = false; d.emit('dirty'); } else if (fmt === 'psd') await exportPSD(d);
      else { const c = exportCanvas(d, { bg: fmt === 'jpg' ? '#ffffff' : null }); download(await canvasToBlob(c, { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[fmt], .92), `${d.name}.${fmt}`); }
    } }],
  });
}

// ── New Layer / Warp Text / misc ─────────────────────────────────────────
export function newLayerDialog() {
  const d = D(); if (!d) return;
  const s = { name: `Layer ${d.layerCounter + 1}`, clip: false, color: null, mode: 'normal', opacity: 100 };
  const name = h('input.inp', { value: s.name, style: { width: '100%' } }); name.addEventListener('keydown', e => e.stopPropagation());
  dialog({
    title: 'New Layer', width: 420, body: h('div', field('Nama', name), h('div', { style: { height: '8px' } }), check('Use Previous Layer to Create Clipping Mask', false, v => { s.clip = v; }),
      h('div.prow', { style: { marginTop: '8px' } }, h('label', { text: 'Warna' }), select([['', 'None'], ['red', 'Merah'], ['orange', 'Oranye'], ['yellow', 'Kuning'], ['green', 'Hijau'], ['blue', 'Biru'], ['violet', 'Ungu'], ['gray', 'Abu-abu']], '', v => { s.color = v || null; })),
      h('div.prow', h('label', { text: 'Mode' }), select(blendOpts(), 'normal', v => { s.mode = v; })), sliderRow({ label: 'Opacity', value: 100, min: 0, max: 100, unit: '%', onInput: v => { s.opacity = v; } })),
    buttons: ['grow', { label: 'Batal' }, { label: 'OK', primary: true, run: () => { const L = d.newRasterLayer(name.value || s.name); L.clip = s.clip && !!d.below(L); L.color = s.color; L.blend = s.mode; L.opacity = s.opacity / 100; d.layerCounter++; App.emit('layers'); invalidate(); commit('Layer Baru', 'add_box'); } }],
  });
}
export function warpTextDialog() {
  const L = D()?.active; if (L?.type !== 'text') { toast('Pilih layer teks'); return; }
  const t = L.text, before = t.warp ? { ...t.warp } : null; t.warp ||= { style: 'arc', bend: 50 };
  const upd = () => { L._cache = null; L.touch(); invalidate(); };
  let ok = false; upd();
  dialog({
    title: 'Warp Text', width: 380, body: h('div', h('div.prow', h('label', { text: 'Style' }), select([['none', 'None'], ['arc', 'Arc'], ['arch', 'Arch'], ['bulge', 'Bulge'], ['flag', 'Flag'], ['wave', 'Wave'], ['rise', 'Rise']], t.warp.style, v => { t.warp.style = v; upd(); })), sliderRow({ label: 'Bend', value: t.warp.bend, min: -100, max: 100, unit: '%', onInput: v => { t.warp.bend = v; upd(); } })),
    buttons: ['grow', { label: 'Batal' }, { label: 'OK', primary: true, run: () => { ok = true; commit('Warp Text', 'text_rotation_none'); } }],
    onClose: () => { if (!ok) { t.warp = before; upd(); } },
  });
}
export async function rotateArbitraryDialog() {
  let a = 15, cw = true;
  dialog({ title: 'Rotate Canvas', width: 360, body: h('div', h('div.prow', h('label', { text: 'Sudut' }), numField({ value: a, min: -359.99, max: 359.99, step: .01, unit: '°', onChange: v => { a = v; } })), h('div.prow', h('label', { text: '' }), select([['cw', '° Searah jarum jam'], ['ccw', '° Berlawanan jarum jam']], 'cw', v => { cw = v === 'cw'; }))), buttons: ['grow', { label: 'Batal' }, { label: 'OK', primary: true, run: () => ops.rotateCanvas(cw ? a : -a) }] });
}

// ── Camera Raw ───────────────────────────────────────────────────────────
export async function cameraRawDialog() {
  const t = await editTarget({ allowMask: false }); if (!t) return;
  const src = t.canvas, k = Math.min(1, 1100 / Math.max(src.width, src.height));
  const small = canvas(src.width * k, src.height * k); ctx2d(small).drawImage(src, 0, 0, small.width, small.height);
  const base = ctx2d(small).getImageData(0, 0, small.width, small.height);
  const view = canvas(small.width, small.height); ctx2d(view).putImageData(base, 0, 0);
  const p = { ...CAMRAW_DEFAULTS };
  let showBefore = false;
  const render = debounce(() => { const img = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height); if (!showBefore) cameraRaw(img, p); ctx2d(view).putImageData(img, 0, 0); }, 60);
  const sliders = [];
  const S = (label, key, min, max, track, step = 1) => { const r = sliderRow({ label, value: p[key], min, max, step, track, onInput: v => { p[key] = v; render(); } }); r.dataset.def = 0; sliders.push([r, key]); return r; };
  const side = h('div.side',
    h('div.sect', { text: 'White Balance' }), S('Temperature', 'temp', -100, 100, 'linear-gradient(90deg,#3d7bff,#ccc,#ffb13d)'), S('Tint', 'tint', -100, 100, 'linear-gradient(90deg,#3cd65a,#ccc,#e24cd8)'),
    h('div.sect', { text: 'Tone' }), S('Exposure', 'exposure', -5, 5, 'linear-gradient(90deg,#000,#fff)', .05), S('Contrast', 'contrast', -100, 100), S('Highlights', 'highlights', -100, 100), S('Shadows', 'shadows', -100, 100), S('Whites', 'whites', -100, 100), S('Blacks', 'blacks', -100, 100),
    h('div.sect', { text: 'Presence' }), S('Texture', 'texture', -100, 100), S('Clarity', 'clarity', -100, 100), S('Dehaze', 'dehaze', -100, 100), S('Vibrance', 'vibrance', -100, 100), S('Saturation', 'saturation', -100, 100, 'linear-gradient(90deg,#888,#ff3b3b)'),
    h('div.sect', { text: 'Detail & Effects' }), S('Sharpening', 'sharpen', 0, 150), S('Vignette', 'vignette', -100, 100), S('Grain', 'grain', 0, 100));
  const auto = h('button.btn.sm', { type: 'button' }, icon('auto_fix_high'), 'Auto');
  auto.onclick = () => {
    const d = base.data; let sum = 0, n = 0, r = 0, b = 0; for (let i = 0; i < d.length; i += 16) { sum += (d[i] + d[i + 1] + d[i + 2]) / 3; r += d[i]; b += d[i + 2]; n++; }
    const mean = sum / n; Object.assign(p, CAMRAW_DEFAULTS, { exposure: round(clamp(Math.log2(118 / Math.max(10, mean)), -2, 2), 2), contrast: 12, highlights: -30, shadows: 28, vibrance: 18, clarity: 8, temp: round(clamp((b - r) / n / 2, -30, 30), 0) });
    sliders.forEach(([row, key]) => row.set(p[key])); render();
  };
  const before = h('button.btn.sm', { type: 'button', 'data-tip': 'Tahan untuk melihat sebelum' }, icon('compare'), 'Sebelum');
  before.onpointerdown = () => { showBefore = true; render(); }; before.onpointerup = before.onpointerleave = () => { if (showBefore) { showBefore = false; render(); } };
  const pvBox = h('div.preview', view); view.style.maxWidth = '100%'; view.style.maxHeight = '100%';
  dialog({
    title: 'Camera Raw Filter', cls: '.xwide', body: h('div.split', pvBox, h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0 } }, h('div.prow', auto, before, h('button.btn.sm', { type: 'button', onclick: () => { Object.assign(p, CAMRAW_DEFAULTS); sliders.forEach(([r, k2]) => r.set(p[k2])); render(); } }, 'Reset')), side)),
    buttons: ['grow', { label: 'Batal' }, { label: 'OK', primary: true, run: () => { ops.applyPixels('Camera Raw Filter', img => cameraRaw(img, p), { icon: 'camera', allowMask: false }); } }],
  });
}

// ── Preferences / shortcuts / about ──────────────────────────────────────
export const THEMES = [['glass-dark', 'Liquid Glass Gelap'], ['glass-light', 'Liquid Glass Terang'], ['glass-aurora', 'Liquid Glass Aurora'], ['glass-sunset', 'Liquid Glass Senja'], ['classic-darkest', 'Klasik Tergelap'], ['classic-dark', 'Klasik Gelap'], ['classic-medium', 'Klasik Sedang'], ['classic-light', 'Klasik Terang']];
export function prefsDialog(section = 'interface') {
  const P = App.prefs, upd = () => { savePrefs(); App.applyPrefs(); };
  const pages = {
    interface: ['Antarmuka', () => [h('div.prow', h('label', { text: 'Tema' }), select(THEMES, P.theme, v => { P.theme = v; upd(); })), check('Efek liquid glass (blur & refraksi)', P.glass, v => { P.glass = v; upd(); }), check('Tampilkan tooltip', P.showTips, v => { P.showTips = v; upd(); }), check('Animasi latar', !P.noMotion, v => { P.noMotion = !v; upd(); })]],
    tools: ['Tools', () => [h('div.prow', h('label', { text: 'Kursor brush' }), select([['normal', 'Ujung brush normal'], ['precise', 'Presisi (crosshair)']], P.brushCursor, v => { P.brushCursor = v; upd(); })), check('Zoom dengan roda gulir', P.zoomWheel, v => { P.zoomWheel = v; upd(); })]],
    units: ['Unit & Penggaris', () => [h('div.prow', h('label', { text: 'Penggaris' }), select([['px', 'Piksel'], ['in', 'Inci'], ['cm', 'Sentimeter'], ['mm', 'Milimeter'], ['%', 'Persen']], P.units, v => { P.units = v; upd(); }))]],
    guides: ['Guides & Grid', () => [h('div.prow', h('label', { text: 'Warna guide' }), colorSwatch(() => P.guideColor, c => { P.guideColor = c; upd(); })), h('div.prow', h('label', { text: 'Warna grid' }), colorSwatch(() => P.gridColor, c => { P.gridColor = c; upd(); })), h('div.prow', h('label', { text: 'Gridline tiap' }), numField({ value: P.gridSize, min: 2, max: 2000, unit: 'px', onChange: v => { P.gridSize = v; upd(); } })), h('div.prow', h('label', { text: 'Subdivisi' }), numField({ value: P.gridSub, min: 1, max: 20, onChange: v => { P.gridSub = v; upd(); } })), check('Pixel grid (zoom ≥ 1000%)', P.pixelGrid, v => { P.pixelGrid = v; upd(); })]],
    transparency: ['Transparansi', () => [h('div.prow', h('label', { text: 'Ukuran kotak' }), select([['none', 'Tidak ada'], ['small', 'Kecil'], ['medium', 'Sedang'], ['large', 'Besar']], P.checker, v => { P.checker = v; upd(); }))]],
  };
  const nav = h('div.ls-nav'), panel = h('div');
  const show = k => { section = k; nav.querySelectorAll('.it').forEach(e => e.classList.toggle('on', e.dataset.k === k)); panel.replaceChildren(h('div.sect', { text: pages[k][0] }), ...pages[k][1]()); };
  for (const [k, [n]] of Object.entries(pages)) { const it = h('div.it', { 'data-k': k, text: n }); it.onclick = () => show(k); nav.append(it); }
  show(section);
  dialog({ title: 'Preferensi', width: 640, body: h('div', { style: { display: 'grid', gridTemplateColumns: '170px 1fr', gap: '16px', minHeight: '300px' } }, nav, panel), buttons: ['grow', { label: 'Selesai', primary: true }] });
}
export function shortcutsDialog(commands) {
  const q = h('input.inp', { placeholder: 'Cari perintah…', style: { width: '100%', marginBottom: '10px' } }); q.addEventListener('keydown', e => e.stopPropagation());
  const list = h('div', { style: { maxHeight: '55vh', overflow: 'auto' } });
  const render = () => { const s = q.value.toLowerCase(); list.replaceChildren(...commands.filter(c => c.key && (!s || c.label.toLowerCase().includes(s))).map(c => h('div', { style: { display: 'flex', justifyContent: 'space-between', padding: '5px 4px', borderBottom: '1px solid var(--line-2)' } }, h('span', { text: `${c.menu ? c.menu + ' › ' : ''}${c.label}` }), h('kbd', { text: fmtKey(c.key) })))); };
  q.oninput = render; render();
  dialog({ title: 'Pintasan Keyboard', width: 560, body: h('div', q, list), buttons: ['grow', { label: 'Tutup', primary: true }] });
}
export function aboutDialog() {
  const logo = h('div', { style: { width: '64px', height: '64px' }, html: App.icons.logo });
  dialog({ title: 'Tentang Amatu Photo', width: 440, body: h('div', { style: { display: 'grid', gap: '10px', justifyItems: 'center', textAlign: 'center', padding: '10px 0' } }, logo, h('b', { style: { fontSize: '16px' }, text: 'Amatu Photo' }), h('span.note', { text: 'Versi 1.0 · Editor foto berbasis layer di browser' }), h('p', { style: { color: 'var(--text-2)', lineHeight: 1.5, margin: 0 }, text: 'Layer, mask, blend mode, adjustment & fill layer, layer style, 70+ tool, filter, Camera Raw, Liquify, Content-Aware, Pen & Shape, teks, impor/ekspor PSD. Semua diproses lokal di perangkat Anda.' })), buttons: ['grow', { label: 'Tutup', primary: true }] });
}
export function duplicateDocDialog() {
  const d = D(); if (!d) return;
  import('../io.js').then(async ({ serializeDoc, deserializeDoc }) => { const o = await serializeDoc(d); const c = await deserializeDoc(o); c.name = d.name + ' copy'; App.addDoc(c); c.history.push('Duplikat', 'content_copy'); });
}
export { popover, rgbCss, hexToRgb };
