// Panel dock with tabbed groups and every panel implementation

import { App, commit, invalidate, toast, savePrefs } from '../state.js';
import { h, icon, $, canvas, ctx2d, clamp, rafThrottle, debounce, storeGet, storeSet, round, isMac } from '../util.js';
import { numField, sliderRow, select, check, ibtn, showMenu, colorSwatch } from './controls.js';
import { BLEND_MODES } from '../doc.js';
import { contentSurface, STYLE_NAMES, hasStyles } from '../composite.js';
import { ADJUSTMENTS, ADJ_ORDER, histogram } from '../adjust.js';
import { adjustUI } from './adjustui.js';
import { rgbCss, rgbToHex, hexToRgb, rgbToHsv, hsvToRgb, rgbToCmyk, DEFAULT_SWATCHES, GRADIENT_PRESETS, resolveStops, stopsCss } from '../color.js';
import { CMD } from '../actions.js';
import * as ops from '../ops.js';
import { opts, setOpt, TOOLS, pixelAt } from '../tools/base.js';
import { BRUSH_PRESETS, tipPreview } from '../brush.js';
import { FONTS, loadFont, rebuildShape } from '../tools/vector.js';
import { moveLayerBy } from '../tools/select.js';
import { Selection } from '../selection.js';
import { layerStyleDialog } from './dialogs.js';

const D = () => App.doc;
const LABEL_COLORS = { red: '#ff5a5f', orange: '#ff9f43', yellow: '#ffd43b', green: '#3ccf8e', blue: '#4a8cff', violet: '#a66bff', gray: '#9aa0a6' };
export const WORKSPACES = {
  essentials: [['color', 'swatches', 'gradients'], ['properties', 'adjustments', 'history'], ['layers', 'channels', 'paths']],
  photography: [['histogram', 'navigator', 'info'], ['properties', 'adjustments', 'history'], ['layers', 'channels', 'paths']],
  painting: [['color', 'swatches', 'brushes'], ['history', 'navigator', 'properties'], ['layers', 'channels']],
  graphic: [['character', 'paragraph', 'properties'], ['swatches', 'gradients', 'info'], ['layers', 'paths']],
};
const TITLES = { layers: 'Layers', channels: 'Channels', paths: 'Paths', properties: 'Properties', adjustments: 'Adjustments', color: 'Color', swatches: 'Swatches', gradients: 'Gradients', history: 'History', navigator: 'Navigator', info: 'Info', histogram: 'Histogram', brushes: 'Brushes', character: 'Character', paragraph: 'Paragraph' };
const FLEX = { layers: 3, properties: 2, history: 2, character: 2 };

// ── Dock ─────────────────────────────────────────────────────────────────
let groups = [];
export function buildDock() {
  const dock = $('#dock');
  const ws = WORKSPACES[App.prefs.workspace] || WORKSPACES.essentials;
  const saved = storeGet('dock:' + (App.prefs.workspace || 'essentials'), null);
  groups = (saved?.groups || ws).map((tabs, i) => ({ tabs: [...tabs], active: saved?.active?.[i] || tabs[0], collapsed: saved?.collapsed?.[i] || false, flex: saved?.flex?.[i] || Math.max(...tabs.map(t => FLEX[t] || 1)) }));
  renderDock();
  // resizer between dock and canvas
  const rs = h('div.resizer'); dock.append(rs);
  rs.addEventListener('pointerdown', e => {
    rs.setPointerCapture(e.pointerId); const x0 = e.clientX, w0 = dock.getBoundingClientRect().width;
    const mv = ev => { const w = clamp(w0 - (ev.clientX - x0), 220, 520); document.documentElement.style.setProperty('--dock-w', w + 'px'); App.view?.resize(); };
    const up = () => { rs.removeEventListener('pointermove', mv); rs.removeEventListener('pointerup', up); storeSet('dockW', getComputedStyle(document.documentElement).getPropertyValue('--dock-w')); };
    rs.addEventListener('pointermove', mv); rs.addEventListener('pointerup', up);
  });
  const w = storeGet('dockW', null); if (w) document.documentElement.style.setProperty('--dock-w', w);
}
function saveDock() { storeSet('dock:' + (App.prefs.workspace || 'essentials'), { groups: groups.map(g => g.tabs), active: groups.map(g => g.active), collapsed: groups.map(g => g.collapsed), flex: groups.map(g => g.flex) }); }
function renderDock() {
  const dock = $('#dock'); [...dock.querySelectorAll('.pgroup')].forEach(e => { e._cleanup?.(); e.remove(); });
  groups.forEach((g, gi) => {
    const head = h('div.phead'), body = h('div.pbody'), el = h('div.pgroup' + (g.collapsed ? '.collapsed' : ''), head, body);
    el.style.flex = g.collapsed ? '0 0 auto' : `${g.flex} 1 0`;
    for (const t of g.tabs) { const b = h('button.ptab' + (t === g.active ? '.on' : ''), { type: 'button', text: TITLES[t] }); b.onclick = () => { if (g.collapsed) g.collapsed = false; g.active = t; saveDock(); renderDock(); }; b.ondblclick = () => { g.collapsed = !g.collapsed; saveDock(); renderDock(); }; head.append(b); }
    head.append(h('span.sp'), ibtn(g.collapsed ? 'expand_more' : 'expand_less', g.collapsed ? 'Buka panel' : 'Ciutkan panel', () => { g.collapsed = !g.collapsed; saveDock(); renderDock(); }, { cls: '.sm' }),
      ibtn('more_horiz', 'Menu panel', e => showMenu(panelMenu(g.active), e.clientX, e.clientY, { alignRight: true }), { cls: '.sm' }));
    dock.insertBefore(el, dock.querySelector('.resizer'));
    if (!g.collapsed) { const p = PANELS[g.active]; if (p) el._cleanup = p(body); }
    if (gi < groups.length - 1 && !g.collapsed) {
      const sp = h('div.gsplit'); dock.insertBefore(sp, dock.querySelector('.resizer'));
      sp.addEventListener('pointerdown', e => {
        sp.setPointerCapture(e.pointerId); const y0 = e.clientY, a = g, b = groups[gi + 1], fa = a.flex, fb = b.flex, tot = el.getBoundingClientRect().height;
        const mv = ev => { const dy = (ev.clientY - y0) / tot * fa; a.flex = clamp(fa + dy, .3, 8); b.flex = clamp(fb - dy, .3, 8); renderFlex(); };
        const up = () => { sp.removeEventListener('pointermove', mv); sp.removeEventListener('pointerup', up); saveDock(); };
        sp.addEventListener('pointermove', mv); sp.addEventListener('pointerup', up);
      });
    }
  });
  [...dock.querySelectorAll('.gsplit')].forEach(sp => { if (!sp.nextElementSibling?.classList.contains('pgroup')) sp.remove(); });
}
function renderFlex() { [...$('#dock').querySelectorAll('.pgroup')].forEach((el, i) => { const g = groups[i]; if (g && !g.collapsed) el.style.flex = `${g.flex} 1 0`; }); }
function panelMenu(id) {
  const items = [{ label: 'Tutup tab', run: () => { const g = groups.find(x => x.tabs.includes(id)); g.tabs = g.tabs.filter(t => t !== id); if (!g.tabs.length) groups = groups.filter(x => x !== g); else g.active = g.tabs[0]; saveDock(); renderDock(); } }, { label: 'Reset workspace', run: () => App.setWorkspace(App.prefs.workspace || 'essentials', true) }];
  if (id === 'layers') items.unshift({ label: 'Layer baru…', run: () => CMD.newLayer.run() }, { label: 'Duplikat layer', run: () => CMD.dupLayer.run() }, { label: 'Hapus layer', run: () => CMD.delLayer.run() }, '-', { label: 'Merge Down', run: () => CMD.mergeDown.run() }, { label: 'Flatten Image', run: () => CMD.flatten.run() }, '-');
  if (id === 'history') items.unshift({ label: 'Snapshot baru', run: () => D()?.history.snapshot() }, { label: 'Hapus riwayat (sisakan status saat ini)', run: () => { const hh = D()?.history; if (!hh) return; hh.states = [hh.states[hh.index]]; hh.index = 0; App.emit('history'); } }, '-');
  if (id === 'swatches') items.unshift({ label: 'Reset swatches', run: () => { App.swatches = [...DEFAULT_SWATCHES]; storeSet('swatches', App.swatches); App.emit('swatches'); } }, '-');
  return items;
}
App.on('showpanel', id => {
  App.toggleDock?.(true);
  let g = groups.find(x => x.tabs.includes(id));
  if (!g) { g = groups[0]; g.tabs.push(id); }
  g.active = id; g.collapsed = false; saveDock(); renderDock();
  $('#dock').classList.add('mobile-open');
});
App.setWorkspace = (id, reset = false) => { App.prefs.workspace = id; savePrefs(); if (reset) storeSet('dock:' + id, null); buildDock(); };

// Helper: render on events while mounted
function live(el, events, render, ms = 0) {
  const fn = ms ? debounce(render, ms) : rafThrottle(render);
  const offs = events.map(e => App.on(e, () => { if (el.isConnected) fn(); }));
  render();
  return () => offs.forEach(o => o());
}

// ── Thumbnails ───────────────────────────────────────────────────────────
function layerThumb(L, w = 34, hh = 28) {
  const d = D();
  if (L._thumb && L._thumbRev === L.rev && L._thumbDocRev === d.history.index) return L._thumb;
  const c = canvas(w * 2, hh * 2), x = ctx2d(c);
  let src = null;
  try {
    if (L.isGroup) src = null;
    else { const s = contentSurface(L, d); if (s) { const t = canvas(d.w, d.h); ctx2d(t).drawImage(s.canvas, s.x, s.y); src = t; } }
  } catch { /* thumbnail is best-effort */ }
  if (src) { const k = Math.min(c.width / d.w, c.height / d.h); x.imageSmoothingQuality = 'high'; x.drawImage(src, (c.width - d.w * k) / 2, (c.height - d.h * k) / 2, d.w * k, d.h * k); }
  L._thumb = c; L._thumbRev = L.rev; L._thumbDocRev = d.history.index;
  return c;
}
function maskThumb(L, w = 34, hh = 28) {
  const d = D(), m = L.mask, c = canvas(w * 2, hh * 2), x = ctx2d(c), k = Math.min(c.width / d.w, c.height / d.h);
  x.fillStyle = m.def === 255 ? '#fff' : '#000'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(m.canvas, (c.width - d.w * k) / 2 + m.x * k, (c.height - d.h * k) / 2 + m.y * k, m.canvas.width * k, m.canvas.height * k);
  if (!m.enabled) { x.strokeStyle = '#ff3b30'; x.lineWidth = 4; x.beginPath(); x.moveTo(0, 0); x.lineTo(c.width, c.height); x.moveTo(c.width, 0); x.lineTo(0, c.height); x.stroke(); }
  return c;
}

// ── Layers panel ─────────────────────────────────────────────────────────
function layersPanel(el) {
  const top = h('div.lp-top'), list = h('div.layers'), foot = h('div.pfoot');
  const wrap = h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, top, h('div', { style: { flex: 1, overflow: 'auto', minHeight: 0 } }, list), foot);
  el.append(wrap);
  let lastClick = null;
  const blendSel = select(BLEND_MODES.map(b => b && [b[0], b[1]]), 'normal', v => { for (const L of D().selectedLayers()) { if (v === 'pass' && !L.isGroup) continue; L.blend = v; L.touch(); } invalidate(); commit('Blend Mode', 'layers'); });
  const opF = numField({ label: 'Opacity:', value: 100, min: 0, max: 100, unit: '%', width: 40, dd: true, onInput: v => { for (const L of D().selectedLayers()) { L.opacity = v / 100; L._styled = null; } invalidate(); }, onChange: () => commit('Opacity', 'opacity') });
  const fillF = numField({ label: 'Fill:', value: 100, min: 0, max: 100, unit: '%', width: 40, dd: true, onInput: v => { for (const L of D().selectedLayers()) { L.fillOpacity = v / 100; L._styled = null; } invalidate(); }, onChange: () => commit('Fill Opacity', 'opacity') });
  const lockBtn = (ic, key, tip) => ibtn(ic, tip, () => { const L = D()?.active; if (!L) return; L.locks[key] = !L.locks[key]; App.emit('layers'); commit('Kunci', 'lock'); });
  const locks = [lockBtn('grid_on', 'alpha', 'Kunci piksel transparan'), lockBtn('brush', 'pixels', 'Kunci piksel gambar'), lockBtn('open_with', 'position', 'Kunci posisi'), lockBtn('lock', 'all', 'Kunci semua')];
  locks.forEach(b => b.classList.add('sm'));
  top.append(h('div.full', blendSel, opF), h('div.full', h('span.ob-label', { text: 'Lock:' }), h('div.lockrow', ...locks), h('span', { style: { flex: 1 } }), fillF));
  foot.append(
    ibtn('link', 'Tautkan layer (grup)', () => CMD.group.run()),
    ibtn('', 'Tambah layer style', e => showMenu(['layerStyle', '-', 'ls-bevel', 'ls-stroke', 'ls-innerShadow', 'ls-innerGlow', 'ls-satin', 'ls-colorOverlay', 'ls-gradientOverlay', 'ls-outerGlow', 'ls-dropShadow'].map(id => id === '-' ? '-' : { label: CMD[id].label, run: CMD[id].run }), e.clientX, e.clientY - 300), { svg: '<svg viewBox="0 0 24 24"><text x="4" y="17" font-size="14" font-style="italic" font-weight="700" fill="currentColor" font-family="Georgia,serif">fx</text></svg>' }),
    ibtn('vignette', 'Tambah layer mask', () => ops.addMask('reveal')),
    ibtn('contrast', 'Buat fill / adjustment layer baru', e => showMenu([{ label: 'Solid Color…', run: CMD.fillSolid.run }, { label: 'Gradient…', run: CMD.fillGradient.run }, { label: 'Pattern…', run: CMD.fillPattern.run }, '-', ...ADJ_ORDER.flatMap((g, i) => [...g.map(k => ({ label: ADJUSTMENTS[k].name + '…', run: () => ops.newAdjustmentLayer(k) })), i < 2 ? '-' : null]).filter(Boolean)], e.clientX, e.clientY - 420)),
    ibtn('create_new_folder', 'Buat grup baru', () => ops.newGroup()),
    ibtn('add_box', 'Buat layer baru|Shift+Mod+N', e => e.altKey ? CMD.newLayer.run() : ops.newLayer()),
    ibtn('delete', 'Hapus layer', () => ops.deleteLayers()));

  const render = () => {
    const d = D(); list.replaceChildren();
    if (!d) { list.append(h('div.props-empty', { text: 'Tidak ada dokumen' })); return; }
    const A = d.active;
    blendSel.value = A?.blend || 'normal'; opF.set(Math.round((A?.opacity ?? 1) * 100)); fillF.set(Math.round((A?.fillOpacity ?? 1) * 100));
    locks.forEach((b, i) => b.classList.toggle('on', !!A?.locks[['alpha', 'pixels', 'position', 'all'][i]]));
    const rows = [];
    const walk = (node, depth) => { for (let i = node.children.length - 1; i >= 0; i--) { const L = node.children[i]; rows.push([L, depth]); if (L.isGroup && !L.collapsed) walk(L, depth + 1); } };
    walk(d.root, 0);
    for (const [L, depth] of rows) list.append(row(L, depth));
  };
  const row = (L, depth) => {
    const d = D();
    const r = h('div.lrow' + (d.selectedIds.has(L.id) ? '.sel' : '') + (d.activeId === L.id ? '.active' : '') + (L.visible ? '' : '.hidden'), { 'data-id': L.id });
    if (L.color && LABEL_COLORS[L.color]) r.append(h('div.colorlabel', { style: { background: LABEL_COLORS[L.color] } }));
    const eye = h('button.eye', { type: 'button', 'aria-label': 'Visibilitas' }, icon(L.visible ? 'visibility' : 'visibility_off'));
    eye.onclick = e => {
      e.stopPropagation();
      if (e.altKey) { const others = d.flat().filter(x => x !== L && !x.isGroup); const solo = others.some(x => x.visible); others.forEach(x => { x.visible = !solo; }); L.visible = true; }
      else L.visible = !L.visible;
      invalidate(); App.emit('layers'); commit('Visibilitas Layer', 'visibility');
    };
    r.append(eye, h('span.ind', { style: { width: depth * 14 + 'px' } }));
    if (L.isGroup) { const tw = h('button.twist' + (L.collapsed ? '.closed' : ''), { type: 'button' }, icon('expand_more')); tw.onclick = e => { e.stopPropagation(); L.collapsed = !L.collapsed; render(); }; r.append(tw); }
    else r.append(h('span', { style: { width: '14px', flex: 'none' } }));
    if (L.clip) r.append(h('span.clipmark.ms', { text: 'subdirectory_arrow_right' }));
    // main thumb
    let th;
    if (L.isGroup) th = h('div.thumb.kind', icon(L.collapsed ? 'folder' : 'folder_open'));
    else if (L.type === 'adjust') th = h('div.thumb.kind', icon(ADJUSTMENTS[L.adjust.kind]?.icon || 'tune'));
    else if (L.type === 'text') th = h('div.thumb.kind', h('b', { text: 'T', style: { fontSize: '16px', fontFamily: 'Georgia, serif' } }));
    else if (L.type === 'fill' && L.fill.kind === 'solid') th = h('div.thumb', { style: { background: L.fill.color } });
    else { th = h('div.thumb'); th.append(layerThumb(L)); }
    if (L.mask && App.maskTarget !== L.id) th.classList.add('target');
    if (!L.mask && d.activeId === L.id) th.classList.add('target');
    th.addEventListener('click', e => {
      if (e.metaKey || e.ctrlKey) { e.stopPropagation(); ops.loadLayerSelection(L, e.shiftKey ? (e.altKey ? 'int' : 'add') : e.altKey ? 'sub' : 'new'); return; }
      if (App.maskTarget === L.id) { App.maskTarget = null; App.viewSource = null; invalidate(); }
    });
    th.addEventListener('dblclick', e => {
      e.stopPropagation();
      if (L.type === 'adjust' || L.type === 'fill' || L.type === 'shape') { App.emit('showpanel', 'properties'); if (L.type === 'fill' && L.fill.kind === 'solid') App.pickColor(L.fill.color, { title: 'Color Picker (Solid Color)' }).then(c => { if (c) { L.fill.color = c; L._cache = null; L.touch(); invalidate(); commit('Ubah Fill', 'format_color_fill'); } }); return; }
      if (L.type === 'text') { App.setTool('type'); TOOLS.type.edit(L); return; }
      layerStyleDialog('blending');
    });
    r.append(th);
    if (L.mask) {
      r.append(h('span.link.ms', { text: L.mask.linked ? 'link' : '', style: { cursor: 'pointer' }, onclick: e => { e.stopPropagation(); L.mask.linked = !L.mask.linked; render(); } }));
      const mt = h('div.thumb.mask' + (App.maskTarget === L.id ? '.target' : '')); mt.append(maskThumb(L));
      mt.addEventListener('click', e => {
        e.stopPropagation();
        if (e.shiftKey) { ops.toggleMask(); return; }
        if (e.metaKey || e.ctrlKey) { ops.loadMaskSelection(L); return; }
        d.setActive(L.id); App.maskTarget = L.id;
        if (e.altKey) { App.viewSource = App.viewSource ? null : () => { const c = canvas(d.w, d.h), x = ctx2d(c); x.fillStyle = L.mask.def === 255 ? '#fff' : '#000'; x.fillRect(0, 0, d.w, d.h); x.drawImage(L.mask.canvas, L.mask.x, L.mask.y); return c; }; invalidate(); }
        App.emit('layers');
      });
      mt.addEventListener('dblclick', e => { e.stopPropagation(); App.emit('showpanel', 'properties'); });
      r.append(mt);
    }
    const nm = h('div.lname', { text: L.name });
    nm.addEventListener('dblclick', e => {
      e.stopPropagation();
      const inp = h('input.inp', { value: L.name }); nm.replaceChildren(inp); inp.focus(); inp.select();
      const done = ok => { if (ok && inp.value.trim() && inp.value !== L.name) { L.name = inp.value.trim(); commit('Ganti Nama Layer', 'edit'); } render(); };
      inp.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
      inp.addEventListener('blur', () => done(true));
    });
    r.append(nm);
    const badges = h('div.badges');
    if (hasStyles(L)) { const fx = h('span.fx', { text: 'fx', style: { cursor: 'pointer' } }); fx.onclick = e => { e.stopPropagation(); L._fxOpen = !L._fxOpen; render(); }; badges.append(fx); }
    if (L.locks.all || L.locks.pixels || L.locks.position || L.locks.alpha || L.isBackground) badges.append(icon(L.locks.all || L.isBackground ? 'lock' : 'lock_open'));
    r.append(badges);
    r.addEventListener('click', e => {
      if (e.shiftKey && lastClick) {
        const ids = [...list.querySelectorAll('.lrow')].map(x => x.dataset.id), a = ids.indexOf(lastClick), b = ids.indexOf(L.id);
        d.selectedIds = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)); d.activeId = L.id; App.emit('layers'); return;
      }
      if (e.metaKey || e.ctrlKey) { if (d.selectedIds.has(L.id) && d.selectedIds.size > 1) d.selectedIds.delete(L.id); else d.selectedIds.add(L.id); d.activeId = L.id; App.emit('layers'); lastClick = L.id; return; }
      lastClick = L.id; if (App.maskTarget && App.maskTarget !== L.id) App.maskTarget = null;
      if (L.mask && App.maskTarget !== L.id && d.activeId !== L.id) App.maskTarget = null;
      d.setActive(L.id); App.viewSource = null;
    });
    r.addEventListener('dblclick', () => { if (L.isBackground) { ops.convertBackground(L); commit('Layer dari Background', 'layers'); } else layerStyleDialog('blending'); });
    r.addEventListener('contextmenu', e => {
      e.preventDefault(); if (!d.selectedIds.has(L.id)) d.setActive(L.id);
      showMenu([{ label: 'Blending Options…', run: () => layerStyleDialog('blending') }, '-', { label: 'Duplikat Layer', run: CMD.dupLayer.run }, { label: 'Hapus Layer', run: CMD.delLayer.run }, { label: 'Group from Layers', run: CMD.group.run }, '-',
        { label: 'Pilih Piksel', run: () => ops.loadLayerSelection(L) }, L.mask ? { label: 'Disable Layer Mask', run: () => ops.toggleMask() } : { label: 'Add Layer Mask', run: () => ops.addMask('reveal') }, L.mask ? { label: 'Apply Layer Mask', run: () => ops.deleteMask(true) } : null, L.mask ? { label: 'Delete Layer Mask', run: () => ops.deleteMask(false) } : null, '-',
        { label: L.clip ? 'Release Clipping Mask' : 'Create Clipping Mask', run: CMD.clip.run }, { label: 'Rasterize Layer', run: CMD.rasterize.run, disabled: CMD.rasterize.disabled }, { label: 'Rasterize Layer Style', run: CMD.rasterizeStyle.run, disabled: CMD.rasterizeStyle.disabled }, '-',
        { label: 'Copy Layer Style', run: CMD.copyStyle.run, disabled: CMD.copyStyle.disabled }, { label: 'Paste Layer Style', run: CMD.pasteStyle.run, disabled: CMD.pasteStyle.disabled }, { label: 'Clear Layer Style', run: CMD.clearStyle.run, disabled: CMD.clearStyle.disabled }, '-',
        { label: 'Merge Down', run: CMD.mergeDown.run }, { label: 'Merge Visible', run: CMD.mergeVisible.run }, { label: 'Flatten Image', run: CMD.flatten.run }, '-',
        { label: 'Warna label', sub: [['', 'Tanpa warna'], ...Object.keys(LABEL_COLORS).map(k => [k, { red: 'Merah', orange: 'Oranye', yellow: 'Kuning', green: 'Hijau', blue: 'Biru', violet: 'Ungu', gray: 'Abu-abu' }[k]])].map(([k, n]) => ({ label: n, checked: (L.color || '') === k, run: () => { for (const x of d.selectedLayers()) x.color = k || null; App.emit('layers'); } })) },
      ].filter(Boolean), e.clientX, e.clientY);
    });
    // drag to reorder
    r.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button, input, .thumb')) return;
      const y0 = e.clientY; let dragging = false, target = null, pos = null;
      const mv = ev => {
        if (!dragging && Math.abs(ev.clientY - y0) < 5) return; dragging = true;
        list.querySelectorAll('.drop-above,.drop-below,.drop-into').forEach(x => x.classList.remove('drop-above', 'drop-below', 'drop-into'));
        const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.lrow'); if (!over || over === r) { target = null; return; }
        const rr = over.getBoundingClientRect(), t = (ev.clientY - rr.top) / rr.height, OL = d.find(over.dataset.id);
        pos = OL?.isGroup && t > .3 && t < .7 ? 'into' : t < .5 ? 'above' : 'below'; target = OL;
        over.classList.add('drop-' + pos);
      };
      const up = () => {
        removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
        list.querySelectorAll('.drop-above,.drop-below,.drop-into').forEach(x => x.classList.remove('drop-above', 'drop-below', 'drop-into'));
        if (!dragging || !target) return;
        const moving = d.selectedIds.has(L.id) ? d.selectedLayers() : [L];
        if (moving.some(m => m.isBackground) || moving.includes(target)) return;
        for (const m of [...moving].reverse()) {
          if (pos === 'into') d.moveTo(m, target, target.children.length);
          else { const p = d.parentOf(target), i = p.children.indexOf(target); d.moveTo(m, p, pos === 'above' ? i + 1 : i); }
        }
        const bg = d.root.children.findIndex(x => x.isBackground); if (bg > 0) { const B = d.root.children.splice(bg, 1)[0]; d.root.children.unshift(B); }
        invalidate(); App.emit('layers'); commit('Pindah Layer', 'swap_vert');
      };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
    if (!hasStyles(L) || !L._fxOpen) return r;
    const box = h('div', r);
    box.append(h('div.fxrow', icon('auto_awesome'), h('span', { text: 'Effects' })));
    for (const [k, n] of Object.entries(STYLE_NAMES)) if (L.styles[k]?.enabled) { const fr = h('div.fxrow', { style: { cursor: 'pointer' } }, icon('visibility'), h('span', { text: n })); fr.ondblclick = () => layerStyleDialog(k); box.append(fr); }
    return box;
  };
  const off = live(el, ['layers', 'history', 'docchange', 'restore'], render);
  const offT = App.on('composited', debounce(() => { if (el.isConnected) { for (const c of list.querySelectorAll('.lrow')) { const L = D()?.find(c.dataset.id); if (L && L._thumbRev !== L.rev) { const th = c.querySelector('.thumb:not(.kind):not(.mask)'); if (th && th.firstChild?.tagName === 'CANVAS') th.replaceChildren(layerThumb(L)); } } } }, 350));
  return () => { off(); offT(); };
}

// ── Channels ─────────────────────────────────────────────────────────────
function channelsPanel(el) {
  const list = h('div.ch-list'), foot = h('div.pfoot');
  el.append(h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, h('div', { style: { flex: 1, overflow: 'auto' } }, list), foot));
  foot.append(ibtn('select', 'Muat channel sebagai seleksi', () => { const d = D(), c = d?.channels.find(x => x.id === App.channelSel); if (!c) return; const sl = new Selection(d.w, d.h); sl.ctx.drawImage(c.canvas, 0, 0); sl.touch(); ops.setSel(sl, 'Muat Seleksi'); }),
    ibtn('save', 'Simpan seleksi sebagai channel', () => ops.saveSelectionChannel()), ibtn('delete', 'Hapus channel', () => { const d = D(); if (!d) return; d.channels = d.channels.filter(c => c.id !== App.channelSel); App.channelSel = null; App.viewSource = null; invalidate(); App.emit('channels'); }));
  const thumbOf = (fn) => { const d = D(), k = Math.min(92 / d.w, 68 / d.h), c = canvas(Math.max(1, d.w * k), Math.max(1, d.h * k)); fn(ctx2d(c), k); return c; };
  const chanCanvas = ch => () => {
    const d = D(), src = d._comp, img = ctx2d(src).getImageData(0, 0, d.w, d.h), o = img.data, idx = { r: 0, g: 1, b: 2 }[ch];
    for (let i = 0; i < o.length; i += 4) { const v = o[i + idx] * o[i + 3] / 255 + 255 * (1 - o[i + 3] / 255); o[i] = o[i + 1] = o[i + 2] = v; o[i + 3] = 255; }
    const c = canvas(d.w, d.h); ctx2d(c).putImageData(img, 0, 0); return c;
  };
  const render = () => {
    const d = D(); list.replaceChildren(); if (!d) return;
    const sel = App.channelSel || 'rgb';
    const mk = (id, name, key, draw, onClick) => {
      const c = thumbOf(draw); const r = h('div.ch' + (sel === id ? '.sel' : ''), c, h('span', { text: name }), key ? h('kbd', { text: key }) : null);
      r.onclick = e => onClick(e); list.append(r);
    };
    const comp = d._comp;
    mk('rgb', 'RGB', (isMac ? '⌘' : 'Ctrl+') + '2', (x, k) => x.drawImage(comp, 0, 0, d.w * k, d.h * k), () => { App.channelSel = 'rgb'; App.viewSource = null; invalidate(); render(); });
    for (const [id, n] of [['r', 'Red'], ['g', 'Green'], ['b', 'Blue']]) mk(id, n, (isMac ? '⌘' : 'Ctrl+') + (3 + ['r', 'g', 'b'].indexOf(id)), (x, k) => x.drawImage(chanCanvas(id)(), 0, 0, d.w * k, d.h * k), e => {
      if (e.metaKey || e.ctrlKey) { const c = chanCanvas(id)(); ops.setSel(Selection.fromGray(d.w, d.h, c), 'Muat Channel'); return; }
      App.channelSel = id; App.viewSource = chanCanvas(id); invalidate(); render();
    });
    if (App.quickMask) mk('qm', 'Quick Mask', null, (x, k) => { x.fillStyle = '#000'; x.fillRect(0, 0, d.w * k, d.h * k); if (d.selection) x.drawImage(d.selection.canvas, 0, 0, d.w * k, d.h * k); }, () => { });
    for (const ch of d.channels) mk(ch.id, ch.name, null, (x, k) => { x.fillStyle = '#000'; x.fillRect(0, 0, d.w * k, d.h * k); x.drawImage(ch.canvas, 0, 0, d.w * k, d.h * k); }, e => {
      if (e.metaKey || e.ctrlKey) { const s = new Selection(d.w, d.h); s.ctx.drawImage(ch.canvas, 0, 0); s.touch(); ops.setSel(s, 'Muat Seleksi'); return; }
      App.channelSel = ch.id; App.viewSource = () => { const c = canvas(d.w, d.h), x = ctx2d(c); x.fillStyle = '#000'; x.fillRect(0, 0, d.w, d.h); x.drawImage(ch.canvas, 0, 0); return c; }; invalidate(); render();
    });
  };
  return live(el, ['channels', 'history', 'docchange', 'quickmask', 'composited'], render, 400);
}

// ── Paths ────────────────────────────────────────────────────────────────
function pathsPanel(el) {
  const list = h('div.ch-list'), foot = h('div.pfoot');
  el.append(h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, h('div', { style: { flex: 1, overflow: 'auto' } }, list), foot));
  foot.append(ibtn('format_color_fill', 'Isi path dengan warna depan', () => CMD.fillPath.run()), ibtn('border_style', 'Stroke path dengan brush', () => CMD.strokePath.run()), ibtn('select', 'Muat path sebagai seleksi', () => CMD.pathToSelection.run()),
    ibtn('vignette', 'Tambah mask dari path', () => CMD.pathToMask.run()), ibtn('add_box', 'Path baru', () => { const d = D(); if (!d) return; const P = { id: 'P' + Date.now(), name: `Path ${d.paths.length + 1}`, subpaths: [] }; d.paths.push(P); d.activePathId = P.id; App.pathTarget = 'doc'; App.emit('paths'); }),
    ibtn('delete', 'Hapus path', () => { const d = D(); if (!d) return; d.paths = d.paths.filter(p => p.id !== d.activePathId); d.activePathId = null; App.emit('paths'); App.view.redraw(); commit('Hapus Path', 'delete'); }));
  const thumb = subs => { const d = D(), k = Math.min(92 / d.w, 68 / d.h), c = canvas(Math.max(1, d.w * k), Math.max(1, d.h * k)), x = ctx2d(c); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.scale(k, k); x.lineWidth = 1 / k; x.strokeStyle = '#333'; x.fillStyle = 'rgba(0,0,0,.25)'; import('../composite.js').then(m => { const p = m.shapePath({ subpaths: subs }); x.fill(p); x.stroke(p); }); return c; };
  const render = () => {
    const d = D(); list.replaceChildren(); if (!d) return;
    const L = d.active;
    if (L?.type === 'shape') { const r = h('div.ch' + (App.pathTarget !== 'doc' ? '.sel' : ''), thumb(L.shape.subpaths), h('i', { text: `${L.name} Shape Path` })); r.onclick = () => { App.pathTarget = 'layer'; render(); App.view.redraw(); }; list.append(r); }
    for (const P of d.paths) {
      const r = h('div.ch' + (P.id === d.activePathId && App.pathTarget === 'doc' ? '.sel' : ''), thumb(P.subpaths), h(P.work ? 'i' : 'span', { text: P.name }));
      r.onclick = e => { d.activePathId = P.id; App.pathTarget = 'doc'; if (e.metaKey || e.ctrlKey) CMD.pathToSelection.run(); render(); App.view.redraw(); };
      r.ondblclick = async () => { const n = await App.prompt('Nama path:', P.work ? 'Path 1' : P.name); if (n) { P.name = n; P.work = false; render(); } };
      list.append(r);
    }
    if (!list.children.length) list.append(h('div.props-empty', { text: 'Belum ada path. Gunakan Pen Tool (P).' }));
  };
  return live(el, ['paths', 'history', 'docchange', 'layers'], render);
}

// ── Properties ───────────────────────────────────────────────────────────
function propertiesPanel(el) {
  const render = () => {
    el.replaceChildren(); const d = D();
    if (!d) { el.append(h('div.props-empty', { text: 'Tidak ada properti' })); return; }
    const L = d.active;
    const amend = debounce(lbl => commit(lbl, 'tune'), 500);
    if (!L) { docProps(el, d); return; }
    if (L.type === 'adjust') {
      const A = ADJUSTMENTS[L.adjust.kind];
      el.append(h('div.props-head', icon(A.icon), h('span', { text: A.name })));
      const body = h('div.pad');
      body.append(adjustUI(L.adjust.kind, L.adjust.params, fin => { L.touch(); invalidate(); if (fin) amend(A.name); }));
      body.append(h('div.prow', { style: { marginTop: '10px' } }, ibtn('subdirectory_arrow_right', 'Clip ke layer di bawah', () => ops.toggleClip()), ibtn('visibility', 'Toggle visibilitas', () => { L.visible = !L.visible; invalidate(); App.emit('layers'); }), ibtn('restart_alt', 'Reset ke default', () => { L.adjust.params = structuredClone(A.defaults); L.touch(); invalidate(); commit('Reset Adjustment', 'restart_alt'); render(); }), ibtn('delete', 'Hapus layer', () => ops.deleteLayers())));
      el.append(body); maskProps(el, L); return;
    }
    if (L.type === 'fill') {
      el.append(h('div.props-head', icon('format_color_fill'), h('span', { text: L.name })));
      const body = h('div.pad'); const f = L.fill, upd = () => { L._cache = null; L.touch(); invalidate(); amend('Ubah Fill'); };
      if (f.kind === 'solid') body.append(h('div.prow', h('label', { text: 'Warna' }), colorSwatch(() => f.color, c => { f.color = c; upd(); })));
      if (f.kind === 'gradient') {
        const bar = h('div.grad-bar', { style: { flex: 1 } }); const paint = () => { bar.style.background = stopsCss(resolveStops(f.stops, App.fg, App.bg)); }; paint();
        bar.onclick = async () => { const st = await App.editGradient(f.stops); if (st) { f.stops = st; paint(); upd(); } };
        body.append(h('div.prow', h('label', { text: 'Gradient' }), bar), h('div.prow', h('label', { text: 'Style' }), select([['linear', 'Linear'], ['radial', 'Radial'], ['angle', 'Angle'], ['reflected', 'Reflected'], ['diamond', 'Diamond']], f.type, v => { f.type = v; upd(); })),
          sliderRow({ label: 'Angle', value: f.angle, min: -180, max: 180, unit: '°', onInput: v => { f.angle = v; upd(); } }), sliderRow({ label: 'Scale', value: f.scale, min: 10, max: 150, unit: '%', onInput: v => { f.scale = v; upd(); } }), check('Reverse', f.reverse, v => { f.reverse = v; upd(); }));
      }
      if (f.kind === 'pattern') body.append(sliderRow({ label: 'Scale', value: f.scale || 100, min: 1, max: 1000, unit: '%', onInput: v => { f.scale = v; upd(); } }));
      el.append(body); maskProps(el, L); return;
    }
    const kindName = { raster: 'Pixel Layer', text: 'Type Layer', shape: 'Live Shape', group: 'Group' }[L.type];
    el.append(h('div.props-head', icon({ raster: 'image', text: 'title', shape: 'category', group: 'folder' }[L.type]), h('span', { text: kindName })));
    const body = h('div.pad'); el.append(body);
    const b = App.transform.boundsOf(L);
    if (b) {
      body.append(h('div.sect', { text: 'Transform' }));
      const mv = (dx, dy) => { moveLayerBy(L, dx, dy); invalidate(); amend('Move'); };
      body.append(h('div.two', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } },
        numField({ label: 'W', value: Math.round(b.w), min: 1, max: 30000, unit: 'px', width: 54, onChange: v => { if (L.type === 'shape' && L.shape.params?.w !== undefined) { L.shape.params.w = v; rebuildShape(L); invalidate(); amend('Ubah Shape'); render(); } else { App.transform.start('free').then(() => { App.transform.setNumeric('w', v / b.w * 100); App.transform.commit(); render(); }); } } }),
        numField({ label: 'H', value: Math.round(b.h), min: 1, max: 30000, unit: 'px', width: 54, onChange: v => { if (L.type === 'shape' && L.shape.params?.h !== undefined) { L.shape.params.h = v; rebuildShape(L); invalidate(); amend('Ubah Shape'); render(); } else { App.transform.start('free').then(() => { App.transform.setNumeric('h', v / b.h * 100); App.transform.commit(); render(); }); } } }),
        numField({ label: 'X', value: Math.round(b.x), min: -30000, max: 30000, unit: 'px', width: 54, onChange: v => mv(Math.round(v - b.x), 0) }),
        numField({ label: 'Y', value: Math.round(b.y), min: -30000, max: 30000, unit: 'px', width: 54, onChange: v => mv(0, Math.round(v - b.y)) })));
      body.append(h('div.prow', { style: { marginTop: '6px' } }, ibtn('flip', 'Flip horizontal', () => ops.flipLayer('h')), ibtn('flip', 'Flip vertikal', () => ops.flipLayer('v')), ibtn('rotate_right', 'Rotate 90°', () => CMD['tr-r90'].run()), ibtn('transform', 'Free Transform', () => CMD.freeTransform.run())));
    }
    body.append(h('div.sect', { text: 'Align' }), h('div.align-row', ...[['align_horizontal_left', 'left'], ['align_horizontal_center', 'hcenter'], ['align_horizontal_right', 'right'], ['align_vertical_top', 'top'], ['align_vertical_center', 'vcenter'], ['align_vertical_bottom', 'bottom']].map(([ic, k]) => ibtn(ic, 'Align ' + k, () => ops.align(k)))));
    if (L.type === 'text') {
      const t = L.text, upd = () => { L._cache = null; L.touch(); invalidate(); amend('Ubah Teks'); };
      body.append(h('div.sect', { text: 'Character' }), h('div.prow', select([...FONTS.system, ...FONTS.google, ...FONTS.local].map(f => [f, f]), t.font, v => { t.font = v; loadFont(v, t.weight, t.italic).then(upd); })),
        h('div.prow', numField({ label: 'Size', value: t.size, min: 1, max: 2000, unit: 'pt', width: 46, onChange: v => { t.size = v; upd(); } }), colorSwatch(() => t.color, c => { t.color = c; upd(); })),
        h('div.prow', numField({ label: 'Leading', value: t.leading || 0, min: 0, max: 3000, unit: 'pt', width: 46, onChange: v => { t.leading = v; upd(); } }), numField({ label: 'Tracking', value: t.tracking || 0, min: -1000, max: 1000, width: 46, onChange: v => { t.tracking = v; upd(); } })),
        h('div.sect', { text: 'Paragraph' }), h('div.seg', ...['left', 'center', 'right'].map(a => { const bb = ibtn('format_align_' + a, a, () => { t.align = a; upd(); render(); }); bb.classList.toggle('on', t.align === a); return bb; })),
        h('div.prow', { style: { marginTop: '10px' } }, h('button.btn.sm', { type: 'button', onclick: () => { App.setTool('type'); TOOLS.type.edit(L); } }, icon('edit'), 'Edit Teks'), h('button.btn.sm', { type: 'button', onclick: () => CMD.warpText.run() }, 'Warp…')));
    }
    if (L.type === 'shape') {
      const sh = L.shape, upd = () => { L._cache = null; L.touch(); invalidate(); amend('Ubah Shape'); };
      body.append(h('div.sect', { text: 'Appearance' }),
        h('div.prow', h('label', { text: 'Fill' }), colorSwatch(() => sh.fill?.color || null, c => { sh.fill = { type: 'solid', color: c }; upd(); }), ibtn('block', 'Tanpa fill', () => { sh.fill = null; upd(); render(); }, { cls: '.sm' })),
        h('div.prow', h('label', { text: 'Stroke' }), colorSwatch(() => sh.stroke?.color || null, c => { sh.stroke = { width: 3, align: 'inside', ...(sh.stroke || {}), type: 'solid', color: c }; upd(); }), ibtn('block', 'Tanpa stroke', () => { sh.stroke = null; upd(); render(); }, { cls: '.sm' })),
        sh.stroke ? numField({ label: 'Lebar stroke', value: sh.stroke.width, min: 0, max: 500, unit: 'px', width: 46, onChange: v => { sh.stroke.width = v; upd(); } }) : null,
        sh.params?.kind === 'rect' ? h('div.prow', { style: { marginTop: '8px' } }, numField({ label: 'Radius sudut', value: sh.params.radius || 0, min: 0, max: 5000, unit: 'px', width: 46, onChange: v => { sh.params.radius = v; rebuildShape(L); upd(); } })) : null,
        sh.params?.kind === 'polygon' ? h('div.prow', numField({ label: 'Sisi', value: sh.params.sides, min: 3, max: 100, width: 40, onChange: v => { sh.params.sides = v; rebuildShape(L); upd(); } }), numField({ label: 'Star', value: sh.params.star || 0, min: 0, max: 99, unit: '%', width: 40, onChange: v => { sh.params.star = v; rebuildShape(L); upd(); } })) : null);
    }
    if (L.type === 'raster') body.append(h('div.sect', { text: 'Quick Actions' }), h('div', { style: { display: 'grid', gap: '6px' } },
      h('button.btn', { type: 'button', onclick: () => ops.removeBackground() }, icon('person_remove'), 'Hapus Latar Belakang'), h('button.btn', { type: 'button', onclick: () => ops.selectSubject() }, icon('person_search'), 'Select Subject'), h('button.btn', { type: 'button', onclick: () => CMD.cameraRaw.run() }, icon('camera'), 'Camera Raw Filter…')));
    maskProps(el, L);
  };
  const docProps = (el2, d) => {
    el2.append(h('div.props-head', icon('description'), h('span', { text: 'Document' })));
    el2.append(h('div.pad', h('div.sect', { text: 'Canvas' }), h('div', { text: `${d.w} × ${d.h} px · ${d.ppi} ppi · ${d.colorMode}` }), h('div.prow', { style: { marginTop: '8px' } }, h('button.btn.sm', { type: 'button', onclick: () => CMD.imageSize.run() }, 'Image Size…'), h('button.btn.sm', { type: 'button', onclick: () => CMD.canvasSize.run() }, 'Canvas Size…'))));
  };
  const maskProps = (el2, L) => {
    if (!L.mask) return;
    const m = L.mask, upd = () => { m.rev++; m._alpha = null; L._styled = null; L.touch(); invalidate(); };
    const amend = debounce(() => commit('Properti Mask', 'vignette'), 500);
    el2.append(h('div.pad', h('div.sect', { text: 'Layer Mask' }),
      sliderRow({ label: 'Density', value: Math.round((m.density ?? 1) * 100), min: 0, max: 100, unit: '%', onInput: v => { m.density = v / 100; upd(); amend(); } }),
      sliderRow({ label: 'Feather', value: m.feather || 0, min: 0, max: 250, step: .5, unit: 'px', onInput: v => { m.feather = v; upd(); amend(); } }),
      h('div.prow', h('button.btn.sm', { type: 'button', onclick: () => { App.maskTarget = L.id; ops.invertMaskOrLayer(); } }, 'Invert'), h('button.btn.sm', { type: 'button', onclick: () => CMD.selectMask.run() }, 'Select and Mask…')),
      h('div.prow', ibtn('select', 'Muat mask sebagai seleksi', () => ops.loadMaskSelection(L)), ibtn('done_all', 'Terapkan mask', () => ops.deleteMask(true)), ibtn('visibility_off', 'Nonaktif/aktifkan mask', () => ops.toggleMask()), ibtn('delete', 'Hapus mask', () => ops.deleteMask(false)))));
  };
  return live(el, ['layers', 'history', 'docchange', 'restore'], render, 60);
}

// ── Adjustments ──────────────────────────────────────────────────────────
function adjustmentsPanel(el) {
  el.append(h('div.pad', { style: { paddingBottom: 0 }, text: 'Tambahkan adjustment layer' }));
  el.append(h('div.adj-grid', ...ADJ_ORDER.flat().map(k => { const b = ibtn(ADJUSTMENTS[k].icon, ADJUSTMENTS[k].name, () => D() ? ops.newAdjustmentLayer(k) : toast('Buka dokumen terlebih dahulu')); return b; })));
  el.append(h('div.pad', h('div.sect', { text: 'Preset cepat' }), h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } },
    ...[['Kontras Kuat', 'curves', p => { p.rgb = [[0, 0], [64, 40], [192, 216], [255, 255]]; }], ['Hitam Putih', 'black-white', () => { }], ['Hangat', 'photo-filter', p => { p.color = '#ec8a00'; p.density = 30; }], ['Dingin', 'photo-filter', p => { p.color = '#006dff'; p.density = 30; }], ['Pudar', 'curves', p => { p.rgb = [[0, 36], [128, 128], [255, 236]]; }], ['Teal & Orange', 'color-lookup', p => { p.look = 'Teal & Orange'; }], ['Vintage', 'color-lookup', p => { p.look = 'Vintage'; }], ['Vivid', 'vibrance', p => { p.vibrance = 45; p.saturation = 10; }]]
      .map(([n, k, f]) => h('button.btn.sm', { type: 'button', onclick: () => { if (!D()) return; const L = ops.newAdjustmentLayer(k, n); f(L.adjust.params); L.touch(); invalidate(); D().history.amend(); App.emit('layers'); } }, n)))));
}

// ── Color / Swatches / Gradients ─────────────────────────────────────────
function colorPanel(el) {
  let target = 'fg';
  const field = h('div.cp-field'), fc = canvas(300, 120); field.append(fc); const knob = h('div.cp-knob'); field.append(knob);
  const hue = h('div.cp-hue'), hk = h('div.cp-knob'); hue.append(hk);
  const fgB = h('div.swatch', { style: { width: '28px', height: '28px' } }), bgB = h('div.swatch', { style: { width: '28px', height: '28px' } });
  const hex = h('input.inp', { style: { width: '84px' } }); hex.addEventListener('keydown', e => e.stopPropagation()); hex.onchange = () => { if (/^#?[0-9a-f]{3,6}$/i.test(hex.value.trim())) set(hexToRgb(hex.value)); };
  const rows = ['r', 'g', 'b'].map(c => sliderRow({ label: c.toUpperCase(), value: 0, min: 0, max: 255, onInput: v => set({ ...cur(), [c]: v }) }));
  let hsv = rgbToHsv(App.fg);
  const cur = () => target === 'fg' ? App.fg : App.bg;
  const set = c => { target === 'fg' ? App.setFg(c) : App.setBg(c); };
  el.append(h('div.color-panel', h('div.prow', fgB, bgB, h('span', { style: { flex: 1 } }), h('span.ob-label', { text: '#' }), hex), field, hue, ...rows));
  fgB.onclick = () => { if (target === 'fg') App.pickColor(App.fg).then(c => c && App.setFg(hexToRgb(c))); target = 'fg'; render(); };
  bgB.onclick = () => { if (target === 'bg') App.pickColor(App.bg).then(c => c && App.setBg(hexToRgb(c))); target = 'bg'; render(); };
  const drawField = () => { const x = ctx2d(fc), base = hsvToRgb({ h: hsv.h, s: 100, v: 100 }); const g1 = x.createLinearGradient(0, 0, 300, 0); g1.addColorStop(0, '#fff'); g1.addColorStop(1, rgbCss(base)); x.fillStyle = g1; x.fillRect(0, 0, 300, 120); const g2 = x.createLinearGradient(0, 0, 0, 120); g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, '#000'); x.fillStyle = g2; x.fillRect(0, 0, 300, 120); };
  const drag = (elx, fn) => elx.addEventListener('pointerdown', e => { elx.setPointerCapture(e.pointerId); fn(e); const mv = ev => fn(ev), up = () => { elx.removeEventListener('pointermove', mv); elx.removeEventListener('pointerup', up); }; elx.addEventListener('pointermove', mv); elx.addEventListener('pointerup', up); });
  drag(field, e => { const r = field.getBoundingClientRect(); hsv = { h: hsv.h, s: clamp((e.clientX - r.left) / r.width * 100, 0, 100), v: clamp(100 - (e.clientY - r.top) / r.height * 100, 0, 100) }; set(hsvToRgb(hsv)); });
  drag(hue, e => { const r = hue.getBoundingClientRect(); hsv = { ...hsv, h: clamp((e.clientX - r.left) / r.width * 360, 0, 359.9) }; set(hsvToRgb(hsv)); });
  const render = () => {
    const c = cur(), n = rgbToHsv(c); if (rgbToHex(hsvToRgb(hsv)) !== rgbToHex(c)) hsv = n.s ? n : { ...hsv, s: 0, v: n.v };
    drawField(); knob.style.left = hsv.s + '%'; knob.style.top = 100 - hsv.v + '%'; hk.style.left = hsv.h / 360 * 100 + '%';
    fgB.style.background = rgbCss(App.fg); bgB.style.background = rgbCss(App.bg);
    fgB.style.outline = target === 'fg' ? '2px solid var(--accent)' : ''; bgB.style.outline = target === 'bg' ? '2px solid var(--accent)' : '';
    hex.value = rgbToHex(c).slice(1); rows.forEach((r, i) => r.set(c['rgb'[i]]));
  };
  return live(el, ['colors'], render);
}
function swatchesPanel(el) {
  const grid = h('div.sw-grid');
  el.append(grid);
  const render = () => {
    grid.replaceChildren(...App.swatches.map((c, i) => { const s = h('div.sw', { style: { background: c }, 'data-tip': c }); s.onclick = e => (e.metaKey || e.ctrlKey || e.altKey) ? App.setBg(hexToRgb(c)) : App.setFg(hexToRgb(c)); s.oncontextmenu = e => { e.preventDefault(); showMenu([{ label: 'Jadikan warna latar', run: () => App.setBg(hexToRgb(c)) }, { label: 'Hapus swatch', run: () => { App.swatches.splice(i, 1); storeSet('swatches', App.swatches); App.emit('swatches'); } }], e.clientX, e.clientY); }; return s; }),
      (() => { const a = h('div.sw', { style: { display: 'grid', placeItems: 'center', background: 'var(--inp)' }, 'data-tip': 'Tambah warna depan' }, icon('add')); a.onclick = () => App.addSwatch(rgbToHex(App.fg)); return a; })());
  };
  return live(el, ['swatches'], render);
}
function gradientsPanel(el) {
  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(52px, 1fr))', gap: '8px', padding: '10px' } });
  el.append(grid);
  const render = () => grid.replaceChildren(...GRADIENT_PRESETS.map((g, i) => { const b = h('button.btn', { type: 'button', 'data-tip': g.name, style: { height: '44px', padding: 0, background: `${stopsCss(resolveStops(g.stops, App.fg, App.bg))}, repeating-conic-gradient(#fff 0 25%, #ccc 0 50%) 50% / 8px 8px` } }); b.onclick = () => { setOpt('gradient', 'preset', i); setOpt('gradient', 'custom', null); App.setTool('gradient'); }; return b; }));
  return live(el, ['colors'], render);
}

// ── History ──────────────────────────────────────────────────────────────
function historyPanel(el) {
  const list = h('div.hist-list'), foot = h('div.pfoot');
  el.append(h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, h('div', { style: { flex: 1, overflow: 'auto' } }, list), foot));
  foot.append(ibtn('photo_camera', 'Snapshot baru', () => D()?.history.snapshot()), ibtn('note_add', 'Dokumen baru dari status saat ini', () => CMD.duplicateDoc.run()), ibtn('delete', 'Hapus status setelah ini', () => { const hh = D()?.history; if (!hh) return; hh.states.splice(hh.index + 1); App.emit('history'); }));
  const render = () => {
    const d = D(); list.replaceChildren(); if (!d) return;
    const H = d.history;
    const src = st => { const b = h('button.src' + ((App.historySource || H.states[0]) === st ? '.on' : ''), { type: 'button', 'data-tip': 'Sumber History Brush' }, icon('brush')); b.onclick = e => { e.stopPropagation(); App.historySource = st; render(); }; return b; };
    for (const sn of H.snapshots) { const r = h('div.hi', src(sn), icon('photo_camera'), h('span', { text: sn.name })); r.onclick = () => { H.apply(sn.state); App.emit('history'); }; list.append(r); }
    H.states.forEach((s, i) => {
      const r = h('div.hi' + (i === H.index ? '.cur' : i > H.index ? '.future' : ''), src(s), icon(s.icon || 'edit'), h('span', { text: s.label }));
      r.onclick = () => App.historyGoto(i); list.append(r);
    });
    list.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
  };
  return live(el, ['history', 'docchange'], render);
}

// ── Navigator / Info / Histogram ─────────────────────────────────────────
function navigatorPanel(el) {
  const viewBox = h('div.nav-view'), cv = canvas(10, 10), rect = h('div.nav-rect'); viewBox.append(cv, rect);
  const z = numField({ value: 100, min: 1, max: 6400, unit: '%', width: 52, onChange: v => App.view.zoomTo(v / 100) });
  const sl = h('input', { type: 'range', min: 0, max: 100, value: 50 });
  sl.oninput = () => App.view.zoomTo(Math.pow(2, (sl.value - 50) / 50 * 6));
  el.append(h('div.nav-box', viewBox, h('div.prow', { style: { marginTop: '8px' } }, ibtn('zoom_out', 'Perkecil', () => App.view.zoomStep(-1), { cls: '.sm' }), sl, ibtn('zoom_in', 'Perbesar', () => App.view.zoomStep(1), { cls: '.sm' }), z)));
  let scale = 1;
  const drawThumb = () => { const d = D(); if (!d?._comp) return; const r = viewBox.getBoundingClientRect(); scale = Math.min((r.width || 260) / d.w, 150 / d.h); cv.width = Math.max(1, d.w * scale); cv.height = Math.max(1, d.h * scale); ctx2d(cv).drawImage(d._comp, 0, 0, cv.width, cv.height); drawRect(); };
  const drawRect = () => {
    const d = D(); if (!d || !App.view.W) return;
    const a = App.view.toDoc(0, 0), b = App.view.toDoc(App.view.W, App.view.H);
    const cr = cv.getBoundingClientRect(), vr = viewBox.getBoundingClientRect();
    Object.assign(rect.style, { left: cr.left - vr.left + Math.min(a.x, b.x) * scale + 'px', top: cr.top - vr.top + Math.min(a.y, b.y) * scale + 'px', width: Math.abs(b.x - a.x) * scale + 'px', height: Math.abs(b.y - a.y) * scale + 'px' });
    z.set(Math.round(App.view.zoom * 1000) / 10); sl.value = 50 + Math.log2(App.view.zoom) / 6 * 50;
  };
  viewBox.addEventListener('pointerdown', e => {
    viewBox.setPointerCapture(e.pointerId);
    const go = ev => { const cr = cv.getBoundingClientRect(); App.view.centerOn((ev.clientX - cr.left) / scale, (ev.clientY - cr.top) / scale); };
    go(e); const up = () => { viewBox.removeEventListener('pointermove', go); viewBox.removeEventListener('pointerup', up); };
    viewBox.addEventListener('pointermove', go); viewBox.addEventListener('pointerup', up);
  });
  const o1 = live(el, ['composited', 'docchange'], drawThumb, 250), o2 = App.on('viewchange', () => el.isConnected && drawRect());
  return () => { o1(); o2(); };
}
function infoPanel(el) {
  const g = h('div.info-grid'); el.append(g);
  let last = null;
  const render = () => {
    const d = D(); g.replaceChildren(); if (!d) return;
    const p = last && last.x >= 0 && last.y >= 0 && last.x < d.w && last.y < d.h ? pixelAt(d._comp, last.x, last.y) : null;
    const cm = p ? rgbToCmyk(p) : null;
    const blk = (ic, rows) => h('div.blk', icon(ic), ...rows.map(([k, v]) => h('div', h('span.k', { text: k }), ' ', h('span', { text: String(v) }))));
    g.append(blk('colorize', [['R:', p ? p.r : ''], ['G:', p ? p.g : ''], ['B:', p ? p.b : ''], ['A:', p ? Math.round(p.a / 2.55) + '%' : '']]),
      blk('print', [['C:', cm ? Math.round(cm.c) + '%' : ''], ['M:', cm ? Math.round(cm.m) + '%' : ''], ['Y:', cm ? Math.round(cm.y) + '%' : ''], ['K:', cm ? Math.round(cm.k) + '%' : '']]),
      blk('my_location', [['X:', last ? Math.floor(last.x) : ''], ['Y:', last ? Math.floor(last.y) : '']]),
      blk('aspect_ratio', (() => { const b = d.selection?.bounds?.(); return [['W:', b ? b.w : ''], ['H:', b ? b.h : '']]; })()));
    g.append(h('div', { style: { gridColumn: '1/-1', color: 'var(--text-3)' }, text: `Dok: ${d.w} × ${d.h} px · ${d.ppi} ppi · ${d.flat().length} layer` }));
    (d.samplers || []).forEach((s, i) => { const c = pixelAt(d._comp, s.x, s.y); if (c) g.append(h('div', { style: { gridColumn: '1/-1', display: 'flex', gap: '8px', alignItems: 'center' } }, h('b', { text: '#' + (i + 1) }), h('span.swatch', { style: { background: rgbCss(c), width: '14px', height: '14px' } }), h('span', { text: `R ${c.r}  G ${c.g}  B ${c.b}` }))); });
  };
  const off1 = App.on('cursor', ev => { last = ev; if (el.isConnected) rr(); });
  const rr = rafThrottle(render);
  const off2 = live(el, ['samplers', 'selection', 'docchange'], render);
  return () => { off1(); off2(); };
}
function histogramPanel(el) {
  let ch = 'rgb';
  const cv = canvas(520, 220); cv.className = 'hist-canvas'; const stats = h('div.info-grid', { style: { padding: '8px 0 0' } });
  el.append(h('div.pad', h('div.prow', h('label', { text: 'Channel' }), select([['rgb', 'Colors'], ['l', 'Luminosity'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']], ch, v => { ch = v; render(); })), cv, stats));
  const render = () => {
    const d = D(); const x = ctx2d(cv); x.clearRect(0, 0, cv.width, cv.height); if (!d?._comp) return;
    const k = Math.min(1, 500 / Math.max(d.w, d.h)), t = canvas(d.w * k, d.h * k); ctx2d(t).drawImage(d._comp, 0, 0, t.width, t.height);
    const H = histogram(ctx2d(t).getImageData(0, 0, t.width, t.height));
    const draw = (arr, color, mode = 'source-over') => { let mx = 0; for (let i = 0; i < 256; i++) mx = Math.max(mx, arr[i]); x.globalCompositeOperation = mode; x.fillStyle = color; for (let i = 0; i < 256; i++) { const v = arr[i] / (mx || 1) * cv.height; x.fillRect(i / 256 * cv.width, cv.height - v, cv.width / 256 + .5, v); } x.globalCompositeOperation = 'source-over'; };
    if (ch === 'rgb') { draw(H.r, 'rgba(255,60,60,.8)', 'lighter'); draw(H.g, 'rgba(60,220,90,.8)', 'lighter'); draw(H.b, 'rgba(70,120,255,.8)', 'lighter'); }
    else draw(H[ch], ch === 'l' ? getComputedStyle(document.documentElement).getPropertyValue('--text-2') : { r: '#ff4d4d', g: '#3ccf6e', b: '#4a8cff' }[ch]);
    const arr = H[ch === 'rgb' ? 'l' : ch]; let sum = 0, sq = 0, n = 0; for (let i = 0; i < 256; i++) { sum += i * arr[i]; sq += i * i * arr[i]; n += arr[i]; }
    const mean = n ? sum / n : 0; let acc = 0, med = 0; for (let i = 0; i < 256; i++) { acc += arr[i]; if (acc >= n / 2) { med = i; break; } }
    stats.replaceChildren(h('div', { text: `Mean: ${round(mean, 2)}` }), h('div', { text: `Std Dev: ${round(Math.sqrt(Math.max(0, sq / (n || 1) - mean * mean)), 2)}` }), h('div', { text: `Median: ${med}` }), h('div', { text: `Pixels: ${Math.round(n / (k * k)).toLocaleString('id-ID')}` }));
  };
  return live(el, ['composited', 'docchange'], render, 500);
}

// ── Brushes / Character / Paragraph ──────────────────────────────────────
const PAINT_TOOLS = ['brush', 'pencil', 'eraser', 'mixer', 'clone', 'pattern-stamp', 'history-brush', 'blur', 'sharpen', 'smudge', 'dodge', 'burn', 'sponge', 'healing', 'spot-healing', 'color-replace', 'bg-eraser'];
function brushesPanel(el) {
  const render = () => {
    el.replaceChildren();
    const id = PAINT_TOOLS.includes(App.toolId) ? App.toolId : 'brush', o = opts(id);
    el.append(h('div.pad', { style: { paddingBottom: 0 } }, sliderRow({ label: 'Size', value: o.size, min: 1, max: 1000, unit: 'px', onInput: v => { setOpt(id, 'size', v); App.emit('brushsize'); } }), sliderRow({ label: 'Hardness', value: o.hardness ?? 100, min: 0, max: 100, unit: '%', onInput: v => { setOpt(id, 'hardness', v); App.emit('brushsize'); } })));
    el.append(h('div.brush-list', ...[...BRUSH_PRESETS, ...App.brushes].map(p => {
      const b = h('div.bpre' + (o.preset === p.id ? '.on' : ''), { 'data-tip': p.name }, tipPreview({ ...p, size: 36 }, 36, 36), h('span', { text: p.size }));
      b.onclick = () => { for (const k of ['tip', 'hardness', 'spacing', 'pSize', 'pOpacity', 'air', 'angleJitter', 'sizeJitter', 'scatter', 'colorJitter', 'angleFollow', 'angle']) setOpt(id, k, p[k] ?? ({ tip: 'round', spacing: 10, angle: 0 })[k] ?? (typeof o[k] === 'boolean' ? false : 0)); setOpt(id, 'flow', p.flow ?? 100); setOpt(id, 'size', p.size); setOpt(id, 'preset', p.id); setOpt(id, 'custom', p.custom || null); if (!PAINT_TOOLS.includes(App.toolId)) App.setTool('brush'); App.emit('tool', App.toolId); render(); };
      return b;
    })));
  };
  return live(el, ['tool', 'brushes', 'brushsize'], render, 50);
}
function characterPanel(el) {
  const render = () => {
    el.replaceChildren();
    const L = D()?.active?.type === 'text' ? D().active : null, o = opts('type'), t = L ? L.text : o;
    const set = (k, v) => { setOpt('type', k, v); if (L) { L.text[k] = v; loadFont(L.text.font, L.text.weight, L.text.italic).then(() => { L._cache = null; L.touch(); invalidate(); App.emit('textstyle'); if (!App.textEdit) commit('Ubah Karakter', 'title'); }); } };
    el.append(h('div.pad',
      h('div.prow', select([...FONTS.system, ...FONTS.google, ...FONTS.local].map(f => [f, f]), t.font, v => { loadFont(v); set('font', v); })),
      h('div.prow', select([[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra Bold'], [900, 'Black']], t.weight, v => set('weight', +v)), check('Italic', t.italic, v => set('italic', v))),
      h('div.prow', numField({ label: 'Size', value: t.size, min: 1, max: 2000, unit: 'pt', width: 46, onChange: v => set('size', v) }), numField({ label: 'Leading', value: t.leading || 0, min: 0, max: 3000, width: 46, onChange: v => set('leading', v) })),
      h('div.prow', numField({ label: 'Tracking', value: t.tracking || 0, min: -1000, max: 1000, width: 46, onChange: v => set('tracking', v) }), h('label', { text: 'Warna', style: { width: 'auto' } }), colorSwatch(() => t.color || rgbToHex(App.fg), c => set('color', c))),
      h('div.prow', ...[['underline', 'format_underlined', 'Underline'], ['strike', 'format_strikethrough', 'Strikethrough'], ['caps', 'match_case', 'All Caps']].map(([k, ic, tip]) => { const b = ibtn(ic, tip, () => { set(k, !t[k]); render(); }); b.classList.toggle('on', !!t[k]); return b; })),
      L ? null : h('div.note', { text: 'Pengaturan ini dipakai untuk teks baru. Pilih layer teks untuk mengubahnya.' })));
  };
  return live(el, ['layers', 'textedit', 'tool'], render, 60);
}
function paragraphPanel(el) {
  const render = () => {
    el.replaceChildren();
    const L = D()?.active?.type === 'text' ? D().active : null, t = L ? L.text : opts('type');
    const set = (k, v) => { setOpt('type', k, v); if (L) { L.text[k] = v; L._cache = null; L.touch(); invalidate(); App.emit('textstyle'); commit('Ubah Paragraf', 'format_align_left'); } render(); };
    el.append(h('div.pad', h('div.seg', ...['left', 'center', 'right'].map(a => { const b = ibtn('format_align_' + a, { left: 'Rata kiri', center: 'Rata tengah', right: 'Rata kanan' }[a], () => set('align', a)); b.classList.toggle('on', t.align === a); return b; })),
      L?.text.box ? h('div.prow', { style: { marginTop: '10px' } }, numField({ label: 'Lebar kotak', value: Math.round(L.text.box.w), min: 10, max: 30000, unit: 'px', width: 54, onChange: v => { L.text.box.w = v; L._cache = null; L.touch(); invalidate(); commit('Ubah Kotak Teks', 'crop_free'); } }), numField({ label: 'Tinggi', value: Math.round(L.text.box.h), min: 10, max: 30000, unit: 'px', width: 54, onChange: v => { L.text.box.h = v; L._cache = null; L.touch(); invalidate(); commit('Ubah Kotak Teks', 'crop_free'); } })) : h('div.note', { style: { marginTop: '10px' }, text: 'Seret dengan Type Tool untuk membuat teks paragraf (kotak).' })));
  };
  return live(el, ['layers', 'textedit'], render, 60);
}

const PANELS = { layers: layersPanel, channels: channelsPanel, paths: pathsPanel, properties: propertiesPanel, adjustments: adjustmentsPanel, color: colorPanel, swatches: swatchesPanel, gradients: gradientsPanel, history: historyPanel, navigator: navigatorPanel, info: infoPanel, histogram: histogramPanel, brushes: brushesPanel, character: characterPanel, paragraph: paragraphPanel };
