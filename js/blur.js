// Fast blurs (triple box ≈ gaussian) and distance transforms on typed arrays

function boxesForGauss(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = []; for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

// Blur one channel plane (Float32Array or Uint8) horizontally then vertically with box radius r
function boxH(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let i = 0; i < h; i++) {
    let ti = i * w, li = ti, ri = ti + r;
    const end = ti + w - 1, fv = src[ti], lv = src[end];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[ti + Math.min(j, w - 1)];
    for (let j = 0; j <= r; j++) { val += src[Math.min(ri++, end)] - fv; dst[ti++] = val * iarr; }
    for (let j = r + 1; j < w - r; j++) { val += src[ri++] - src[li++]; dst[ti++] = val * iarr; }
    for (let j = Math.max(w - r, r + 1); j < w; j++) { val += lv - src[li++]; dst[ti++] = val * iarr; }
  }
}
function boxV(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let i = 0; i < w; i++) {
    let ti = i, li = ti, ri = ti + r * w;
    const end = i + w * (h - 1), fv = src[ti], lv = src[end];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[ti + Math.min(j, h - 1) * w];
    for (let j = 0; j <= r; j++) { val += src[Math.min(ri, end)] - fv; ri += w; dst[ti] = val * iarr; ti += w; }
    for (let j = r + 1; j < h - r; j++) { val += src[ri] - src[li]; ri += w; li += w; dst[ti] = val * iarr; ti += w; }
    for (let j = Math.max(h - r, r + 1); j < h; j++) { val += lv - src[li]; li += w; dst[ti] = val * iarr; ti += w; }
  }
}
export function blurPlane(plane, w, h, sigma) {
  if (sigma < .3) return plane;
  const tmp = new Float32Array(plane.length);
  let a = plane instanceof Float32Array ? plane : Float32Array.from(plane);
  for (const s of boxesForGauss(sigma)) {
    const r = (s - 1) / 2;
    if (r <= 0) continue;
    boxH(a, tmp, w, h, Math.min(r, w - 1)); boxV(tmp, a, w, h, Math.min(r, h - 1));
  }
  return a;
}
export function boxBlurPlane(plane, w, h, r) {
  if (r < 1) return plane;
  const tmp = new Float32Array(plane.length);
  const a = plane instanceof Float32Array ? plane : Float32Array.from(plane);
  boxH(a, tmp, w, h, Math.min(r, w - 1)); boxV(tmp, a, w, h, Math.min(r, h - 1));
  return a;
}

// Gaussian blur of ImageData (premultiplied so transparent edges don't darken)
export function gaussianImageData(img, sigma, { alphaOnly = false } = {}) {
  const { width: w, height: h, data: d } = img, n = w * h;
  if (sigma < .3) return img;
  const A = new Float32Array(n);
  for (let i = 0; i < n; i++) A[i] = d[i * 4 + 3];
  if (alphaOnly) {
    const b = blurPlane(A, w, h, sigma);
    for (let i = 0; i < n; i++) d[i * 4 + 3] = b[i];
    return img;
  }
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) { const a = A[i] / 255; R[i] = d[i * 4] * a; G[i] = d[i * 4 + 1] * a; B[i] = d[i * 4 + 2] * a; }
  const r = blurPlane(R, w, h, sigma), g = blurPlane(G, w, h, sigma), b = blurPlane(B, w, h, sigma), a = blurPlane(A, w, h, sigma);
  for (let i = 0; i < n; i++) {
    const al = a[i], k = al > .01 ? 255 / al : 0;
    d[i * 4] = r[i] * k; d[i * 4 + 1] = g[i] * k; d[i * 4 + 2] = b[i] * k; d[i * 4 + 3] = al;
  }
  return img;
}
export function boxImageData(img, radius) {
  const { width: w, height: h, data: d } = img, n = w * h;
  const planes = [0, 1, 2, 3].map(c => { const p = new Float32Array(n); for (let i = 0; i < n; i++) p[i] = d[i * 4 + c]; return p; });
  const A = planes[3];
  for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) planes[c][i] *= A[i] / 255;
  const out = planes.map(p => boxBlurPlane(p, w, h, Math.round(radius)));
  for (let i = 0; i < n; i++) {
    const al = out[3][i], k = al > .01 ? 255 / al : 0;
    d[i * 4] = out[0][i] * k; d[i * 4 + 1] = out[1][i] * k; d[i * 4 + 2] = out[2][i] * k; d[i * 4 + 3] = al;
  }
  return img;
}

// Euclidean-ish distance transform (two pass, 3-4 chamfer scaled) for binary masks.
// inside[i] = true → distance 0. Returns Float32Array distances (pixels) to nearest inside pixel.
export function distanceTransform(inside, w, h) {
  const INF = 1e9, D = new Float32Array(w * h);
  for (let i = 0; i < D.length; i++) D[i] = inside[i] ? 0 : INF;
  const a = 1, b = Math.SQRT2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; let v = D[i]; if (!v) continue;
    if (x > 0) v = Math.min(v, D[i - 1] + a);
    if (y > 0) {
      v = Math.min(v, D[i - w] + a);
      if (x > 0) v = Math.min(v, D[i - w - 1] + b);
      if (x < w - 1) v = Math.min(v, D[i - w + 1] + b);
    }
    D[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; let v = D[i]; if (!v) continue;
    if (x < w - 1) v = Math.min(v, D[i + 1] + a);
    if (y < h - 1) {
      v = Math.min(v, D[i + w] + a);
      if (x < w - 1) v = Math.min(v, D[i + w + 1] + b);
      if (x > 0) v = Math.min(v, D[i + w - 1] + b);
    }
    D[i] = v;
  }
  return D;
}

// Grayscale min/max filter with square radius (separable, O(n·r))
export function minMaxPlane(p, w, h, r, max = true) {
  const out = new Float32Array(p.length), tmp = new Float32Array(p.length);
  const pick = max ? Math.max : Math.min;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = p[y * w + x];
    for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) v = pick(v, p[y * w + xx]); }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = tmp[y * w + x];
    for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) v = pick(v, tmp[yy * w + x]); }
    out[y * w + x] = v;
  }
  return out;
}
