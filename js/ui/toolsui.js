// Tools palette (left) and contextual options bar

import { App, invalidate, commit, toast } from '../state.js';
import { h, icon, $, canvas, ctx2d, storeGet, storeSet } from '../util.js';
import { TOOLS, opts, setOpt } from '../tools/base.js';
import { ICONS, toolIcon } from '../icons.js';
import { numField, select, check, ibtn, popover, colorSwatch } from './controls.js';
import { BRUSH_PRESETS, tipPreview } from '../brush.js';
import { GRADIENT_PRESETS, resolveStops, stopsCss, rgbCss, rgbToHex, hexToRgb } from '../color.js';
import { FONTS, loadFont, CUSTOM_SHAPES, svgToSubpaths, rebuildShape } from '../tools/vector.js';
import { shapePath } from '../composite.js';
import * as ops from '../ops.js';
import { CMD } from '../actions.js';

export const GROUPS = [
  ['move', ['move', 'artboard']], ['marquee', ['marquee-rect', 'marquee-ellipse', 'marquee-row', 'marquee-col']], ['lasso', ['lasso', 'polygon-lasso', 'magnetic-lasso']],
  ['quicksel', ['object-select', 'quick-select', 'magic-wand']], ['crop', ['crop']], ['eyedropper', ['eyedropper', 'color-sampler', 'ruler']], null,
  ['heal', ['spot-healing', 'remove', 'healing', 'patch', 'red-eye']], ['brush', ['brush', 'pencil', 'color-replace', 'mixer']], ['stamp', ['clone', 'pattern-stamp']],
  ['history', ['history-brush', 'art-history']], ['eraser', ['eraser', 'bg-eraser', 'magic-eraser']], ['gradient', ['gradient', 'bucket']], ['focus', ['blur', 'sharpen', 'smudge']], ['tone', ['dodge', 'burn', 'sponge']], null,
  ['pen', ['pen', 'freeform-pen', 'add-anchor', 'delete-anchor', 'convert-point']], ['type', ['type', 'type-vertical', 'type-mask']], ['pathsel', ['path-select', 'direct-select']],
  ['shape', ['shape-rect', 'shape-ellipse', 'shape-triangle', 'shape-polygon', 'shape-line', 'shape-custom']], null, ['hand', ['hand', 'rotate-view']], ['zoom', ['zoom']],
];
const groupOf = id => GROUPS.find(g => g && g[1].includes(id));
App.groupCur = storeGet('groupCur', {});

// ── Active tool management ───────────────────────────────────────────────
const transformTool = {
  id: 'transform', name: 'Free Transform',
  down: e => App.transform.down(e), move: e => App.transform.move(e), up: e => App.transform.up(e),
  overlay: (x, v) => App.transform.overlay(x, v),
  cursor: ev => App.transform.cursorFor(App.transform.hit(ev) || 'rotate'),
  dblclick: () => App.transform.commit(),
};
App.activeTool = () => App.transform?.active ? transformTool : TOOLS[App.tempTool || App.toolId];
App.setTool = (id) => {
  if (!TOOLS[id]) return;
  if (App.transform?.active) App.transform.commit();
  const prev = TOOLS[App.toolId];
  if (prev && prev.id !== id) prev.deactivate?.();
  App.toolId = id; const g = groupOf(id); if (g) { App.groupCur[g[0]] = id; storeSet('groupCur', App.groupCur); }
  TOOLS[id].activate?.();
  App.emit('tool', id); App.view?.redraw();
};
App.tools = TOOLS;

// ── Toolbar ──────────────────────────────────────────────────────────────
let flyout = null;
function closeFlyout() { flyout?.remove(); flyout = null; }
document.addEventListener('pointerdown', e => { if (flyout && !flyout.contains(e.target)) closeFlyout(); }, true);
function openFlyout(btn, g) {
  closeFlyout();
  const r = btn.getBoundingClientRect();
  flyout = h('div.flyout', ...g[1].map(id => {
    const T = TOOLS[id]; const it = h('div.fi' + (App.toolId === id ? '.cur' : ''), h('i.mark'), h('span', { html: toolIcon(T.icon) }), h('span', { text: T.name }), T.key ? h('kbd', { text: T.key }) : null);
    it.onclick = () => { App.setTool(id); closeFlyout(); };
    return it;
  }));
  $('#popups').append(flyout);
  flyout.style.left = r.right + 6 + 'px'; flyout.style.top = Math.min(r.top, innerHeight - flyout.offsetHeight - 8) + 'px';
}
export function buildToolbar() {
  const tb = $('#toolbar'); tb.replaceChildren(h('div.grip'));
  const btns = {};
  for (const g of GROUPS) {
    if (!g) { tb.append(h('div.tsep')); continue; }
    const b = h('button.tbtn' + (g[1].length > 1 ? '.has-more' : ''), { type: 'button' });
    let t = null;
    b.addEventListener('pointerdown', e => { if (e.button === 0 && g[1].length > 1) t = setTimeout(() => { t = null; openFlyout(b, g); }, 380); });
    b.addEventListener('pointerup', () => { if (t) { clearTimeout(t); t = null; App.setTool(App.groupCur[g[0]] || g[1][0]); } else if (g[1].length === 1) App.setTool(g[1][0]); });
    b.addEventListener('contextmenu', e => { e.preventDefault(); if (g[1].length > 1) openFlyout(b, g); });
    btns[g[0]] = b; tb.append(b);
  }
  const colors = h('div.colors');
  const fg = h('div.fg', { 'data-tip': 'Warna depan (foreground)' }), bg = h('div.bg', { 'data-tip': 'Warna latar (background)' });
  const swap = h('div.swap', { 'data-tip': 'Tukar warna|X' }, icon('swap_horiz')), def = h('div.def', { 'data-tip': 'Warna default|D' }, icon('contrast'));
  fg.onclick = async () => { const c = await App.pickColor(App.fg, { title: 'Color Picker (Foreground Color)' }); if (c) App.setFg(hexToRgb(c)); };
  bg.onclick = async () => { const c = await App.pickColor(App.bg, { title: 'Color Picker (Background Color)' }); if (c) App.setBg(hexToRgb(c)); };
  swap.onclick = () => App.swapColors(); def.onclick = () => App.defaultColors();
  colors.append(bg, fg, swap, def); tb.append(colors);
  const qm = ibtn('', 'Quick Mask Mode|Q', () => App.toggleQuickMask(), { svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="12" cy="12" r="4" stroke-dasharray="2 2"/></svg>' });
  const sm = ibtn('fullscreen', 'Ganti Screen Mode|F', () => App.cycleScreenMode());
  qm.classList.add('tbtn'); sm.classList.add('tbtn'); tb.append(qm, sm);
  const paint = () => {
    for (const g of GROUPS) if (g) { const cur = g[1].includes(App.toolId) ? App.toolId : (App.groupCur[g[0]] || g[1][0]); const b = btns[g[0]]; b.innerHTML = toolIcon(TOOLS[cur].icon); b.classList.toggle('on', g[1].includes(App.toolId)); const T = TOOLS[cur]; b.dataset.tip = `${T.name}|${T.key || ''}`; }
    fg.style.background = rgbCss(App.fg); bg.style.background = rgbCss(App.bg); qm.classList.toggle('on', App.quickMask);
  };
  App.on('tool', paint); App.on('colors', paint); App.on('quickmask', paint); paint();
}

// ── Options bar ──────────────────────────────────────────────────────────
const ACTIONS = {
  selectAndMask: () => CMD.selectMask.run(), selectSubject: () => ops.selectSubject(),
  cropSwap: () => { const o = opts('crop'); o.swapped = !o.swapped; App.tools.crop.activate(); }, cropClear: () => { setOpt('crop', 'ratio', 'free'); renderOptions(); },
  cropCancel: () => App.tools.crop.activate(), cropCommit: () => App.tools.crop.commitCrop(),
  clearSamplers: () => { if (App.doc) { App.doc.samplers = []; App.emit('samplers'); App.view.redraw(); } },
  rulerStraighten: () => { const i = App.tools.ruler.info(); if (!i || !i.l) return; let a = -i.a; while (a > 45) a -= 90; while (a < -45) a += 90; App.transform.start('free').then(() => { App.transform.rotateBy(a); App.transform.commit(); }); },
  rulerClear: () => { App.tools.ruler.a = null; App.emit('ruler'); App.view.redraw(); },
  zoom100: () => App.view.actual(), zoomFit: () => App.view.fit(), zoomFill: () => App.view.fit(true), zoomIn: () => App.view.zoomStep(1), zoomOut: () => App.view.zoomStep(-1),
  resetRotation: () => { if (App.doc) { const c = App.view.toDoc(App.view.W / 2, App.view.H / 2); App.doc.view.rot = 0; App.view.centerOn(c.x, c.y); } },
  pathToSelection: () => CMD.pathToSelection.run(), pathToMask: () => CMD.pathToMask.run(), pathToShape: () => CMD.pathToShape.run(), fillPath: () => CMD.fillPath.run(), strokePath: () => CMD.strokePath.run(),
  warpText: () => CMD.warpText.run(), toggleCharacter: () => App.emit('showpanel', 'character'),
};
App.runAction = n => ACTIONS[n]?.();

// Apply type options to the edited / selected text layer
function applyTextOpt(k, v) {
  const L = App.textEdit?.layer || (App.doc?.active?.type === 'text' ? App.doc.active : null); if (!L) return;
  const t = L.text;
  if (k === 'style') { t.weight = parseInt(v); t.italic = String(v).endsWith('i'); } else if (k === 'color') t.color = v; else t[k] = v;
  loadFont(t.font, t.weight, t.italic).then(() => { L._cache = null; L.touch(); invalidate(); App.emit('textstyle'); if (!App.textEdit) commit('Ubah Teks', 'title'); });
}
function applyShapeOpt(id, k) {
  const L = App.doc?.active; if (L?.type !== 'shape' || !['fill', 'fillNone', 'stroke', 'strokeNone', 'strokeW', 'strokeAlign', 'dash', 'radius'].includes(k)) return;
  const o = opts(id), sh = L.shape;
  sh.fill = o.fillNone ? null : { type: 'solid', color: o.fill || rgbToHex(App.fg) };
  sh.stroke = o.strokeNone ? null : { type: 'solid', color: o.stroke, width: o.strokeW, align: o.strokeAlign, dash: o.dash };
  if (k === 'radius' && sh.params?.kind === 'rect') { sh.params.radius = o.radius; rebuildShape(L); }
  L._cache = null; L.touch(); invalidate(); commit('Ubah Shape', 'category');
}

export function renderOptions() {
  const bar = $('#optionsbar'), id = App.transform?.active ? 'transform' : App.toolId, T = TOOLS[App.toolId];
  bar.replaceChildren();
  if (id === 'transform') return renderTransformOptions(bar);
  const o = opts(id);
  bar.append(h('div.tool-badge', { 'data-tip': T.name, html: toolIcon(T.icon) }));
  const set = (k, v) => {
    setOpt(id, k, v);
    if (T.group === 'type') applyTextOpt(k, v);
    if (T.group === 'shape' || T.group === 'pen') applyShapeOpt(id, k);
  };
  for (const spec of T.bar || []) {
    const el = control(spec, id, o, set); if (el) bar.append(el);
  }
}
function control(s, id, o, set) {
  switch (s.type) {
    case 'sep': return h('div.ob-sep');
    case 'note': return h('span.ob-note', { text: s.text });
    case 'range': return h('div.ob-group', numField({ label: s.label, value: o[s.key], min: s.min, max: s.max, step: s.step || 1, unit: s.unit, width: s.width || 46, tip: s.tip, dd: true, onChange: v => set(s.key, v) }));
    case 'select': { const sel = select(s.options, o[s.key], v => set(s.key, isNaN(+v) || v === '' || /^\d+i$/.test(v) ? v : +v)); if (s.tip) sel.dataset.tip = s.tip; return h('div.ob-group', s.label ? h('span.ob-label', { text: s.label + ':' }) : null, sel); }
    case 'check': return check(s.label, o[s.key], v => set(s.key, v));
    case 'toggle': { const b = ibtn('', s.tip, () => { set(s.key, !opts(id)[s.key]); b.classList.toggle('on', opts(id)[s.key]); }, { svg: ICONS[s.icon] }); b.classList.toggle('on', !!o[s.key]); return b; }
    case 'seg': {
      const g = h('div.seg');
      const draw = () => g.replaceChildren(...s.options.map(([v, ic, tip]) => { const b = ibtn(ICONS[ic] ? '' : ic, tip, () => { set(s.key, v); draw(); }, ICONS[ic] ? { svg: ICONS[ic] } : {}); b.classList.toggle('on', opts(id)[s.key] === v); return b; }));
      draw(); return h('div.ob-group', s.label ? h('span.ob-label', { text: s.label + ':' }) : null, g);
    }
    case 'selmode': return control({ type: 'seg', key: 'selMode', options: [['new', 'sel-new', 'Seleksi baru'], ['add', 'sel-add', 'Tambah ke seleksi (Shift)'], ['sub', 'sel-sub', 'Kurangi dari seleksi (Alt)'], ['int', 'sel-int', 'Irisan dengan seleksi']] }, id, o, set);
    case 'button': { const b = s.icon ? ibtn(s.icon, s.tip, () => App.runAction(s.action)) : h('button.btn.sm' + (s.primary ? '.primary' : ''), { type: 'button', text: s.label }); if (!s.icon) b.onclick = () => App.runAction(s.action); if (s.primary && s.icon) b.classList.add('on'); return b; }
    case 'brush': return brushPicker(id, o, set);
    case 'wh': {
      if (!('wTyped' in o) && !('fixW' in o)) return null;
      const k1 = 'fixW' in o ? 'fixW' : 'wTyped', k2 = 'fixH' in o ? 'fixH' : 'hTyped';
      return h('div.ob-group', numField({ label: 'W:', value: +o[k1] || 0, min: 0, max: 30000, unit: 'px', width: 52, onChange: v => set(k1, v) }), ibtn('swap_horiz', 'Tukar', () => { const a = o[k1]; set(k1, o[k2]); set(k2, a); renderOptions(); }, { cls: '.sm' }), numField({ label: 'H:', value: +o[k2] || 0, min: 0, max: 30000, unit: 'px', width: 52, onChange: v => set(k2, v) }));
    }
    case 'align': return h('div.ob-group.align-row', ...[['align_horizontal_left', 'left', 'Rata kiri'], ['align_horizontal_center', 'hcenter', 'Tengah horizontal'], ['align_horizontal_right', 'right', 'Rata kanan'], ['align_vertical_top', 'top', 'Rata atas'], ['align_vertical_center', 'vcenter', 'Tengah vertikal'], ['align_vertical_bottom', 'bottom', 'Rata bawah'], ['horizontal_distribute', 'dist-h', 'Distribusi horizontal'], ['vertical_distribute', 'dist-v', 'Distribusi vertikal']].map(([ic, k, tip]) => ibtn(ic, tip, () => App.doc && ops.align(k))));
    case 'gradient': {
      const b = h('button.grad-bar', { type: 'button', style: { width: '120px', height: '22px' }, 'data-tip': 'Klik untuk memilih/mengedit gradient' });
      const paint = () => { const pre = o.custom || GRADIENT_PRESETS[o.preset]?.stops; b.style.background = `${stopsCss(resolveStops(pre, App.fg, App.bg))}, repeating-conic-gradient(#fff 0 25%, #ccc 0 50%) 50% / 8px 8px`; };
      paint(); App.on('colors', paint);
      b.onclick = () => {
        const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 54px)', gap: '6px' } }, ...GRADIENT_PRESETS.map((g, i) => { const t = h('button.btn', { type: 'button', 'data-tip': g.name, style: { height: '34px', padding: 0, background: `${stopsCss(resolveStops(g.stops, App.fg, App.bg))}, repeating-conic-gradient(#fff 0 25%, #ccc 0 50%) 50% / 8px 8px` } }); t.onclick = () => { set('preset', i); set('custom', null); paint(); p.close(); }; return t; }));
        const ed = h('button.btn.sm', { type: 'button', style: { marginTop: '10px', width: '100%' } }, icon('edit'), 'Edit Gradient…');
        ed.onclick = async () => { p.close(); const st = await App.editGradient(o.custom || resolveStops(GRADIENT_PRESETS[o.preset].stops, App.fg, App.bg).map(([q, c, a]) => [q, rgbToHex(c), a])); if (st) { set('custom', st); paint(); } };
        const p = popover(b, h('div', h('div.ttl', { text: 'Gradients' }), grid, ed));
      };
      return b;
    }
    case 'pattern': {
      const b = h('button.btn.sm', { type: 'button', 'data-tip': 'Pola' }, icon('texture'), 'Pola');
      b.onclick = () => {
        if (!App.patterns.length) { toast('Belum ada pola'); return; }
        const p = popover(b, h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 48px)', gap: '6px' } }, ...App.patterns.map((pt, i) => { const c = h('button.btn', { type: 'button', 'data-tip': pt.name, style: { height: '48px', padding: 0, backgroundImage: `url(${pt.canvas.toDataURL()})`, outline: o[s.key] === i ? '2px solid var(--accent)' : '' } }); c.onclick = () => { set(s.key, i); p.close(); }; return c; })));
      };
      return b;
    }
    case 'shapefill': {
      const fill = colorSwatch(() => o.fillNone ? null : (o.fill || rgbToHex(App.fg)), c => { set('fillNone', false); set('fill', c); }, 'Fill');
      const stroke = colorSwatch(() => o.strokeNone ? null : o.stroke, c => { set('strokeNone', false); set('stroke', c); }, 'Stroke');
      const none = (k, sw) => ibtn('block', 'Tanpa ' + (k === 'fillNone' ? 'fill' : 'stroke'), () => { set(k, !opts(id)[k]); sw.refresh(); }, { cls: '.sm' });
      return h('div.ob-group', h('span.ob-label', { text: 'Fill:' }), fill, none('fillNone', fill), h('span.ob-label', { text: 'Stroke:' }), stroke, none('strokeNone', stroke));
    }
    case 'customshape': {
      const b = h('button.btn.sm', { type: 'button' }); const paintB = () => { b.replaceChildren(shapeThumb(o[s.key] || 0, 18), h('span', { text: CUSTOM_SHAPES[o[s.key] || 0][0] })); };
      paintB();
      b.onclick = () => { const p = popover(b, h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(6, 40px)', gap: '6px' } }, ...CUSTOM_SHAPES.map(([n], i) => { const c = h('button.btn', { type: 'button', 'data-tip': n, style: { height: '40px', padding: 0 } }, shapeThumb(i, 28)); c.onclick = () => { set(s.key, i); paintB(); p.close(); }; return c; }))); };
      return h('div.ob-group', h('span.ob-label', { text: 'Shape:' }), b);
    }
    case 'font': {
      const L = App.doc?.active?.type === 'text' ? App.doc.active : null;
      const cur = L ? L.text.font : o.font;
      const all = [...FONTS.system, ...FONTS.google, ...FONTS.local];
      const sel = select(all.map(f => [f, f]), cur, v => { set('font', v); loadFont(v); });
      sel.style.width = '150px'; sel.dataset.tip = 'Font family';
      return sel;
    }
    case 'textcolor': return colorSwatch(() => (App.doc?.active?.type === 'text' ? App.doc.active.text.color : o.color) || rgbToHex(App.fg), c => set('color', c), 'Warna teks');
    case 'textcommit': {
      if (!App.textEdit) return null;
      return h('div.ob-group', ibtn('block', 'Batalkan edit (Esc)', () => App.textEdit?.cancel()), ibtn('check', 'Terapkan (⌘↩)', () => App.textEdit?.commit(), { cls: '.on' }));
    }
    case 'rulerinfo': {
      const i = App.tools.ruler.info(); if (!i) return h('span.ob-note', { text: 'Seret untuk mengukur jarak & sudut' });
      return h('span.ob-label', { text: `X: ${Math.round(i.x)}  Y: ${Math.round(i.y)}  W: ${Math.round(i.w)}  H: ${Math.round(i.h)}  A: ${i.a.toFixed(1)}°  L1: ${i.l.toFixed(1)}` });
    }
    case 'rotinfo': return numField({ label: 'Rotation Angle:', value: Math.round(App.doc?.view.rot || 0), min: -180, max: 180, unit: '°', width: 46, onChange: v => { if (!App.doc) return; const c = App.view.toDoc(App.view.W / 2, App.view.H / 2); App.doc.view.rot = v; App.view.centerOn(c.x, c.y); } });
  }
  return null;
}
function shapeThumb(i, s) { const c = canvas(s * 2, s * 2); c.style.width = s + 'px'; c.style.height = s + 'px'; const x = ctx2d(c); x.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text').trim(); x.fill(shapePath({ subpaths: svgToSubpaths(CUSTOM_SHAPES[i][1], 2, 2, s * 2 - 4, s * 2 - 4) })); return c; }

function brushPicker(id, o, set) {
  const b = h('button.btn.sm', { type: 'button', 'data-tip': 'Brush Preset Picker' });
  const paint = () => { b.replaceChildren(tipPreview(o, 22, 22), h('span', { text: Math.round(o.size) }), icon('expand_more')); };
  paint();
  b.onclick = () => {
    const presets = [...BRUSH_PRESETS, ...App.brushes];
    const size = numField({ label: 'Size:', value: o.size, min: 1, max: 5000, unit: 'px', width: 56, onChange: v => { set('size', v); paint(); } });
    const hard = numField({ label: 'Hardness:', value: o.hardness, min: 0, max: 100, unit: '%', width: 46, onChange: v => { set('hardness', v); paint(); } });
    const sz = h('input', { type: 'range', min: 1, max: 1000, value: o.size }); sz.oninput = () => { set('size', +sz.value); size.set(+sz.value); paint(); };
    const hd = h('input', { type: 'range', min: 0, max: 100, value: o.hardness }); hd.oninput = () => { set('hardness', +hd.value); hard.set(+hd.value); paint(); };
    const list = h('div.brush-list', { style: { padding: 0, maxHeight: '240px', overflow: 'auto' } }, ...presets.map(p => {
      const el = h('div.bpre' + (o.preset === p.id ? '.on' : ''), { 'data-tip': p.name }, tipPreview({ ...p, size: 36 }, 36, 36), h('span', { text: p.size }));
      el.onclick = () => { for (const k of ['tip', 'hardness', 'spacing', 'pSize', 'pOpacity', 'flow', 'air', 'angleJitter', 'sizeJitter', 'scatter', 'colorJitter', 'angleFollow', 'angle', 'custom']) set(k, p[k] ?? ({ tip: 'round', spacing: 10, flow: 100, angle: 0 })[k] ?? (typeof o[k] === 'boolean' ? false : 0)); set('size', p.size); set('preset', p.id); set('custom', p.custom || null); pop.close(); paint(); };
      return el;
    }));
    const dyn = h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '10px' } },
      numField({ label: 'Spacing', value: o.spacing, min: 1, max: 500, unit: '%', width: 40, onChange: v => set('spacing', v) }), numField({ label: 'Roundness', value: o.roundness ?? 100, min: 5, max: 100, unit: '%', width: 40, onChange: v => set('roundness', v) }),
      numField({ label: 'Size jitter', value: o.sizeJitter || 0, min: 0, max: 100, unit: '%', width: 40, onChange: v => set('sizeJitter', v) }), numField({ label: 'Scatter', value: o.scatter || 0, min: 0, max: 1000, unit: '%', width: 40, onChange: v => set('scatter', v) }),
      numField({ label: 'Angle jitter', value: o.angleJitter || 0, min: 0, max: 100, unit: '%', width: 40, onChange: v => set('angleJitter', v) }), numField({ label: 'Opacity jitter', value: o.opacityJitter || 0, min: 0, max: 100, unit: '%', width: 40, onChange: v => set('opacityJitter', v) }));
    const pop = popover(b, h('div', h('div.prow', size), sz, h('div.prow', { style: { marginTop: '8px' } }, hard), hd, h('div.sect', { text: 'Preset' }), list, h('div.sect', { text: 'Brush Settings' }), dyn), { width: 330 });
  };
  App.on('brushsize', paint);
  return b;
}

function renderTransformOptions(bar) {
  const n = App.transform.numeric(), tr = App.transform;
  bar.append(h('div.tool-badge', { html: ICONS.move }),
    numField({ label: 'X:', value: Math.round(n.x), min: -1e5, max: 1e5, unit: 'px', width: 54, onChange: v => tr.setNumeric('x', v) }),
    numField({ label: 'Y:', value: Math.round(n.y), min: -1e5, max: 1e5, unit: 'px', width: 54, onChange: v => tr.setNumeric('y', v) }), h('div.ob-sep'),
    numField({ label: 'W:', value: +n.w.toFixed(2), min: -10000, max: 10000, step: .01, unit: '%', width: 54, onChange: v => tr.setNumeric('w', v) }),
    numField({ label: 'H:', value: +n.h.toFixed(2), min: -10000, max: 10000, step: .01, unit: '%', width: 54, onChange: v => tr.setNumeric('h', v) }), h('div.ob-sep'),
    numField({ label: '∠', value: +n.a.toFixed(2), min: -180, max: 180, step: .01, unit: '°', width: 50, onChange: v => tr.setNumeric('a', v) }), h('div.ob-sep'),
    select([['bicubic', 'Bicubic'], ['bilinear', 'Bilinear'], ['nearest', 'Nearest Neighbor']], tr.st.interp, v => { tr.st.interp = v; tr.preview(); }),
    ibtn('flip', 'Flip Horizontal', () => tr.flip('h')), ibtn('rotate_90_degrees_cw', 'Rotate 90° CW', () => tr.rotateBy(90)),
    h('div', { style: { flex: 1 } }),
    h('span.ob-note', { text: '⌘/Ctrl seret sudut = distort · Shift = bebas proporsi · Alt = dari tengah' }),
    ibtn('block', 'Batal (Esc)', () => tr.cancel()), ibtn('check', 'Terapkan (Enter)', () => tr.commit(), { cls: '.on' }));
}
export function bindOptionsBar() {
  App.on('tool', renderOptions); App.on('transform', () => { clearTimeout(bindOptionsBar.t); bindOptionsBar.t = setTimeout(renderOptions, 30); }); App.on('textedit', renderOptions); App.on('ruler', () => App.toolId === 'ruler' && renderOptions());
  App.on('layers', () => { if (['type', 'type-vertical'].includes(App.toolId) && !App.textEdit) renderOptions(); });
  renderOptions();
}
