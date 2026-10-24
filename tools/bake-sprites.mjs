// Offline sprite baker for Nebula Harrier.
// Programmatically synthesises a 4x4 billboard atlas (projectiles, particles,
// explosion flipbook, distant enemy LOD) as SVG and rasterises it with sharp.
// No hand-made assets are involved: every pixel comes from the code below.
//
// Channel encoding for tintable cells (everything except the explosion
// flipbook, which is baked in full colour):
//   R = "whiteness"  (0 = runtime tint colour, 1 = pure white highlight)
//   G = brightness   (1 = full, lower = dark outline / shading)
//   A = coverage
// The sprite shader computes  rgb = mix(tint, white, R) * G.
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

// Deterministic PRNG so every bake is byte-identical.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0x4e48);

// Encoded colours.
const WHITE = '#ffffff'; // white highlight
const TINT = '#00ff00'; // pure tint
const HALF = '#80ff80'; // half-way to white
const DARK = '#005000'; // dark outline (tint * 0.31)

const defs = [];
const cells = [];
let gradId = 0;

function radial(stops, cx = '50%', cy = '50%', r = '50%') {
  const id = `g${gradId++}`;
  defs.push(
    `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}">${stops
      .map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`)
      .join('')}</radialGradient>`,
  );
  return `url(#${id})`;
}

function linear(stops, x1 = 0, y1 = 0, x2 = 0, y2 = 1) {
  const id = `g${gradId++}`;
  defs.push(
    `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops
      .map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`)
      .join('')}</linearGradient>`,
  );
  return `url(#${id})`;
}

function cell(index, body) {
  const x = (index % COLS) * CELL;
  const y = Math.floor(index / COLS) * CELL;
  cells.push(`<g transform="translate(${x},${y})">${body}</g>`);
}

function star(points, rOuter, rInner, cx = 64, cy = 64, rot = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = rot + (i * Math.PI) / points;
    pts.push(`${(cx + Math.cos(a) * r).toFixed(2)},${(cy + Math.sin(a) * r).toFixed(2)}`);
  }
  return pts.join(' ');
}

const softGlow = (a = 0.45) =>
  radial([
    [0, TINT, a],
    [0.6, TINT, a * 0.4],
    [1, TINT, 0],
  ]);

// 0: PLAYER_BOLT – glossy energy capsule: white core, tinted body, soft halo
cell(
  0,
  `<ellipse cx="64" cy="64" rx="34" ry="62" fill="${softGlow(0.5)}"/>
   <rect x="44" y="8" width="40" height="112" rx="20" fill="${DARK}" opacity="0.55"/>
   <rect x="47" y="11" width="34" height="106" rx="17" fill="${TINT}"/>
   <rect x="55" y="20" width="18" height="80" rx="9" fill="${HALF}"/>
   <rect x="57" y="24" width="7" height="30" rx="3.5" fill="${WHITE}"/>`,
);

// 1: ENEMY_ORB – candy orb with dark rim for readability on bright skies
cell(
  1,
  `<circle cx="64" cy="64" r="62" fill="${softGlow(0.35)}"/>
   <circle cx="64" cy="64" r="42" fill="${radial([
     [0, WHITE, 1],
     [0.35, HALF, 1],
     [0.7, TINT, 1],
     [1, TINT, 1],
   ])}" stroke="${DARK}" stroke-width="8"/>
   <ellipse cx="52" cy="50" rx="12" ry="8" fill="${WHITE}" opacity="0.9"/>`,
);

// 2: ENEMY_NEEDLE – laser dart
cell(
  2,
  `<ellipse cx="64" cy="64" rx="26" ry="62" fill="${softGlow(0.35)}"/>
   <rect x="50" y="8" width="28" height="112" rx="14" fill="${TINT}" stroke="${DARK}" stroke-width="6"/>
   <rect x="59" y="18" width="10" height="92" rx="5" fill="${WHITE}"/>`,
);

// 3: SPARKLE – four-point twinkle
cell(
  3,
  `<circle cx="64" cy="64" r="44" fill="${softGlow(0.5)}"/>
   <polygon points="${star(4, 62, 12)}" fill="${TINT}"/>
   <polygon points="${star(4, 40, 7)}" fill="${WHITE}"/>`,
);

// 4..11: EXPLOSION flipbook – cartoon fireball blooming into soft smoke.
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const a = p(c1);
  const b = p(c2);
  return `#${a.map((v, i) => Math.round(lerp(v, b[i], t)).toString(16).padStart(2, '0')).join('')}`;
};
const blobs = Array.from({ length: 9 }, (_, i) => ({
  a: (i / 9) * Math.PI * 2 + rng() * 0.5,
  d: 0.35 + rng() * 0.35,
  s: 0.45 + rng() * 0.3,
}));
for (let f = 0; f < 8; f++) {
  const t = f / 7;
  const R = 22 + t * 34;
  const smoke = Math.max(0, (t - 0.35) / 0.65); // 0 = fire, 1 = smoke
  const alpha = f === 7 ? 0.35 : 1 - smoke * 0.55;
  const core = mix('#fff8d6', '#f2f2f6', smoke);
  const mid = mix('#ffcf3a', '#d9dbe6', smoke);
  const edge = mix('#ff6a1f', '#a9adbf', smoke);
  const line = mix('#d6411a', '#8b90a6', smoke);
  let body = '';
  const g = radial(
    [
      [0, core, 1],
      [0.45, mid, 1],
      [1, edge, 1],
    ],
    '42%',
    '38%',
    '65%',
  );
  // Outline pass then fill pass so overlapping blobs read as one puffy mass.
  for (const pass of ['line', 'fill']) {
    for (const b of blobs) {
      const x = 64 + Math.cos(b.a) * R * b.d;
      const y = 64 + Math.sin(b.a) * R * b.d - smoke * 8;
      const r = R * b.s;
      body +=
        pass === 'line'
          ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(r + 3).toFixed(1)}" fill="${line}"/>`
          : `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${g}"/>`;
    }
    body +=
      pass === 'line'
        ? `<circle cx="64" cy="${64 - smoke * 8}" r="${(R * 0.62 + 3).toFixed(1)}" fill="${line}"/>`
        : `<circle cx="64" cy="${64 - smoke * 8}" r="${(R * 0.62).toFixed(1)}" fill="${g}"/>`;
  }
  // Highlight blobs.
  body += `<circle cx="${(64 - R * 0.25).toFixed(1)}" cy="${(58 - R * 0.25 - smoke * 8).toFixed(1)}" r="${(R * 0.22).toFixed(
    1,
  )}" fill="#ffffff" opacity="${(0.75 * (1 - smoke * 0.6)).toFixed(2)}"/>`;
  cell(4 + f, `<g opacity="${alpha.toFixed(2)}">${body}</g>`);
}

// 12: MINE – hexagonal charge
{
  const hex = (r) => {
    const out = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      out.push(`${(64 + Math.cos(a) * r).toFixed(1)},${(64 + Math.sin(a) * r).toFixed(1)}`);
    }
    return out.join(' ');
  };
  cell(
    12,
    `<circle cx="64" cy="64" r="62" fill="${softGlow(0.4)}"/>
     <polygon points="${hex(40)}" fill="${TINT}" stroke="${DARK}" stroke-width="7" stroke-linejoin="round"/>
     <circle cx="64" cy="64" r="15" fill="${WHITE}"/>`,
  );
}

// 13: WYRM_LOD – distant enemy: rounded body with outline and highlight
cell(
  13,
  `<ellipse cx="64" cy="70" rx="44" ry="30" fill="${TINT}" stroke="${DARK}" stroke-width="7"/>
   <circle cx="64" cy="54" r="26" fill="${TINT}" stroke="${DARK}" stroke-width="7"/>
   <ellipse cx="56" cy="46" rx="9" ry="6" fill="${WHITE}"/>`,
);

// 14: RING – shockwave
cell(
  14,
  `<circle cx="64" cy="64" r="54" fill="none" stroke="${TINT}" stroke-width="10" opacity="0.9"/>
   <circle cx="64" cy="64" r="49" fill="none" stroke="${WHITE}" stroke-width="3" opacity="0.8"/>`,
);

// 15: PUFF – soft cloud puff (tinted, lit from above)
{
  const shade = linear([
    [0, '#d0ffd0', 1],
    [1, '#60dc60', 1],
  ]);
  let puffs = '';
  for (const [x, y, r] of [
    [64, 70, 40],
    [40, 74, 28],
    [88, 74, 28],
    [52, 52, 28],
    [78, 50, 26],
  ]) {
    puffs += `<circle cx="${x}" cy="${y}" r="${r}" fill="${shade}"/>`;
  }
  cell(15, `<g opacity="0.95">${puffs}</g><ellipse cx="54" cy="46" rx="12" ry="7" fill="${WHITE}" opacity="0.7"/>`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<defs>${defs.join('')}</defs>
${cells.join('\n')}
</svg>`;

mkdirSync(dirname(OUT), { recursive: true });
await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(OUT);
console.log(`[bake] wrote ${OUT} (${SIZE}x${SIZE}, ${COLS * COLS} cells)`);
