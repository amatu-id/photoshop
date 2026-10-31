// Shared helpers: DOM, math, events, files

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl+';
export const ALT = isMac ? '⌥' : 'Alt+';
export const SHIFT = isMac ? '⇧' : 'Shift+';

let _uid = 1;
export const uid = (p = 'id') => `${p}${Date.now().toString(36)}${(_uid++).toString(36)}`;

// h('div.cls#id', {attrs, on:{click}}, children...)
export function h(tag, props, ...kids) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag) || [];
  const el = document.createElement(m[1] || 'div');
  if (m[2]) for (const part of m[2].match(/[.#][\w-]+/g)) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export const icon = (name, cls = '') => h('span', { class: `ms ${cls}`.trim(), 'aria-hidden': 'true', text: name });

export function canvas(w, h2) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h2));
  return c;
}
export const ctx2d = (c, opts) => c.getContext('2d', opts || { willReadFrequently: true });

export function cloneCanvas(src) {
  const c = canvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

export function debounce(fn, ms = 120) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function rafThrottle(fn) {
  let q = false, args;
  return (...a) => { args = a; if (q) return; q = true; requestAnimationFrame(() => { q = false; fn(...args); }); };
}

export class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] ||= new Set()).add(fn); return () => this._h[ev].delete(fn); }
  emit(ev, ...a) { this._h[ev]?.forEach(fn => { try { fn(...a); } catch (e) { console.error(e); } }); }
}

// Rectangles: {x,y,w,h}
export const rect = (x, y, w, h2) => ({ x, y, w: h2 === undefined ? w : w, h: h2 });
export function rectUnion(a, b) {
  if (!a) return b ? { ...b } : null; if (!b) return { ...a };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
export function rectClip(r, W, H) {
  if (!r) return null;
  const x = clamp(Math.floor(r.x), 0, W), y = clamp(Math.floor(r.y), 0, H);
  const x2 = clamp(Math.ceil(r.x + r.w), 0, W), y2 = clamp(Math.ceil(r.y + r.h), 0, H);
  if (x2 <= x || y2 <= y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}
export function rectFromPts(x1, y1, x2, y2) {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

export function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export const canvasToBlob = (c, type = 'image/png', q) => new Promise(r => c.toBlob(r, type, q));

export function pickFile(accept, multiple = false) {
  return new Promise(res => {
    const inp = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    inp.onchange = () => { res([...inp.files]); inp.remove(); };
    document.body.append(inp); inp.click();
  });
}

export function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image(); im.decoding = 'async';
    im.onload = () => res(im); im.onerror = rej; im.src = src;
  });
}
export async function fileToImage(file) {
  const url = URL.createObjectURL(file);
  try { return await loadImage(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 2000); }
}

export function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = h('script', { src }); s.onload = res; s.onerror = () => rej(new Error('Gagal memuat ' + src));
    document.head.append(s);
  });
}

export const fmtBytes = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(2) + ' MB';
export const round = (v, d = 0) => { const p = 10 ** d; return Math.round(v * p) / p; };
export const fmtNum = (v, d = 0) => round(v, d).toLocaleString('id-ID', { maximumFractionDigits: d });

export function keyName(e) {
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (e.code?.startsWith('Key')) k = e.code.slice(3);
  else if (e.code?.startsWith('Digit')) k = e.code.slice(5);
  else if (e.code === 'BracketLeft') k = '[';
  else if (e.code === 'BracketRight') k = ']';
  else if (e.code === 'Minus') k = '-';
  else if (e.code === 'Equal') k = '=';
  else if (e.code === 'Backslash') k = '\\';
  else if (e.code === 'Quote') k = "'";
  else if (e.code === 'Semicolon') k = ';';
  else if (e.code === 'Comma') k = ',';
  else if (e.code === 'Period') k = '.';
  else if (e.code === 'Slash') k = '/';
  else if (e.code === 'Backquote') k = '`';
  else if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  parts.push(k);
  return parts.join('+');
}

// Human readable shortcut label: "Mod+Shift+N" → "⇧⌘N"
export function fmtKey(s) {
  if (!s) return '';
  const p = s.split('+');
  const key = p.pop();
  const keyLabel = { Delete: '⌦', Backspace: '⌫', Enter: '↩', Escape: 'Esc', Space: 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Tab: '⇥' }[key] || key;
  if (isMac) {
    const order = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' };
    return ['Ctrl', 'Alt', 'Shift', 'Mod'].filter(m => p.includes(m)).map(m => order[m]).join('') + keyLabel;
  }
  return [...p.map(m => m === 'Mod' ? 'Ctrl' : m), keyLabel].join('+');
}

export function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
export function angleOf(a, b) { return Math.atan2(b.y - a.y, b.x - a.x); }
export const deg = r => r * 180 / Math.PI;
export const rad = d => d * Math.PI / 180;

export function storeGet(k, d) { try { const v = localStorage.getItem('amp.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }
export function storeSet(k, v) { try { localStorage.setItem('amp.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } }
