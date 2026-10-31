// Adjustment controls (shared by Image › Adjustments dialogs and the Properties panel)

import { App } from '../state.js';
import { h, canvas, ctx2d, clamp } from '../util.js';
import { sliderRow, check, select, colorSwatch, ibtn } from './controls.js';
import { ADJUSTMENTS, PHOTO_FILTERS, LOOKS, curveLUT, histogram, defaultsFor } from '../adjust.js';
import { flattenDoc } from '../composite.js';
import { stopsCss, resolveStops, GRADIENT_PRESETS } from '../color.js';

export function docHistogram() {
  const d = App.doc; if (!d) return null;
  const c = d._comp || flattenDoc(d), k = Math.min(1, 600 / Math.max(c.width, c.height));
  const t = canvas(c.width * k, c.height * k); ctx2d(t).drawImage(c, 0, 0, t.width, t.height);
  return histogram(ctx2d(t).getImageData(0, 0, t.width, t.height));
}
function drawHist(cv, H, ch = 'l', color) {
  const x = ctx2d(cv), w = cv.width, hh = cv.height; x.clearRect(0, 0, w, hh);
  if (!H) return;
  const arr = H[ch === 'rgb' ? 'l' : ch] || H.l; let mx = 0; for (let i = 0; i < 256; i++) mx = Math.max(mx, arr[i]);
  const cap = Math.max(1, mx * .9);
  x.fillStyle = color || getComputedStyle(document.documentElement).getPropertyValue('--text-3');
  for (let i = 0; i < 256; i++) { const v = Math.min(1, arr[i] / cap) * hh; x.fillRect(i / 256 * w, hh - v, w / 256 + .6, v); }
}

const CURVE_PRESETS = {
  'Default': [[0, 0], [255, 255]],
  'Strong Contrast': [[0, 0], [64, 40], [192, 216], [255, 255]],
  'Medium Contrast': [[0, 0], [64, 52], [192, 204], [255, 255]],
  'Lighter': [[0, 0], [128, 160], [255, 255]],
  'Darker': [[0, 0], [128, 96], [255, 255]],
  'Negative': [[0, 255], [255, 0]],
  'Faded Film': [[0, 36], [128, 128], [255, 236]],
  'Cross Process': [[0, 0], [64, 48], [128, 140], [192, 210], [255, 255]],
};

function curvesWidget(p, fire) {
  const box = h('div.curve-box'), cv = canvas(512, 512); box.append(cv);
  const H = docHistogram();
  let sel = -1, dragging = -1;
  const pts = () => p[p.channel];
  const colors = { rgb: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(), r: '#ff5a5a', g: '#4cd964', b: '#4a8cff' };
  const draw = () => {
    const x = ctx2d(cv), S = 512; x.clearRect(0, 0, S, S);
    drawHist(cv, H, p.channel === 'rgb' ? 'l' : p.channel, 'rgba(140,150,170,.28)');
    x.strokeStyle = 'rgba(140,150,170,.3)'; x.lineWidth = 1;
    for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo(i * S / 4, 0); x.lineTo(i * S / 4, S); x.moveTo(0, i * S / 4); x.lineTo(S, i * S / 4); x.stroke(); }
    x.beginPath(); x.moveTo(0, S); x.lineTo(S, 0); x.strokeStyle = 'rgba(140,150,170,.35)'; x.stroke();
    for (const ch of ['r', 'g', 'b']) if (ch !== p.channel && p.channel === 'rgb' && JSON.stringify(p[ch]) !== '[[0,0],[255,255]]') { const l = curveLUT(p[ch]); x.beginPath(); for (let i = 0; i < 256; i++) x.lineTo(i * 2, S - l[i] * 2); x.strokeStyle = colors[ch]; x.globalAlpha = .5; x.stroke(); x.globalAlpha = 1; }
    const lut = curveLUT(pts()); x.beginPath(); for (let i = 0; i < 256; i++) x.lineTo(i * 2, S - lut[i] * 2);
    x.strokeStyle = colors[p.channel]; x.lineWidth = 2.5; x.stroke();
    pts().forEach(([a, b], i) => { x.beginPath(); x.rect(a * 2 - 6, S - b * 2 - 6, 12, 12); x.fillStyle = i === sel ? colors[p.channel] : '#fff'; x.fill(); x.lineWidth = 1.5; x.strokeStyle = '#000'; x.stroke(); });
  };
  const toVal = e => { const r = box.getBoundingClientRect(); return [clamp(Math.round((e.clientX - r.left) / r.width * 255), 0, 255), clamp(Math.round(255 - (e.clientY - r.top) / r.height * 255), 0, 255)]; };
  box.addEventListener('pointerdown', e => {
    box.setPointerCapture(e.pointerId);
    const [vx, vy] = toVal(e), P = pts();
    let idx = P.findIndex(([a, b]) => Math.abs(a - vx) < 8 && Math.abs(b - vy) < 8);
    if (idx < 0) { P.push([vx, vy]); P.sort((a, b) => a[0] - b[0]); idx = P.findIndex(q => q[0] === vx && q[1] === vy); }
    sel = dragging = idx; draw(); fire();
  });
  box.addEventListener('pointermove', e => {
    if (dragging < 0) return; const P = pts(); let [vx, vy] = toVal(e);
    const r = box.getBoundingClientRect(), out = e.clientX < r.left - 20 || e.clientX > r.right + 20 || e.clientY < r.top - 20 || e.clientY > r.bottom + 20;
    if (out && P.length > 2) { P.splice(dragging, 1); dragging = sel = -1; draw(); fire(); return; }
    const lo = dragging > 0 ? P[dragging - 1][0] + 1 : 0, hi = dragging < P.length - 1 ? P[dragging + 1][0] - 1 : 255;
    P[dragging] = [clamp(vx, lo, hi), vy]; draw(); fire();
  });
  box.addEventListener('pointerup', () => { dragging = -1; fire(true); });
  box.redraw = draw; draw();
  return box;
}

function levelsWidget(p, fire) {
  const wrap = h('div');
  const H = docHistogram();
  const hc = canvas(512, 200); hc.className = 'levels-hist';
  const tin = h('div.lv-track'), tout = h('div.lv-track');
  const kb = [h('div.lv-knob', { style: { '--k': '#000' } }), h('div.lv-knob', { style: { '--k': '#888' } }), h('div.lv-knob', { style: { '--k': '#fff' } })];
  const ko = [h('div.lv-knob', { style: { '--k': '#000' } }), h('div.lv-knob', { style: { '--k': '#fff' } })];
  tin.append(...kb); tout.append(...ko);
  const nums = ['ib', 'g', 'iw'].map(k => { const i = h('input.inp', { style: { width: '56px', textAlign: 'center' } }); i.onchange = () => { const v = parseFloat(i.value); if (!isNaN(v)) { L()[k] = k === 'g' ? clamp(v, .1, 9.99) : clamp(Math.round(v), 0, 255); sync(); fire(true); } }; i.addEventListener('keydown', e => e.stopPropagation()); return i; });
  const onums = ['ob', 'ow'].map(k => { const i = h('input.inp', { style: { width: '56px', textAlign: 'center' } }); i.onchange = () => { const v = parseInt(i.value); if (!isNaN(v)) { L()[k] = clamp(v, 0, 255); sync(); fire(true); } }; i.addEventListener('keydown', e => e.stopPropagation()); return i; });
  const L = () => p[p.channel];
  const sync = () => {
    const l = L();
    drawHist(hc, H, p.channel === 'rgb' ? 'l' : p.channel);
    kb[0].style.left = l.ib / 255 * 100 + '%'; kb[2].style.left = l.iw / 255 * 100 + '%';
    const mid = l.ib + (l.iw - l.ib) * Math.pow(.5, l.g); kb[1].style.left = mid / 255 * 100 + '%';
    ko[0].style.left = l.ob / 255 * 100 + '%'; ko[1].style.left = l.ow / 255 * 100 + '%';
    nums[0].value = l.ib; nums[1].value = l.g.toFixed(2); nums[2].value = l.iw; onums[0].value = l.ob; onums[1].value = l.ow;
  };
  const dragKnob = (el, track, fn) => el.addEventListener('pointerdown', e => {
    e.stopPropagation(); el.setPointerCapture(e.pointerId);
    const mv = ev => { const r = track.getBoundingClientRect(); fn(clamp((ev.clientX - r.left) / r.width * 255, 0, 255)); sync(); fire(); };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); fire(true); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  });
  dragKnob(kb[0], tin, v => { L().ib = Math.min(Math.round(v), L().iw - 2); });
  dragKnob(kb[2], tin, v => { L().iw = Math.max(Math.round(v), L().ib + 2); });
  dragKnob(kb[1], tin, v => { const l = L(); const t = clamp((v - l.ib) / Math.max(1, l.iw - l.ib), .01, .99); l.g = clamp(Math.log(t) / Math.log(.5), .1, 9.99); });
  dragKnob(ko[0], tout, v => { L().ob = Math.round(v); });
  dragKnob(ko[1], tout, v => { L().ow = Math.round(v); });
  wrap.append(hc, tin, h('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '10px' } }, ...nums),
    h('div.note', { text: 'Output Levels:', style: { marginBottom: '4px' } }), tout, h('div', { style: { display: 'flex', justifyContent: 'space-between' } }, ...onums));
  wrap.redraw = sync; sync();
  return wrap;
}

function gradientBar(get, set, fire) {
  const bar = h('div.grad-bar');
  const paint = () => { bar.style.background = stopsCss(resolveStops(get(), App.fg, App.bg)); };
  bar.onclick = async () => { const st = await App.editGradient?.(get()); if (st) { set(st); paint(); fire(true); } };
  paint(); return bar;
}

// Build the control set for an adjustment. p is mutated; onChange(final:boolean)
export function adjustUI(kind, p, onChange) {
  const fire = (fin = false) => onChange(fin);
  const el = h('div.adj-ui');
  const S = (label, key, min, max, opt = {}) => {
    const r = sliderRow({ label, value: opt.get ? opt.get() : p[key], min, max, step: opt.step || 1, track: opt.track, onInput: v => { opt.set ? opt.set(v) : (p[key] = v); fire(); }, onChange: () => fire(true) });
    r.dataset.def = opt.def ?? 0; return r;
  };
  const presetSel = (presets, apply) => select([['', 'Preset: Kustom'], ...Object.keys(presets).map(k => [k, k])], '', v => { if (v) { apply(presets[v]); rebuild(); fire(true); } });
  const rebuild = () => { const n = adjustUI(kind, p, onChange); el.replaceWith(n); };
  switch (kind) {
    case 'brightness-contrast':
      el.append(S('Brightness', 'brightness', -150, 150), S('Contrast', 'contrast', -50, 100), check('Use Legacy', p.legacy, v => { p.legacy = v; fire(true); }));
      break;
    case 'levels': {
      const w = levelsWidget(p, fire);
      el.append(h('div.prow', select([['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']], p.channel, v => { p.channel = v; w.redraw(); }), ibtn('auto_fix_high', 'Auto', () => {
        const H = docHistogram(); if (!H) return;
        const pct = (a, q) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += a[i]; if (acc >= H.n * q) return i; } return 255; };
        for (const c of ['r', 'g', 'b']) { p[c].ib = pct(H[c], .001); p[c].iw = Math.max(p[c].ib + 2, pct(H[c], .999)); }
        w.redraw(); fire(true);
      })), w);
      break;
    }
    case 'curves': {
      const w = curvesWidget(p, fire);
      el.append(h('div.prow', select([['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']], p.channel, v => { p.channel = v; w.redraw(); }), presetSel(CURVE_PRESETS, pts => { p[p.channel] = structuredClone(pts); }), ibtn('restart_alt', 'Reset kurva', () => { p[p.channel] = [[0, 0], [255, 255]]; w.redraw(); fire(true); })), w, h('div.note', { text: 'Klik untuk menambah titik, seret keluar kotak untuk menghapus.', style: { marginTop: '6px' } }));
      break;
    }
    case 'exposure':
      el.append(S('Exposure', 'exposure', -20, 20, { step: .01 }), S('Offset', 'offset', -.5, .5, { step: .001 }), S('Gamma Correction', 'gamma', .01, 9.99, { step: .01, def: 1 }));
      break;
    case 'vibrance':
      el.append(S('Vibrance', 'vibrance', -100, 100), S('Saturation', 'saturation', -100, 100));
      break;
    case 'hue-saturation': {
      const ranges = [['master', 'Master'], ['reds', 'Reds'], ['yellows', 'Yellows'], ['greens', 'Greens'], ['cyans', 'Cyans'], ['blues', 'Blues'], ['magentas', 'Magentas']];
      const R = () => p.colorize ? p.cz : p[p.range];
      const box = h('div');
      const fill = () => {
        box.replaceChildren(
          S('Hue', null, -180, 180, { get: () => R().h, set: v => { R().h = v; }, track: 'linear-gradient(90deg,cyan,blue,magenta,red,yellow,lime,cyan)' }),
          S('Saturation', null, p.colorize ? 0 : -100, 100, { get: () => R().s, set: v => { R().s = v; }, track: 'linear-gradient(90deg,#808080,#ff3030)' }),
          S('Lightness', null, -100, 100, { get: () => R().l, set: v => { R().l = v; }, track: 'linear-gradient(90deg,#000,#808080,#fff)' }));
      };
      const rs = select(ranges, p.range, v => { p.range = v; fill(); });
      el.append(h('div.prow', rs), box, check('Colorize', p.colorize, v => { p.colorize = v; rs.disabled = v; fill(); fire(true); }));
      rs.disabled = p.colorize; fill();
      break;
    }
    case 'color-balance': {
      const box = h('div');
      const fill = () => {
        const a = p[p.tone];
        box.replaceChildren(
          S('Cyan — Red', null, -100, 100, { get: () => a[0], set: v => { a[0] = v; }, track: 'linear-gradient(90deg,cyan,#888,red)' }),
          S('Magenta — Green', null, -100, 100, { get: () => a[1], set: v => { a[1] = v; }, track: 'linear-gradient(90deg,magenta,#888,lime)' }),
          S('Yellow — Blue', null, -100, 100, { get: () => a[2], set: v => { a[2] = v; }, track: 'linear-gradient(90deg,yellow,#888,blue)' }));
      };
      el.append(h('div.prow', h('label', { text: 'Tone' }), select([['shadows', 'Shadows'], ['mid', 'Midtones'], ['highlights', 'Highlights']], p.tone, v => { p.tone = v; fill(); })), box, check('Preserve Luminosity', p.preserve, v => { p.preserve = v; fire(true); }));
      fill();
      break;
    }
    case 'black-white':
      el.append(
        S('Reds', 'reds', -200, 300, { def: 40, track: 'linear-gradient(90deg,#000,red)' }), S('Yellows', 'yellows', -200, 300, { def: 60, track: 'linear-gradient(90deg,#000,yellow)' }),
        S('Greens', 'greens', -200, 300, { def: 40, track: 'linear-gradient(90deg,#000,lime)' }), S('Cyans', 'cyans', -200, 300, { def: 60, track: 'linear-gradient(90deg,#000,cyan)' }),
        S('Blues', 'blues', -200, 300, { def: 20, track: 'linear-gradient(90deg,#000,blue)' }), S('Magentas', 'magentas', -200, 300, { def: 80, track: 'linear-gradient(90deg,#000,magenta)' }),
        check('Tint', p.tint, v => { p.tint = v; fire(true); }), S('Hue', 'th', 0, 360, { def: 42 }), S('Saturation', 'ts', 0, 100, { def: 20 }));
      break;
    case 'photo-filter': {
      const sw = colorSwatch(() => p.color, c => { p.color = c; fire(true); });
      el.append(h('div.prow', h('label', { text: 'Filter' }), select(PHOTO_FILTERS.map(([n, c]) => [c, n]), p.color, v => { p.color = v; sw.refresh(); fire(true); })),
        h('div.prow', h('label', { text: 'Color' }), sw), S('Density', 'density', 1, 100, { def: 25 }), check('Preserve Luminosity', p.preserve, v => { p.preserve = v; fire(true); }));
      break;
    }
    case 'channel-mixer': {
      const box = h('div');
      const fill = () => {
        const a = p.mono ? p.k : p[p.out];
        box.replaceChildren(S('Red', null, -200, 200, { get: () => a[0], set: v => { a[0] = v; } }), S('Green', null, -200, 200, { get: () => a[1], set: v => { a[1] = v; } }), S('Blue', null, -200, 200, { get: () => a[2], set: v => { a[2] = v; } }), S('Constant', null, -200, 200, { get: () => a[3], set: v => { a[3] = v; } }), h('div.note', { text: `Total: ${a[0] + a[1] + a[2]}%` }));
      };
      const os = select([['r', 'Red'], ['g', 'Green'], ['b', 'Blue']], p.out, v => { p.out = v; fill(); });
      el.append(h('div.prow', h('label', { text: 'Output Channel' }), os), check('Monochrome', p.mono, v => { p.mono = v; os.disabled = v; fill(); fire(true); }), box); fill();
      break;
    }
    case 'color-lookup':
      el.append(h('div.prow', h('label', { text: 'Look' }), select(LOOKS.map(l => [l, l]), p.look, v => { p.look = v; fire(true); })), S('Amount', 'amount', 0, 100, { def: 100 }));
      break;
    case 'invert': el.append(h('div.note', { text: 'Membalik semua warna di bawah layer ini. Tidak ada pengaturan.' })); break;
    case 'posterize': el.append(S('Levels', 'levels', 2, 255, { def: 4 })); break;
    case 'threshold': {
      const hc = canvas(512, 160); hc.className = 'levels-hist'; drawHist(hc, docHistogram());
      el.append(hc, S('Threshold Level', 'level', 1, 255, { def: 128 }));
      break;
    }
    case 'gradient-map':
      el.append(gradientBar(() => p.stops, st => { p.stops = st; }, fire), h('div', { style: { height: '8px' } }), check('Reverse', p.reverse, v => { p.reverse = v; fire(true); }),
        h('div.prow', { style: { marginTop: '8px', flexWrap: 'wrap' } }, ...GRADIENT_PRESETS.filter(g => Array.isArray(g.stops)).map(g => { const b = h('button.btn.sm', { type: 'button', style: { width: '36px', background: stopsCss(resolveStops(g.stops)) }, 'data-tip': g.name }); b.onclick = () => { p.stops = structuredClone(g.stops); rebuild(); fire(true); }; return b; })));
      break;
    case 'selective-color': {
      const box = h('div');
      const fill = () => { const a = p[p.target]; box.replaceChildren(...['Cyan', 'Magenta', 'Yellow', 'Black'].map((n, i) => S(n, null, -100, 100, { get: () => a[i], set: v => { a[i] = v; } }))); };
      el.append(h('div.prow', h('label', { text: 'Colors' }), select([['reds', 'Reds'], ['yellows', 'Yellows'], ['greens', 'Greens'], ['cyans', 'Cyans'], ['blues', 'Blues'], ['magentas', 'Magentas'], ['whites', 'Whites'], ['neutrals', 'Neutrals'], ['blacks', 'Blacks']], p.target, v => { p.target = v; fill(); })), box,
        h('div.prow', h('label', { text: 'Method' }), select([['relative', 'Relative'], ['absolute', 'Absolute']], p.method, v => { p.method = v; fire(true); })));
      fill();
      break;
    }
  }
  return el;
}
export { ADJUSTMENTS, defaultsFor };
