// Filter gallery: every filter works on an ImageData in place (or returns a new one)

import { clamp, rad } from './util.js';
import { gaussianImageData, boxImageData, blurPlane, minMaxPlane } from './blur.js';
import { luma } from './color.js';

const R = (key, label, min, max, def, step = 1, unit = '') => ({ key, label, type: 'range', min, max, def, step, unit });
const S = (key, label, options, def) => ({ key, label, type: 'select', options, def });
const C = (key, label, def = false) => ({ key, label, type: 'check', def });

function copyOf(img) { return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height); }
function sampler(src) {
  const { width: w, height: h, data: d } = src;
  return (x, y, out, wrap = false) => {
    if (wrap) { x = ((x % w) + w) % w; y = ((y % h) + h) % h; }
    x = clamp(x, 0, w - 1.001); y = clamp(y, 0, h - 1.001);
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
    const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4;
    for (let c = 0; c < 4; c++) {
      out[c] = (d[i00 + c] * (1 - fx) + d[i10 + c] * fx) * (1 - fy) + (d[i01 + c] * (1 - fx) + d[i11 + c] * fx) * fy;
    }
    return out;
  };
}
// Generic displacement: map(dst x,y) → src x,y
function displace(img, fn, wrap = false) {
  const src = copyOf(img), s = sampler(src), d = img.data, { width: w, height: h } = img, o = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = fn(x, y); if (!p) continue;
    s(p[0], p[1], o, wrap); const i = (y * w + x) * 4;
    d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2]; d[i + 3] = o[3];
  }
  return img;
}
function convolve(img, k, div = 1, bias = 0, keepAlpha = true) {
  const src = img.data.slice(), d = img.data, { width: w, height: h } = img, n = Math.sqrt(k.length) | 0, half = n >> 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let ky = 0; ky < n; ky++) {
      const yy = clamp(y + ky - half, 0, h - 1);
      for (let kx = 0; kx < n; kx++) {
        const xx = clamp(x + kx - half, 0, w - 1), wt = k[ky * n + kx]; if (!wt) continue;
        const i = (yy * w + xx) * 4; r += src[i] * wt; g += src[i + 1] * wt; b += src[i + 2] * wt; a += src[i + 3] * wt;
      }
    }
    const i = (y * w + x) * 4;
    d[i] = r / div + bias; d[i + 1] = g / div + bias; d[i + 2] = b / div + bias; if (!keepAlpha) d[i + 3] = a / div;
  }
  return img;
}
function planes(img) {
  const n = img.width * img.height, d = img.data, P = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) P[c][i] = d[i * 4 + c];
  return P;
}
function hash(x, y, s) { let n = x * 374761393 + y * 668265263 + s * 2147483647; n = (n ^ (n >> 13)) * 1274126177; return ((n ^ (n >> 16)) >>> 0) / 4294967295; }
function valueNoise(x, y, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, seed), b = hash(x0 + 1, y0, seed), c = hash(x0, y0 + 1, seed), e = hash(x0 + 1, y0 + 1, seed);
  return (a + (b - a) * sx) + ((c + (e - c) * sx) - (a + (b - a) * sx)) * sy;
}
function fbm(x, y, seed, oct = 7) { let v = 0, amp = .5, f = 1; for (let o = 0; o < oct; o++) { v += amp * valueNoise(x * f, y * f, seed + o * 17); f *= 2; amp *= .5; } return v; }

export function unsharp(img, amount, radius, threshold = 0) {
  const blurred = gaussianImageData(copyOf(img), radius), d = img.data, b = blurred.data, k = amount / 100;
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) {
    const diff = d[i + c] - b[i + c];
    if (Math.abs(diff) >= threshold) d[i + c] = d[i + c] + diff * k;
  }
  return img;
}
function medianImg(img, r) {
  const { width: w, height: h } = img, src = img.data.slice(), d = img.data, vals = [[], [], []];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    vals[0].length = vals[1].length = vals[2].length = 0;
    for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
      const i = (yy * w + xx) * 4; vals[0].push(src[i]); vals[1].push(src[i + 1]); vals[2].push(src[i + 2]);
    }
    const i = (y * w + x) * 4, m = vals[0].length >> 1;
    for (let c = 0; c < 3; c++) { vals[c].sort((a, b) => a - b); d[i + c] = vals[c][m]; }
  }
  return img;
}
// Edge-preserving smoothing used by Surface Blur / Reduce Noise
function bilateral(img, radius, thr) {
  const { width: w, height: h } = img, src = img.data.slice(), d = img.data, r = Math.max(1, Math.round(radius)), step = r > 6 ? 2 : 1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i0 = (y * w + x) * 4; let sr = 0, sg = 0, sb = 0, sw = 0;
    for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy += step) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx += step) {
      const i = (yy * w + xx) * 4;
      const diff = (Math.abs(src[i] - src[i0]) + Math.abs(src[i + 1] - src[i0 + 1]) + Math.abs(src[i + 2] - src[i0 + 2])) / 3;
      const wt = Math.max(0, 1 - diff / (thr * 2.5));
      sr += src[i] * wt; sg += src[i + 1] * wt; sb += src[i + 2] * wt; sw += wt;
    }
    d[i0] = sr / sw; d[i0 + 1] = sg / sw; d[i0 + 2] = sb / sw;
  }
  return img;
}

export const FILTERS = {
  // ── Blur ───────────────────────────────────────────────────────────────
  'gaussian-blur': { group: 'Blur', name: 'Gaussian Blur…', params: [R('radius', 'Radius', .1, 250, 4, .1, 'piksel')], apply: (img, p) => gaussianImageData(img, p.radius) },
  'box-blur': { group: 'Blur', name: 'Box Blur…', params: [R('radius', 'Radius', 1, 200, 6, 1, 'piksel')], apply: (img, p) => boxImageData(img, p.radius) },
  'motion-blur': {
    group: 'Blur', name: 'Motion Blur…', params: [R('angle', 'Sudut', -90, 90, 0, 1, '°'), R('distance', 'Jarak', 1, 400, 20, 1, 'piksel')],
    apply(img, p) {
      const src = copyOf(img), s = sampler(src), { width: w, height: h, data: d } = img;
      const n = Math.max(2, Math.round(p.distance)), dx = Math.cos(rad(p.angle)), dy = -Math.sin(rad(p.angle)), o = [0, 0, 0, 0];
      const steps = Math.min(n, 64), st = p.distance / steps;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = 0; k <= steps; k++) {
          const t = (k - steps / 2) * st; s(x + dx * t, y + dy * t, o);
          const al = o[3] / 255; r += o[0] * al; g += o[1] * al; b += o[2] * al; a += o[3];
        }
        const i = (y * w + x) * 4, al = a / 255;
        d[i] = al ? r / al : 0; d[i + 1] = al ? g / al : 0; d[i + 2] = al ? b / al : 0; d[i + 3] = a / (steps + 1);
      }
      return img;
    },
  },
  'radial-blur': {
    group: 'Blur', name: 'Radial Blur…', params: [R('amount', 'Jumlah', 1, 100, 10), S('method', 'Metode', [['spin', 'Spin'], ['zoom', 'Zoom']], 'zoom'), R('cx', 'Pusat X', 0, 100, 50, 1, '%'), R('cy', 'Pusat Y', 0, 100, 50, 1, '%')],
    apply(img, p) {
      const src = copyOf(img), s = sampler(src), { width: w, height: h, data: d } = img, o = [0, 0, 0, 0];
      const cx = w * p.cx / 100, cy = h * p.cy / 100, N = 24;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        const vx = x - cx, vy = y - cy;
        for (let k = 0; k < N; k++) {
          const t = (k / (N - 1) - .5);
          if (p.method === 'zoom') { const f = 1 + t * p.amount / 100 * .6; s(cx + vx * f, cy + vy * f, o); }
          else { const ang = t * p.amount / 100 * .8, ca = Math.cos(ang), sa = Math.sin(ang); s(cx + vx * ca - vy * sa, cy + vx * sa + vy * ca, o); }
          r += o[0]; g += o[1]; b += o[2]; a += o[3];
        }
        const i = (y * w + x) * 4; d[i] = r / N; d[i + 1] = g / N; d[i + 2] = b / N; d[i + 3] = a / N;
      }
      return img;
    },
  },
  'surface-blur': { group: 'Blur', name: 'Surface Blur…', params: [R('radius', 'Radius', 1, 30, 5, 1, 'piksel'), R('threshold', 'Ambang', 2, 255, 15, 1, 'level')], apply: (img, p) => bilateral(img, p.radius, p.threshold) },
  'tilt-shift': {
    group: 'Blur', name: 'Tilt-Shift…', params: [R('blur', 'Blur', 1, 60, 12, 1, 'piksel'), R('center', 'Posisi fokus', 0, 100, 50, 1, '%'), R('band', 'Lebar fokus', 2, 80, 22, 1, '%'), R('sat', 'Saturasi', 0, 60, 15, 1, '%')],
    apply(img, p) {
      const bl = gaussianImageData(copyOf(img), p.blur), { width: w, height: h, data: d } = img, b = bl.data;
      const c = h * p.center / 100, band = h * p.band / 200, fall = h * .18;
      for (let y = 0; y < h; y++) {
        const t = clamp((Math.abs(y - c) - band) / fall, 0, 1);
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          for (let ch = 0; ch < 4; ch++) d[i + ch] += (b[i + ch] - d[i + ch]) * t;
          const l = luma(d[i], d[i + 1], d[i + 2]), k = 1 + p.sat / 100;
          d[i] = l + (d[i] - l) * k; d[i + 1] = l + (d[i + 1] - l) * k; d[i + 2] = l + (d[i + 2] - l) * k;
        }
      }
      return img;
    },
  },
  average: {
    group: 'Blur', name: 'Average', params: [],
    apply(img) { const d = img.data; let r = 0, g = 0, b = 0, a = 0, n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++; } if (!n) return img; for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { d[i] = r / n; d[i + 1] = g / n; d[i + 2] = b / n; } return img; },
  },
  blur: { group: 'Blur', name: 'Blur', params: [], apply: img => gaussianImageData(img, .8) },
  'blur-more': { group: 'Blur', name: 'Blur More', params: [], apply: img => gaussianImageData(img, 1.8) },

  // ── Distort ────────────────────────────────────────────────────────────
  pinch: {
    group: 'Distort', name: 'Pinch…', params: [R('amount', 'Jumlah', -100, 100, 50, 1, '%')],
    apply(img, p) {
      const { width: w, height: h } = img, cx = w / 2, cy = h / 2, rr = Math.min(w, h) / 2, k = p.amount / 100;
      return displace(img, (x, y) => {
        const dx = x - cx, dy = y - cy, dd = Math.hypot(dx, dy) / rr; if (dd >= 1) return null;
        const e = k >= 0 ? 1 - k * .5 : 1 - k * .8, s = Math.pow(dd, e) / (dd || 1);
        return [cx + dx * s, cy + dy * s];
      });
    },
  },
  spherize: {
    group: 'Distort', name: 'Spherize…', params: [R('amount', 'Jumlah', -100, 100, 100, 1, '%'), S('mode', 'Mode', [['normal', 'Normal'], ['h', 'Horizontal saja'], ['v', 'Vertikal saja']], 'normal')],
    apply(img, p) {
      const { width: w, height: h } = img, cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2, k = p.amount / 100;
      return displace(img, (x, y) => {
        let nx = (x - cx) / rx, ny = (y - cy) / ry; const r2 = nx * nx + ny * ny; if (r2 >= 1) return null;
        const r = Math.sqrt(r2), nr = k >= 0 ? Math.pow(r, 1 + k * .9) : Math.pow(r, 1 / (1 - k * .9)) ;
        const s = r ? nr / r : 1;
        if (p.mode !== 'v') nx *= s; if (p.mode !== 'h') ny *= s;
        return [cx + nx * rx, cy + ny * ry];
      });
    },
  },
  twirl: {
    group: 'Distort', name: 'Twirl…', params: [R('angle', 'Sudut', -999, 999, 50, 1, '°')],
    apply(img, p) {
      const { width: w, height: h } = img, cx = w / 2, cy = h / 2, rr = Math.min(w, h) / 2, a = rad(p.angle);
      return displace(img, (x, y) => {
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy); if (d >= rr) return null;
        const t = a * (1 - d / rr) ** 2, c = Math.cos(t), s = Math.sin(t);
        return [cx + dx * c - dy * s, cy + dx * s + dy * c];
      });
    },
  },
  ripple: {
    group: 'Distort', name: 'Ripple…', params: [R('amount', 'Jumlah', -999, 999, 100, 1, '%'), S('size', 'Ukuran', [['s', 'Kecil'], ['m', 'Sedang'], ['l', 'Besar']], 'm')],
    apply(img, p) {
      const wl = { s: 8, m: 16, l: 32 }[p.size], amp = p.amount / 100 * 4;
      return displace(img, (x, y) => [x + Math.sin(y / wl * Math.PI * 2) * amp, y + Math.sin(x / wl * Math.PI * 2) * amp]);
    },
  },
  wave: {
    group: 'Distort', name: 'Wave…', params: [R('wavelength', 'Panjang gelombang', 2, 500, 60), R('amplitude', 'Amplitudo', 1, 200, 12), S('type', 'Tipe', [['sine', 'Sinus'], ['triangle', 'Segitiga'], ['square', 'Kotak']], 'sine'), C('wrap', 'Bungkus tepi', true)],
    apply(img, p) {
      const fn = t => p.type === 'sine' ? Math.sin(t) : p.type === 'triangle' ? (2 / Math.PI) * Math.asin(Math.sin(t)) : Math.sign(Math.sin(t));
      return displace(img, (x, y) => [x + fn(y / p.wavelength * Math.PI * 2) * p.amplitude, y + fn(x / p.wavelength * Math.PI * 2) * p.amplitude * .5], p.wrap);
    },
  },
  zigzag: {
    group: 'Distort', name: 'ZigZag…', params: [R('amount', 'Jumlah', -100, 100, 20), R('ridges', 'Riak', 1, 20, 6)],
    apply(img, p) {
      const { width: w, height: h } = img, cx = w / 2, cy = h / 2, rr = Math.min(w, h) / 2;
      return displace(img, (x, y) => {
        const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy); if (d >= rr || !d) return null;
        const k = 1 + Math.sin(d / rr * p.ridges * Math.PI * 2) * p.amount / 100 * .12 * (1 - d / rr);
        return [cx + dx * k, cy + dy * k];
      });
    },
  },
  polar: {
    group: 'Distort', name: 'Polar Coordinates…', params: [S('mode', 'Mode', [['r2p', 'Rectangular ke Polar'], ['p2r', 'Polar ke Rectangular']], 'r2p')],
    apply(img, p) {
      const { width: w, height: h } = img, cx = w / 2, cy = h / 2, rr = Math.min(w, h) / 2;
      if (p.mode === 'r2p') return displace(img, (x, y) => {
        const dx = x - cx, dy = y - cy; let a = Math.atan2(dx, -dy); if (a < 0) a += Math.PI * 2;
        return [a / (Math.PI * 2) * w, Math.hypot(dx * h / w, dy) / rr * h * (w / Math.max(w, h))];
      });
      return displace(img, (x, y) => { const a = x / w * Math.PI * 2, r = y / h * rr; return [cx + Math.sin(a) * r, cy - Math.cos(a) * r]; });
    },
  },

  // ── Noise ──────────────────────────────────────────────────────────────
  'add-noise': {
    group: 'Noise', name: 'Add Noise…', params: [R('amount', 'Jumlah', .1, 400, 12, .1, '%'), S('dist', 'Distribusi', [['uniform', 'Seragam'], ['gaussian', 'Gaussian']], 'gaussian'), C('mono', 'Monokromatik')],
    apply(img, p) {
      const d = img.data, a = p.amount / 100 * 255;
      const rnd = p.dist === 'gaussian' ? () => { let u = 0, v = 0; while (!u) u = Math.random(); v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * .5; } : () => Math.random() - .5;
      for (let i = 0; i < d.length; i += 4) {
        if (p.mono) { const n = rnd() * a; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
        else { d[i] += rnd() * a; d[i + 1] += rnd() * a; d[i + 2] += rnd() * a; }
      }
      return img;
    },
  },
  median: { group: 'Noise', name: 'Median…', params: [R('radius', 'Radius', 1, 20, 2, 1, 'piksel')], apply: (img, p) => medianImg(img, p.radius) },
  'reduce-noise': {
    group: 'Noise', name: 'Reduce Noise…', params: [R('strength', 'Kekuatan', 1, 10, 6), R('details', 'Pertahankan detail', 0, 100, 60, 1, '%')],
    apply(img, p) { const orig = copyOf(img); bilateral(img, 2 + p.strength / 3, 6 + p.strength * 4); const d = img.data, o = orig.data, k = p.details / 250; for (let i = 0; i < d.length; i++) if ((i & 3) !== 3) d[i] += (o[i] - d[i]) * k; return img; },
  },
  despeckle: { group: 'Noise', name: 'Despeckle', params: [], apply: img => bilateral(img, 2, 10) },
  'dust-scratches': {
    group: 'Noise', name: 'Dust & Scratches…', params: [R('radius', 'Radius', 1, 20, 2, 1, 'piksel'), R('threshold', 'Ambang', 0, 255, 0, 1, 'level')],
    apply(img, p) { const orig = copyOf(img); medianImg(img, p.radius); const d = img.data, o = orig.data; for (let i = 0; i < d.length; i += 4) { const diff = Math.abs(luma(d[i], d[i + 1], d[i + 2]) - luma(o[i], o[i + 1], o[i + 2])); if (diff < p.threshold) { d[i] = o[i]; d[i + 1] = o[i + 1]; d[i + 2] = o[i + 2]; } } return img; },
  },

  // ── Pixelate ───────────────────────────────────────────────────────────
  mosaic: {
    group: 'Pixelate', name: 'Mosaic…', params: [R('size', 'Ukuran sel', 2, 200, 12, 1, 'persegi')],
    apply(img, p) {
      const { width: w, height: h, data: d } = img, s = p.size | 0;
      for (let by = 0; by < h; by += s) for (let bx = 0; bx < w; bx += s) {
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let y = by; y < Math.min(h, by + s); y++) for (let x = bx; x < Math.min(w, bx + s); x++) { const i = (y * w + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++; }
        r /= n; g /= n; b /= n; a /= n;
        for (let y = by; y < Math.min(h, by + s); y++) for (let x = bx; x < Math.min(w, bx + s); x++) { const i = (y * w + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; }
      }
      return img;
    },
  },
  crystallize: {
    group: 'Pixelate', name: 'Crystallize…', params: [R('size', 'Ukuran sel', 3, 300, 18)],
    apply(img, p) {
      const { width: w, height: h, data: d } = img, s = p.size, src = d.slice();
      const gw = Math.ceil(w / s) + 1, gh = Math.ceil(h / s) + 1, pts = [];
      for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) pts.push([(gx + hash(gx, gy, 3)) * s, (gy + hash(gx, gy, 9)) * s]);
      const col = pts.map(([px, py]) => { const i = (clamp(py | 0, 0, h - 1) * w + clamp(px | 0, 0, w - 1)) * 4; return [src[i], src[i + 1], src[i + 2], src[i + 3]]; });
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const gx = Math.floor(x / s), gy = Math.floor(y / s); let best = 0, bd = 1e18;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const cx = gx + ox, cy = gy + oy; if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) continue;
          const k = cy * gw + cx, dd = (pts[k][0] - x) ** 2 + (pts[k][1] - y) ** 2; if (dd < bd) { bd = dd; best = k; }
        }
        const i = (y * w + x) * 4, c = col[best]; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3];
      }
      return img;
    },
  },
  'color-halftone': {
    group: 'Pixelate', name: 'Color Halftone…', params: [R('radius', 'Radius maks', 4, 127, 8, 1, 'piksel')],
    apply(img, p) {
      const { width: w, height: h } = img, src = copyOf(img).data, d = img.data, r = p.radius, cell = r * 2;
      const angles = [108, 162, 90, 45].map(rad); // C M Y K
      for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 255; }
      for (let ch = 0; ch < 3; ch++) {
        const a = angles[ch], ca = Math.cos(a), sa = Math.sin(a);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const u = x * ca + y * sa, v = -x * sa + y * ca;
          const cu = (Math.floor(u / cell) + .5) * cell, cv = (Math.floor(v / cell) + .5) * cell;
          const sx = clamp(Math.round(cu * ca - cv * sa), 0, w - 1), sy = clamp(Math.round(cu * sa + cv * ca), 0, h - 1);
          const ink = 1 - src[(sy * w + sx) * 4 + ch] / 255, dotR = Math.sqrt(ink) * r * 1.05;
          const i = (y * w + x) * 4;
          if ((u - cu) ** 2 + (v - cv) ** 2 < dotR * dotR) d[i + ch] = 0;
        }
      }
      return img;
    },
  },
  pointillize: {
    group: 'Pixelate', name: 'Pointillize…', params: [R('size', 'Ukuran sel', 3, 300, 8)],
    apply(img, p, env) {
      const { width: w, height: h } = img, src = copyOf(img).data, d = img.data, s = p.size, bg = env.bg;
      for (let i = 0; i < d.length; i += 4) { d[i] = bg.r; d[i + 1] = bg.g; d[i + 2] = bg.b; }
      const n = Math.round(w * h / (s * s) * 1.6);
      for (let k = 0; k < n; k++) {
        const cx = Math.random() * w, cy = Math.random() * h, si = ((cy | 0) * w + (cx | 0)) * 4, rr = s * (.5 + Math.random() * .3);
        for (let y = Math.max(0, cy - rr | 0); y < Math.min(h, cy + rr); y++) for (let x = Math.max(0, cx - rr | 0); x < Math.min(w, cx + rr); x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 > rr * rr) continue; const i = (y * w + x) * 4;
          d[i] = src[si] + (Math.random() - .5) * 20; d[i + 1] = src[si + 1] + (Math.random() - .5) * 20; d[i + 2] = src[si + 2] + (Math.random() - .5) * 20;
        }
      }
      return img;
    },
  },

  // ── Render ─────────────────────────────────────────────────────────────
  clouds: {
    group: 'Render', name: 'Clouds', params: [R('scale', 'Skala', 10, 800, 160)],
    apply(img, p, env) {
      const { width: w, height: h, data: d } = img, seed = (Math.random() * 1000) | 0, fg = env.fg, bg = env.bg;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = clamp((fbm(x / p.scale, y / p.scale, seed) - .15) / .7, 0, 1), i = (y * w + x) * 4;
        d[i] = fg.r + (bg.r - fg.r) * v; d[i + 1] = fg.g + (bg.g - fg.g) * v; d[i + 2] = fg.b + (bg.b - fg.b) * v; d[i + 3] = 255;
      }
      return img;
    },
  },
  'difference-clouds': {
    group: 'Render', name: 'Difference Clouds', params: [R('scale', 'Skala', 10, 800, 160)],
    apply(img, p, env) {
      const { width: w, height: h, data: d } = img, seed = (Math.random() * 1000) | 0, fg = env.fg, bg = env.bg;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = clamp((fbm(x / p.scale, y / p.scale, seed) - .15) / .7, 0, 1), i = (y * w + x) * 4;
        d[i] = Math.abs(d[i] - (fg.r + (bg.r - fg.r) * v)); d[i + 1] = Math.abs(d[i + 1] - (fg.g + (bg.g - fg.g) * v)); d[i + 2] = Math.abs(d[i + 2] - (fg.b + (bg.b - fg.b) * v));
      }
      return img;
    },
  },
  'lens-flare': {
    group: 'Render', name: 'Lens Flare…', params: [R('brightness', 'Kecerahan', 10, 300, 100, 1, '%'), R('cx', 'Pusat X', 0, 100, 30, 1, '%'), R('cy', 'Pusat Y', 0, 100, 30, 1, '%'), S('lens', 'Tipe lensa', [['50', '50-300mm Zoom'], ['35', '35mm Prime'], ['105', '105mm Prime']], '50')],
    apply(img, p) {
      const { width: w, height: h, data: d } = img, cx = w * p.cx / 100, cy = h * p.cy / 100, B = p.brightness / 100, D = Math.hypot(w, h);
      const ghosts = [[.25, .04, [255, 200, 120]], [.45, .02, [120, 200, 255]], [.7, .06, [180, 255, 160]], [1.1, .03, [255, 140, 200]], [1.35, .09, [140, 160, 255]]];
      const ex = w / 2, ey = h / 2;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, dd = Math.hypot(x - cx, y - cy) / D;
        let add = Math.exp(-dd * dd * 900) * 255 * B + Math.exp(-dd * 18) * 90 * B;
        let r = add, g = add * .95, b = add * .85;
        const ang = Math.atan2(y - cy, x - cx); const streak = Math.pow(Math.abs(Math.cos(ang * 6)), 60) * Math.exp(-dd * 10) * 70 * B; r += streak; g += streak; b += streak;
        const ring = Math.exp(-Math.pow((dd - .09 * (p.lens === '105' ? 1.4 : p.lens === '35' ? .8 : 1)) * 120, 2)) * 40 * B; r += ring * .8; g += ring * .6; b += ring;
        for (const [t, rad2, c] of ghosts) {
          const gx = cx + (ex - cx) * t * 2, gy = cy + (ey - cy) * t * 2, gd = Math.hypot(x - gx, y - gy) / D;
          const v = gd < rad2 ? (1 - gd / rad2) ** .5 * .25 * B : 0; r += c[0] * v; g += c[1] * v; b += c[2] * v;
        }
        d[i] = 255 - (255 - d[i]) * (255 - Math.min(255, r)) / 255; d[i + 1] = 255 - (255 - d[i + 1]) * (255 - Math.min(255, g)) / 255; d[i + 2] = 255 - (255 - d[i + 2]) * (255 - Math.min(255, b)) / 255;
      }
      return img;
    },
  },
  fibers: {
    group: 'Render', name: 'Fibers…', params: [R('variance', 'Variasi', 1, 64, 16), R('strength', 'Kekuatan', 1, 64, 4)],
    apply(img, p, env) {
      const { width: w, height: h, data: d } = img, seed = (Math.random() * 999) | 0, fg = env.fg, bg = env.bg;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = clamp(fbm(x / (p.strength * 3), y / (p.variance * 14), seed, 4), 0, 1), i = (y * w + x) * 4;
        d[i] = fg.r + (bg.r - fg.r) * v; d[i + 1] = fg.g + (bg.g - fg.g) * v; d[i + 2] = fg.b + (bg.b - fg.b) * v; d[i + 3] = 255;
      }
      return img;
    },
  },
  vignette: {
    group: 'Render', name: 'Vignette…', params: [R('amount', 'Jumlah', -100, 100, -45), R('midpoint', 'Titik tengah', 0, 100, 50), R('feather', 'Lembut', 0, 100, 60)],
    apply(img, p) {
      const { width: w, height: h, data: d } = img, cx = w / 2, cy = h / 2, a = p.amount / 100;
      const inner = .2 + p.midpoint / 100 * .8, f = .05 + p.feather / 100;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const nx = (x - cx) / cx, ny = (y - cy) / cy, r = Math.sqrt(nx * nx + ny * ny) / Math.SQRT2 * 1.2;
        const t = clamp((r - inner) / f, 0, 1), v = t * t * (3 - 2 * t), i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) d[i + c] = a < 0 ? d[i + c] * (1 + a * v) : d[i + c] + (255 - d[i + c]) * a * v;
      }
      return img;
    },
  },

  // ── Sharpen ────────────────────────────────────────────────────────────
  'unsharp-mask': { group: 'Sharpen', name: 'Unsharp Mask…', params: [R('amount', 'Jumlah', 1, 500, 100, 1, '%'), R('radius', 'Radius', .1, 100, 1.5, .1, 'piksel'), R('threshold', 'Ambang', 0, 255, 0, 1, 'level')], apply: (img, p) => unsharp(img, p.amount, p.radius, p.threshold) },
  'smart-sharpen': {
    group: 'Sharpen', name: 'Smart Sharpen…', params: [R('amount', 'Jumlah', 1, 500, 150, 1, '%'), R('radius', 'Radius', .1, 64, 1.2, .1, 'piksel'), R('noise', 'Kurangi noise', 0, 100, 10, 1, '%')],
    apply(img, p) { if (p.noise) bilateral(img, 1 + p.noise / 40, 4 + p.noise / 4); return unsharp(img, p.amount, p.radius, 2); },
  },
  sharpen: { group: 'Sharpen', name: 'Sharpen', params: [], apply: img => convolve(img, [0, -1, 0, -1, 5, -1, 0, -1, 0]) },
  'sharpen-more': { group: 'Sharpen', name: 'Sharpen More', params: [], apply: img => convolve(img, [-1, -1, -1, -1, 9, -1, -1, -1, -1]) },
  'sharpen-edges': { group: 'Sharpen', name: 'Sharpen Edges', params: [], apply: img => unsharp(img, 120, 1, 12) },

  // ── Stylize ────────────────────────────────────────────────────────────
  emboss: {
    group: 'Stylize', name: 'Emboss…', params: [R('angle', 'Sudut', -180, 180, 135, 1, '°'), R('height', 'Tinggi', 1, 10, 3, 1, 'piksel'), R('amount', 'Jumlah', 1, 500, 100, 1, '%')],
    apply(img, p) {
      const { width: w, height: h, data: d } = img, src = d.slice(), dx = Math.cos(rad(p.angle)) * p.height, dy = -Math.sin(rad(p.angle)) * p.height, k = p.amount / 100;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const a = (clamp(Math.round(y + dy), 0, h - 1) * w + clamp(Math.round(x + dx), 0, w - 1)) * 4;
        const b = (clamp(Math.round(y - dy), 0, h - 1) * w + clamp(Math.round(x - dx), 0, w - 1)) * 4;
        const v = 128 + (luma(src[a], src[a + 1], src[a + 2]) - luma(src[b], src[b + 1], src[b + 2])) * k;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      return img;
    },
  },
  'find-edges': {
    group: 'Stylize', name: 'Find Edges', params: [],
    apply(img) {
      const { width: w, height: h, data: d } = img, src = d.slice();
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
        const g = (xx, yy) => src[(clamp(yy, 0, h - 1) * w + clamp(xx, 0, w - 1)) * 4 + c];
        const gx = -g(x - 1, y - 1) - 2 * g(x - 1, y) - g(x - 1, y + 1) + g(x + 1, y - 1) + 2 * g(x + 1, y) + g(x + 1, y + 1);
        const gy = -g(x - 1, y - 1) - 2 * g(x, y - 1) - g(x + 1, y - 1) + g(x - 1, y + 1) + 2 * g(x, y + 1) + g(x + 1, y + 1);
        d[(y * w + x) * 4 + c] = 255 - Math.min(255, Math.hypot(gx, gy) * .7);
      }
      return img;
    },
  },
  'glowing-edges': {
    group: 'Stylize', name: 'Glowing Edges…', params: [R('width', 'Lebar tepi', 1, 14, 2), R('brightness', 'Kecerahan', 0, 20, 8)],
    apply(img, p) {
      FILTERS['find-edges'].apply(img); const d = img.data;
      for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = clamp((255 - d[i + c]) * (.6 + p.brightness / 8), 0, 255);
      if (p.width > 1) { const P = planes(img); for (let c = 0; c < 3; c++) { const m = minMaxPlane(P[c], img.width, img.height, (p.width / 2) | 0, true); for (let i = 0; i < m.length; i++) d[i * 4 + c] = m[i]; } }
      return img;
    },
  },
  'oil-paint': {
    group: 'Stylize', name: 'Oil Paint…', params: [R('radius', 'Stilisasi', 1, 10, 4), R('levels', 'Kebersihan', 4, 40, 18), R('shine', 'Kilau', 0, 10, 2)],
    apply(img, p) {
      const { width: w, height: h, data: d } = img, src = d.slice(), r = p.radius | 0, L = p.levels | 0;
      const cnt = new Int32Array(L), sr = new Float64Array(L), sg = new Float64Array(L), sb = new Float64Array(L);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        cnt.fill(0); sr.fill(0); sg.fill(0); sb.fill(0);
        for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++) for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
          const i = (yy * w + xx) * 4, b = Math.min(L - 1, (luma(src[i], src[i + 1], src[i + 2]) / 256 * L) | 0);
          cnt[b]++; sr[b] += src[i]; sg[b] += src[i + 1]; sb[b] += src[i + 2];
        }
        let m = 0; for (let k = 1; k < L; k++) if (cnt[k] > cnt[m]) m = k;
        const i = (y * w + x) * 4; d[i] = sr[m] / cnt[m]; d[i + 1] = sg[m] / cnt[m]; d[i + 2] = sb[m] / cnt[m];
      }
      if (p.shine) FILTERS['unsharp-mask'].apply(img, { amount: p.shine * 25, radius: 2, threshold: 0 });
      return img;
    },
  },
  solarize: { group: 'Stylize', name: 'Solarize', params: [], apply(img) { const d = img.data; for (let i = 0; i < d.length; i++) if ((i & 3) !== 3 && d[i] > 127) d[i] = 255 - d[i]; return img; } },
  diffuse: {
    group: 'Stylize', name: 'Diffuse…', params: [R('amount', 'Jarak', 1, 10, 3)],
    apply(img, p) { const r = p.amount; return displace(img, (x, y) => [x + (Math.random() - .5) * 2 * r, y + (Math.random() - .5) * 2 * r]); },
  },
  wind: {
    group: 'Stylize', name: 'Wind…', params: [S('method', 'Metode', [['wind', 'Wind'], ['blast', 'Blast'], ['stagger', 'Stagger']], 'wind'), S('dir', 'Arah', [['left', 'Dari kanan'], ['right', 'Dari kiri']], 'right')],
    apply(img, p) {
      const { width: w, height: h, data: d } = img, src = d.slice(), len = p.method === 'blast' ? 60 : 24;
      for (let y = 0; y < h; y++) {
        const prob = p.method === 'stagger' ? .08 : .04;
        for (let x0 = 0; x0 < w; x0++) {
          if (Math.random() > prob) continue;
          const x = p.dir === 'right' ? x0 : w - 1 - x0, i0 = (y * w + x) * 4, L = Math.random() * len;
          for (let k = 1; k < L; k++) {
            const xx = p.dir === 'right' ? x + k : x - k; if (xx < 0 || xx >= w) break;
            const i = (y * w + xx) * 4, t = 1 - k / L;
            for (let c = 0; c < 3; c++) d[i + c] = Math.max(d[i + c], src[i0 + c] * t + d[i + c] * (1 - t));
          }
        }
      }
      return img;
    },
  },
  'trace-contour': {
    group: 'Stylize', name: 'Trace Contour…', params: [R('level', 'Level', 0, 255, 128)],
    apply(img, p) {
      const { width: w, height: h, data: d } = img, src = d.slice();
      for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) for (let c = 0; c < 3; c++) {
        const i = (y * w + x) * 4 + c, a = src[i] >= p.level, b = src[i + 4] >= p.level, e = src[i + w * 4] >= p.level;
        d[i] = a !== b || a !== e ? 0 : 255;
      }
      return img;
    },
  },

  // ── Other ──────────────────────────────────────────────────────────────
  'high-pass': {
    group: 'Other', name: 'High Pass…', params: [R('radius', 'Radius', .1, 250, 10, .1, 'piksel')],
    apply(img, p) { const b = gaussianImageData(copyOf(img), p.radius).data, d = img.data; for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = 128 + d[i + c] - b[i + c]; return img; },
  },
  minimum: {
    group: 'Other', name: 'Minimum…', params: [R('radius', 'Radius', 1, 100, 1, 1, 'piksel')],
    apply(img, p) { const P = planes(img), d = img.data; for (let c = 0; c < 3; c++) { const m = minMaxPlane(P[c], img.width, img.height, p.radius, false); for (let i = 0; i < m.length; i++) d[i * 4 + c] = m[i]; } return img; },
  },
  maximum: {
    group: 'Other', name: 'Maximum…', params: [R('radius', 'Radius', 1, 100, 1, 1, 'piksel')],
    apply(img, p) { const P = planes(img), d = img.data; for (let c = 0; c < 3; c++) { const m = minMaxPlane(P[c], img.width, img.height, p.radius, true); for (let i = 0; i < m.length; i++) d[i * 4 + c] = m[i]; } return img; },
  },
  offset: {
    group: 'Other', name: 'Offset…', params: [R('h', 'Horizontal', -2000, 2000, 50, 1, 'piksel'), R('v', 'Vertikal', -2000, 2000, 50, 1, 'piksel'), S('edge', 'Area tak terdefinisi', [['wrap', 'Bungkus'], ['repeat', 'Ulangi piksel tepi'], ['clear', 'Transparan']], 'wrap')],
    apply(img, p) {
      const { width: w, height: h, data: d } = img, src = d.slice();
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let sx = x - p.h, sy = y - p.v; const i = (y * w + x) * 4;
        if (p.edge === 'wrap') { sx = ((sx % w) + w) % w; sy = ((sy % h) + h) % h; }
        else if (p.edge === 'repeat') { sx = clamp(sx, 0, w - 1); sy = clamp(sy, 0, h - 1); }
        else if (sx < 0 || sy < 0 || sx >= w || sy >= h) { d[i + 3] = 0; continue; }
        const j = (sy * w + sx) * 4; d[i] = src[j]; d[i + 1] = src[j + 1]; d[i + 2] = src[j + 2]; d[i + 3] = src[j + 3];
      }
      return img;
    },
  },
  custom: {
    group: 'Other', name: 'Custom…', params: [{ key: 'kernel', label: 'Kernel 3×3', type: 'kernel', def: [0, -1, 0, -1, 5, -1, 0, -1, 0] }, R('scale', 'Skala', 1, 9999, 1), R('offset', 'Offset', -9999, 9999, 0)],
    apply: (img, p) => convolve(img, p.kernel, p.scale || 1, p.offset),
  },
};
export const FILTER_GROUPS = ['Blur', 'Distort', 'Noise', 'Pixelate', 'Render', 'Sharpen', 'Stylize', 'Other'];
export const filterDefaults = id => Object.fromEntries(FILTERS[id].params.map(q => [q.key, Array.isArray(q.def) ? [...q.def] : q.def]));

// ── Camera Raw (non-destructive-looking global develop) ──────────────────
export const CAMRAW_DEFAULTS = { temp: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0, vignette: 0, grain: 0, sharpen: 0 };
export function cameraRaw(img, p) {
  const { width: w, height: h, data: d } = img, n = w * h;
  let base = null;
  if (p.clarity || p.texture || p.dehaze) {
    const L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = luma(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    base = { big: blurPlane(Float32Array.from(L), w, h, Math.max(4, Math.min(w, h) / 60)), small: p.texture ? blurPlane(Float32Array.from(L), w, h, 2) : null, L };
  }
  const ex = Math.pow(2, p.exposure), ct = 1 + p.contrast / 100;
  const tr = p.temp / 100 * 40, tb = -p.temp / 100 * 40, tg = -p.tint / 100 * 30;
  const cx = w / 2, cy = h / 2;
  for (let i = 0; i < n; i++) {
    const j = i * 4; let r = d[j], g = d[j + 1], b = d[j + 2];
    r += tr; g += tg; b += tb;
    r *= ex; g *= ex; b *= ex;
    let l = luma(r, g, b) / 255;
    const sh = (1 - l) ** 2, hi = l ** 2;
    let dl = p.shadows / 100 * sh * .45 + p.highlights / 100 * hi * .45;
    dl += p.whites / 100 * Math.max(0, l - .7) * .8 + p.blacks / 100 * Math.max(0, .3 - l) * .8;
    if (base) {
      const bl = base.big[i] / 255, lo = base.L[i] / 255;
      dl += (lo - bl) * p.clarity / 100 * 1.2;
      if (base.small) dl += (lo - base.small[i] / 255) * p.texture / 100 * 2;
      if (p.dehaze) { const k = p.dehaze / 100; dl += (lo - bl) * k * .5 - k * .06 * (1 - lo); }
    }
    const nl = clamp(l + dl, 0, 1.2), f = l > .002 ? nl / l : 1;
    r *= f; g *= f; b *= f;
    r = (r / 255 - .5) * ct + .5; g = (g / 255 - .5) * ct + .5; b = (b / 255 - .5) * ct + .5;
    const L2 = luma(r, g, b), mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx - mn;
    const k = 1 + p.saturation / 100 + p.vibrance / 100 * (1 - sat) * 1.2 + (p.dehaze / 100) * .25;
    r = L2 + (r - L2) * k; g = L2 + (g - L2) * k; b = L2 + (b - L2) * k;
    if (p.vignette) {
      const x = i % w, y = (i / w) | 0, dd = Math.hypot((x - cx) / cx, (y - cy) / cy) / Math.SQRT2;
      const v = clamp((dd - .35) / .65, 0, 1) ** 2 * p.vignette / 100;
      if (v < 0) { r *= 1 + v; g *= 1 + v; b *= 1 + v; } else { r += (1 - r) * v; g += (1 - g) * v; b += (1 - b) * v; }
    }
    if (p.grain) { const nz = (Math.random() - .5) * p.grain / 100 * .25; r += nz; g += nz; b += nz; }
    d[j] = r * 255; d[j + 1] = g * 255; d[j + 2] = b * 255;
  }
  if (p.sharpen) unsharp(img, p.sharpen * 1.5, 1, 2);
  return img;
}
