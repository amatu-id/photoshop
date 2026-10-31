// Content-aware fill: multi-scale PatchMatch inpainting (coarse diffusion → patch voting)

const PR = 3; // patch radius (7×7)

function holeBounds(mask, w, h) {
  let x1 = w, y1 = h, x2 = -1, y2 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; }
  return x2 < 0 ? null : { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
}

function downsample(L) {
  const w = Math.max(1, L.w >> 1), h = Math.max(1, L.h >> 1);
  const c = new Float32Array(w * h * 3), m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, n = 0, holes = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = Math.min(L.w - 1, x * 2 + dx), sy = Math.min(L.h - 1, y * 2 + dy), i = sy * L.w + sx;
      if (L.m[i]) { holes++; continue; }
      r += L.c[i * 3]; g += L.c[i * 3 + 1]; b += L.c[i * 3 + 2]; n++;
    }
    const j = y * w + x;
    if (n && holes < 3) { c[j * 3] = r / n; c[j * 3 + 1] = g / n; c[j * 3 + 2] = b / n; } else m[j] = 1;
  }
  return { w, h, c, m };
}

// onion-peel diffusion fill for the coarsest level
function diffuseFill(L) {
  const { w, h, c } = L, m = L.m.slice();
  let remaining = m.reduce((a, v) => a + v, 0), guard = 0;
  while (remaining > 0 && guard++ < 4000) {
    const next = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!m[i]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx; if (m[j]) continue;
        r += c[j * 3]; g += c[j * 3 + 1]; b += c[j * 3 + 2]; n++;
      }
      if (n) next.push([i, r / n, g / n, b / n]);
    }
    if (!next.length) break;
    for (const [i, r, g, b] of next) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; m[i] = 0; remaining--; }
  }
}

function patchMatch(L, iters) {
  const { w, h, c, m } = L;
  // valid source centres: whole patch known and inside
  const valid = new Uint8Array(w * h), list = [];
  for (let y = PR; y < h - PR; y++) for (let x = PR; x < w - PR; x++) {
    let ok = 1;
    for (let dy = -PR; dy <= PR && ok; dy++) for (let dx = -PR; dx <= PR; dx++) if (m[(y + dy) * w + x + dx]) { ok = 0; break; }
    if (ok) { valid[y * w + x] = 1; list.push(y * w + x); }
  }
  if (!list.length) return;
  const holes = []; for (let i = 0; i < w * h; i++) if (m[i]) holes.push(i);
  const nnf = new Int32Array(w * h).fill(-1), cost = new Float32Array(w * h);
  const dist = (t, s, best = Infinity) => {
    const tx = t % w, ty = (t / w) | 0, sx = s % w, sy = (s / w) | 0; let d = 0, n = 0;
    for (let dy = -PR; dy <= PR; dy++) {
      const yy = ty + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -PR; dx <= PR; dx++) {
        const xx = tx + dx; if (xx < 0 || xx >= w) continue;
        const ti = (yy * w + xx) * 3, si = ((sy + dy) * w + sx + dx) * 3;
        const a = c[ti] - c[si], b = c[ti + 1] - c[si + 1], e = c[ti + 2] - c[si + 2];
        d += a * a + b * b + e * e; n++;
        if (d > best * n) return Infinity;
      }
    }
    return d / (n || 1);
  };
  const rnd = () => list[(Math.random() * list.length) | 0];
  for (const t of holes) { const s = rnd(); nnf[t] = s; cost[t] = dist(t, s); }
  const maxR = Math.max(w, h);
  for (let it = 0; it < iters; it++) {
    const fwd = it % 2 === 0, step = fwd ? 1 : -1;
    for (let k = fwd ? 0 : holes.length - 1; fwd ? k < holes.length : k >= 0; k += step) {
      const t = holes[k], tx = t % w, ty = (t / w) | 0;
      let best = nnf[t], bc = cost[t];
      // propagation
      for (const [dx, dy] of [[-step, 0], [0, -step]]) {
        const nx = tx + dx, ny = ty + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx, src = nnf[ni]; if (src < 0) continue;
        const cand = src - dx - dy * w; if (cand < 0 || cand >= w * h || !valid[cand]) continue;
        const cc = dist(t, cand, bc); if (cc < bc) { bc = cc; best = cand; }
      }
      // random search
      let r = maxR; const bx = best % w, by = (best / w) | 0;
      while (r >= 1) {
        const cx = Math.round(bx + (Math.random() * 2 - 1) * r), cy = Math.round(by + (Math.random() * 2 - 1) * r);
        if (cx >= 0 && cy >= 0 && cx < w && cy < h) { const cand = cy * w + cx; if (valid[cand]) { const cc = dist(t, cand, bc); if (cc < bc) { bc = cc; best = cand; } } }
        r /= 2;
      }
      if (Math.random() < .08) { const cand = rnd(), cc = dist(t, cand, bc); if (cc < bc) { bc = cc; best = cand; } }
      nnf[t] = best; cost[t] = bc;
    }
    // voting
    const acc = new Float32Array(holes.length * 4);
    holes.forEach((t, k) => {
      const tx = t % w, ty = (t / w) | 0;
      for (let dy = -PR; dy <= PR; dy++) for (let dx = -PR; dx <= PR; dx++) {
        const qx = tx + dx, qy = ty + dy; if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        const q = qy * w + qx; const s = m[q] ? nnf[q] : q; if (s < 0) continue;
        const sx = (s % w) - dx, sy = ((s / w) | 0) - dy; if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const si = (sy * w + sx) * 3, wt = m[q] ? Math.exp(-cost[q] / 2000) + .02 : .5;
        acc[k * 4] += c[si] * wt; acc[k * 4 + 1] += c[si + 1] * wt; acc[k * 4 + 2] += c[si + 2] * wt; acc[k * 4 + 3] += wt;
      }
    });
    holes.forEach((t, k) => { const n = acc[k * 4 + 3]; if (n) { c[t * 3] = acc[k * 4] / n; c[t * 3 + 1] = acc[k * 4 + 1] / n; c[t * 3 + 2] = acc[k * 4 + 2] / n; } });
  }
}

export function inpaint(img, mask, { quality = 'normal' } = {}) {
  const W = img.width, H = img.height, d = img.data;
  const hb = holeBounds(mask, W, H); if (!hb) return img;
  const pad = Math.round(Math.max(hb.w, hb.h) * (quality === 'fast' ? 1.2 : 1.8)) + 12;
  const rx = Math.max(0, hb.x - pad), ry = Math.max(0, hb.y - pad), rw = Math.min(W, hb.x + hb.w + pad) - rx, rh = Math.min(H, hb.y + hb.h + pad) - ry;
  const base = { w: rw, h: rh, c: new Float32Array(rw * rh * 3), m: new Uint8Array(rw * rh) };
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const si = (y + ry) * W + x + rx, i = y * rw + x;
    base.m[i] = mask[si] ? 1 : 0;
    base.c[i * 3] = d[si * 4]; base.c[i * 3 + 1] = d[si * 4 + 1]; base.c[i * 3 + 2] = d[si * 4 + 2];
  }
  const pyr = [base];
  while (pyr.length < 7) {
    const L = pyr[pyr.length - 1]; if (Math.min(L.w, L.h) < 40) break;
    pyr.push(downsample(L));
  }
  diffuseFill(pyr[pyr.length - 1]);
  const iters = quality === 'fast' ? 3 : 5;
  for (let lv = pyr.length - 1; lv >= 0; lv--) {
    const L = pyr[lv];
    if (lv < pyr.length - 1) {
      const C = pyr[lv + 1];
      for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
        const i = y * L.w + x; if (!L.m[i]) continue;
        const cx = Math.min(C.w - 1, x >> 1), cy = Math.min(C.h - 1, y >> 1), j = cy * C.w + cx;
        L.c[i * 3] = C.c[j * 3]; L.c[i * 3 + 1] = C.c[j * 3 + 1]; L.c[i * 3 + 2] = C.c[j * 3 + 2];
      }
    }
    if (lv === pyr.length - 1 && L.w * L.h < 64) continue;
    patchMatch(L, lv === 0 ? Math.max(2, iters - 2) : iters);
  }
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const i = y * rw + x; if (!base.m[i]) continue;
    const si = ((y + ry) * W + x + rx) * 4;
    d[si] = base.c[i * 3]; d[si + 1] = base.c[i * 3 + 1]; d[si + 2] = base.c[i * 3 + 2]; d[si + 3] = 255;
  }
  return img;
}
