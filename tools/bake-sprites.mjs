// Offline sprite baker for Nebula Harrier.
// Programmatically synthesises a 4x4 billboard atlas (projectiles, particles,
// explosion flipbook, distant enemy LOD) as SVG and rasterises it with sharp.
// No hand-made assets are involved: every pixel comes from the code below.
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

const defs = [];
const cells = [];
let gradId = 0;

function radial(stops) {
  const id = `g${gradId++}`;
  defs.push(
    `<radialGradient id="${id}" cx="50%" cy="50%" r="50%">${stops
      .map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`)
      .join('')}</radialGradient>`,
  );
  return `url(#${id})`;
}

function cell(index, body) {
  const x = (index % COLS) * CELL;
  const y = Math.floor(index / COLS) * CELL;
  cells.push(`<g transform="translate(${x},${y})">${body}</g>`);
}

function star(points, rOuter, rInner, cx = 64, cy = 64, rot = 0) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = rot + (i * Math.PI) / points;
    pts.push(`${(cx + Math.cos(a) * r).toFixed(2)},${(cy + Math.sin(a) * r).toFixed(2)}`);
  }
  return pts.join(' ');
}

const WHITE_GLOW = () =>
  radial([
    [0, '#ffffff', 1],
    [0.25, '#ffffff', 0.85],
    [0.6, '#ffffff', 0.25],
    [1, '#ffffff', 0],
  ]);

// 0: PLAYER_BOLT – plasma lance: soft halo + bright diamond core (tinted at runtime)
cell(
  0,
  `<circle cx="64" cy="64" r="62" fill="${WHITE_GLOW()}"/>
   <polygon points="64,8 76,64 64,120 52,64" fill="#ffffff" opacity="0.95"/>
   <circle cx="64" cy="64" r="14" fill="#ffffff"/>`,
);

// 1: ENEMY_ORB – hot core with hard ring so hostile shots read clearly
cell(
  1,
  `<circle cx="64" cy="64" r="60" fill="${radial([
    [0, '#ffffff', 0.9],
    [0.5, '#ffffff', 0.35],
    [1, '#ffffff', 0],
  ])}"/>
   <circle cx="64" cy="64" r="30" fill="none" stroke="#ffffff" stroke-width="7"/>
   <circle cx="64" cy="64" r="16" fill="#ffffff"/>`,
);

// 2: ENEMY_NEEDLE – laser segment (long, thin)
cell(
  2,
  `<ellipse cx="64" cy="64" rx="22" ry="62" fill="${WHITE_GLOW()}"/>
   <rect x="58" y="6" width="12" height="116" rx="6" fill="#ffffff"/>`,
);

// 3: SPARK – four-point star
cell(
  3,
  `<circle cx="64" cy="64" r="40" fill="${WHITE_GLOW()}"/>
   <polygon points="${star(4, 62, 7)}" fill="#ffffff"/>`,
);

// 4..11: EXPLOSION flipbook (8 frames), baked in fire colours
for (let f = 0; f < 8; f++) {
  const t = f / 7;
  const r = 18 + t * 44;
  const coreA = Math.max(0, 1 - t * 1.3);
  let shards = '';
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng() * 0.5;
    const d0 = r * (0.35 + rng() * 0.25);
    const d1 = r * (0.85 + rng() * 0.25);
    const w = 0.12 + rng() * 0.1;
    const p = [
      [64 + Math.cos(a - w) * d0, 64 + Math.sin(a - w) * d0],
      [64 + Math.cos(a) * d1, 64 + Math.sin(a) * d1],
      [64 + Math.cos(a + w) * d0, 64 + Math.sin(a + w) * d0],
    ]
      .map((q) => q.map((v) => v.toFixed(1)).join(','))
      .join(' ');
    shards += `<polygon points="${p}" fill="#ffd27a" opacity="${(1 - t).toFixed(2)}"/>`;
  }
  cell(
    4 + f,
    `<circle cx="64" cy="64" r="${r.toFixed(1)}" fill="${radial([
      [0, '#ffffff', coreA],
      [0.3, '#ffb347', 0.9 * (1 - t * 0.6)],
      [0.7, '#ff3d7f', 0.6 * (1 - t * 0.7)],
      [1, '#5b1bff', 0],
    ])}"/>
     <circle cx="64" cy="64" r="${(r * 0.95).toFixed(1)}" fill="none" stroke="#ff7ad9" stroke-width="${(
       4 *
       (1 - t)
     ).toFixed(2)}" opacity="${(0.8 * (1 - t)).toFixed(2)}"/>
     ${shards}`,
  );
}

// 12: MINE – hexagonal antimatter charge
{
  const hex = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    hex.push(`${(64 + Math.cos(a) * 34).toFixed(1)},${(64 + Math.sin(a) * 34).toFixed(1)}`);
  }
  cell(
    12,
    `<circle cx="64" cy="64" r="62" fill="${WHITE_GLOW()}" opacity="0.6"/>
     <polygon points="${hex.join(' ')}" fill="none" stroke="#ffffff" stroke-width="7"/>
     <circle cx="64" cy="64" r="12" fill="#ffffff"/>`,
  );
}

// 13: WYRM_LOD – distant enemy silhouette (chevron glider with glow)
cell(
  13,
  `<circle cx="64" cy="64" r="58" fill="${WHITE_GLOW()}" opacity="0.5"/>
   <polygon points="64,30 104,76 64,62 24,76" fill="#ffffff"/>
   <polygon points="64,62 80,96 64,88 48,96" fill="#ffffff" opacity="0.7"/>`,
);

// 14: RING – shockwave
cell(
  14,
  `<circle cx="64" cy="64" r="54" fill="none" stroke="#ffffff" stroke-width="8" opacity="0.9"/>
   <circle cx="64" cy="64" r="58" fill="none" stroke="#ffffff" stroke-width="3" opacity="0.4"/>`,
);

// 15: SOFT_GLOW – generic round glow for engine jets / streaks
cell(
  15,
  `<circle cx="64" cy="64" r="63" fill="${radial([
    [0, '#ffffff', 1],
    [0.4, '#ffffff', 0.45],
    [1, '#ffffff', 0],
  ])}"/>`,
);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
<defs>${defs.join('')}</defs>
${cells.join('\n')}
</svg>`;

mkdirSync(dirname(OUT), { recursive: true });
await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(OUT);
console.log(`[bake] wrote ${OUT} (${SIZE}x${SIZE}, ${COLS * COLS} cells)`);
