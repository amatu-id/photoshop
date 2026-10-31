// Compositor: renders the layer tree (blend modes, masks, clipping, styles,
// adjustment/fill/text/shape layers) into a document-sized canvas, rect by rect.

import { canvas, ctx2d, clamp, rad } from './util.js';
import { NATIVE_BLEND } from './doc.js';
import { applyAdjustment } from './adjust.js';
import { hexToRgb, rgbCss, resolveStops, luma } from './color.js';
import { gaussianImageData, distanceTransform, blurPlane } from './blur.js';

// ── Buffers in document coordinates ──────────────────────────────────────
function buffer(r) {
  const c = canvas(r.w, r.h), x = ctx2d(c);
  x.setTransform(1, 0, 0, 1, -r.x, -r.y);
  return { c, x, r };
}
function getData(b) { return b.x.getImageData(0, 0, b.r.w, b.r.h); }
function putData(b, img) { b.x.putImageData(img, 0, 0); }

// ── Custom blend modes not supported by canvas ───────────────────────────
const B = {
  'linear-burn': (b, s) => Math.max(0, b + s - 1),
  'vivid-light': (b, s) => s <= .5 ? (s === 0 ? 0 : Math.max(0, 1 - (1 - b) / (2 * s))) : (s === 1 ? 1 : Math.min(1, b / (2 * (1 - s)))),
  'linear-light': (b, s) => clamp(b + 2 * s - 1, 0, 1),
  'pin-light': (b, s) => s <= .5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1),
  'hard-mix': (b, s) => (b + s >= 1 ? 1 : 0),
  subtract: (b, s) => Math.max(0, b - s),
  divide: (b, s) => (s === 0 ? (b ? 1 : 0) : Math.min(1, b / s)),
};
export function blendPixels(dst, src, mode, opacity, maskData) {
  const d = dst.data, s = src.data, f = B[mode];
  for (let i = 0; i < d.length; i += 4) {
    let as = s[i + 3] / 255 * opacity;
    if (maskData) as *= maskData[i + 3] / 255;
    if (as <= 0) continue;
    if (mode === 'dissolve') { if (Math.random() >= as) continue; as = 1; }
    const ab = d[i + 3] / 255, ao = as + ab * (1 - as);
    if (mode === 'darker-color' || mode === 'lighter-color') {
      const lb = luma(d[i], d[i + 1], d[i + 2]), ls = luma(s[i], s[i + 1], s[i + 2]);
      const pickS = mode === 'darker-color' ? ls < lb : ls > lb;
      for (let c = 0; c < 3; c++) {
        const cb = d[i + c] / 255, cs = s[i + c] / 255, mix = (1 - ab) * cs + ab * (pickS ? cs : cb);
        d[i + c] = (as * mix + ab * cb * (1 - as)) / ao * 255;
      }
    } else {
      for (let c = 0; c < 3; c++) {
        const cb = d[i + c] / 255, cs = s[i + c] / 255;
        const mix = f ? (1 - ab) * cs + ab * f(cb, cs) : cs;
        d[i + c] = (as * mix + ab * cb * (1 - as)) / ao * 255;
      }
    }
    d[i + 3] = ao * 255;
  }
}

// Draw a positioned surface onto a buffer with blend mode + opacity
function drawSurface(dst, surf, mode, opacity) {
  if (!surf || opacity <= 0) return;
  if (mode === 'pass') mode = 'normal';
  if (NATIVE_BLEND.has(mode)) {
    dst.x.save();
    dst.x.globalAlpha = opacity;
    dst.x.globalCompositeOperation = mode === 'normal' ? 'source-over' : mode;
    dst.x.drawImage(surf.canvas, surf.x, surf.y);
    dst.x.restore();
    return;
  }
  const tmp = buffer(dst.r); tmp.x.drawImage(surf.canvas, surf.x, surf.y);
  const img = getData(dst); blendPixels(img, getData(tmp), mode, opacity); putData(dst, img);
}

// ── Text rendering ───────────────────────────────────────────────────────
export function fontString(t, scale = 1) {
  return `${t.italic ? 'italic ' : ''}${t.weight || 400} ${t.size * scale}px ${quoteFont(t.font)}`;
}
const quoteFont = f => /[\s\d]/.test(f) && !/[",]/.test(f) ? `"${f}", sans-serif` : `${f}, sans-serif`;

export function layoutText(t, mctx) {
  // vertical type stacks one glyph per line
  const x = mctx || ctx2d(canvas(1, 1));
  x.font = fontString(t);
  const track = (t.tracking || 0) / 1000 * t.size;
  const measure = s => x.measureText(s).width + track * Math.max(0, [...s].length - 1);
  let content = t.caps ? t.content.toUpperCase() : t.content;
  if (t.vertical) { content = [...content.replace(/\n/g, ' ')].join('\n'); t = { ...t, align: 'center' }; }
  const paras = content.split('\n'), lines = [];
  const lead = t.leading || Math.round(t.size * 1.2);
  for (const p of paras) {
    if (t.box && t.box.w > 0) {
      const words = p.split(/(\s+)/); let cur = '';
      for (const w of words) {
        const test = cur + w;
        if (measure(test.trimEnd()) > t.box.w && cur.trim()) { lines.push(cur.trimEnd()); cur = w.trimStart(); }
        else cur = test;
      }
      lines.push(cur);
    } else lines.push(p);
  }
  const out = lines.map((s, i) => ({ s, w: measure(s), y: t.y + i * lead }));
  const maxW = Math.max(1, ...out.map(l => l.w));
  for (const l of out) {
    const bw = t.box ? t.box.w : 0;
    if (t.box) l.x = t.x + (t.align === 'center' ? (bw - l.w) / 2 : t.align === 'right' ? bw - l.w : 0);
    else l.x = t.x - (t.align === 'center' ? l.w / 2 : t.align === 'right' ? l.w : 0);
  }
  const top = t.y - t.size * .92, height = (out.length - 1) * lead + t.size * 1.18;
  const left = t.box ? t.x : Math.min(...out.map(l => l.x));
  return { lines: out, lead, track, bounds: { x: left, y: top, w: t.box ? t.box.w : maxW, h: t.box ? Math.max(t.box.h, height) : height } };
}

function renderText(L, W, H) {
  const t = L.text, c = canvas(W, H), x = ctx2d(c);
  const lay = layoutText(t, x);
  if (t.matrix) x.setTransform(...t.matrix);
  x.font = fontString(t); x.fillStyle = t.color; x.textBaseline = 'alphabetic';
  if (t.box) { x.save(); x.beginPath(); x.rect(t.box ? t.x : 0, t.y - t.size, t.box.w, Math.max(t.box.h, 1) + t.size * .3); x.clip(); }
  for (const l of lay.lines) {
    if (!lay.track) x.fillText(l.s, l.x, l.y);
    else { let px = l.x; for (const ch of l.s) { x.fillText(ch, px, l.y); px += x.measureText(ch).width + lay.track; } }
    if (t.underline || t.strike) {
      x.fillRect(l.x, l.y + (t.underline ? t.size * .1 : -t.size * .3), l.w, Math.max(1, t.size / 16));
    }
  }
  if (t.box) x.restore();
  if (t.warp && t.warp.style !== 'none') return warpText(c, lay.bounds, t.warp, W, H);
  return c;
}
function warpText(src, b, warp, W, H) {
  const out = canvas(W, H), x = ctx2d(out), k = warp.bend / 100;
  const cols = Math.max(1, Math.ceil(b.w));
  for (let i = 0; i < cols; i++) {
    const u = i / cols - .5; let dy = 0, sc = 1;
    if (warp.style === 'arc') dy = -k * b.h * 1.2 * (1 - 4 * u * u);
    else if (warp.style === 'arch') { dy = -k * b.h * (1 - 4 * u * u); sc = 1 + k * .4 * (1 - 4 * u * u); }
    else if (warp.style === 'bulge') sc = 1 + k * .6 * (1 - 4 * u * u);
    else if (warp.style === 'flag') dy = Math.sin(u * Math.PI * 2) * k * b.h * .35;
    else if (warp.style === 'wave') dy = Math.sin(u * Math.PI * 3) * k * b.h * .3;
    else if (warp.style === 'rise') dy = -u * k * b.h * 1.2;
    const sx = b.x + i, sh = b.h + 4;
    x.drawImage(src, sx, b.y - 2, 1, sh, sx, b.y - 2 + dy - (sh * sc - sh) / 2, 1.2, sh * sc);
  }
  return out;
}

// ── Shapes ───────────────────────────────────────────────────────────────
export function shapePath(sh) {
  const p = new Path2D();
  for (const sp of sh.subpaths || []) {
    const pts = sp.pts; if (!pts.length) continue;
    p.moveTo(pts[0].x, pts[0].y);
    const seg = (a, b) => {
      if (a.ox === undefined && b.ix === undefined) p.lineTo(b.x, b.y);
      else p.bezierCurveTo(a.ox ?? a.x, a.oy ?? a.y, b.ix ?? b.x, b.iy ?? b.y, b.x, b.y);
    };
    for (let i = 1; i < pts.length; i++) seg(pts[i - 1], pts[i]);
    if (sp.closed) { seg(pts[pts.length - 1], pts[0]); p.closePath(); }
  }
  return p;
}
function paintFor(x, spec, bounds, fallback) {
  if (!spec) return null;
  if (spec.type === 'gradient') {
    const st = resolveStops(spec.stops), b = bounds, ang = rad(spec.angle ?? 90);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2, len = Math.abs(b.w * Math.cos(ang)) / 2 + Math.abs(b.h * Math.sin(ang)) / 2;
    const g = spec.style === 'radial' ? x.createRadialGradient(cx, cy, 0, cx, cy, Math.max(b.w, b.h) / 2)
      : x.createLinearGradient(cx - Math.cos(ang) * len, cy + Math.sin(ang) * len, cx + Math.cos(ang) * len, cy - Math.sin(ang) * len);
    for (const [pp, c, a] of st) g.addColorStop(clamp(pp, 0, 1), rgbCss(c, a));
    return g;
  }
  return spec.color || fallback;
}
function renderShape(L, W, H) {
  const sh = L.shape, c = canvas(W, H), x = ctx2d(c);
  const path = shapePath(sh);
  const b = sh.bounds || { x: 0, y: 0, w: W, h: H };
  if (sh.fill) { x.fillStyle = paintFor(x, sh.fill, b, '#000'); x.fill(path, 'nonzero'); }
  if (sh.stroke && sh.stroke.width > 0) {
    const s = sh.stroke; x.lineWidth = s.width * (s.align === 'center' ? 1 : 2);
    x.strokeStyle = paintFor(x, s, b, '#000'); x.lineJoin = s.join || 'miter'; x.lineCap = s.cap || 'butt';
    x.setLineDash(s.dash === 'dash' ? [s.width * 3, s.width * 2] : s.dash === 'dot' ? [0.01, s.width * 2] : []);
    if (s.dash === 'dot') x.lineCap = 'round';
    if (s.align === 'inside') { x.save(); x.clip(path); x.stroke(path); x.restore(); }
    else if (s.align === 'outside') {
      const t = canvas(W, H), tx = ctx2d(t); Object.assign(tx, { lineWidth: x.lineWidth, strokeStyle: x.strokeStyle, lineJoin: x.lineJoin, lineCap: x.lineCap }); tx.setLineDash(x.getLineDash());
      tx.stroke(path); tx.globalCompositeOperation = 'destination-out'; tx.fill(path); x.drawImage(t, 0, 0);
    } else x.stroke(path);
  }
  return c;
}

// ── Fill layers ──────────────────────────────────────────────────────────
function renderFill(L, W, H) {
  const f = L.fill, c = canvas(W, H), x = ctx2d(c);
  if (f.kind === 'solid') { x.fillStyle = f.color; x.fillRect(0, 0, W, H); }
  else if (f.kind === 'gradient') {
    renderGradient(x, { x: 0, y: 0, w: W, h: H }, f);
  } else if (f.kind === 'pattern' && f.pattern) {
    const s = (f.scale || 100) / 100, pc = canvas(Math.max(1, f.pattern.width * s), Math.max(1, f.pattern.height * s));
    ctx2d(pc).drawImage(f.pattern, 0, 0, pc.width, pc.height);
    x.fillStyle = x.createPattern(pc, 'repeat'); x.fillRect(0, 0, W, H);
  }
  return c;
}
// Gradient fill used by fill layers and gradient overlay; supports linear/radial/angle/reflected/diamond
export function renderGradient(x, b, f) {
  let st = resolveStops(f.stops, f.fg, f.bg);
  if (f.reverse) st = st.map(([p, c, a]) => [1 - p, c, a]).reverse();
  const ang = rad(f.angle ?? 90), sc = (f.scale || 100) / 100;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const len = (Math.abs(b.w * Math.cos(ang)) + Math.abs(b.h * Math.sin(ang))) / 2 * sc;
  const style = f.type || f.style || 'linear';
  if (style === 'linear' || style === 'reflected') {
    const g = x.createLinearGradient(cx - Math.cos(ang) * len, cy + Math.sin(ang) * len, cx + Math.cos(ang) * len, cy - Math.sin(ang) * len);
    if (style === 'reflected') { for (const [p, c, a] of st) { g.addColorStop(.5 - p / 2, rgbCss(c, a)); g.addColorStop(.5 + p / 2, rgbCss(c, a)); } }
    else for (const [p, c, a] of st) g.addColorStop(clamp(p, 0, 1), rgbCss(c, a));
    x.fillStyle = g; x.fillRect(b.x, b.y, b.w, b.h); return;
  }
  if (style === 'radial') {
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(b.w, b.h) / 2 * sc);
    for (const [p, c, a] of st) g.addColorStop(clamp(p, 0, 1), rgbCss(c, a));
    x.fillStyle = g; x.fillRect(b.x, b.y, b.w, b.h); return;
  }
  if (style === 'angle' && x.createConicGradient) {
    const g = x.createConicGradient(-ang, cx, cy);
    for (const [p, c, a] of st) g.addColorStop(clamp(p, 0, 1), rgbCss(c, a));
    x.fillStyle = g; x.fillRect(b.x, b.y, b.w, b.h); return;
  }
  // diamond (and fallback): per-pixel
  const img = x.createImageData(Math.max(1, b.w | 0), Math.max(1, b.h | 0)), d = img.data, R2 = Math.max(b.w, b.h) / 2 * sc;
  const lut = []; for (let i = 0; i <= 255; i++) { const t = i / 255; let k = 0; while (k < st.length - 2 && t > st[k + 1][0]) k++; const [p0, c0, a0] = st[k], [p1, c1, a1] = st[Math.min(k + 1, st.length - 1)]; const u = clamp((t - p0) / ((p1 - p0) || 1), 0, 1); lut.push([c0.r + (c1.r - c0.r) * u, c0.g + (c1.g - c0.g) * u, c0.b + (c1.b - c0.b) * u, (a0 + (a1 - a0) * u) * 255]); }
  for (let y = 0; y < img.height; y++) for (let xx = 0; xx < img.width; xx++) {
    const dx = xx + b.x - cx, dy = y + b.y - cy;
    const t = clamp((Math.abs(dx * Math.cos(ang) + dy * Math.sin(ang)) + Math.abs(-dx * Math.sin(ang) + dy * Math.cos(ang))) / R2, 0, 1);
    const v = lut[Math.round(t * 255)], i = (y * img.width + xx) * 4; d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2]; d[i + 3] = v[3];
  }
  x.putImageData(img, b.x, b.y);
}

// ── Layer styles ─────────────────────────────────────────────────────────
export const STYLE_DEFAULTS = {
  dropShadow: { enabled: false, blend: 'multiply', color: '#000000', opacity: 75, angle: 120, distance: 8, spread: 0, size: 10 },
  innerShadow: { enabled: false, blend: 'multiply', color: '#000000', opacity: 75, angle: 120, distance: 5, choke: 0, size: 5 },
  outerGlow: { enabled: false, blend: 'screen', color: '#ffffbe', opacity: 75, spread: 0, size: 12 },
  innerGlow: { enabled: false, blend: 'screen', color: '#ffffbe', opacity: 75, source: 'edge', choke: 0, size: 8 },
  bevel: { enabled: false, style: 'inner', depth: 100, dir: 'up', size: 6, soften: 0, angle: 120, altitude: 30, hiColor: '#ffffff', hiOpacity: 75, shColor: '#000000', shOpacity: 75 },
  satin: { enabled: false, blend: 'multiply', color: '#000000', opacity: 50, angle: 19, distance: 11, size: 14 },
  colorOverlay: { enabled: false, blend: 'normal', color: '#ff0000', opacity: 100 },
  gradientOverlay: { enabled: false, blend: 'normal', opacity: 100, stops: null, style: 'linear', angle: 90, scale: 100, reverse: false },
  stroke: { enabled: false, size: 3, position: 'outside', blend: 'normal', opacity: 100, color: '#000000' },
};
export const STYLE_NAMES = { bevel: 'Bevel & Emboss', stroke: 'Stroke', innerShadow: 'Inner Shadow', innerGlow: 'Inner Glow', satin: 'Satin', colorOverlay: 'Color Overlay', gradientOverlay: 'Gradient Overlay', outerGlow: 'Outer Glow', dropShadow: 'Drop Shadow' };
export const hasStyles = L => L.styles && Object.values(L.styles).some(s => s && s.enabled);

function colorize(src, color, w, h) {
  const c = canvas(w, h), x = ctx2d(c); x.drawImage(src, 0, 0);
  x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, w, h); return c;
}
function blurAlpha(c, size, spread = 0) {
  const x = ctx2d(c), img = x.getImageData(0, 0, c.width, c.height);
  if (size > 0) gaussianImageData(img, size / 2.3, { alphaOnly: true });
  if (spread > 0) { const k = 1 / Math.max(.02, 1 - spread / 100), d = img.data; for (let i = 3; i < d.length; i += 4) d[i] = Math.min(255, d[i] * k); }
  x.putImageData(img, 0, 0); return c;
}
function invertAlpha(src, w, h) {
  const c = canvas(w, h), x = ctx2d(c); x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
  x.globalCompositeOperation = 'destination-out'; x.drawImage(src, 0, 0); return c;
}
function drawBlend(x, src, mode, opacity, dx = 0, dy = 0) {
  x.save(); x.globalAlpha = opacity / 100;
  x.globalCompositeOperation = NATIVE_BLEND.has(mode) ? (mode === 'normal' ? 'source-over' : mode) : (mode === 'lighter' ? 'lighter' : 'source-over');
  x.drawImage(src, dx, dy); x.restore();
}
function strokeAlpha(src, w, h, size, position) {
  const x0 = ctx2d(src).getImageData(0, 0, w, h).data, n = w * h;
  const inside = new Uint8Array(n), outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) { inside[i] = x0[i * 4 + 3] >= 128; outside[i] = !inside[i]; }
  const out = new ImageData(w, h), o = out.data;
  const Dout = position !== 'inside' ? distanceTransform(inside, w, h) : null;
  const Din = position !== 'outside' ? distanceTransform(outside, w, h) : null;
  const sOut = position === 'outside' ? size : position === 'center' ? size / 2 : 0;
  const sIn = position === 'inside' ? size : position === 'center' ? size / 2 : 0;
  for (let i = 0; i < n; i++) {
    let a = 0;
    if (Dout && !inside[i]) a = clamp(sOut - Dout[i] + 1, 0, 1);
    if (Din && inside[i]) a = clamp(sIn - Din[i] + 1, 0, 1);
    if (position === 'outside' && inside[i]) a = 0;
    o[i * 4 + 3] = a * 255;
  }
  const c = canvas(w, h); ctx2d(c).putImageData(out, 0, 0); return c;
}
function bevelMaps(src, w, h, s) {
  const d = ctx2d(src).getImageData(0, 0, w, h).data, n = w * h, A = new Float32Array(n);
  for (let i = 0; i < n; i++) A[i] = d[i * 4 + 3] / 255;
  const inside = new Uint8Array(n); for (let i = 0; i < n; i++) inside[i] = A[i] < .5;
  const D = distanceTransform(inside, w, h);
  let Hm = new Float32Array(n);
  const size = Math.max(1, s.size);
  for (let i = 0; i < n; i++) Hm[i] = s.style === 'pillow' ? Math.sin(Math.min(1, D[i] / size) * Math.PI) : Math.min(1, D[i] / size);
  Hm = blurPlane(Hm, w, h, Math.max(.6, s.soften / 2 + .6));
  const az = rad(s.angle), el = rad(s.altitude), lx = Math.cos(az) * Math.cos(el), ly = -Math.sin(az) * Math.cos(el), lz = Math.sin(el);
  const depth = s.depth / 100 * (s.dir === 'down' ? -1 : 1) * 2.2;
  const hi = new ImageData(w, h), sh = new ImageData(w, h), hd = hi.data, sd = sh.data;
  const flat = lz;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (A[i] <= 0 && s.style === 'inner') continue;
    const nx = -(Hm[i + 1] - Hm[i - 1]) * depth * size / 2, ny = -(Hm[i + w] - Hm[i - w]) * depth * size / 2;
    const len = Math.hypot(nx, ny, 1), dot = (nx * lx + ny * ly + lz) / len - flat;
    const a = s.style === 'inner' ? A[i] : s.style === 'outer' ? 1 - A[i] : 1;
    if (dot > 0) hd[i * 4 + 3] = Math.min(255, dot * 255 * 2.2 * a); else sd[i * 4 + 3] = Math.min(255, -dot * 255 * 2.2 * a);
  }
  const hc = canvas(w, h), sc = canvas(w, h); ctx2d(hc).putImageData(hi, 0, 0); ctx2d(sc).putImageData(sh, 0, 0);
  return { hc, sc };
}

export function styleMargin(st) {
  let m = 0;
  if (st.dropShadow?.enabled) m = Math.max(m, st.dropShadow.distance + st.dropShadow.size * 1.6);
  if (st.outerGlow?.enabled) m = Math.max(m, st.outerGlow.size * 1.6);
  if (st.stroke?.enabled) m = Math.max(m, st.stroke.size + 2);
  if (st.bevel?.enabled && st.bevel.style !== 'inner') m = Math.max(m, st.bevel.size + 2);
  return Math.ceil(m + 2);
}

// surf: {canvas,x,y} of the layer content (fill opacity already applied separately)
export function applyStyles(surf, styles, fillOpacity, globalAngle = 120) {
  const st = styles, m = styleMargin(st);
  const w = surf.canvas.width + m * 2, h = surf.canvas.height + m * 2;
  const shape = canvas(w, h); ctx2d(shape).drawImage(surf.canvas, m, m);
  const out = canvas(w, h), x = ctx2d(out);
  const ang = a => rad(a ?? globalAngle);

  if (st.dropShadow?.enabled) {
    const s = st.dropShadow, c = blurAlpha(colorize(shape, s.color, w, h), s.size, s.spread);
    drawBlend(x, c, s.blend, s.opacity, Math.round(-Math.cos(ang(s.angle)) * s.distance), Math.round(Math.sin(ang(s.angle)) * s.distance));
  }
  if (st.outerGlow?.enabled) {
    const s = st.outerGlow, c = blurAlpha(colorize(shape, s.color, w, h), s.size, s.spread);
    drawBlend(x, c, s.blend, s.opacity);
  }
  if (st.bevel?.enabled && st.bevel.style !== 'inner') {
    const { hc, sc } = bevelMaps(shape, w, h, st.bevel);
    const sOut = colorize(sc, st.bevel.shColor, w, h), hOut = colorize(hc, st.bevel.hiColor, w, h);
    const k = ctx2d(sOut); k.globalCompositeOperation = 'destination-out'; k.drawImage(shape, 0, 0);
    const k2 = ctx2d(hOut); k2.globalCompositeOperation = 'destination-out'; k2.drawImage(shape, 0, 0);
    drawBlend(x, sOut, 'multiply', st.bevel.shOpacity); drawBlend(x, hOut, 'screen', st.bevel.hiOpacity);
  }

  // content layer (fill opacity) + interior effects clipped to the shape
  const inner = canvas(w, h), ix = ctx2d(inner);
  ix.globalAlpha = fillOpacity; ix.drawImage(shape, 0, 0); ix.globalAlpha = 1;
  const clipTo = (c, mode, op) => { const t = canvas(w, h), tx = ctx2d(t); tx.drawImage(c, 0, 0); tx.globalCompositeOperation = 'destination-in'; tx.drawImage(shape, 0, 0); drawBlend(ix, t, mode, op); };
  if (st.colorOverlay?.enabled) { const s = st.colorOverlay; clipTo(colorize(shape, s.color, w, h), s.blend, s.opacity); }
  if (st.gradientOverlay?.enabled) {
    const s = st.gradientOverlay, g = canvas(w, h);
    renderGradient(ctx2d(g), { x: m, y: m, w: surf.canvas.width, h: surf.canvas.height }, { stops: s.stops || [[0, '#000000', 1], [1, '#ffffff', 1]], type: s.style, angle: s.angle, scale: s.scale, reverse: s.reverse });
    clipTo(g, s.blend, s.opacity);
  }
  if (st.satin?.enabled) {
    const s = st.satin, a = colorize(shape, s.color, w, h), t = canvas(w, h), tx = ctx2d(t);
    const dx = Math.cos(ang(s.angle)) * s.distance, dy = Math.sin(ang(s.angle)) * s.distance;
    tx.drawImage(a, dx, dy); tx.globalCompositeOperation = 'xor'; tx.drawImage(a, -dx, -dy);
    clipTo(blurAlpha(t, s.size), s.blend, s.opacity);
  }
  if (st.innerGlow?.enabled) {
    const s = st.innerGlow;
    const src = s.source === 'center' ? colorize(shape, s.color, w, h) : colorize(invertAlpha(shape, w, h), s.color, w, h);
    if (s.source === 'center') {
      const inv = blurAlpha(invertAlpha(shape, w, h), s.size, s.choke), t = canvas(w, h), tx = ctx2d(t);
      tx.drawImage(src, 0, 0); tx.globalCompositeOperation = 'destination-out'; tx.drawImage(inv, 0, 0); clipTo(t, s.blend, s.opacity);
    } else clipTo(blurAlpha(src, s.size, s.choke), s.blend, s.opacity);
  }
  if (st.innerShadow?.enabled) {
    const s = st.innerShadow, c = blurAlpha(colorize(invertAlpha(shape, w, h), s.color, w, h), s.size, s.choke);
    const t = canvas(w, h); ctx2d(t).drawImage(c, Math.round(-Math.cos(ang(s.angle)) * s.distance), Math.round(Math.sin(ang(s.angle)) * s.distance));
    clipTo(t, s.blend, s.opacity);
  }
  if (st.bevel?.enabled && st.bevel.style !== 'outer') {
    const { hc, sc } = bevelMaps(shape, w, h, st.bevel);
    clipTo(colorize(sc, st.bevel.shColor, w, h), 'multiply', st.bevel.shOpacity);
    clipTo(colorize(hc, st.bevel.hiColor, w, h), 'screen', st.bevel.hiOpacity);
  }
  x.drawImage(inner, 0, 0);
  if (st.stroke?.enabled) {
    const s = st.stroke, a = strokeAlpha(shape, w, h, s.size, s.position);
    drawBlend(x, colorize(a, s.color, w, h), s.blend, s.opacity);
  }
  return { canvas: out, x: surf.x - m, y: surf.y - m };
}

// ── Surfaces ─────────────────────────────────────────────────────────────
export function contentSurface(L, doc) {
  const W = doc.w, H = doc.h;
  if (L.type === 'raster') return L.canvas ? { canvas: L.canvas, x: L.x, y: L.y } : null;
  const key = JSON.stringify([L.type, L.text, L.shape, L.fill && { ...L.fill, pattern: !!L.fill.pattern }, W, H, L.x, L.y, L.fill?.pattern?._id]);
  if (L._cache && L._cache.key === key) return L._cache.surf;
  let c = null;
  if (L.type === 'text') c = renderText(L, W, H);
  else if (L.type === 'shape') c = renderShape(L, W, H);
  else if (L.type === 'fill') c = renderFill(L, W, H);
  if (!c) return null;
  const surf = { canvas: c, x: L.type === 'fill' ? 0 : L.x, y: L.type === 'fill' ? 0 : L.y };
  L._cache = { key, surf };
  return surf;
}
// Surface with fill opacity, mask and styles applied — what the layer contributes before opacity/blend
export function layerSurface(L, doc, override) {
  let surf = override || contentSurface(L, doc);
  if (!surf) return null;
  const styled = hasStyles(L), mask = L.mask && L.mask.enabled;
  const fo = L.fillOpacity ?? 1;
  if (!styled && !mask && fo >= 1) return surf;
  const key = `${L.rev}|${L._cache?.key || ''}|${mask ? L.mask.rev + ':' + L.mask.x + ':' + L.mask.y + ':' + L.mask.density : ''}|${styled ? JSON.stringify(L.styles) : ''}|${fo}|${surf.x},${surf.y}|${doc.globalAngle}`;
  if (!override && L._styled && L._styled.key === key) return L._styled.surf;
  let out;
  if (styled) out = applyStyles(surf, L.styles, fo, doc.globalAngle);
  else if (fo < 1) { const c = canvas(surf.canvas.width, surf.canvas.height), x = ctx2d(c); x.globalAlpha = fo; x.drawImage(surf.canvas, 0, 0); out = { canvas: c, x: surf.x, y: surf.y }; }
  else out = surf;
  if (mask) {
    const c = out === surf ? canvas(surf.canvas.width, surf.canvas.height) : out.canvas, x = ctx2d(c);
    if (out === surf) x.drawImage(surf.canvas, 0, 0);
    applyMaskToCanvas(x, L, out.x, out.y, c.width, c.height);
    out = { canvas: c, x: out.x, y: out.y };
  }
  if (!override) L._styled = { key, surf: out };
  return out;
}
function applyMaskToCanvas(x, L, ox, oy, w, h) {
  const m = L.mask, a = L.maskAlpha();
  x.save(); x.globalCompositeOperation = 'destination-in';
  if (m.def === 255) {
    // area outside the mask canvas is revealed
    const t = canvas(w, h), tx = ctx2d(t); tx.fillStyle = '#000'; tx.fillRect(0, 0, w, h);
    tx.clearRect(m.x - ox, m.y - oy, m.canvas.width, m.canvas.height); tx.drawImage(a, m.x - ox, m.y - oy);
    x.drawImage(t, 0, 0);
  } else x.drawImage(a, m.x - ox, m.y - oy);
  x.restore();
  if (m.feather > 0) {
    const img = x.getImageData(0, 0, w, h); gaussianImageData(img, m.feather / 2, { alphaOnly: true }); x.putImageData(img, 0, 0);
  }
}

// ── Adjustment layers ────────────────────────────────────────────────────
function applyAdjustLayer(dst, L, doc) {
  const img = getData(dst), orig = new Uint8ClampedArray(img.data);
  applyAdjustment(L.adjust.kind, L.adjust.params, img);
  const d = img.data, k = L.opacity;
  let md = null;
  if (L.mask && L.mask.enabled) {
    const mb = buffer(dst.r); mb.x.fillStyle = '#000'; mb.x.fillRect(dst.r.x, dst.r.y, dst.r.w, dst.r.h);
    const a = L.maskAlpha(); const m = L.mask;
    if (m.def === 255) { mb.x.clearRect(dst.r.x, dst.r.y, dst.r.w, dst.r.h); mb.x.fillStyle = '#000'; mb.x.fillRect(dst.r.x, dst.r.y, dst.r.w, dst.r.h); mb.x.clearRect(m.x, m.y, m.canvas.width, m.canvas.height); mb.x.drawImage(a, m.x, m.y); }
    else { mb.x.clearRect(dst.r.x, dst.r.y, dst.r.w, dst.r.h); mb.x.drawImage(a, m.x, m.y); }
    md = getData(mb).data;
  }
  if (L.blend !== 'normal' && L.blend !== 'pass') {
    const res = new ImageData(new Uint8ClampedArray(d), img.width, img.height);
    d.set(orig); blendPixels(img, res, L.blend, k, md);
    putData(dst, img); return;
  }
  for (let i = 0; i < d.length; i += 4) {
    const t = k * (md ? md[i + 3] / 255 : 1);
    if (t >= 1) { d[i + 3] = orig[i + 3]; continue; }
    d[i] = orig[i] + (d[i] - orig[i]) * t; d[i + 1] = orig[i + 1] + (d[i + 1] - orig[i + 1]) * t; d[i + 2] = orig[i + 2] + (d[i + 2] - orig[i + 2]) * t; d[i + 3] = orig[i + 3];
  }
  putData(dst, img);
}

// ── Tree compositing ─────────────────────────────────────────────────────
function compositeChildren(children, dst, doc, opts) {
  for (let i = 0; i < children.length;) {
    const base = children[i]; let j = i + 1;
    const clipped = [];
    while (j < children.length && children[j].clip) { clipped.push(children[j]); j++; }
    i = j;
    if (!visibleNow(base, opts)) continue;
    renderNode(base, clipped.filter(c => visibleNow(c, opts)), dst, doc, opts);
  }
}
const visibleNow = (L, opts) => opts.solo ? (opts.solo.has(L.id) || L.isGroup) && L.visible : L.visible && !opts.hidden?.has(L.id);

function renderNode(L, clipped, dst, doc, opts) {
  if (L.type === 'adjust') {
    applyAdjustLayer(dst, L, doc);
    return;
  }
  let surf;
  if (L.isGroup) {
    const passThrough = L.blend === 'pass' && L.opacity >= 1 && !(L.mask && L.mask.enabled) && !clipped.length && !hasStyles(L);
    if (passThrough) { compositeChildren(L.children, dst, doc, opts); return; }
    const g = buffer(dst.r);
    compositeChildren(L.children, g, doc, opts);
    surf = { canvas: g.c, x: g.r.x, y: g.r.y };
    if (L.mask && L.mask.enabled || hasStyles(L)) surf = layerSurface(L, doc, surf);
  } else {
    surf = layerSurface(L, doc, opts.live?.get(L.id));
  }
  if (!surf) return;
  if (!clipped.length) { drawSurface(dst, surf, L.blend, L.opacity); return; }
  // clipping group: base pixels + clipped layers restricted to base alpha
  const cb = buffer(dst.r);
  cb.x.drawImage(surf.canvas, surf.x, surf.y);
  const baseAlpha = buffer(dst.r); baseAlpha.x.drawImage(cb.c, dst.r.x, dst.r.y);
  for (const c of clipped) {
    if (c.type === 'adjust') { applyAdjustLayer(cb, c, doc); continue; }
    let cs;
    if (c.isGroup) { const g = buffer(dst.r); compositeChildren(c.children, g, doc, opts); cs = { canvas: g.c, x: g.r.x, y: g.r.y }; }
    else cs = layerSurface(c, doc, opts.live?.get(c.id));
    if (!cs) continue;
    if (c.blend === 'normal' || c.blend === 'pass') {
      cb.x.save(); cb.x.globalAlpha = c.opacity; cb.x.globalCompositeOperation = 'source-atop'; cb.x.drawImage(cs.canvas, cs.x, cs.y); cb.x.restore();
    } else {
      drawSurface(cb, cs, c.blend, c.opacity);
      cb.x.save(); cb.x.globalCompositeOperation = 'destination-in'; cb.x.drawImage(baseAlpha.c, dst.r.x, dst.r.y); cb.x.restore();
    }
  }
  drawSurface(dst, { canvas: cb.c, x: dst.r.x, y: dst.r.y }, L.blend, L.opacity);
}

// Composite whole document (or rect) into out canvas (doc-sized)
export function compositeDoc(doc, out, rect, opts = {}) {
  const r = rect || { x: 0, y: 0, w: doc.w, h: doc.h };
  if (r.w <= 0 || r.h <= 0) return;
  const dst = buffer(r);
  compositeChildren(doc.root.children, dst, doc, opts);
  const ox = ctx2d(out);
  ox.clearRect(r.x, r.y, r.w, r.h);
  ox.drawImage(dst.c, r.x, r.y);
}
// Fresh composite canvas of the whole document (for export, Copy Merged, sample all layers…)
export function flattenDoc(doc, opts) {
  const c = canvas(doc.w, doc.h); compositeDoc(doc, c, null, opts || {}); return c;
}
// Composite of only the given subtree (for merge/group thumbnails)
export function compositeLayers(doc, layers, rect) {
  const r = rect || { x: 0, y: 0, w: doc.w, h: doc.h }, dst = buffer(r);
  compositeChildren(layers, dst, doc, {});
  return dst.c;
}
