// Photoshop-style Color Picker dialog (HSB field + hue strip + HSB/RGB/Lab/CMYK/hex)

import { App } from '../state.js';
import { h, canvas, ctx2d, clamp } from '../util.js';
import { dialog, ibtn } from './controls.js';
import { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, rgbToLab, labToRgb, rgbToCmyk, cmykToRgb, rgbCss } from '../color.js';

const norm = c => typeof c === 'string' ? hexToRgb(c) : { r: c.r, g: c.g, b: c.b };

export function pickColor(initial = '#000000', { title = 'Color Picker', live } = {}) {
  return new Promise(res => {
    const old = norm(initial);
    let hsv = rgbToHsv(old), rgb = { ...old };
    const sv = h('div.sv'), svc = canvas(256, 256); svc.style.width = '100%'; svc.style.height = '100%'; sv.append(svc);
    const knob = h('div.cp-knob'); sv.append(knob);
    const hue = h('div.hue'), bar = h('div.bar'); hue.append(bar);
    const nw = h('div', { style: { height: '50%' } }), od = h('div', { style: { height: '50%', background: rgbCss(old), cursor: 'pointer' }, title: 'Kembalikan warna awal' });
    od.onclick = () => setRgb(old);
    const fields = {};
    const mk = (k, lab, max, unit = '') => {
      const i = h('input.inp', { 'aria-label': k });
      i.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') i.blur(); });
      i.onchange = () => fromField(k, parseFloat(i.value));
      fields[k] = i; return [h('label', { text: lab }), h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } }, i, h('span', { text: unit, style: { color: 'var(--text-3)' } }))];
    };
    const hex = h('input.inp', { style: { width: '84px' }, 'aria-label': 'hex' });
    hex.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') hex.blur(); });
    hex.onchange = () => { const v = hex.value.trim(); if (/^#?[0-9a-f]{3,6}$/i.test(v)) setRgb(hexToRgb(v)); };
    const eyedrop = window.EyeDropper ? ibtn('colorize', 'Ambil warna dari layar', async () => { try { const r = await new window.EyeDropper().open(); setRgb(hexToRgb(r.sRGBHex)); } catch { /* cancelled */ } }) : null;
    const vals = h('div.vals',
      h('div.newold', nw, od),
      ...mk('h', 'H:', 360, '°'), ...mk('L', 'L:', 100),
      ...mk('s', 'S:', 100, '%'), ...mk('a', 'a:', 127),
      ...mk('v', 'B:', 100, '%'), ...mk('lb', 'b:', 127),
      ...mk('r', 'R:', 255), ...mk('c', 'C:', 100, '%'),
      ...mk('g', 'G:', 255), ...mk('m', 'M:', 100, '%'),
      ...mk('b', 'B:', 255), ...mk('y', 'Y:', 100, '%'),
      h('label', { text: '#' }), h('div', { style: { display: 'flex', gap: '4px' } }, hex, eyedrop), ...mk('k', 'K:', 100, '%'),
    );
    const sw = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: '3px', marginTop: '12px' } });
    for (const c of (App.swatches || []).slice(0, 36)) { const d = h('div', { style: { aspectRatio: 1, borderRadius: '3px', background: c, cursor: 'pointer', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,.2)' } }); d.onclick = () => setRgb(hexToRgb(c)); sw.append(d); }
    const body = h('div', h('div.cpick', sv, hue, vals), sw);

    function drawSV() {
      const x = ctx2d(svc), base = hsvToRgb({ h: hsv.h, s: 100, v: 100 });
      const g1 = x.createLinearGradient(0, 0, 256, 0); g1.addColorStop(0, '#fff'); g1.addColorStop(1, rgbCss(base));
      x.fillStyle = g1; x.fillRect(0, 0, 256, 256);
      const g2 = x.createLinearGradient(0, 0, 0, 256); g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, '#000');
      x.fillStyle = g2; x.fillRect(0, 0, 256, 256);
    }
    function sync(skip) {
      drawSV();
      knob.style.left = hsv.s + '%'; knob.style.top = (100 - hsv.v) + '%';
      bar.style.top = (1 - hsv.h / 360) * 100 + '%';
      nw.style.background = rgbCss(rgb);
      const lab = rgbToLab(rgb), cmyk = rgbToCmyk(rgb);
      const set = { h: hsv.h, s: hsv.s, v: hsv.v, r: rgb.r, g: rgb.g, b: rgb.b, L: lab.L, a: lab.a, lb: lab.b, c: cmyk.c, m: cmyk.m, y: cmyk.y, k: cmyk.k };
      for (const [k, v] of Object.entries(set)) if (k !== skip) fields[k].value = Math.round(v);
      if (skip !== 'hex') hex.value = rgbToHex(rgb).slice(1);
      live?.(rgbToHex(rgb));
    }
    function setRgb(c) { rgb = { r: clamp(Math.round(c.r), 0, 255), g: clamp(Math.round(c.g), 0, 255), b: clamp(Math.round(c.b), 0, 255) }; const n = rgbToHsv(rgb); hsv = { h: n.s ? n.h : hsv.h, s: n.s, v: n.v }; sync(); }
    function setHsv(n) { hsv = n; rgb = hsvToRgb(hsv); sync(); }
    function fromField(k, v) {
      if (isNaN(v)) return sync();
      if ('hsv'.includes(k) && k.length === 1) { setHsv({ ...hsv, [k]: clamp(v, 0, k === 'h' ? 359.9 : 100) }); return; }
      if ('rgb'.includes(k) && k.length === 1) { setRgb({ ...rgb, [k]: v }); return; }
      if (k === 'L' || k === 'a' || k === 'lb') { const lab = rgbToLab(rgb); const nl = { L: k === 'L' ? clamp(v, 0, 100) : lab.L, a: k === 'a' ? clamp(v, -128, 127) : lab.a, b: k === 'lb' ? clamp(v, -128, 127) : lab.b }; setRgb(labToRgb(nl)); return; }
      const cm = rgbToCmyk(rgb); cm[k] = clamp(v, 0, 100); setRgb(cmykToRgb(cm));
    }
    const drag = (el, fn) => el.addEventListener('pointerdown', e => {
      el.setPointerCapture(e.pointerId); fn(e);
      const mv = ev => fn(ev), up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
    });
    drag(sv, e => { const r = sv.getBoundingClientRect(); setHsv({ h: hsv.h, s: clamp((e.clientX - r.left) / r.width * 100, 0, 100), v: clamp(100 - (e.clientY - r.top) / r.height * 100, 0, 100) }); });
    drag(hue, e => { const r = hue.getBoundingClientRect(); setHsv({ ...hsv, h: clamp((1 - (e.clientY - r.top) / r.height) * 360, 0, 359.9) }); });

    let result = null;
    dialog({
      title, body, width: 640,
      buttons: [{ label: 'Tambah ke Swatches', run: () => { App.addSwatch?.(rgbToHex(rgb)); return false; } }, 'grow', { label: 'Batal' }, { label: 'OK', primary: true, run: () => { result = rgbToHex(rgb); } }],
      onClose: () => res(result),
    });
    sync();
  });
}
App.pickColor = pickColor;
