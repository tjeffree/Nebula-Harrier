// Offline sprite baker for Nebula Harrier.
// Programmatically synthesises a 4x4 billboard atlas (projectiles, particles,
// explosion flipbook, distant enemy LOD) pixel by pixel and writes it with sharp.
// No hand-made assets are involved: every pixel comes from the code below.
//
// Channel encoding for tintable cells (everything except the explosion
// flipbook, which is baked in full sRGB colour):
//   R = "whiteness"  (0 = runtime tint colour, 1 = white-hot)
//   G = brightness   (1 = full, lower = shading / dark silhouette)
//   A = coverage
// The sprite shader computes  rgb = mix(tint, white, R) * G, and boosts the
// whiteness of hot cells into HDR so bloom picks up their cores.
//
// Cell layout MUST stay in sync with ATLAS in src/procgen/ModelFactory.ts.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/sprites/atlas.png');
const CELL = 128;
const COLS = 4;
const SIZE = CELL * COLS;
const px = Buffer.alloc(SIZE * SIZE * 4);

// Deterministic value noise so every bake is byte-identical.
function hash(x, y, s) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise(x, y, s = 0) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y, s = 0, oct = 5) {
  let v = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { v += a * noise(x * f, y * f, s + i * 17); f *= 2; a *= 0.5; }
  return v / (1 - Math.pow(0.5, oct));
}
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const gauss = (x, w) => Math.exp(-(x / w) * (x / w));

/** Rasterises one cell; `fn(u, v)` gets coordinates in [-1, 1] and returns [r, g, b, a] in 0..1. */
function cell(index, fn) {
  const ox = (index % COLS) * CELL;
  const oy = Math.floor(index / COLS) * CELL;
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const u = ((x + 0.5) / CELL) * 2 - 1;
      const v = ((y + 0.5) / CELL) * 2 - 1;
      const [r, g, b, a] = fn(u, v);
      const i = ((oy + y) * SIZE + ox + x) * 4;
      px[i] = Math.round(clamp(r) * 255);
      px[i + 1] = Math.round(clamp(g) * 255);
      px[i + 2] = Math.round(clamp(b) * 255);
      px[i + 3] = Math.round(clamp(a) * 255);
    }
  }
}

/** Elongated tracer: white-hot core, tinted body, soft halo. */
const tracer = (width) => (u, v) => {
  const ell = (sx, sy) => Math.sqrt((u / sx) ** 2 + (v / sy) ** 2);
  const halo = Math.exp(-((u / (width * 2.2)) ** 2 + (v / 0.95) ** 2) * 3) * 0.55;
  const body = smooth(1, 0.65, ell(width, 0.9));
  const core = smooth(1, 0.35, ell(width * 0.45, 0.78));
  return [Math.max(core, body * 0.15), 1, 0, Math.max(halo, body)];
};

// 0: PLAYER_BOLT – energy ball: white-hot core, tinted body, soft halo.
cell(0, (u, v) => {
  const r = Math.hypot(u, v);
  const halo = Math.exp(-r * r * 4) * 0.55;
  const body = smooth(0.5, 0.36, r);
  const core = smooth(0.3, 0.05, r);
  return [Math.max(core, body * 0.15), 1, 0, Math.max(halo, body)];
});

// 1: ENEMY_ORB – plasma ball with a dark rim so it reads against bright sky.
cell(1, (u, v) => {
  const r = Math.hypot(u, v);
  const halo = Math.exp(-r * r * 5) * 0.6;
  const body = smooth(0.46, 0.4, r);
  const rim = gauss(r - 0.43, 0.035);
  const core = smooth(0.32, 0.0, r);
  const g = 1 - rim * 0.65;
  return [core, g, 0, Math.max(halo, body, rim)];
});

// 2: ENEMY_NEEDLE – thin laser dart.
cell(2, tracer(0.1));

// 3: SPARK – four-point glint.
cell(3, (u, v) => {
  const r = Math.hypot(u, v);
  const streak = Math.max(gauss(u, 0.035) * Math.exp(-Math.abs(v) * 3.2), gauss(v, 0.035) * Math.exp(-Math.abs(u) * 3.2));
  const core = Math.exp(-r * r * 40);
  const halo = Math.exp(-r * r * 6) * 0.35;
  return [clamp(core + streak * 0.8), 1, 0, clamp(Math.max(core, streak, halo))];
});

// 4..11: EXPLOSION flipbook – white-hot flash, churning fireball, then dark smoke.
const RAMP = [
  [0.0, [0.17, 0.155, 0.15]],
  [0.18, [0.35, 0.16, 0.1]],
  [0.35, [0.72, 0.22, 0.07]],
  [0.55, [1.0, 0.48, 0.12]],
  [0.75, [1.0, 0.76, 0.32]],
  [1.0, [1.0, 0.97, 0.86]],
];
function ramp(h) {
  for (let i = 1; i < RAMP.length; i++) {
    if (h <= RAMP[i][0]) {
      const [a0, c0] = RAMP[i - 1];
      const [a1, c1] = RAMP[i];
      const t = (h - a0) / (a1 - a0);
      return c0.map((c, k) => c + (c1[k] - c) * t);
    }
  }
  return RAMP[RAMP.length - 1][1];
}
for (let f = 0; f < 8; f++) {
  const t = f / 7;
  const R = 0.38 + 0.52 * Math.pow(t, 0.6);
  cell(4 + f, (u, v) => {
    const r = Math.hypot(u, v);
    // Billows: domain-warped noise, drifting upward as the fireball ages.
    const w = fbm(u * 2.2 + 3, v * 2.2 - t * 1.2, 11);
    const n = fbm(u * 3.2 + w * 1.4, v * 3.2 + w * 1.4 - t * 1.5, 5);
    const edge = R * (0.72 + 0.42 * n);
    const inside = smooth(edge, edge - 0.18, r);
    if (inside <= 0) return [0, 0, 0, 0];
    const depth = clamp(1 - r / edge);
    let heat = (1.15 - t * 1.25) * (0.45 + 0.75 * depth) + (n - 0.5) * 0.5;
    heat = clamp(heat);
    let [cr, cg, cb] = ramp(heat);
    // Smoke is lit from above.
    const lit = 0.75 + 0.35 * clamp(-v * 0.8 + (n - 0.5));
    if (heat < 0.2) { cr *= lit; cg *= lit; cb *= lit; }
    const fade = f === 7 ? 0.5 : 1 - Math.max(0, t - 0.55) * 0.9;
    return [cr, cg, cb, inside * fade];
  });
}

// 12: MINE – hexagonal charge with a hot core.
cell(12, (u, v) => {
  const a = Math.atan2(v, u);
  const r = Math.hypot(u, v);
  const sector = Math.PI / 3;
  const local = ((((a + Math.PI / 6) % sector) + sector) % sector) - Math.PI / 6;
  const hex = (r * Math.cos(local)) / Math.cos(Math.PI / 6);
  const body = smooth(0.66, 0.6, hex);
  const rim = gauss(hex - 0.63, 0.04);
  const core = smooth(0.25, 0.0, r);
  const halo = Math.exp(-r * r * 3) * 0.45;
  return [core, 0.55 + 0.45 * Math.max(rim, core), 0, Math.max(body, halo)];
});

// 13: FLOCK_LOD – a distant razorwing: dark body, swept bat wings, glinting eyes.
cell(13, (u, v) => {
  const body = smooth(1, 0.85, Math.hypot(u / 0.16, (v - 0.02) / 0.34));
  const au = Math.abs(u);
  // Wing: leading edge rises toward the tip; trailing edge scalloped between fingers.
  const lead = -0.05 - au * 0.35;
  const trail = 0.12 + 0.12 * Math.abs(Math.sin(au * 9)) - au * 0.18;
  const wing = smooth(0.02, -0.02, lead - v) * smooth(0.02, -0.02, v - trail) * smooth(0.95, 0.85, au);
  const eye = smooth(0.06, 0.02, Math.hypot(au - 0.05, v + 0.22));
  const a = Math.max(body, wing);
  return [eye, clamp(0.3 + wing * 0.25 + eye), 0, a];
});

// 14: RING – shockwave.
cell(14, (u, v) => {
  const r = Math.hypot(u, v);
  const ring = gauss(r - 0.82, 0.06);
  const fill = smooth(0.85, 0.3, r) * 0.1;
  return [ring * 0.6, 1, 0, clamp(ring * 0.85 + fill)];
});

// 15: PUFF – billowing smoke, lit from above, mostly tint.
cell(15, (u, v) => {
  const r = Math.hypot(u, v);
  const n = fbm(u * 2.6 + 7, v * 2.6 + 1, 23);
  const shape = smooth(0.95, 0.45, r + (n - 0.5) * 0.55);
  const lit = clamp(0.55 + 0.4 * (-v * 0.6 + (n - 0.5) * 1.2));
  return [0.1, lit, 0, shape * 0.88];
});

mkdirSync(dirname(OUT), { recursive: true });
await sharp(px, { raw: { width: SIZE, height: SIZE, channels: 4 } }).png({ compressionLevel: 9 }).toFile(OUT);
console.log(`[bake] wrote ${OUT} (${SIZE}x${SIZE}, ${COLS * COLS} cells)`);
