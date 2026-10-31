// Files: open images / PSD / .amp projects, browser storage (Recent), save & export

import { App, toast } from './state.js';
import { canvas, ctx2d, download, canvasToBlob, fileToImage, loadScript, pickFile, uid, fmtBytes } from './util.js';
import { Doc, Layer } from './doc.js';
import { flattenDoc, contentSurface, layerSurface } from './composite.js';
import { pasteCanvas } from './ops.js';
import { Selection } from './selection.js';

const AGPSD = 'https://cdn.jsdelivr.net/npm/ag-psd@31.0.3/dist/bundle.js';
const JSZIP = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
export const OPEN_ACCEPT = 'image/*,.psd,.amp,.json,.svg';

// ── IndexedDB ────────────────────────────────────────────────────────────
let dbp;
function db() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('amatu-photo', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('files', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction('files', mode), s = t.objectStore('files'); const r = fn(s); t.oncomplete = () => res(r?.result); t.onerror = () => rej(t.error); });
}
export async function listRecent() {
  try { const all = await tx('readonly', s => s.getAll()); return (all || []).map(f => ({ id: f.id, name: f.name, w: f.w, h: f.h, thumb: f.thumb, updated: f.updated, size: f.size })).sort((a, b) => b.updated - a.updated); }
  catch { return []; }
}
export async function deleteRecent(id) { try { await tx('readwrite', s => s.delete(id)); } catch { /* storage unavailable */ } App.emit('recent'); }

// ── Serialisation (.amp) ─────────────────────────────────────────────────
async function serLayer(L, asDataURL) {
  const blob = async c => asDataURL ? c.toDataURL('image/png') : await canvasToBlob(c, 'image/png');
  const o = { ...L, canvas: null, mask: null, children: null, _cache: undefined, _styled: undefined, _snapCanvas: undefined, _thumb: undefined, _bbox: undefined };
  for (const k of Object.keys(o)) if (k.startsWith('_')) delete o[k];
  if (L.canvas && L.type === 'raster') o.canvas = await blob(L.canvas);
  if (L.mask) { const { canvas: mc, _alpha, _snapCanvas, ...m } = L.mask; void _alpha; void _snapCanvas; o.mask = { ...m, canvas: await blob(mc) }; }
  if (L.fill?.pattern) o.fill = { ...L.fill, pattern: await blob(L.fill.pattern) };
  if (L.children) o.children = await Promise.all(L.children.map(c => serLayer(c, asDataURL)));
  return o;
}
async function toCanvas(src) {
  if (!src) return null;
  const bmp = typeof src === 'string' ? await (await fetch(src)).blob().then(createImageBitmap) : await createImageBitmap(src);
  const c = canvas(bmp.width, bmp.height); ctx2d(c).drawImage(bmp, 0, 0); return c;
}
async function deserLayer(o) {
  const L = new Layer({ ...o, canvas: null, mask: null, children: null });
  L.id = o.id || uid('L');
  if (o.canvas) L.canvas = await toCanvas(o.canvas);
  if (o.mask) L.mask = { ...o.mask, canvas: await toCanvas(o.mask.canvas), rev: 1 };
  if (o.fill?.pattern) L.fill = { ...o.fill, pattern: await toCanvas(o.fill.pattern) };
  if (o.children) L.children = await Promise.all(o.children.map(deserLayer));
  return L;
}
export async function serializeDoc(d, asDataURL = false) {
  return {
    format: 'amatu-photo', version: 1, name: d.name, w: d.w, h: d.h, ppi: d.ppi,
    root: await serLayer(d.root, asDataURL), guides: d.guides, paths: d.paths, layerCounter: d.layerCounter,
    channels: await Promise.all(d.channels.map(async c => ({ id: c.id, name: c.name, canvas: asDataURL ? c.canvas.toDataURL() : await canvasToBlob(c.canvas) }))),
    selection: d.selection ? (asDataURL ? d.selection.canvas.toDataURL() : await canvasToBlob(d.selection.canvas)) : null,
  };
}
export async function deserializeDoc(o) {
  const d = new Doc({ w: o.w, h: o.h, name: o.name, ppi: o.ppi, transparent: true });
  d.root = await deserLayer(o.root); d.root.type = 'group';
  d.guides = o.guides || []; d.paths = o.paths || []; d.layerCounter = o.layerCounter || d.flat().length;
  d.channels = await Promise.all((o.channels || []).map(async c => ({ ...c, canvas: await toCanvas(c.canvas) })));
  if (o.selection) { const c = await toCanvas(o.selection); d.selection = Selection.fromCanvas(c); d.selection.touch(); }
  const flat = d.flat(); d.activeId = flat[flat.length - 1]?.id; d.selectedIds = new Set([d.activeId]);
  return d;
}

function thumbOf(d, max = 320) {
  const c = flattenDoc(d), k = Math.min(1, max / Math.max(d.w, d.h)), t = canvas(d.w * k, d.h * k), x = ctx2d(t);
  x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, t.width, t.height); return t.toDataURL('image/jpeg', .8);
}
export async function saveToBrowser(d = App.doc, { quiet = false } = {}) {
  if (!d) return;
  if (!quiet) App.emit('busy', true);
  try {
    const ver = d._edits;
    const data = await serializeDoc(d);
    const rec = { id: d.storeId ||= uid('F'), name: d.name, w: d.w, h: d.h, thumb: thumbOf(d), updated: Date.now(), data };
    await tx('readwrite', s => s.put(rec));
    if (!quiet || d._edits === ver) { d.dirty = false; d.emit('dirty'); }
    App.emit('recent'); App.emit('docs');
    if (!quiet) toast(`"${d.name}" disimpan di browser`, 'ok');
  } catch (e) { console.error(e); if (!quiet) toast('Gagal menyimpan: ' + e.message, 'err', 4000); }
  if (!quiet) App.emit('busy', false);
}
// Autosave: every edit is written to the browser store shortly after it is made.
export function autosaveSoon(d, ms = 2000) {
  clearTimeout(d._asT);
  d._asT = setTimeout(async () => {
    if (d._asBusy) return autosaveSoon(d, 1000);
    d._asBusy = true;
    try { await saveToBrowser(d, { quiet: true }); } finally { d._asBusy = false; }
  }, ms);
}
export async function openRecent(id) {
  const existing = App.docs.find(d => d.storeId === id); if (existing) return App.setDoc(existing);
  const rec = await tx('readonly', s => s.get(id)); if (!rec) { toast('Berkas tidak ditemukan'); return; }
  App.emit('busy', true);
  try { const d = await deserializeDoc(rec.data); d.storeId = id; App.addDoc(d); d.history.push('Buka', 'folder_open'); d.dirty = false; }
  catch (e) { console.error(e); toast('Gagal membuka: ' + e.message, 'err'); }
  App.emit('busy', false);
}

// ── Opening files ────────────────────────────────────────────────────────
export async function openFiles(files, { asLayer = false } = {}) {
  for (const f of files) {
    try {
      const name = f.name.replace(/\.[^.]+$/, '');
      const ext = f.name.split('.').pop().toLowerCase();
      if (ext === 'psd' || ext === 'psb') { await openPSD(f); continue; }
      if (ext === 'amp' || ext === 'json') { const o = JSON.parse(await f.text()); if (o.format !== 'amatu-photo') throw new Error('Bukan berkas Amatu Photo'); const d = await deserializeDoc(o); App.addDoc(d); d.history.push('Buka', 'folder_open'); continue; }
      const img = await fileToImage(f);
      const c = canvas(img.naturalWidth || img.width || 1024, img.naturalHeight || img.height || 768);
      ctx2d(c).drawImage(img, 0, 0, c.width, c.height);
      if (asLayer && App.doc) { const L = pasteCanvas(c, false); if (L) { L.name = name; App.emit('layers'); } }
      else App.openCanvasAsDoc(c, name);
    } catch (e) { console.error(e); toast(`Tidak dapat membuka ${f.name}: ${e.message || e}`, 'err', 4200); }
  }
}
App.openCanvasAsDoc = (c, name = 'Gambar') => {
  const d = new Doc({ w: c.width, h: c.height, name, bg: '#ffffff' });
  const L = d.root.children[0]; ctx2d(L.canvas).clearRect(0, 0, c.width, c.height); ctx2d(L.canvas).drawImage(c, 0, 0);
  App.addDoc(d); d.history.push('Buka', 'folder_open'); return d;
};
export async function openDialog() { const files = await pickFile(OPEN_ACCEPT, true); if (files.length) openFiles(files); }
export async function placeDialog() { if (!App.doc) return openDialog(); const files = await pickFile('image/*', false); if (files.length) openFiles(files, { asLayer: true }); }

// ── PSD via ag-psd ───────────────────────────────────────────────────────
const PSD_BLEND = { normal: 'normal', dissolve: 'dissolve', darken: 'darken', multiply: 'multiply', 'color burn': 'color-burn', 'linear burn': 'linear-burn', 'darker color': 'darker-color', lighten: 'lighten', screen: 'screen', 'color dodge': 'color-dodge', 'linear dodge': 'lighter', 'lighter color': 'lighter-color', overlay: 'overlay', 'soft light': 'soft-light', 'hard light': 'hard-light', 'vivid light': 'vivid-light', 'linear light': 'linear-light', 'pin light': 'pin-light', 'hard mix': 'hard-mix', difference: 'difference', exclusion: 'exclusion', subtract: 'subtract', divide: 'divide', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity', 'pass through': 'pass' };
const PSD_BLEND_R = Object.fromEntries(Object.entries(PSD_BLEND).map(([a, b]) => [b, a]));
async function agPsd() { await loadScript(AGPSD); return window.agPsd; }
async function openPSD(f) {
  App.emit('busy', true);
  try {
    const lib = await agPsd();
    const psd = lib.readPsd(await f.arrayBuffer(), { skipThumbnail: true });
    const d = new Doc({ w: psd.width, h: psd.height, name: f.name.replace(/\.[^.]+$/, ''), transparent: true });
    d.root.children = [];
    const conv = n => {
      const isGroup = !!n.children;
      const L = new Layer({ type: isGroup ? 'group' : 'raster', name: n.name || 'Layer', visible: !n.hidden, opacity: n.opacity ?? 1, blend: PSD_BLEND[n.blendMode] || (isGroup ? 'pass' : 'normal'), clip: !!n.clipping });
      if (n.layerColor && n.layerColor !== 'none') L.color = n.layerColor;
      if (n.fillOpacity !== undefined) L.fillOpacity = n.fillOpacity;
      if (isGroup) { L.children = n.children.map(conv); L.collapsed = !n.opened; }
      else if (n.canvas) { L.canvas = n.canvas; L.x = n.left || 0; L.y = n.top || 0; }
      else { L.canvas = canvas(1, 1); }
      if (n.mask?.canvas) {
        L.mask = { canvas: n.mask.canvas, x: n.mask.left || 0, y: n.mask.top || 0, def: n.mask.defaultColor ?? 255, enabled: !n.mask.disabled, linked: !n.mask.positionRelativeToLayer, density: 1, feather: 0, rev: 1 };
      }
      if (n.text?.text && n.canvas) L.name = n.name || n.text.text.slice(0, 30);
      return L;
    };
    d.root.children = (psd.children || []).map(conv);
    if (!d.root.children.length && psd.canvas) { const L = new Layer({ name: 'Background', isBackground: true, locks: { position: true, alpha: true } }); L.canvas = psd.canvas; d.root.children.push(L); }
    const flat = d.flat(); d.activeId = flat[flat.length - 1]?.id; d.selectedIds = new Set([d.activeId]); d.layerCounter = flat.length;
    App.addDoc(d); d.history.push('Buka PSD', 'folder_open');
    toast(`PSD dibuka: ${flat.length} layer`, 'ok');
  } catch (e) { console.error(e); toast('PSD tidak dapat dibaca: ' + e.message, 'err', 4500); }
  App.emit('busy', false);
}
export async function exportPSD(d = App.doc) {
  App.emit('busy', true);
  try {
    const lib = await agPsd();
    const conv = L => {
      const n = { name: L.name, hidden: !L.visible, opacity: L.opacity, blendMode: PSD_BLEND_R[L.blend] || 'normal', clipping: L.clip };
      if (L.isGroup) { n.children = L.children.map(conv); n.opened = !L.collapsed; return n; }
      let s = null;
      if (L.type === 'raster') s = { canvas: L.canvas, x: L.x, y: L.y };
      else if (L.type !== 'adjust') s = contentSurface(L, d);
      if (s) { n.canvas = s.canvas; n.left = s.x; n.top = s.y; }
      if (L.type === 'adjust') { n.canvas = canvas(1, 1); n.left = 0; n.top = 0; n.name = L.name + ' (adjustment)'; n.hidden = true; }
      if (L.mask) n.mask = { canvas: L.mask.canvas, left: L.mask.x, top: L.mask.y, defaultColor: L.mask.def, disabled: !L.mask.enabled };
      return n;
    };
    const psd = { width: d.w, height: d.h, children: d.root.children.map(conv), canvas: flattenDoc(d) };
    const buf = lib.writePsd(psd, { generateThumbnail: true });
    download(new Blob([buf], { type: 'image/vnd.adobe.photoshop' }), `${d.name}.psd`);
    toast('PSD diekspor', 'ok');
  } catch (e) { console.error(e); toast('Gagal mengekspor PSD: ' + e.message, 'err', 4500); }
  App.emit('busy', false);
}
export async function downloadProject(d = App.doc) {
  App.emit('busy', true);
  const data = await serializeDoc(d, true);
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `${d.name}.amp`);
  App.emit('busy', false);
}

// ── Export ───────────────────────────────────────────────────────────────
export function exportCanvas(d, { scale = 1, w, h: hh, bg } = {}) {
  const src = flattenDoc(d);
  const W = Math.max(1, Math.round(w || d.w * scale)), H = Math.max(1, Math.round(hh || d.h * scale));
  let c = src;
  if (W !== d.w || H !== d.h) {
    let cw = d.w, ch = d.h;
    while (cw / 2 > W && ch / 2 > H) { cw = Math.round(cw / 2); ch = Math.round(ch / 2); const t = canvas(cw, ch), x = ctx2d(t); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, cw, ch); c = t; }
    const t = canvas(W, H), x = ctx2d(t); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, W, H); c = t;
  }
  if (bg) { const t = canvas(W, H), x = ctx2d(t); x.fillStyle = bg; x.fillRect(0, 0, W, H); x.drawImage(c, 0, 0); c = t; }
  return c;
}
export async function quickExport(type = 'png') {
  const d = App.doc; if (!d) return;
  const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[type];
  const c = exportCanvas(d, { bg: type === 'jpg' ? '#ffffff' : null });
  const blob = await canvasToBlob(c, mime, .92);
  download(blob, `${d.name}.${type}`); toast(`Diekspor sebagai ${type.toUpperCase()} (${fmtBytes(blob.size)})`, 'ok');
}
export async function exportLayers() {
  const d = App.doc; if (!d) return;
  await loadScript(JSZIP);
  const zip = new window.JSZip(); let n = 0;
  for (const L of d.flat()) {
    if (L.isGroup || L.type === 'adjust') continue;
    const s = layerSurface(L, d); if (!s) continue;
    const c = canvas(d.w, d.h); ctx2d(c).drawImage(s.canvas, s.x, s.y);
    zip.file(`${String(++n).padStart(2, '0')}_${L.name.replace(/[\\/:*?"<>|]+/g, '_')}.png`, await canvasToBlob(c));
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  download(blob, `${d.name}-layers.zip`); toast(`${n} layer diekspor`, 'ok');
}
export function printDoc() {
  const d = App.doc; if (!d) return;
  const url = flattenDoc(d).toDataURL('image/png');
  const w = window.open('', '_blank'); if (!w) { toast('Pop-up diblokir browser'); return; }
  w.document.write(`<!doctype html><title>${d.name}</title><style>@page{margin:10mm}html,body{margin:0;height:100%}img{max-width:100%;max-height:100%;display:block;margin:auto}</style><img src="${url}" onload="setTimeout(()=>print(),200)">`);
  w.document.close();
}

// Drag & drop + paste handling
export function bindDropAndPaste() {
  const dz = document.getElementById('dropzone'); let depth = 0;
  addEventListener('dragenter', e => { if (![...(e.dataTransfer?.types || [])].includes('Files')) return; e.preventDefault(); depth++; dz.classList.add('on'); });
  addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) dz.classList.remove('on'); });
  addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  addEventListener('drop', e => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault(); depth = 0; dz.classList.remove('on');
    openFiles([...e.dataTransfer.files], { asLayer: e.shiftKey || (!!App.doc && e.target.closest?.('.stage')) });
  });
  addEventListener('paste', e => {
    if (e.target.matches?.('input, textarea')) return;
    const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('image/'));
    if (!f) return;
    e.preventDefault();
    App._pasteHandled = Date.now();
    if (App.doc) openFiles([f], { asLayer: true }); else openFiles([f]);
  });
}
