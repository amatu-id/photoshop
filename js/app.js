// Amatu Photo — boot, document management, keyboard and global behaviours

import { App, invalidate, commit, toast } from './state.js';
import { $, canvas, ctx2d, keyName, storeSet } from './util.js';
import { View } from './view.js';
import { Layer, makeMask } from './doc.js';
import { Selection } from './selection.js';
import './tools/paint.js';
import './tools/select.js';
import './tools/vector.js';
import { TOOLS, opts, setOpt } from './tools/base.js';
import './transform.js';
import './ui/colorpicker.js';
import { confirmDlg, promptDlg, showMenu, closeMenus } from './ui/controls.js';
import { buildToolbar, bindOptionsBar, GROUPS } from './ui/toolsui.js';
import { buildDock } from './ui/panels.js';
import { buildMenubar, buildTabs, buildStatus, buildHome } from './ui/shell.js';
import { CMD, keymap } from './actions.js';
import { bindDropAndPaste, saveToBrowser } from './io.js';
import { DEFAULT_SWATCHES } from './color.js';
import { FONTS, loadFont, rebuildShape } from './tools/vector.js';
import { ICONS } from './icons.js';

App.icons = ICONS;
App.confirm = (m, o) => confirmDlg(m, o);
App.prompt = (m, v, o) => promptDlg(m, v, o);
App.swatches ||= [...DEFAULT_SWATCHES];

// ── Colours ──────────────────────────────────────────────────────────────
App.setFg = c => { App.fg = { r: c.r, g: c.g, b: c.b }; App.emit('colors'); };
App.setBg = c => { App.bg = { r: c.r, g: c.g, b: c.b }; App.emit('colors'); };
App.swapColors = () => { [App.fg, App.bg] = [App.bg, App.fg]; App.emit('colors'); };
App.defaultColors = () => { App.fg = { r: 0, g: 0, b: 0 }; App.bg = { r: 255, g: 255, b: 255 }; App.emit('colors'); };
App.addSwatch = hex => { if (!App.swatches.includes(hex)) { App.swatches.push(hex); storeSet('swatches', App.swatches); App.emit('swatches'); } };

// ── Documents ────────────────────────────────────────────────────────────
App.addDoc = d => {
  App.docs.push(d);
  d.on('dirty', () => App.emit('docs'));
  d.on('history', () => App.emit('history'));
  d.on('restore', () => { App.live?.clear(); App.emit('layers'); });
  App.setDoc(d);
};
App.setDoc = d => {
  if (App.transform?.active) App.transform.commit();
  App.textEdit?.commit();
  App.doc = d; App.live?.clear(); App.hidden?.clear(); App.viewSource = null; App.maskTarget = null; App.channelSel = null;
  if (App.quickMask) exitQuickMask(false);
  App.view.setDoc(d);
  App.showHome(false);
  App.emit('docchange'); App.emit('docs'); App.emit('layers'); App.emit('history'); App.emit('tool', App.toolId);
};
App.closeDoc = async d => {
  if (!d) return;
  if (d.dirty) {
    const r = await confirmDlg(`Simpan perubahan pada "${d.name}" sebelum menutup?`, { ok: 'Simpan', cancel: 'Batal', extra: 'Jangan Simpan', title: 'Amatu Photo' });
    if (r === false) return;
    if (r === true) await saveToBrowser(d);
  }
  const i = App.docs.indexOf(d); App.docs.splice(i, 1);
  if (App.doc === d) {
    const next = App.docs[Math.min(i, App.docs.length - 1)];
    if (next) App.setDoc(next);
    else { App.doc = null; App.view.setDoc(null); App.showHome(true); App.emit('docchange'); App.emit('docs'); App.emit('layers'); App.emit('history'); }
  } else App.emit('docs');
};
App.closeAll = async () => { for (const d of [...App.docs]) await App.closeDoc(d); };
App.historyGoto = i => {
  const d = App.doc; if (!d) return;
  if (App.transform?.active) App.transform.cancel();
  App.textEdit?.cancel();
  d.history.goto(i);
  if (d.view && !d._comp) d._comp = canvas(d.w, d.h);
  App.view.setDoc(d); invalidate();
};
App.undo = () => { const d = App.doc; if (!d) return; if (App.transform?.active) return App.transform.cancel(); if (d.history.canUndo) App.historyGoto(d.history.index - 1); };
App.redo = () => { const d = App.doc; if (d?.history.canRedo) App.historyGoto(d.history.index + 1); };
App.selectAdjacentLayer = dir => {
  const d = App.doc; const flat = d.flat(); const i = flat.indexOf(d.active);
  const n = flat[Math.max(0, Math.min(flat.length - 1, i + dir))]; if (n) d.setActive(n.id);
};

// ── Quick Mask: a grayscale channel painted with normal tools ────────────
function enterQuickMask() {
  const d = App.doc; if (!d) return;
  const c = canvas(d.w, d.h), x = ctx2d(c); x.fillStyle = '#000'; x.fillRect(0, 0, d.w, d.h);
  if (d.selection) x.drawImage(d.selection.canvas, 0, 0);
  App.qm = { canvas: c, x: 0, y: 0, def: 0, rev: 1, enabled: true };
  App.quickMask = true; App.emit('quickmask'); App.view.redraw();
}
function exitQuickMask(apply = true) {
  const d = App.doc; App.quickMask = false;
  if (apply && d && App.qm) { const s = Selection.fromGray(d.w, d.h, App.qm.canvas); d.selection = s.empty ? null : s; commit('Quick Mask', 'select'); }
  App.qm = null; App.emit('quickmask'); App.emit('selection'); App.view?.redraw();
}
App.toggleQuickMask = () => (App.quickMask ? exitQuickMask(true) : enterQuickMask());
App.quickMaskTarget = () => App.quickMask && App.qm ? { kind: 'mask', layer: { id: '__qm', touch() { }, _styled: null, locks: {} }, mask: App.qm, canvas: App.qm.canvas, x: 0, y: 0 } : null;

// ── Screen modes, dock ───────────────────────────────────────────────────
App.cycleScreenMode = () => {
  App.screenMode = (App.screenMode + 1) % 3;
  document.body.classList.toggle('screen-menus', App.screenMode === 1);
  document.body.classList.toggle('screen-full', App.screenMode === 2);
  setTimeout(() => App.view.resize(), 30);
  if (App.screenMode) toast(App.screenMode === 1 ? 'Full Screen dengan menu · tekan F untuk berganti' : 'Full Screen · tekan F atau Esc untuk kembali', 'info', 2000);
};
App.toggleDock = (force) => {
  const wa = $('.workarea'), hidden = force === true ? false : force === false ? true : !wa.classList.contains('dock-hidden');
  wa.classList.toggle('dock-hidden', hidden);
  if (innerWidth <= 820) $('#dock').classList.toggle('mobile-open', !hidden);
  setTimeout(() => App.view.resize(), 30);
};

// ── Preferences & theme ──────────────────────────────────────────────────
const supportsLiquid = (() => { try { const ua = navigator.userAgent; return /Chrome|Chromium|Edg\//.test(ua) && !/Mobile/.test(ua) && CSS.supports('backdrop-filter', 'url(#liquid)'); } catch { return false; } })();
App.applyPrefs = () => {
  const P = App.prefs, root = document.documentElement;
  root.dataset.theme = P.theme;
  document.body.classList.toggle('no-glass', !P.glass);
  document.body.classList.toggle('liquid-ok', P.glass && supportsLiquid && !P.theme.startsWith('classic'));
  document.body.classList.toggle('no-motion', !!P.noMotion);
  const light = P.theme === 'glass-light' || P.theme === 'classic-light';
  $('meta[name="theme-color"]').content = light ? '#e9edf5' : '#14161c';
  App.view?.refreshTheme(); App.view?.resize();
  App.emit('prefs');
};

// ── Fonts ────────────────────────────────────────────────────────────────
App.loadLocalFonts = async () => {
  if (!window.queryLocalFonts) { toast('Browser ini tidak mendukung akses font lokal (gunakan Chrome/Edge)'); return; }
  try {
    const fonts = await window.queryLocalFonts(); const fams = [...new Set(fonts.map(f => f.family))].sort();
    FONTS.local.splice(0, FONTS.local.length, ...fams.filter(f => !FONTS.system.includes(f)));
    toast(`${fams.length} font lokal dimuat`, 'ok'); App.emit('tool', App.toolId);
  } catch { toast('Izin font lokal ditolak'); }
};

// ── Default patterns ─────────────────────────────────────────────────────
function makePatterns() {
  const mk = (name, s, fn) => { const c = canvas(s, s), x = ctx2d(c); fn(x, s); App.patterns.push({ name, canvas: c }); };
  mk('Kotak-kotak', 32, (x, s) => { x.fillStyle = '#fff'; x.fillRect(0, 0, s, s); x.fillStyle = '#c9c9c9'; x.fillRect(0, 0, s / 2, s / 2); x.fillRect(s / 2, s / 2, s / 2, s / 2); });
  mk('Titik', 24, (x, s) => { x.fillStyle = '#fff'; x.fillRect(0, 0, s, s); x.fillStyle = '#222'; x.beginPath(); x.arc(s / 2, s / 2, 3.5, 0, 7); x.fill(); });
  mk('Garis Diagonal', 20, (x, s) => { x.fillStyle = '#fff'; x.fillRect(0, 0, s, s); x.strokeStyle = '#333'; x.lineWidth = 3; x.beginPath(); for (let k = -s; k < s * 2; k += 10) { x.moveTo(k, 0); x.lineTo(k + s, s); } x.stroke(); });
  mk('Grid', 32, (x, s) => { x.fillStyle = '#fff'; x.fillRect(0, 0, s, s); x.strokeStyle = '#9ab'; x.strokeRect(.5, .5, s, s); });
  mk('Noise', 64, (x, s) => { const im = x.createImageData(s, s); for (let i = 0; i < im.data.length; i += 4) { const v = 110 + Math.random() * 120; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255; } x.putImageData(im, 0, 0); });
  mk('Bata', 48, (x, s) => { x.fillStyle = '#b5523b'; x.fillRect(0, 0, s, s); x.strokeStyle = '#e8dccf'; x.lineWidth = 2; x.beginPath(); x.moveTo(0, 1); x.lineTo(s, 1); x.moveTo(0, s / 2 + 1); x.lineTo(s, s / 2 + 1); x.moveTo(s / 2, 0); x.lineTo(s / 2, s / 2); x.moveTo(1, s / 2); x.lineTo(1, s); x.stroke(); });
  mk('Kayu', 96, (x, s) => { const im = x.createImageData(s, s); for (let y = 0; y < s; y++) for (let xx = 0; xx < s; xx++) { const v = Math.sin((xx + Math.sin(y / 9) * 6) / 3.2) * .5 + .5, i = (y * s + xx) * 4; im.data[i] = 150 + v * 40; im.data[i + 1] = 100 + v * 30; im.data[i + 2] = 60 + v * 20; im.data[i + 3] = 255; } x.putImageData(im, 0, 0); });
}

// ── Sample project ───────────────────────────────────────────────────────
App.openSample = async () => {
  const { makeDocument } = await import('./ops.js');
  App.untitled++;
  const d = makeDocument({ name: 'Contoh Proyek', w: 1600, h: 1000, bg: '#ffffff' });
  const W = 1600, H = 1000, bg = d.root.children[0], x = bg.ctx;
  const sky = x.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#1d2b64'); sky.addColorStop(.55, '#f8a170'); sky.addColorStop(1, '#ffd6a5');
  x.fillStyle = sky; x.fillRect(0, 0, W, H); bg.touch();
  const sun = new Layer({ name: 'Matahari' }); sun.canvas = canvas(W, H); const sx = sun.ctx; const g = sx.createRadialGradient(1100, 520, 10, 1100, 520, 200); g.addColorStop(0, '#fff7d6'); g.addColorStop(.35, '#ffd27a'); g.addColorStop(1, 'rgba(255,170,90,0)'); sx.fillStyle = g; sx.fillRect(0, 0, W, H);
  sun.blend = 'screen'; d.root.children.push(sun);
  const mtn = (name, color, base, amp, seed) => { const L = new Layer({ name }); L.canvas = canvas(W, H); const c = L.ctx; c.fillStyle = color; c.beginPath(); c.moveTo(0, H); for (let i = 0; i <= W; i += 8) { const y = base - Math.abs(Math.sin(i / 260 + seed)) * amp - Math.sin(i / 70 + seed * 3) * amp * .12; c.lineTo(i, y); } c.lineTo(W, H); c.fill(); return L; };
  d.root.children.push(mtn('Gunung Jauh', '#6b5b95', 640, 220, 1.3), mtn('Gunung Tengah', '#3e3a6d', 760, 200, 2.7), mtn('Bukit Depan', '#1b1838', 880, 120, .4));
  const grp = new Layer({ type: 'group', name: 'Judul' });
  const t = new Layer({ type: 'text', name: 'SENJA DI LEMBAH' });
  t.text = { content: 'SENJA DI LEMBAH', font: 'Inter', weight: 800, italic: false, size: 96, color: '#ffffff', align: 'center', leading: 0, tracking: 120, x: W / 2, y: 260, box: null };
  t.styles = { dropShadow: { enabled: true, blend: 'multiply', color: '#000000', opacity: 45, angle: 120, distance: 6, spread: 0, size: 18 } };
  const sub = new Layer({ type: 'text', name: 'Amatu Photo' });
  sub.text = { content: 'Dibuat dengan Amatu Photo', font: 'Inter', weight: 500, italic: false, size: 30, color: '#ffe8c7', align: 'center', leading: 0, tracking: 40, x: W / 2, y: 320, box: null };
  grp.children.push(t, sub); d.root.children.push(grp);
  const card = new Layer({ type: 'shape', name: 'Lencana' });
  card.shape = { params: { kind: 'rect', x: 80, y: 80, w: 260, h: 64, radius: 32 }, fill: { type: 'solid', color: '#ffffff' }, stroke: null };
  card.opacity = .18; rebuildShape(card); d.root.children.push(card);
  const adj = new Layer({ type: 'adjust', name: 'Curves 1' }); adj.adjust = { kind: 'curves', params: { channel: 'rgb', rgb: [[0, 0], [64, 52], [192, 210], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [128, 118], [255, 255]] } }; adj.mask = makeMask(W, H, true);
  d.root.children.push(adj);
  d.layerCounter = 8; d.setActive(grp.children[0].id);
  await loadFont('Inter', 800);
  d.history.states = []; d.history.index = -1; d.history.push('Buka Contoh', 'folder_open'); d.dirty = false;
  App.emit('layers'); invalidate();
};

// ── Keyboard ─────────────────────────────────────────────────────────────
const PAINTERS = new Set(['brush', 'pencil', 'mixer', 'color-replace', 'eraser', 'bg-eraser', 'history-brush', 'art-history', 'gradient', 'bucket', 'shape-rect', 'shape-ellipse', 'shape-triangle', 'shape-polygon', 'shape-line', 'shape-custom', 'type', 'type-vertical', 'blur', 'sharpen', 'smudge', 'dodge', 'burn', 'sponge']);
const SIZED = new Set(['brush', 'pencil', 'mixer', 'color-replace', 'eraser', 'bg-eraser', 'history-brush', 'art-history', 'clone', 'pattern-stamp', 'healing', 'spot-healing', 'remove', 'blur', 'sharpen', 'smudge', 'dodge', 'burn', 'sponge', 'quick-select']);
let spaceDown = false, digitBuf = '', digitT;
function typing(e) { const t = e.target; return t.matches?.('input:not([type=checkbox]):not([type=range]), textarea, select, [contenteditable]'); }
addEventListener('keydown', e => {
  if (typing(e)) return;
  if ($('#dialogs').children.length) return;
  const k = keyName(e);
  if (e.key === 'Escape') {
    closeMenus();
    if (App.transform?.active) { App.transform.cancel(); e.preventDefault(); return; }
    if (App.screenMode) { App.screenMode = 2; App.cycleScreenMode(); return; }
  }
  if (e.key === 'Enter' && App.transform?.active) { e.preventDefault(); App.transform.commit(); return; }
  const tool = App.activeTool();
  if (tool?.onKey && !e.metaKey && !e.ctrlKey && tool.onKey(e)) { e.preventDefault(); return; }
  if (e.code === 'Space' && !e.repeat) {
    e.preventDefault(); if (spaceDown) return; spaceDown = true;
    App.tempTool = (e.metaKey || e.ctrlKey) ? 'zoom' : e.altKey ? 'zoom' : 'hand'; App.view.redraw(); App.emit('temptool'); return;
  }
  if (e.code === 'Space') { e.preventDefault(); return; }
  if (e.key === 'Alt' && PAINTERS.has(App.toolId) && !App.tempTool && !['eraser', 'bg-eraser', 'gradient', 'type', 'type-vertical'].includes(App.toolId) && !App.toolId.startsWith('shape')) { App.tempTool = 'eyedropper'; App.altTemp = true; e.preventDefault(); return; }
  // registered shortcuts
  const km = keymap(), C = km[k] || (k === 'Backspace' ? km.Delete : null) || (k === 'Mod+Shift+=' ? km['Mod+='] : null);
  if (C && !['Q', 'F'].includes(k)) { e.preventDefault(); if (!(typeof C.disabled === 'function' ? C.disabled() : C.disabled)) C.run(); return; }
  if (e.metaKey || e.ctrlKey) return;
  // tool letters (Shift cycles within a group)
  const letter = k.replace('Shift+', '');
  const groupsForKey = GROUPS.filter(g => g && TOOLS[g[1][0]]?.key === letter);
  if (letter.length === 1 && groupsForKey.length && !e.altKey) {
    e.preventDefault();
    const g = groupsForKey[0], cur = g[1].includes(App.toolId) ? App.toolId : App.groupCur[g[0]] || g[1][0];
    if (e.shiftKey) { const keyed = g[1].filter(id => TOOLS[id].key === letter); const i = keyed.indexOf(cur); App.setTool(keyed[(i + 1) % keyed.length]); }
    else App.setTool(cur);
    return;
  }
  switch (k) {
    case 'X': App.swapColors(); return;
    case 'D': App.defaultColors(); return;
    case 'Q': if (App.doc) App.toggleQuickMask(); return;
    case 'F': App.cycleScreenMode(); return;
    case 'Tab': e.preventDefault(); App.toggleDock(); return;
    case '[': case ']': case 'Shift+[': case 'Shift+]': {
      if (!SIZED.has(App.toolId)) return; const o = opts(App.toolId), up = k.endsWith(']');
      if (e.shiftKey) setOpt(App.toolId, 'hardness', Math.max(0, Math.min(100, (o.hardness ?? 100) + (up ? 25 : -25))));
      else { const s = o.size, step = s < 10 ? 1 : s < 50 ? 5 : s < 100 ? 10 : s < 300 ? 25 : 50; setOpt(App.toolId, 'size', Math.max(1, Math.min(5000, s + (up ? step : -step)))); }
      App.emit('brushsize'); App.emit('tool', App.toolId); App.view.redraw(); return;
    }
  }
  if (/^\d$/.test(k) && App.doc) {
    digitBuf += k; clearTimeout(digitT);
    digitT = setTimeout(() => {
      let v = digitBuf.length === 1 ? (digitBuf === '0' ? 100 : +digitBuf * 10) : Math.min(100, +digitBuf.slice(0, 2) || 100); digitBuf = '';
      if (PAINTERS.has(App.toolId) && 'opacity' in opts(App.toolId)) { setOpt(App.toolId, 'opacity', v); App.emit('tool', App.toolId); toast(`Opacity ${App.activeTool().name}: ${v}%`, 'info', 900); }
      else { for (const L of App.doc.selectedLayers()) L.opacity = v / 100; invalidate(); App.emit('layers'); commit('Opacity', 'opacity'); }
    }, 300);
  }
});
addEventListener('keyup', e => {
  if (e.code === 'Space' && spaceDown) { spaceDown = false; App.tempTool = null; App.view.redraw(); App.emit('temptool'); }
  if (e.key === 'Alt' && App.altTemp) { App.altTemp = false; App.tempTool = null; App.view.redraw(); }
});
addEventListener('blur', () => { spaceDown = false; if (App.tempTool) { App.tempTool = null; App.altTemp = false; } });

// Stage context menu
App.on('stagemenu', e => {
  if (!App.doc) return;
  const sel = !!App.doc.selection, tid = App.toolId;
  const items = [];
  if (App.transform?.active) items.push(...['tr-scale', 'tr-rotate', 'tr-skew', 'tr-distort', 'tr-perspective'].map(id => ({ label: CMD[id].label, run: () => { App.transform.st.mode = id.slice(3); } })), '-', { label: 'Rotate 180°', run: () => App.transform.rotateBy(180) }, { label: 'Rotate 90° CW', run: () => App.transform.rotateBy(90) }, { label: 'Rotate 90° CCW', run: () => App.transform.rotateBy(-90) }, '-', { label: 'Flip Horizontal', run: () => App.transform.flip('h') }, { label: 'Flip Vertical', run: () => App.transform.flip('v') }, '-', { label: 'Terapkan', run: () => App.transform.commit() }, { label: 'Batal', run: () => App.transform.cancel() });
  else if (sel) items.push(...['deselect', 'inverse', 'mod-feather', 'selectMask', '-', 'layerViaCopy', 'layerViaCut', '-', 'freeTransform', 'fill', 'stroke', 'contentAware', '-', 'saveSel'].map(id => id === '-' ? '-' : { label: CMD[id].label, key: CMD[id].key, run: CMD[id].run }));
  else items.push(...['selAll', 'subject', 'colorRange', '-', 'newLayerQuick', 'dupLayer', 'freeTransform', '-', 'paste', 'pasteInPlace', '-', 'fit', 'actual'].map(id => id === '-' ? '-' : { label: CMD[id].label, key: CMD[id].key, run: CMD[id].run }));
  if (tid === 'move' && !App.transform?.active) {
    const hits = App.doc.flat().filter(L => !L.isGroup && L.visible && L.type !== 'adjust').reverse().filter(L => { const s = App.transform.boundsOf(L); const p = App.view.toDoc(e.offsetX, e.offsetY); return s && p.x >= s.x && p.y >= s.y && p.x < s.x + s.w && p.y < s.y + s.h; }).slice(0, 8);
    if (hits.length) items.unshift({ header: 'Pilih layer' }, ...hits.map(L => ({ label: L.name, run: () => App.doc.setActive(L.id) })), '-');
  }
  showMenu(items, e.clientX, e.clientY);
});

addEventListener('beforeunload', e => { if (App.docs.some(d => d.dirty)) { e.preventDefault(); e.returnValue = ''; } });

// ── Boot ─────────────────────────────────────────────────────────────────
function boot() {
  makePatterns();
  App.applyPrefs();
  App.view = new View($('#canvashost'));
  buildMenubar(); buildToolbar(); bindOptionsBar(); buildDock(); buildTabs(); buildStatus(); buildHome();
  bindDropAndPaste();
  App.setTool(TOOLS[App.toolId] ? App.toolId : 'move');
  App.showHome(true);
  App.on('layers', () => App.view.redraw());
  App.on('selection', () => App.view.redraw());
  App.on('temptool', () => { const t = App.activeTool(); App.view.stage.style.cursor = typeof t?.cursor === 'string' ? t.cursor : 'default'; });
  App.applyPrefs();
  requestAnimationFrame(() => document.body.classList.remove('booting'));
  const p = new URLSearchParams(location.search);
  if (p.has('sample')) App.openSample();
  if (p.has('new')) CMD.new.run();
}
Promise.race([document.fonts?.ready, new Promise(r => setTimeout(r, 1500))]).then(boot);
