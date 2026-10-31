// Reusable UI building blocks: scrubby number fields, sliders, menus, popovers, dialogs, toasts, tooltips

import { App } from '../state.js';
import { h, icon, clamp, fmtKey, $ } from '../util.js';
import { rgbCss } from '../color.js';

// ── Number field with scrubby label (drag label to change value) ─────────
export function numField({ label, value, min = -Infinity, max = Infinity, step = 1, unit = '', width, onInput, onChange, tip, dd }) {
  const inp = h('input.inp', { value: fmt(value, step), style: width ? { width: width + 'px' } : null, inputmode: 'decimal', 'aria-label': tip || label || 'nilai' });
  const lab = label != null ? h('label', { text: label }) : null;
  const wrap = h('span.num', lab, inp, unit ? h('span.unit', { text: unit }) : null);
  if (tip) wrap.dataset.tip = tip;
  let cur = value;
  const set = (v, fire = 'input') => {
    v = clamp(Math.round(v / step) * step, min, max); if (!isFinite(v)) return;
    cur = v; inp.value = fmt(v, step);
    if (fire === 'input') onInput?.(v); else { onInput?.(v); onChange?.(v); }
  };
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { inp.blur(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); set(cur + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1), 'change'); }
    if (e.key === 'Escape') { inp.value = fmt(cur, step); inp.blur(); }
  });
  inp.addEventListener('change', () => { const v = parseFloat(inp.value.replace(',', '.')); if (!isNaN(v)) set(v, 'change'); else inp.value = fmt(cur, step); });
  inp.addEventListener('focus', () => inp.select());
  const scrub = el => el.addEventListener('pointerdown', e => {
    e.preventDefault(); const x0 = e.clientX, v0 = cur; let moved = false;
    el.setPointerCapture(e.pointerId);
    const mv = ev => { const dx = ev.clientX - x0; if (Math.abs(dx) > 1) moved = true; const k = ev.shiftKey ? 10 : ev.altKey ? .1 : 1; set(v0 + Math.round(dx / 2) * step * k); };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); if (moved) onChange?.(cur); else inp.focus(); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  });
  if (lab) scrub(lab);
  if (dd) {
    const b = h('button.dd', { type: 'button', 'aria-label': 'Penggeser' }, icon('expand_more'));
    b.onclick = () => {
      const r = h('input', { type: 'range', min: dd.min ?? min, max: dd.max ?? max, step, value: cur, style: { width: '160px' } });
      r.oninput = () => set(+r.value); r.onchange = () => onChange?.(cur);
      popover(b, h('div', r));
    };
    wrap.append(b);
  }
  wrap.set = v => { cur = v; inp.value = fmt(v, step); };
  wrap.get = () => cur;
  return wrap;
}
const fmt = (v, step) => { const d = step < 1 ? Math.min(2, String(step).split('.')[1]?.length || 1) : 0; return (+v).toFixed(d).replace(/\.0+$/, ''); };

// Labelled slider with numeric box
export function sliderRow({ label, value, min, max, step = 1, unit = '', track, onInput, onChange }) {
  const r = h('input', { type: 'range', min, max, step, value });
  const n = h('input.inp', { value: fmt(value, step), 'aria-label': label });
  const row = h('div.slider-row', h('div.lbl', h('span', { text: label }), unit ? h('span', { text: unit, style: { color: 'var(--text-3)' } }) : null), h('div.track' + (track ? '.grad' : ''), r), n);
  if (track) r.style.setProperty('--track', track);
  const set = (v, fire) => { v = clamp(+v, min, max); r.value = v; n.value = fmt(v, step); if (fire) onInput?.(v); };
  r.oninput = () => set(r.value, true);
  r.onchange = () => onChange?.(+r.value);
  r.addEventListener('dblclick', () => { const d = row.dataset.def; if (d !== undefined) { set(d, true); onChange?.(+d); } });
  n.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') n.blur(); });
  n.onchange = () => { const v = parseFloat(n.value); if (!isNaN(v)) { set(v, true); onChange?.(+r.value); } };
  row.dataset.def = value;
  row.set = v => set(v, false);
  return row;
}
export function check(label, value, onChange) {
  const i = h('input', { type: 'checkbox', checked: !!value });
  i.onchange = () => onChange(i.checked);
  const l = h('label.chk', i, h('span', { text: label }));
  l.set = v => { i.checked = !!v; };
  return l;
}
export function select(options, value, onChange, cls = '') {
  const s = h('select.inp' + cls);
  for (const o of options) {
    if (o === null) { s.append(h('option', { disabled: true, text: '──────────' })); continue; }
    s.append(h('option', { value: o[0], text: o[1], selected: String(o[0]) === String(value) }));
  }
  s.onchange = () => onChange(s.value);
  s.addEventListener('keydown', e => e.stopPropagation());
  return s;
}
export function colorSwatch(get, set, title = 'Pilih warna') {
  const sw = h('button.swatch', { type: 'button', 'aria-label': title });
  const paint = () => { const c = get(); sw.classList.toggle('none', !c); sw.style.background = c ? (typeof c === 'string' ? c : rgbCss(c)) : ''; };
  sw.onclick = async () => { const c = await App.pickColor(get() || '#000000', { title }); if (c) { set(c); paint(); } };
  paint(); sw.refresh = paint;
  return sw;
}
export function ibtn(ic, tip, onClick, { svg = false, cls = '' } = {}) {
  const b = h('button.ibtn' + cls, { type: 'button', 'aria-label': tip?.split('|')[0] || ic });
  if (svg) b.innerHTML = svg; else b.append(icon(ic));
  if (tip) b.dataset.tip = tip;
  if (onClick) b.onclick = onClick;
  return b;
}

// ── Menus ────────────────────────────────────────────────────────────────
let openMenus = [];
export function closeMenus(level = 0) { openMenus.splice(level).forEach(m => m.remove()); if (!openMenus.length) App.emit('menuclosed'); }
// items: [{label, key, run, checked, disabled, sub:[...]} | '-' | {header}]
export function showMenu(items, x, y, { level = 0, alignRight = false, minWidth } = {}) {
  closeMenus(level);
  const m = h('div.menu', { role: 'menu' });
  if (minWidth) m.style.minWidth = minWidth + 'px';
  const list = (typeof items === 'function' ? items() : items).filter(Boolean);
  for (const it of list) {
    if (it === '-') { if (m.lastChild && !m.lastChild.classList.contains('sep')) m.append(h('div.sep')); continue; }
    if (it.header) { m.append(h('div.mh', { text: it.header })); continue; }
    const dis = typeof it.disabled === 'function' ? it.disabled() : it.disabled;
    const chk = typeof it.checked === 'function' ? it.checked() : it.checked;
    const row = h('div.mi' + (dis ? '.dis' : ''), { role: 'menuitem' },
      h('span.ck', chk ? icon('check') : null), h('span.lb', { text: it.label }),
      it.sub ? icon('chevron_right', 'sub') : it.key ? h('kbd', { text: fmtKey(it.key) }) : null);
    if (it.sub) {
      let t;
      const open = () => { clearTimeout(t); m.querySelectorAll('.hot').forEach(e => e.classList.remove('hot')); row.classList.add('hot'); const r = row.getBoundingClientRect(); showMenu(it.sub, r.right - 2, r.top - 5, { level: level + 1 }); };
      row.addEventListener('mouseenter', () => { t = setTimeout(open, 120); });
      row.addEventListener('mouseleave', () => clearTimeout(t));
      row.addEventListener('click', open);
    } else {
      row.addEventListener('mouseenter', () => { if (openMenus.length > level + 1) closeMenus(level + 1); m.querySelectorAll('.hot').forEach(e => e.classList.remove('hot')); });
      row.addEventListener('click', e => { e.stopPropagation(); closeMenus(); try { it.run?.(); } catch (err) { console.error(err); App.emit('toast', String(err.message || err), 'err'); } });
    }
    m.append(row);
  }
  if (m.lastChild?.classList.contains('sep')) m.lastChild.remove();
  $('#popups').append(m);
  const r = m.getBoundingClientRect();
  let left = alignRight ? x - r.width : x, top = y;
  if (left + r.width > innerWidth - 6) left = level ? x - r.width - (openMenus[level - 1]?.offsetWidth || 0) + 6 : innerWidth - r.width - 6;
  if (top + r.height > innerHeight - 6) top = Math.max(6, innerHeight - r.height - 6);
  m.style.left = Math.max(6, left) + 'px'; m.style.top = top + 'px';
  openMenus[level] = m;
  return m;
}
document.addEventListener('pointerdown', e => {
  if (openMenus.length && !e.target.closest('.menu') && !e.target.closest('.mitem')) closeMenus();
  for (const p of [...document.querySelectorAll('.pop')]) if (!p.contains(e.target) && !p._anchor?.contains(e.target)) p.remove();
}, true);
export const isMenuOpen = () => openMenus.length > 0;

// Popover anchored to an element
export function popover(anchor, content, { cls = '', width, onClose } = {}) {
  document.querySelectorAll('.pop').forEach(p => p.remove());
  const p = h('div.pop' + cls, content);
  if (width) p.style.width = width + 'px';
  p._anchor = anchor;
  $('#popups').append(p);
  const a = anchor.getBoundingClientRect(), r = p.getBoundingClientRect();
  let left = a.left, top = a.bottom + 6;
  if (left + r.width > innerWidth - 8) left = innerWidth - r.width - 8;
  if (top + r.height > innerHeight - 8) top = Math.max(8, a.top - r.height - 6);
  p.style.left = Math.max(8, left) + 'px'; p.style.top = top + 'px';
  const obs = new MutationObserver(() => { if (!p.isConnected) { obs.disconnect(); onClose?.(); } });
  obs.observe($('#popups'), { childList: true });
  p.close = () => p.remove();
  return p;
}

// ── Dialog ───────────────────────────────────────────────────────────────
export function dialog({ title, body, buttons = [], cls = '', onClose, width, noBackdropClose = true, help }) {
  const back = h('div.dlg-back');
  const box = h('div.dlg' + cls, { role: 'dialog', 'aria-label': title });
  if (width) box.style.width = `min(${width}px, calc(100vw - 24px))`;
  const close = (v) => { back.remove(); document.removeEventListener('keydown', key, true); onClose?.(v); };
  const head = h('div.dlg-head', h('b', { text: title }), help ? h('span.note', { text: help }) : null, ibtn('close', 'Tutup', () => close(null)));
  const foot = h('div.dlg-foot');
  const btnEls = {};
  for (const b of buttons) {
    if (b === 'grow') { foot.append(h('div.grow')); continue; }
    if (b.el) { foot.append(b.el); continue; }
    const el = h('button.btn' + (b.primary ? '.primary' : ''), { type: 'button', text: b.label });
    el.onclick = async () => { const r = await b.run?.(); if (r !== false) close(b.value ?? r ?? b.label); };
    btnEls[b.id || b.label] = el; foot.append(el);
  }
  box.append(head, h('div.dlg-body', body), buttons.length ? foot : null);
  back.append(box);
  $('#dialogs').append(back);
  if (!noBackdropClose) back.addEventListener('pointerdown', e => { if (e.target === back) close(null); });
  const key = e => {
    if (!back.isConnected) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
    if (e.key === 'Enter' && !e.target.matches('textarea')) { const p = buttons.find(b => b.primary); if (p) { e.preventDefault(); e.stopPropagation(); btnEls[p.id || p.label].click(); } }
  };
  document.addEventListener('keydown', key, true);
  // drag by header
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const r = box.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    box.style.position = 'fixed'; box.style.left = r.left + 'px'; box.style.top = r.top + 'px'; box.style.margin = 0;
    const mv = ev => { box.style.left = ev.clientX - x0 + 'px'; box.style.top = ev.clientY - y0 + 'px'; };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
  setTimeout(() => box.querySelector('input:not([type=checkbox]):not([type=range]), select, textarea')?.focus(), 30);
  return { el: box, close, buttons: btnEls };
}
export function confirmDlg(message, { title = 'Amatu Photo', ok = 'OK', cancel = 'Batal', extra } = {}) {
  return new Promise(res => {
    const btns = [];
    if (extra) btns.push({ label: extra, value: 'extra' }, 'grow'); else btns.push('grow');
    btns.push({ label: cancel, value: false }, { label: ok, primary: true, value: true });
    dialog({ title, body: h('p', { style: { margin: '6px 0 4px', lineHeight: 1.5 }, text: message }), buttons: btns, width: 420, onClose: v => res(v === 'extra' ? 'extra' : v === true) });
  });
}
export function promptDlg(message, value = '', { title = 'Amatu Photo', ok = 'OK' } = {}) {
  return new Promise(res => {
    const inp = h('input.inp', { value, style: { width: '100%', height: '30px' } });
    inp.addEventListener('keydown', e => e.stopPropagation());
    let result = null;
    dialog({ title, width: 420, body: h('div.field', h('span', { text: message }), inp), buttons: ['grow', { label: 'Batal', value: null }, { label: ok, primary: true, run: () => { result = inp.value; } }], onClose: () => res(result) });
    setTimeout(() => inp.select(), 40);
  });
}

// ── Toasts & tooltips ────────────────────────────────────────────────────
App.on('toast', (msg, kind = 'info', ms = 2600) => {
  const t = h('div.toast' + (kind === 'err' ? '.err' : ''), icon(kind === 'err' ? 'error' : kind === 'ok' ? 'check_circle' : 'info'), h('span', { text: msg }));
  $('#toasts').append(t);
  setTimeout(() => { t.style.transition = 'opacity .25s'; t.style.opacity = 0; setTimeout(() => t.remove(), 260); }, ms);
});
let tipT;
document.addEventListener('pointerover', e => {
  const el = e.target.closest('[data-tip]'); const tip = $('#tooltip');
  clearTimeout(tipT);
  if (!el || !App.prefs.showTips) { tip.classList.remove('on'); return; }
  tipT = setTimeout(() => {
    if (!el.isConnected) return;
    const [t, k, desc] = el.dataset.tip.split('|');
    tip.replaceChildren(h('span', { text: t }), k ? h('kbd', { text: fmtKey(k) }) : null, desc ? h('div.tdesc', { text: desc }) : null);
    tip.classList.add('on');
    const r = el.getBoundingClientRect(), tr = tip.getBoundingClientRect();
    let left = r.right + 8, top = r.top + r.height / 2 - tr.height / 2;
    if (el.closest('.optionsbar, .menubar, .pfoot, .phead, .statusbar, .dlg') || left + tr.width > innerWidth) { left = r.left + r.width / 2 - tr.width / 2; top = r.bottom + 8; }
    if (top + tr.height > innerHeight - 6) top = r.top - tr.height - 8;
    tip.style.left = clamp(left, 6, innerWidth - tr.width - 6) + 'px'; tip.style.top = Math.max(6, top) + 'px';
  }, 550);
});
document.addEventListener('pointerdown', () => { clearTimeout(tipT); $('#tooltip')?.classList.remove('on'); }, true);

// On-canvas HUD bubble (used by tools)
App.hud = (x, sx, sy, lines) => {
  x.save(); x.font = '500 11px Inter, sans-serif';
  const w = Math.max(...lines.map(l => x.measureText(l).width)) + 14, hh = lines.length * 15 + 8;
  x.fillStyle = 'rgba(20,22,30,.85)'; x.strokeStyle = 'rgba(255,255,255,.15)';
  x.beginPath(); x.roundRect(sx, sy, w, hh, 5); x.fill(); x.stroke();
  x.fillStyle = '#fff'; lines.forEach((l, i) => x.fillText(l, sx + 7, sy + 16 + i * 15));
  x.restore();
};
