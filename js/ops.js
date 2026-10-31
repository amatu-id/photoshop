// Document operations (no UI): layers, masks, selection, canvas geometry, clipboard, pixels

import { App, commit, invalidate, toast } from './state.js';
import { canvas, ctx2d, cloneCanvas, clamp, rectClip } from './util.js';
import { Doc, Layer, makeMask } from './doc.js';
import { Selection, colorRegion } from './selection.js';
import { contentSurface, flattenDoc, compositeLayers, layerSurface } from './composite.js';
import { applyAdjustment, defaultsFor } from './adjust.js';
import { FILTERS } from './filters.js';
import { rgbCss, luma, hexToRgb } from './color.js';
import { moveLayerBy } from './tools/select.js';
import { editTarget, touchTarget } from './tools/base.js';
import { inpaint } from './inpaint.js';
import { gaussianImageData } from './blur.js';
import { rebuildShape } from './tools/vector.js';

const D = () => App.doc;
const changed = () => { App.emit('layers'); invalidate(); };

// ── Pixel application with selection masking ─────────────────────────────
export async function applyPixels(label, fn, { icon = 'tune', allowMask = true } = {}) {
  const t = await editTarget({ allowMask }); if (!t) return false;
  const d = D(), x = ctx2d(t.canvas), W = t.canvas.width, H = t.canvas.height;
  const sel = d.selection && !d.selection.empty ? d.selection : null;
  let r = { x: 0, y: 0, w: W, h: H };
  if (sel) { const b = sel.bounds(); r = rectClip({ x: b.x - t.x, y: b.y - t.y, w: b.w, h: b.h }, W, H); if (!r) { toast('Seleksi berada di luar layer'); return false; } }
  const img = x.getImageData(r.x, r.y, r.w, r.h), orig = sel ? new Uint8ClampedArray(img.data) : null;
  let out = await fn(img, t, r) || img;
  if (sel) {
    const mc = canvas(r.w, r.h); ctx2d(mc).drawImage(sel.canvas, -(r.x + t.x), -(r.y + t.y));
    const m = ctx2d(mc).getImageData(0, 0, r.w, r.h).data, o = out.data;
    for (let i = 0; i < o.length; i += 4) { const a = m[i + 3] / 255; if (a >= 1) continue; for (let c = 0; c < 4; c++) o[i + c] = orig[i + c] + (o[i + c] - orig[i + c]) * a; }
  }
  x.putImageData(out, r.x, r.y);
  touchTarget(t); invalidate(); commit(label, icon);
  return true;
}
export const filterEnv = () => ({ fg: App.fg, bg: App.bg, doc: D() });
export function runFilter(id, params) {
  const F = FILTERS[id];
  App.lastFilter = { id, params };
  App.emit('lastfilter');
  return applyPixels(F.name.replace('…', ''), img => F.apply(img, params, filterEnv()), { icon: 'filter' });
}
export function runAdjust(kind, params, name) {
  return applyPixels(name, img => applyAdjustment(kind, params, img), { icon: 'tune' });
}

// ── Layers ───────────────────────────────────────────────────────────────
export function rasterize(L) {
  const d = D();
  if (L.type === 'raster') return;
  const s = contentSurface(L, d);
  const c = canvas(d.w, d.h); if (s) ctx2d(c).drawImage(s.canvas, s.x, s.y);
  L.type = 'raster'; L.canvas = c; L.x = 0; L.y = 0; L.text = null; L.shape = null; L.fill = null; L._cache = null; L.touch();
  changed();
}
App.rasterize = rasterize;
export function convertBackground(L) {
  if (!L.isBackground) return;
  L.isBackground = false; L.locks = { pixels: false, position: false, alpha: false, all: false };
  if (L.name === 'Background') L.name = 'Layer 0';
  App.emit('layers');
}
App.convertBackground = convertBackground;
export function newLayer(name) { const d = D(); const L = d.newRasterLayer(name); changed(); commit('Layer Baru', 'add_box'); return L; }
export function newGroup() {
  const d = D(), G = new Layer({ type: 'group', name: d.nextName('Group') }); d.insertAbove(G); changed(); commit('Grup Baru', 'folder'); return G;
}
export function addLayerFromCanvas(c, name, x = 0, y = 0, { commitLabel = 'Tempel', ref } = {}) {
  const d = D(), L = new Layer({ name: name || d.nextName() });
  L.canvas = c; L.x = x; L.y = y; d.insertAbove(L, ref); changed(); if (commitLabel) commit(commitLabel, 'content_paste'); return L;
}
export function duplicateLayers() {
  const d = D(), layers = d.selectedLayers(); if (!layers.length) return;
  const clones = [];
  for (const L of layers) {
    const C = cloneLayer(L); C.name = `${L.name} copy`; C.isBackground = false; if (L.isBackground) C.locks = { pixels: false, position: false, alpha: false, all: false };
    const p = d.parentOf(L); p.children.splice(p.children.indexOf(L) + 1, 0, C); clones.push(C);
  }
  d.selectedIds = new Set(clones.map(c => c.id)); d.activeId = clones[clones.length - 1].id;
  changed(); commit('Duplikat Layer', 'content_copy');
}
App.duplicateLayers = duplicateLayers;
export function cloneLayer(L) {
  const C = new Layer({ ...L, id: undefined, locks: { ...L.locks }, children: L.children ? L.children.map(cloneLayer) : null });
  C.id = 'L' + Math.random().toString(36).slice(2, 10);
  if (L.canvas) C.canvas = cloneCanvas(L.canvas);
  if (L.mask) C.mask = { ...L.mask, canvas: cloneCanvas(L.mask.canvas), _alpha: null, _snapCanvas: null, rev: 1 };
  for (const k of ['styles', 'text', 'shape', 'adjust']) C[k] = L[k] ? structuredClone(L[k]) : null;
  C.fill = L.fill ? { ...structuredClone({ ...L.fill, pattern: null }), pattern: L.fill.pattern } : null;
  C._cache = null; C._styled = null; C._snapCanvas = null;
  return C;
}
export function deleteLayers() {
  const d = D(); const layers = d.selectedLayers(); if (!layers.length) return;
  if (d.flat().length - layers.length < 0) return;
  for (const L of layers) d.remove(L);
  if (!d.flat().length) d.newRasterLayer('Layer 1');
  changed(); commit('Hapus Layer', 'delete');
}
export function layerViaCopy(cut = false) {
  const d = D(), L = d.active;
  if (!L || L.type !== 'raster') { duplicateLayers(); return; }
  const sel = d.selection;
  if (!sel || sel.empty) { duplicateLayers(); return; }
  const c = canvas(d.w, d.h), x = ctx2d(c); x.drawImage(L.canvas, L.x, L.y); x.globalCompositeOperation = 'destination-in'; x.drawImage(sel.canvas, 0, 0);
  if (cut) {
    if (L.locks.all || L.locks.pixels) { toast('Layer terkunci'); return; }
    const lx = ctx2d(L.canvas); lx.save(); lx.globalCompositeOperation = 'destination-out'; lx.drawImage(sel.canvas, -L.x, -L.y); lx.restore();
    if (L.isBackground) { lx.save(); lx.globalCompositeOperation = 'destination-over'; lx.fillStyle = rgbCss(App.bg); lx.fillRect(0, 0, L.w, L.h); lx.restore(); }
    L.touch();
  }
  addLayerFromCanvas(c, d.nextName(), 0, 0, { commitLabel: cut ? 'Layer via Cut' : 'Layer via Copy', ref: L });
}
export function groupLayers() {
  const d = D(), layers = d.selectedLayers().filter(l => !l.isBackground); if (!layers.length) return;
  const top = layers[layers.length - 1], p = d.parentOf(top);
  const G = new Layer({ type: 'group', name: d.nextName('Group') });
  p.children.splice(p.children.indexOf(top) + 1, 0, G);
  for (const L of layers) { const lp = d.parentOf(L); lp.children.splice(lp.children.indexOf(L), 1); G.children.push(L); }
  d.setActive(G.id); changed(); commit('Grup Layer', 'folder');
}
export function ungroup() {
  const d = D(), G = d.active; if (!G?.isGroup) return;
  const p = d.parentOf(G), i = p.children.indexOf(G);
  p.children.splice(i, 1, ...G.children);
  d.selectedIds = new Set(G.children.map(c => c.id)); d.activeId = G.children[G.children.length - 1]?.id || p.children[0]?.id;
  changed(); commit('Pisahkan Grup', 'folder_off');
}
// Render a set of layers (in order) into a doc-sized canvas, respecting their blending
function renderStack(layers) { return compositeLayers(D(), layers); }
export function mergeDown() {
  const d = D(), L = d.active; if (!L) return;
  const sel = d.selectedLayers();
  if (sel.length > 1) return mergeSelected(sel);
  const B = d.below(L); if (!B) { toast('Tidak ada layer di bawahnya'); return; }
  if (!B.visible) { toast('Layer di bawahnya tersembunyi'); return; }
  if (B.type !== 'raster' && !B.isGroup) rasterize(B);
  const c = renderStack([B, L]);
  B.type = 'raster'; B.canvas = c; B.x = 0; B.y = 0; B.mask = null; B.styles = null; B.opacity = B.isBackground ? 1 : B.opacity; B.blend = B.isGroup ? 'normal' : B.blend;
  if (B.isGroup) { B.type = 'raster'; B.children = null; }
  B.fillOpacity = 1; B._cache = null; B.touch();
  if (!B.isBackground) { B.opacity = 1; B.blend = 'normal'; }
  d.remove(L); d.setActive(B.id); changed(); commit('Merge Down', 'call_merge');
}
function mergeSelected(layers) {
  const d = D(), c = renderStack(layers.filter(l => l.visible));
  const top = layers[layers.length - 1], p = d.parentOf(top);
  const M = new Layer({ name: top.name }); M.canvas = c;
  p.children.splice(p.children.indexOf(top) + 1, 0, M);
  layers.forEach(l => d.remove(l)); d.setActive(M.id); changed(); commit('Merge Layers', 'call_merge');
}
export function mergeVisible() {
  const d = D(); const c = flattenDoc(d);
  const vis = d.root.children.filter(l => l.visible);
  const L = new Layer({ name: vis.find(l => l.isBackground) ? 'Background' : 'Merged', isBackground: !!vis.find(l => l.isBackground) });
  if (L.isBackground) L.locks = { pixels: false, position: true, alpha: true, all: false };
  L.canvas = c;
  const idx = Math.min(...vis.map(v => d.root.children.indexOf(v)));
  d.root.children = d.root.children.filter(l => !l.visible);
  d.root.children.splice(Math.max(0, idx), 0, L);
  d.setActive(L.id); changed(); commit('Merge Visible', 'call_merge');
}
export function flatten() {
  const d = D(); const c = canvas(d.w, d.h), x = ctx2d(c);
  x.fillStyle = '#fff'; x.fillRect(0, 0, d.w, d.h); x.drawImage(flattenDoc(d), 0, 0);
  const L = new Layer({ name: 'Background', isBackground: true, locks: { position: true, alpha: true } }); L.canvas = c;
  d.root.children = [L]; d.setActive(L.id); changed(); commit('Flatten Image', 'layers_clear');
}
export function stampVisible() { const d = D(); addLayerFromCanvas(flattenDoc(d), d.nextName(), 0, 0, { commitLabel: 'Stamp Visible' }); }
export function toggleClip() {
  const d = D(), layers = d.selectedLayers(); if (!layers.length) return;
  const on = !layers[0].clip;
  for (const L of layers) { if (on && !d.below(L)) continue; L.clip = on; }
  changed(); commit(on ? 'Create Clipping Mask' : 'Release Clipping Mask', 'subdirectory_arrow_right');
}
export function arrange(how) {
  const d = D(), L = d.active; if (!L || L.isBackground) return;
  const p = d.parentOf(L), arr = p.children, i = arr.indexOf(L);
  const minI = arr[0]?.isBackground ? 1 : 0;
  let j = { front: arr.length - 1, forward: i + 1, backward: i - 1, back: minI }[how];
  j = clamp(j, minI, arr.length - 1); if (j === i) return;
  arr.splice(i, 1); arr.splice(j, 0, L); changed(); commit('Atur Layer', 'swap_vert');
}
export function reverseLayers() { const d = D(), sel = d.selectedLayers(); const p = d.parentOf(sel[0]); const idx = sel.map(l => p.children.indexOf(l)).sort((a, b) => a - b); const rev = [...sel].reverse(); idx.forEach((ix, k) => { p.children[ix] = rev[k]; }); changed(); commit('Reverse', 'swap_vert'); }

// Alignment of selected layers to each other, or to the selection / canvas when one layer
export function align(how) {
  const d = D(); const layers = d.selectedLayers().filter(l => !l.locks.position && !l.isBackground);
  if (!layers.length) return;
  const bounds = layers.map(l => [l, App.transform.boundsOf(l)]).filter(([, b]) => b);
  if (!bounds.length) return;
  let ref;
  if (d.selection && !d.selection.empty) ref = d.selection.bounds();
  else if (bounds.length === 1) ref = { x: 0, y: 0, w: d.w, h: d.h };
  else { const xs = bounds.map(([, b]) => b); const x1 = Math.min(...xs.map(b => b.x)), y1 = Math.min(...xs.map(b => b.y)); ref = { x: x1, y: y1, w: Math.max(...xs.map(b => b.x + b.w)) - x1, h: Math.max(...xs.map(b => b.y + b.h)) - y1 }; }
  if (how.startsWith('dist')) {
    const axis = how === 'dist-h' ? 'x' : 'y', size = axis === 'x' ? 'w' : 'h';
    const sorted = bounds.sort((a, b) => (a[1][axis] + a[1][size] / 2) - (b[1][axis] + b[1][size] / 2));
    if (sorted.length < 3) return;
    const c0 = sorted[0][1][axis] + sorted[0][1][size] / 2, c1 = sorted[sorted.length - 1][1][axis] + sorted[sorted.length - 1][1][size] / 2;
    sorted.forEach(([L, b], i) => { const target = c0 + (c1 - c0) * i / (sorted.length - 1) - b[size] / 2; moveLayerBy(L, axis === 'x' ? Math.round(target - b.x) : 0, axis === 'y' ? Math.round(target - b.y) : 0); });
  } else for (const [L, b] of bounds) {
    let dx = 0, dy = 0;
    if (how === 'left') dx = ref.x - b.x; if (how === 'right') dx = ref.x + ref.w - b.x - b.w; if (how === 'hcenter') dx = ref.x + ref.w / 2 - b.x - b.w / 2;
    if (how === 'top') dy = ref.y - b.y; if (how === 'bottom') dy = ref.y + ref.h - b.y - b.h; if (how === 'vcenter') dy = ref.y + ref.h / 2 - b.y - b.h / 2;
    moveLayerBy(L, Math.round(dx), Math.round(dy));
  }
  changed(); commit('Align', 'align_horizontal_center');
}

// ── Masks ────────────────────────────────────────────────────────────────
export function addMask(kind = 'reveal') {
  const d = D(), L = d.active; if (!L) return;
  if (L.isBackground) convertBackground(L);
  if (L.mask) { toast('Layer sudah memiliki mask'); return; }
  const sel = d.selection && !d.selection.empty ? d.selection : null;
  const useSel = sel && (kind === 'reveal' || kind === 'hide');
  const m = makeMask(d.w, d.h, kind === 'reveal' ? !useSel : useSel ? true : false);
  if (useSel) {
    const x = ctx2d(m.canvas); x.fillStyle = kind === 'reveal' ? '#000' : '#fff'; x.fillRect(0, 0, d.w, d.h);
    const t = canvas(d.w, d.h), tx = ctx2d(t); tx.fillStyle = kind === 'reveal' ? '#fff' : '#000'; tx.fillRect(0, 0, d.w, d.h); tx.globalCompositeOperation = 'destination-in'; tx.drawImage(sel.canvas, 0, 0);
    x.drawImage(t, 0, 0); m.def = kind === 'reveal' ? 0 : 255;
    d.selection = null;
  }
  if (kind === 'hideAll') { m.def = 0; }
  L.mask = m; App.maskTarget = L.id; L.touch();
  changed(); commit('Tambah Layer Mask', 'vignette');
}
export function deleteMask(apply = false) {
  const d = D(), L = d.active; if (!L?.mask) return;
  if (apply && L.type === 'raster') {
    L.coverDoc(d.w, d.h);
    const x = ctx2d(L.canvas); x.save(); x.globalCompositeOperation = 'destination-in';
    const a = L.maskAlpha(), m = L.mask;
    if (m.def === 255) { const t = canvas(L.w, L.h), tx = ctx2d(t); tx.fillStyle = '#000'; tx.fillRect(0, 0, L.w, L.h); tx.clearRect(m.x - L.x, m.y - L.y, m.canvas.width, m.canvas.height); tx.drawImage(a, m.x - L.x, m.y - L.y); x.drawImage(t, 0, 0); }
    else x.drawImage(a, m.x - L.x, m.y - L.y);
    x.restore();
  }
  L.mask = null; App.maskTarget = null; L.touch(); changed(); commit(apply ? 'Terapkan Layer Mask' : 'Hapus Layer Mask', 'vignette');
}
export function toggleMask() { const L = D().active; if (!L?.mask) return; L.mask.enabled = !L.mask.enabled; L.mask.rev++; L.touch(); changed(); commit(L.mask.enabled ? 'Aktifkan Layer Mask' : 'Nonaktifkan Layer Mask', 'vignette'); }
export function invertMaskOrLayer() {
  const L = D().active;
  if (L?.mask && App.maskTarget === L.id) {
    const x = ctx2d(L.mask.canvas), img = x.getImageData(0, 0, L.mask.canvas.width, L.mask.canvas.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; }
    x.putImageData(img, 0, 0); L.mask.def = 255 - L.mask.def; L.mask.rev++; L.touch(); changed(); commit('Invert', 'invert_colors'); return;
  }
  runAdjust('invert', {}, 'Invert');
}

// ── Fill & adjustment layers ─────────────────────────────────────────────
export function newAdjustmentLayer(kind, name) {
  const d = D(), L = new Layer({ type: 'adjust', name: name || kindName(kind) + ' 1' });
  L.adjust = { kind, params: defaultsFor(kind) };
  L.mask = makeMask(d.w, d.h, true);
  if (d.selection && !d.selection.empty) { const x = ctx2d(L.mask.canvas); x.fillStyle = '#000'; x.fillRect(0, 0, d.w, d.h); const t = canvas(d.w, d.h), tx = ctx2d(t); tx.fillStyle = '#fff'; tx.fillRect(0, 0, d.w, d.h); tx.globalCompositeOperation = 'destination-in'; tx.drawImage(d.selection.canvas, 0, 0); x.drawImage(t, 0, 0); L.mask.def = 0; d.selection = null; }
  d.insertAbove(L); changed(); commit(`Layer ${kindName(kind)} Baru`, 'tune'); App.emit('showpanel', 'properties');
  return L;
}
const kindName = k => ({ 'brightness-contrast': 'Brightness/Contrast', levels: 'Levels', curves: 'Curves', exposure: 'Exposure', vibrance: 'Vibrance', 'hue-saturation': 'Hue/Saturation', 'color-balance': 'Color Balance', 'black-white': 'Black & White', 'photo-filter': 'Photo Filter', 'channel-mixer': 'Channel Mixer', 'color-lookup': 'Color Lookup', invert: 'Invert', posterize: 'Posterize', threshold: 'Threshold', 'gradient-map': 'Gradient Map', 'selective-color': 'Selective Color' }[k] || k);
export function newFillLayer(kind, extra = {}) {
  const d = D(), names = { solid: 'Color Fill', gradient: 'Gradient Fill', pattern: 'Pattern Fill' };
  const L = new Layer({ type: 'fill', name: names[kind] + ' 1' });
  L.fill = { kind, color: '#' + [App.fg.r, App.fg.g, App.fg.b].map(v => v.toString(16).padStart(2, '0')).join(''), stops: null, type: 'linear', angle: 90, scale: 100, fg: App.fg, bg: App.bg, pattern: App.patterns[0]?.canvas, ...extra };
  L.mask = makeMask(d.w, d.h, true);
  if (d.selection && !d.selection.empty) { const x = ctx2d(L.mask.canvas); x.fillStyle = '#000'; x.fillRect(0, 0, d.w, d.h); const t = canvas(d.w, d.h), tx = ctx2d(t); tx.fillStyle = '#fff'; tx.fillRect(0, 0, d.w, d.h); tx.globalCompositeOperation = 'destination-in'; tx.drawImage(d.selection.canvas, 0, 0); x.drawImage(t, 0, 0); L.mask.def = 0; d.selection = null; }
  d.insertAbove(L); changed(); commit(names[kind], 'format_color_fill'); App.emit('showpanel', 'properties');
  return L;
}

// ── Selection ────────────────────────────────────────────────────────────
function setSel(s, label) {
  const d = D();
  if (d.selection) App.lastSel = { docId: d.id, sel: d.selection.clone() };
  d.selection = s && !s.empty ? s : null;
  invalidate(); App.view.redraw(); commit(label, 'select'); App.emit('selection');
}
export const selectAll = () => setSel(Selection.all(D().w, D().h), 'Pilih Semua');
export const deselect = () => { if (D().selection) setSel(null, 'Batalkan Seleksi'); };
export const reselect = () => { if (App.lastSel?.docId === D().id) setSel(App.lastSel.sel.clone(), 'Pilih Ulang'); };
export const inverse = () => { const d = D(); setSel(d.selection ? d.selection.clone().invert() : Selection.all(d.w, d.h), 'Inverse'); };
export function modifySel(kind, v) {
  const d = D(); if (!d.selection) return;
  const s = d.selection.clone();
  if (kind === 'feather') s.feather(v); if (kind === 'expand') s.expand(v); if (kind === 'contract') s.contract(v); if (kind === 'border') s.border(v); if (kind === 'smooth') s.smooth(v);
  setSel(s, { feather: 'Feather', expand: 'Expand', contract: 'Contract', border: 'Border', smooth: 'Smooth' }[kind]);
}
export function loadLayerSelection(L, mode = 'new') {
  const d = D(); if (!L) return;
  const s = contentSurface(L, d); let sel;
  if (L.isGroup) { const c = compositeLayers(d, L.children); sel = Selection.fromLayerAlpha(d.w, d.h, c, 0, 0); }
  else if (!s) return; else sel = Selection.fromLayerAlpha(d.w, d.h, s.canvas, s.x, s.y);
  if (mode !== 'new' && d.selection) sel = d.selection.combine(sel, mode);
  setSel(sel, 'Muat Seleksi');
}
export function loadMaskSelection(L) { const d = D(); if (!L?.mask) return; setSel(Selection.fromGray(d.w, d.h, L.mask.canvas, L.mask.x, L.mask.y, L.mask.def), 'Muat Seleksi'); }
export function saveSelectionChannel(name) {
  const d = D(); if (!d.selection) return;
  d.channels.push({ id: 'C' + Date.now(), name: name || `Alpha ${d.channels.length + 1}`, canvas: cloneCanvas(d.selection.canvas) });
  App.emit('channels'); commit('Simpan Seleksi', 'save');
}
export function grow(similar = false) {
  const d = D(); if (!d.selection) return;
  const img = ctx2d(flattenDoc(d)).getImageData(0, 0, d.w, d.h), a = d.selection.alpha();
  const tol = App.toolOpts['magic-wand']?.tolerance ?? 32;
  // average colour of the selection
  let r = 0, g = 0, b = 0, n = 0; const px = img.data;
  for (let i = 0; i < a.length; i++) if (a[i] > 128) { r += px[i * 4]; g += px[i * 4 + 1]; b += px[i * 4 + 2]; n++; }
  if (!n) return; r /= n; g /= n; b /= n;
  const out = new Uint8ClampedArray(a);
  const ok = i => Math.max(Math.abs(px[i * 4] - r), Math.abs(px[i * 4 + 1] - g), Math.abs(px[i * 4 + 2] - b)) <= tol;
  if (similar) { for (let i = 0; i < a.length; i++) if (ok(i)) out[i] = 255; }
  else {
    const stack = []; for (let i = 0; i < a.length; i++) if (a[i] > 128) stack.push(i);
    const W = d.w;
    while (stack.length) { const p = stack.pop(); for (const q of [p - 1, p + 1, p - W, p + W]) { if (q < 0 || q >= a.length || out[q] || ((q % W === 0) && p % W === W - 1) || ((p % W === 0) && q % W === W - 1)) continue; if (ok(q)) { out[q] = 255; stack.push(q); } } }
  }
  setSel(Selection.fromAlpha(d.w, d.h, out), similar ? 'Similar' : 'Grow');
}
// Colour-range mask: samples [{r,g,b}], fuzziness, or preset ranges
export function colorRangeMask(img, { samples = [], fuzz = 40, preset = 'sampled', invert = false }) {
  const d = img.data, n = d.length / 4, out = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2]; let v = 0;
    if (preset === 'sampled') { for (const s of samples) { const dist = Math.hypot(r - s.r, g - s.g, b - s.b); v = Math.max(v, clamp(1 - (dist - fuzz * .35) / (fuzz * 1.3 + 1), 0, 1)); } }
    else if (preset === 'highlights') v = clamp((luma(r, g, b) - 170) / 50, 0, 1);
    else if (preset === 'shadows') v = clamp((85 - luma(r, g, b)) / 50, 0, 1);
    else if (preset === 'midtones') v = clamp(1 - Math.abs(luma(r, g, b) - 128) / 70, 0, 1);
    else if (preset === 'skin') { const sk = r > 95 && g > 40 && b > 20 && r > g && r > b && Math.abs(r - g) > 15 && (Math.max(r, g, b) - Math.min(r, g, b)) > 15; v = sk ? 1 : 0; }
    else {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx - mn; if (sat < 30) { out[i] = invert ? 255 : 0; continue; }
      let hh = 0; if (mx === r) hh = ((g - b) / sat) % 6; else if (mx === g) hh = (b - r) / sat + 2; else hh = (r - g) / sat + 4; hh *= 60; if (hh < 0) hh += 360;
      const c = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 }[preset];
      let dd = Math.abs(hh - c); if (dd > 180) dd = 360 - dd; v = clamp(1 - (dd - 20) / 20, 0, 1) * clamp(sat / 80, 0, 1);
    }
    out[i] = (invert ? 1 - v : v) * 255;
  }
  return out;
}

// Heuristic subject detection: background = colours connected to the frame border
export function subjectMask(rect) {
  const d = D(), full = flattenDoc(d);
  const R = rect || { x: 0, y: 0, w: d.w, h: d.h };
  const k = Math.min(1, 420 / Math.max(R.w, R.h)), w = Math.max(8, Math.round(R.w * k)), hh = Math.max(8, Math.round(R.h * k));
  const sc = canvas(w, hh), sx = ctx2d(sc); sx.imageSmoothingQuality = 'high'; sx.drawImage(full, R.x, R.y, R.w, R.h, 0, 0, w, hh);
  const img = sx.getImageData(0, 0, w, hh), px = img.data, n = w * hh;
  const blurImg = gaussianImageData(new ImageData(new Uint8ClampedArray(px), w, hh), 1.2).data;
  // k-means of border colours
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (hh - 1) * w + x);
  for (let y = 0; y < hh; y++) border.push(y * w, y * w + w - 1);
  const cols = border.map(i => [blurImg[i * 4], blurImg[i * 4 + 1], blurImg[i * 4 + 2]]);
  let cents = [0, .25, .5, .75].map(f => cols[Math.floor(f * cols.length)].slice());
  for (let it = 0; it < 8; it++) {
    const acc = cents.map(() => [0, 0, 0, 0]);
    for (const c of cols) { let bi = 0, bd = Infinity; cents.forEach((m, j) => { const dd = (c[0] - m[0]) ** 2 + (c[1] - m[1]) ** 2 + (c[2] - m[2]) ** 2; if (dd < bd) { bd = dd; bi = j; } }); const a = acc[bi]; a[0] += c[0]; a[1] += c[1]; a[2] += c[2]; a[3]++; }
    cents = cents.map((m, j) => acc[j][3] ? [acc[j][0] / acc[j][3], acc[j][1] / acc[j][3], acc[j][2] / acc[j][3]] : m);
  }
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) { let bd = Infinity; for (const m of cents) bd = Math.min(bd, Math.hypot(blurImg[i * 4] - m[0], blurImg[i * 4 + 1] - m[1], blurImg[i * 4 + 2] - m[2])); dist[i] = bd; }
  // threshold from border distance statistics
  const bds = border.map(i => dist[i]).sort((a, b) => a - b), thr = Math.max(18, bds[Math.floor(bds.length * .9)] * 1.6);
  const bg = new Uint8Array(n), stack = [];
  for (const i of border) if (dist[i] < thr && !bg[i]) { bg[i] = 1; stack.push(i); }
  while (stack.length) {
    const p = stack.pop(), x = p % w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
      if (q < 0 || q >= n || bg[q]) continue;
      if (dist[q] < thr * 1.15) { bg[q] = 1; stack.push(q); }
    }
  }
  // keep large foreground components
  const lab = new Int32Array(n).fill(-1), sizes = [];
  for (let i = 0; i < n; i++) {
    if (bg[i] || lab[i] >= 0) continue;
    const id = sizes.length; let cnt = 0; const st = [i]; lab[i] = id;
    while (st.length) { const p = st.pop(); cnt++; const x = p % w; for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && q < n && !bg[q] && lab[q] < 0) { lab[q] = id; st.push(q); } }
    sizes.push(cnt);
  }
  if (!sizes.length) { toast('Subjek tidak terdeteksi'); return null; }
  const maxS = Math.max(...sizes);
  const m = canvas(w, hh), mx = ctx2d(m), mi = mx.createImageData(w, hh);
  for (let i = 0; i < n; i++) { const keep = !bg[i] && sizes[lab[i]] > maxS * .06; mi.data[i * 4 + 3] = keep ? 255 : 0; mi.data[i * 4] = mi.data[i * 4 + 1] = mi.data[i * 4 + 2] = 255; }
  mx.putImageData(mi, 0, 0);
  const sel = new Selection(d.w, d.h), x = sel.ctx; x.imageSmoothingQuality = 'high';
  x.drawImage(m, R.x, R.y, R.w, R.h);
  sel.touch(); sel.smooth(Math.max(1, 1.2 / k * .6)); sel.feather(1);
  return sel.empty ? null : sel;
}
App.subjectMask = subjectMask;
export function selectSubject() { const s = subjectMask(); if (s) setSel(s, 'Select Subject'); }
export async function removeBackground() {
  const d = D(), L = d.active; if (!L || L.type !== 'raster') { toast('Pilih layer piksel'); return; }
  const s = subjectMask(); if (!s) return;
  if (L.isBackground) convertBackground(L);
  d.selection = s; addMask('reveal'); toast('Latar dihapus dengan layer mask — sempurnakan dengan Brush pada mask', 'ok', 3600);
}

// ── Canvas geometry ──────────────────────────────────────────────────────
function scaleCanvasHQ(src, w, h2) {
  let c = src, cw = src.width, ch = src.height;
  while (cw / 2 > w && ch / 2 > h2) { cw = Math.round(cw / 2); ch = Math.round(ch / 2); const t = canvas(cw, ch), x = ctx2d(t); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, cw, ch); c = t; }
  const out = canvas(w, h2), x = ctx2d(out); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, w, h2); return out;
}
// Apply a geometric DOMMatrix to the whole document (rotate, flip, resample)
export function transformDoc(M, newW, newH, label, { resample = false, sx = 1, sy = 1 } = {}) {
  const d = D();
  const mapCanvas = (c, ox, oy, fillDef) => {
    const out = canvas(newW, newH), x = ctx2d(out); x.imageSmoothingQuality = 'high';
    if (fillDef !== undefined) { x.fillStyle = `rgb(${fillDef},${fillDef},${fillDef})`; x.fillRect(0, 0, newW, newH); }
    if (resample && M.b === 0 && M.c === 0) { const w = Math.max(1, Math.round(c.width * sx)), h2 = Math.max(1, Math.round(c.height * sy)); x.drawImage(scaleCanvasHQ(c, w, h2), Math.round(ox * sx), Math.round(oy * sy)); }
    else { x.setTransform(M); x.drawImage(c, ox, oy); }
    return out;
  };
  const walk = L => {
    if (L.isGroup) { L.children.forEach(walk); return; }
    if (L.canvas && L.type === 'raster') { L.canvas = mapCanvas(L.canvas, L.x, L.y); L.x = 0; L.y = 0; }
    if (L.type === 'text') {
      const off = new DOMMatrix().translate(L.x, L.y), old = L.text.matrix ? new DOMMatrix(L.text.matrix) : new DOMMatrix();
      const m = off.inverse().multiply(M).multiply(off).multiply(old); L.text.matrix = [m.a, m.b, m.c, m.d, m.e, m.f];
    }
    if (L.type === 'shape') {
      for (const sp of L.shape.subpaths) for (const p of sp.pts) for (const [a, b] of [['x', 'y'], ['ix', 'iy'], ['ox', 'oy']]) if (p[a] !== undefined) { const q = M.transformPoint(new DOMPoint(p[a] + L.x, p[b] + L.y)); p[a] = q.x - L.x; p[b] = q.y - L.y; }
      L.shape.params = null; if (L.shape.stroke) L.shape.stroke.width *= Math.sqrt(Math.abs(M.a * M.d - M.b * M.c)); rebuildShape(L);
    }
    if (L.mask) { L.mask.canvas = mapCanvas(L.mask.canvas, L.mask.x, L.mask.y, L.mask.def); L.mask.x = 0; L.mask.y = 0; L.mask.rev++; }
    L._cache = null; L.touch();
  };
  walk(d.root);
  if (d.selection) { const s = mapCanvas(d.selection.canvas, 0, 0); d.selection = Selection.fromCanvas(s); d.selection.touch(); }
  d.channels = d.channels.map(c => ({ ...c, canvas: mapCanvas(c.canvas, 0, 0) }));
  for (const P of d.paths) for (const sp of P.subpaths) for (const p of sp.pts) for (const [a, b] of [['x', 'y'], ['ix', 'iy'], ['ox', 'oy']]) if (p[a] !== undefined) { const q = M.transformPoint(new DOMPoint(p[a], p[b])); p[a] = q.x; p[b] = q.y; }
  d.guides = []; d.samplers = [];
  d.w = newW; d.h = newH; d._comp = canvas(newW, newH);
  App.view.setDoc(d); App.view.fit(); changed(); commit(label, 'crop_rotate'); App.emit('docsize');
}
export function rotateCanvas(deg) {
  const d = D(), a = deg * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const nw = Math.round(d.w * c + d.h * s), nh = Math.round(d.w * s + d.h * c);
  const M = new DOMMatrix().translate(nw / 2, nh / 2).rotate(deg).translate(-d.w / 2, -d.h / 2);
  const bg = d.background;
  transformDoc(M, nw, nh, deg === 180 ? 'Rotate 180°' : deg === 90 ? 'Rotate 90° CW' : deg === -90 ? 'Rotate 90° CCW' : 'Rotate Canvas');
  if (bg && deg % 90) { const x = ctx2d(bg.canvas); x.save(); x.globalCompositeOperation = 'destination-over'; x.fillStyle = rgbCss(App.bg); x.fillRect(0, 0, nw, nh); x.restore(); bg.touch(); invalidate(); D().history.amend(); }
}
export function flipCanvas(axis) {
  const d = D(); const M = axis === 'h' ? new DOMMatrix([-1, 0, 0, 1, d.w, 0]) : new DOMMatrix([1, 0, 0, -1, 0, d.h]);
  transformDoc(M, d.w, d.h, axis === 'h' ? 'Flip Canvas Horizontal' : 'Flip Canvas Vertical');
}
export function flipLayer(axis) {
  const d = D(), L = d.active; if (!L || L.isGroup) return;
  if (L.type === 'raster') {
    const c = canvas(L.w, L.h), x = ctx2d(c);
    if (axis === 'h') { x.translate(L.w, 0); x.scale(-1, 1); } else { x.translate(0, L.h); x.scale(1, -1); }
    x.drawImage(L.canvas, 0, 0); L.canvas = c;
    // mirror within the document
    if (axis === 'h') L.x = d.w - L.x - L.w; else L.y = d.h - L.y - L.h;
    L.touch(); changed(); commit(axis === 'h' ? 'Flip Horizontal' : 'Flip Vertical', 'flip'); return;
  }
  App.transform.start('free').then(() => { App.transform.flip(axis); App.transform.commit(); });
}
export function imageSize(w, h2, { resample = true } = {}) {
  const d = D(); if (w === d.w && h2 === d.h) return;
  const sx = w / d.w, sy = h2 / d.h;
  if (!resample) { d.ppi = d.ppi * sx; App.emit('docsize'); return; }
  const M = new DOMMatrix().scale(sx, sy);
  transformDoc(M, w, h2, 'Image Size', { resample: true, sx, sy });
}
export function canvasSize(w, h2, anchor = [1, 1], ext = '#ffffff') {
  const d = D();
  const dx = Math.round((w - d.w) * anchor[0] / 2), dy = Math.round((h2 - d.h) * anchor[1] / 2);
  shiftAndResize(w, h2, dx, dy, ext, 'Canvas Size');
}
function shiftAndResize(w, h2, dx, dy, ext, label, deletePixels = false) {
  const d = D();
  const walk = L => {
    if (L.isGroup) { L.children.forEach(walk); return; }
    if (L.isBackground && L.canvas) {
      const c = canvas(w, h2), x = ctx2d(c); x.fillStyle = ext || rgbCss(App.bg); x.fillRect(0, 0, w, h2); x.drawImage(L.canvas, L.x + dx, L.y + dy);
      L.canvas = c; L.x = 0; L.y = 0;
    } else if (L.type === 'raster' && L.canvas) {
      L.x += dx; L.y += dy;
      if (deletePixels) { const c = canvas(w, h2); ctx2d(c).drawImage(L.canvas, L.x, L.y); L.canvas = c; L.x = 0; L.y = 0; }
    } else if (L.type === 'text' || L.type === 'shape') { L.x += dx; L.y += dy; }
    if (L.mask) { L.mask.x += dx; L.mask.y += dy; L.mask.rev++; }
    L._cache = null; L.touch();
  };
  walk(d.root);
  if (d.selection) { const s = new Selection(w, h2); s.ctx.drawImage(d.selection.canvas, dx, dy); s.touch(); d.selection = s.empty ? null : s; }
  d.channels = d.channels.map(c => { const n = canvas(w, h2); ctx2d(n).drawImage(c.canvas, dx, dy); return { ...c, canvas: n }; });
  for (const P of d.paths) for (const sp of P.subpaths) for (const p of sp.pts) { for (const k of ['x', 'ix', 'ox']) if (p[k] !== undefined) p[k] += dx; for (const k of ['y', 'iy', 'oy']) if (p[k] !== undefined) p[k] += dy; }
  d.guides = d.guides.map(g => ({ ...g, p: g.p + (g.o === 'v' ? dx : dy) }));
  d.w = w; d.h = h2; d._comp = canvas(w, h2);
  App.view.setDoc(d); App.view.fit(); changed(); commit(label, 'crop'); App.emit('docsize');
}
App.cropDoc = (r, deletePixels) => shiftAndResize(r.w, r.h, -r.x, -r.y, null, 'Crop', deletePixels);
export function cropToSelection() { const d = D(); if (!d.selection) return; const b = d.selection.bounds(); App.cropDoc(b, false); }
export function trim(basis = 'transparent') {
  const d = D(), c = flattenDoc(d), data = ctx2d(c).getImageData(0, 0, d.w, d.h).data;
  const ref = basis === 'bottomright' ? (d.w * d.h - 1) * 4 : 0;
  const isBg = i => basis === 'transparent' ? data[i + 3] === 0 : Math.abs(data[i] - data[ref]) + Math.abs(data[i + 1] - data[ref + 1]) + Math.abs(data[i + 2] - data[ref + 2]) < 6;
  let x1 = d.w, y1 = d.h, x2 = -1, y2 = -1;
  for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) if (!isBg((y * d.w + x) * 4)) { x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = y; }
  if (x2 < 0) { toast('Tidak ada yang bisa di-trim'); return; }
  App.cropDoc({ x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 }, false);
}
export function revealAll() {
  const d = D(); let b = { x: 0, y: 0, w: d.w, h: d.h };
  for (const L of d.flat()) if (L.type === 'raster' && L.canvas) { const x1 = Math.min(b.x, L.x), y1 = Math.min(b.y, L.y); b = { x: x1, y: y1, w: Math.max(b.x + b.w, L.x + L.w) - x1, h: Math.max(b.y + b.h, L.y + L.h) - y1 }; }
  if (b.w === d.w && b.h === d.h) { toast('Semua piksel sudah terlihat'); return; }
  shiftAndResize(b.w, b.h, -b.x, -b.y, null, 'Reveal All');
}

// ── Clipboard ────────────────────────────────────────────────────────────
export async function copy(merged = false, cut = false) {
  const d = D(); const sel = d.selection && !d.selection.empty ? d.selection : null;
  let src, ox = 0, oy = 0;
  if (merged) src = flattenDoc(d);
  else {
    const L = d.active; if (!L || L.isGroup || L.type === 'adjust') { toast('Pilih layer piksel'); return; }
    const s = L.type === 'raster' ? { canvas: L.canvas, x: L.x, y: L.y } : contentSurface(L, d); if (!s) return;
    src = canvas(d.w, d.h); ctx2d(src).drawImage(s.canvas, s.x, s.y);
  }
  const b = sel ? sel.bounds() : { x: 0, y: 0, w: d.w, h: d.h };
  const c = canvas(b.w, b.h), x = ctx2d(c); x.drawImage(src, -b.x, -b.y);
  if (sel) { x.globalCompositeOperation = 'destination-in'; x.drawImage(sel.canvas, -b.x, -b.y); }
  ox = b.x; oy = b.y;
  App.clipboard = { canvas: c, x: ox, y: oy, docId: d.id };
  try { const blob = await new Promise(r => c.toBlob(r, 'image/png')); await navigator.clipboard?.write?.([new ClipboardItem({ 'image/png': blob })]); App._clipStamp = Date.now(); } catch { /* clipboard permission not granted */ }
  if (cut && !merged) {
    const t = await editTarget(); if (!t) return;
    const lx = ctx2d(t.canvas); lx.save();
    if (t.layer.isBackground) { lx.fillStyle = rgbCss(App.bg); if (sel) { const m = canvas(d.w, d.h), mx = ctx2d(m); mx.fillStyle = lx.fillStyle; mx.fillRect(0, 0, d.w, d.h); mx.globalCompositeOperation = 'destination-in'; mx.drawImage(sel.canvas, 0, 0); lx.drawImage(m, -t.x, -t.y); } else lx.fillRect(0, 0, t.canvas.width, t.canvas.height); }
    else { lx.globalCompositeOperation = 'destination-out'; if (sel) lx.drawImage(sel.canvas, -t.x, -t.y); else lx.clearRect(0, 0, t.canvas.width, t.canvas.height); }
    lx.restore(); touchTarget(t); invalidate(); commit('Cut', 'content_cut');
  } else toast(merged ? 'Disalin (merged)' : 'Disalin', 'ok', 1200);
}
export function pasteCanvas(c, inPlace = false, x, y) {
  const d = D(); if (!d) return;
  let px = x ?? Math.round((d.w - c.width) / 2), py = y ?? Math.round((d.h - c.height) / 2);
  if (inPlace && App.clipboard?.canvas === c) { px = App.clipboard.x; py = App.clipboard.y; }
  else if (d.selection && !d.selection.empty && x === undefined) { const b = d.selection.bounds(); px = Math.round(b.x + (b.w - c.width) / 2); py = Math.round(b.y + (b.h - c.height) / 2); }
  d.selection = null;
  const L = addLayerFromCanvas(cloneCanvas(c), d.nextName(), px, py, { commitLabel: 'Tempel' });
  return L;
}
export async function paste(inPlace = false) {
  const d = D();
  try {
    const items = await navigator.clipboard?.read?.();
    for (const it of items || []) {
      const type = it.types.find(t => t.startsWith('image/'));
      if (type && (!App._clipStamp || Date.now() - App._clipStamp > 1500 || !App.clipboard)) {
        const blob = await it.getType(type), bmp = await createImageBitmap(blob);
        const c = canvas(bmp.width, bmp.height); ctx2d(c).drawImage(bmp, 0, 0);
        if (!d) return App.openCanvasAsDoc(c, 'Clipboard');
        return pasteCanvas(c, false);
      }
    }
  } catch { /* fall back to internal clipboard */ }
  if (!App.clipboard) { toast('Clipboard kosong'); return; }
  if (!d) return App.openCanvasAsDoc(App.clipboard.canvas, 'Clipboard');
  pasteCanvas(App.clipboard.canvas, inPlace);
}
export async function clearSelection() {
  const d = D(); if (!d.selection) { toast('Buat seleksi terlebih dahulu'); return; }
  const t = await editTarget(); if (!t) return;
  const x = ctx2d(t.canvas); x.save();
  if (t.kind === 'layer' && (t.layer.isBackground || t.layer.locks.alpha)) { const m = canvas(d.w, d.h), mx = ctx2d(m); mx.fillStyle = rgbCss(App.bg); mx.fillRect(0, 0, d.w, d.h); mx.globalCompositeOperation = 'destination-in'; mx.drawImage(d.selection.canvas, 0, 0); x.drawImage(m, -t.x, -t.y); }
  else if (t.kind === 'mask') { const m = canvas(d.w, d.h), mx = ctx2d(m); mx.fillStyle = '#000'; mx.fillRect(0, 0, d.w, d.h); mx.globalCompositeOperation = 'destination-in'; mx.drawImage(d.selection.canvas, 0, 0); x.drawImage(m, -t.x, -t.y); }
  else { x.globalCompositeOperation = 'destination-out'; x.drawImage(d.selection.canvas, -t.x, -t.y); }
  x.restore(); touchTarget(t); invalidate(); commit('Clear', 'backspace');
}

// Fill selection / layer
export async function fill({ use = 'fg', color, mode = 'normal', opacity = 100, preserve = false, pattern = 0 }) {
  const d = D(), t = await editTarget(); if (!t) return;
  const W = d.w, H = d.h, sel = d.selection && !d.selection.empty ? d.selection : null;
  if (use === 'content') {
    if (!sel) { toast('Content-Aware memerlukan seleksi'); return; }
    const x = ctx2d(t.canvas), img = x.getImageData(0, 0, t.canvas.width, t.canvas.height), m = new Uint8Array(t.canvas.width * t.canvas.height);
    const sa = sel.alpha();
    for (let y = 0; y < t.canvas.height; y++) for (let xx = 0; xx < t.canvas.width; xx++) { const dx = xx + t.x, dy = y + t.y; if (dx >= 0 && dy >= 0 && dx < W && dy < H && sa[dy * W + dx] > 60) m[y * t.canvas.width + xx] = 1; }
    App.emit('busy', true); await new Promise(r => setTimeout(r, 30));
    inpaint(img, m, { quality: 'normal' }); x.putImageData(img, 0, 0);
    App.emit('busy', false); touchTarget(t); invalidate(); commit('Content-Aware Fill', 'auto_awesome'); return;
  }
  const f = canvas(W, H), fx = ctx2d(f);
  if (use === 'pattern' && App.patterns[pattern]) fx.fillStyle = fx.createPattern(App.patterns[pattern].canvas, 'repeat');
  else if (use === 'history') { const src = d.history.sourceCanvasFor(t.layer.id, App.historySource || d.history.states[0]); if (src) fx.drawImage(src.canvas, src.x, src.y); }
  else {
    let c = { fg: App.fg, bg: App.bg, black: { r: 0, g: 0, b: 0 }, white: { r: 255, g: 255, b: 255 }, gray: { r: 128, g: 128, b: 128 }, color: color && hexToRgb(color) }[use] || App.fg;
    if (t.kind === 'mask') { const v = Math.round(luma(c.r, c.g, c.b)); c = { r: v, g: v, b: v }; }
    fx.fillStyle = rgbCss(c);
  }
  if (use !== 'history') fx.fillRect(0, 0, W, H);
  if (sel) { fx.globalCompositeOperation = 'destination-in'; fx.drawImage(sel.canvas, 0, 0); }
  const x = ctx2d(t.canvas); x.save(); x.globalAlpha = opacity / 100;
  let gcoMode = { normal: 'source-over', behind: 'destination-over', clear: 'destination-out' }[mode] || mode;
  if ((preserve || (t.kind === 'layer' && t.layer.locks.alpha)) && gcoMode === 'source-over') gcoMode = 'source-atop';
  x.globalCompositeOperation = gcoMode; x.drawImage(f, -t.x, -t.y); x.restore();
  touchTarget(t); invalidate(); commit('Fill', 'format_color_fill');
}
export async function stroke({ width = 2, color = '#000000', location = 'center', mode = 'normal', opacity = 100 }) {
  const d = D(); if (!d.selection) { toast('Buat seleksi terlebih dahulu'); return; }
  const t = await editTarget(); if (!t) return;
  const a = d.selection.clone(), W = d.w, H = d.h;
  const outer = location === 'inside' ? a.clone() : a.clone().expand(location === 'center' ? width / 2 : width);
  const inner = location === 'outside' ? a.clone() : a.clone().contract(location === 'center' ? width / 2 : width);
  const ring = canvas(W, H), rx = ctx2d(ring); rx.drawImage(outer.canvas, 0, 0); rx.globalCompositeOperation = 'destination-out'; rx.drawImage(inner.canvas, 0, 0);
  rx.globalCompositeOperation = 'source-in'; rx.fillStyle = color; rx.fillRect(0, 0, W, H);
  const x = ctx2d(t.canvas); x.save(); x.globalAlpha = opacity / 100; x.globalCompositeOperation = mode === 'normal' ? 'source-over' : mode; x.drawImage(ring, -t.x, -t.y); x.restore();
  touchTarget(t); invalidate(); commit('Stroke', 'border_style');
}
export function definePattern() {
  const d = D(), c = flattenDoc(d), sel = d.selection;
  const b = sel && !sel.empty ? sel.bounds() : { x: 0, y: 0, w: d.w, h: d.h };
  if (b.w > 1024 || b.h > 1024) { toast('Pola maksimal 1024 × 1024 px'); return; }
  const p = canvas(b.w, b.h); ctx2d(p).drawImage(c, -b.x, -b.y);
  App.patterns.push({ name: `Pola ${App.patterns.length + 1}`, canvas: p }); App.emit('patterns'); toast('Pola ditambahkan', 'ok');
}
export function defineBrush() {
  const d = D(), c = flattenDoc(d), sel = d.selection;
  const b = sel && !sel.empty ? sel.bounds() : { x: 0, y: 0, w: d.w, h: d.h };
  const S = Math.max(b.w, b.h), k = Math.min(1, 512 / S);
  const tip = canvas(Math.round(S * k), Math.round(S * k)), x = ctx2d(tip);
  x.drawImage(c, b.x, b.y, b.w, b.h, (S - b.w) / 2 * k, (S - b.h) / 2 * k, b.w * k, b.h * k);
  const img = x.getImageData(0, 0, tip.width, tip.height), dd = img.data;
  for (let i = 0; i < dd.length; i += 4) { const a = (255 - luma(dd[i], dd[i + 1], dd[i + 2])) * dd[i + 3] / 255; dd[i] = dd[i + 1] = dd[i + 2] = 255; dd[i + 3] = a; }
  x.putImageData(img, 0, 0);
  App.brushes.push({ id: 'custom' + Date.now(), name: `Brush ${App.brushes.length + 1}`, custom: tip, size: Math.round(S), hardness: 100, spacing: 25 });
  App.emit('brushes'); toast('Brush preset dibuat', 'ok');
}

// New document
export function makeDocument(o) {
  const d = new Doc({ w: Math.round(o.w), h: Math.round(o.h), name: o.name || `Tanpa Judul-${++App.untitled}`, bg: o.bg === 'transparent' ? null : o.bg || '#ffffff', ppi: o.ppi || 72, transparent: o.bg === 'transparent' });
  App.addDoc(d); d.history.push('Dokumen Baru', 'note_add');
  return d;
}
export function layerToDoc(L) {
  const d = D(); const c = canvas(d.w, d.h), s = layerSurface(L, d); if (s) ctx2d(c).drawImage(s.canvas, s.x, s.y);
  return c;
}
App.untitled = 0;
App.fillPathOnLayer = async (subs, color) => {
  const t = await editTarget(); if (!t) return;
  const { shapePath } = await import('./composite.js');
  const x = ctx2d(t.canvas); x.save(); x.translate(-t.x, -t.y); x.fillStyle = rgbCss(color); x.fill(shapePath({ subpaths: subs })); x.restore();
  touchTarget(t); invalidate(); commit('Fill Path', 'format_color_fill');
};
export { setSel, colorRegion };
