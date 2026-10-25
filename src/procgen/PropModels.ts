import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rb, rockNoise } from './ModelFactory';
import type { PropKind } from './SectorBuilder';

/**
 * One kind of scenery, drawn as two instanced meshes: `a` is the structure
 * (stone, trunk, stem) and `b` the per-instance tinted detail (grass cap,
 * fronds, mushroom cap, topknot). Props in the flight lane are solid: the
 * collision volume is an upright cylinder of `hitW` radius and `hitH` height
 * (in units of the prop's scale).
 */
export interface PropMeshes {
  kind: PropKind;
  a: THREE.InstancedMesh;
  b: THREE.InstancedMesh;
  hitW: number;
  hitH: number;
  /** `a` takes the biome rock colour. */
  rockTint: boolean;
  /** `b` takes the per-instance biome tint (else it keeps its own shading). */
  tintB: boolean;
  /** Faces the camera (stone heads) rather than turning freely. */
  facing: boolean;
}

function finish(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)).map((g) => {
    // Every part needs the same attribute set to merge.
    if (!g.attributes.color) g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(g.attributes.position.count * 3).fill(1), 3));
    if (g.attributes.uv) g.deleteAttribute('uv');
    return g;
  }))!;
  return merged;
}

/** Shades a geometry's vertex colours by a function of position. */
function shade(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number) => number): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const cols: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const v = fn(pos.getX(i), pos.getY(i), pos.getZ(i));
    cols.push(v, v * 0.97, v * 0.93);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  return g;
}

function spireGeometry(H = 6.4, seed = 3.7): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(0.85, 1.4, H, 22, 18);
  geo.translate(0, H / 2, 0);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const cols: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const a = Math.atan2(z, x);
    const n = rockNoise(Math.cos(a) * 2, y * 0.55, Math.sin(a) * 2, seed);
    // Wind-cut ledges: radius steps in and out with height.
    const ledge = 0.06 * Math.sign(Math.sin(y * 1.9)) * Math.min(1, Math.abs(Math.sin(y * 1.9)) * 4);
    const k = 1 + n * 0.22 + ledge;
    const top = y > H - 0.05 ? (n - 0.2) * 0.5 : 0;
    pos.setXYZ(i, x * k, y + top, z * k);
    // Sedimentary bands (grey levels multiply the biome rock colour).
    const band = 0.82 + 0.18 * Math.sin(y * 2.4 + n * 2.0) + 0.08 * n;
    const base = 0.8 + 0.25 * Math.min(1, y / H);
    cols.push(band * base, band * base * 0.97, band * base * 0.93);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  return geo;
}

function boulders(spots: [number, number, number, number][]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const [x, y, z, r] of spots) {
    const g = new THREE.DodecahedronGeometry(r, 0);
    g.scale(1.25, 0.75, 1.05);
    g.rotateY(x * 2 + z);
    g.translate(x, y, z);
    parts.push(g);
  }
  return finish(parts);
}

// --- Rock spire (canyon) ---------------------------------------------------
function spire(): [THREE.BufferGeometry, THREE.BufferGeometry] {
  return [
    spireGeometry(),
    boulders([
      [1.3, 0.25, 0.4, 0.75],
      [-1.1, 0.2, 0.7, 0.6],
      [0.2, 0.15, -1.35, 0.55],
      [-0.6, 0.12, -1.0, 0.4],
    ]),
  ];
}

// --- Sea stack: a tall pillar rising from the surf with a grassy cap --------
function stack(): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const a = spireGeometry(6.4, 5.1);
  a.scale(1.15, 1.5, 1.15);
  a.translate(0, -2, 0);
  const cap = new THREE.DodecahedronGeometry(1.05, 1);
  cap.scale(1.05, 0.32, 1.05);
  cap.translate(0, 7.6, 0);
  const tufts: THREE.BufferGeometry[] = [cap];
  for (let i = 0; i < 4; i++) {
    const t = new THREE.ConeGeometry(0.22, 0.7, 5);
    const ang = i * 1.7;
    t.rotateZ(Math.sin(ang) * 0.4);
    t.translate(Math.cos(ang) * 0.6, 7.95, Math.sin(ang) * 0.6);
    tufts.push(t);
  }
  return [a, finish(tufts)];
}

// --- Palm: a leaning ringed trunk and a crown of drooping fronds -------------
function palm(): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const H = 7;
  const trunk = new THREE.CylinderGeometry(0.17, 0.28, H, 10, 24);
  trunk.translate(0, H / 2, 0);
  const pos = trunk.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    pos.setX(i, pos.getX(i) + 0.02 * y * y);
  }
  trunk.computeVertexNormals();
  shade(trunk, (_x, y) => 0.75 + 0.25 * Math.abs(Math.sin(y * 7.5)));
  const nuts: THREE.BufferGeometry[] = [trunk];
  const topX = 0.02 * H * H;
  for (let i = 0; i < 3; i++) {
    const n = new THREE.SphereGeometry(0.17, 8, 6);
    n.translate(topX + Math.cos(i * 2.1) * 0.22, H - 0.25, Math.sin(i * 2.1) * 0.22);
    shade(n, () => 0.5);
    nuts.push(n);
  }
  const fronds: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) {
    const f = new THREE.BoxGeometry(3.2, 0.05, 0.7, 12, 1, 2);
    const fp = f.attributes.position as THREE.BufferAttribute;
    for (let k = 0; k < fp.count; k++) {
      const x = fp.getX(k) + 1.6; // 0 .. 3.2 from the crown
      const t = x / 3.2;
      fp.setXYZ(k, x, fp.getY(k) + 0.55 * x - 0.32 * x * x, fp.getZ(k) * (1 - t * 0.85) * (1 + 0.3 * Math.sin(t * Math.PI)));
    }
    f.computeVertexNormals();
    f.rotateY((i / 8) * Math.PI * 2 + (i % 2) * 0.2);
    f.translate(topX, H, 0);
    fronds.push(f);
  }
  return [finish(nuts), finish(fronds)];
}

// --- Giant mushroom: pale stem, gills, a domed cap with white spots ---------
function shroom(): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const stem = new THREE.CylinderGeometry(0.45, 0.7, 5.2, 16, 8);
  stem.translate(0, 2.6, 0);
  const sp = stem.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < sp.count; i++) {
    const y = sp.getY(i);
    const k = 1 + 0.35 * Math.max(0, 1 - y / 1.2) + 0.05 * Math.sin(y * 3);
    sp.setX(i, sp.getX(i) * k);
    sp.setZ(i, sp.getZ(i) * k);
  }
  stem.computeVertexNormals();
  shade(stem, (_x, y) => 0.85 + 0.1 * Math.sin(y * 4));
  const ring = new THREE.TorusGeometry(0.62, 0.1, 6, 18);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, 3.9, 0);
  const gills = new THREE.CylinderGeometry(2.3, 0.45, 0.4, 28, 1, true);
  gills.translate(0, 4.95, 0);
  shade(gills, () => 0.7);
  const parts: THREE.BufferGeometry[] = [stem, ring, gills];
  // White spots sitting on the cap surface.
  for (let i = 0; i < 9; i++) {
    const a = i * 2.4;
    const p = 0.35 + (i % 3) * 0.32;
    const s = new THREE.SphereGeometry(0.28 - (i % 3) * 0.05, 8, 6);
    s.scale(1, 0.4, 1);
    s.translate(Math.sin(p) * Math.cos(a) * 2.42, 5.1 + Math.cos(p) * 2.42 * 0.55, Math.sin(p) * Math.sin(a) * 2.42);
    shade(s, () => 1.25);
    parts.push(s);
  }
  const cap = new THREE.SphereGeometry(2.4, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.scale(1, 0.55, 1);
  cap.translate(0, 5.1, 0);
  shade(cap, (_x, y) => 0.75 + 0.3 * Math.min(1, (y - 5.1) / 1.3));
  return [finish(parts), finish([cap])];
}

// --- Ionic column: plinth, fluted shaft, scrolled capital ---------------------
function column(): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const shaft = new THREE.CylinderGeometry(0.52, 0.6, 7, 48, 6);
  shaft.translate(0, 0.6 + 3.5, 0);
  const p = shaft.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const a = Math.atan2(p.getZ(i), p.getX(i));
    const k = 1 - 0.05 * Math.pow(0.5 + 0.5 * Math.cos(a * 12), 2);
    p.setX(i, p.getX(i) * k);
    p.setZ(i, p.getZ(i) * k);
  }
  shaft.computeVertexNormals();
  shade(shaft, (x, y, z) => 0.85 + 0.1 * rockNoise(x * 2, y * 0.8, z * 2, 1.3));
  const parts: THREE.BufferGeometry[] = [shaft];
  const plinth = rb(1.6, 0.4, 1.6, 0.04);
  plinth.translate(0, 0.2, 0);
  const torus = new THREE.TorusGeometry(0.62, 0.12, 8, 28);
  torus.rotateX(Math.PI / 2);
  torus.translate(0, 0.5, 0);
  const neck = new THREE.TorusGeometry(0.55, 0.08, 8, 28);
  neck.rotateX(Math.PI / 2);
  neck.translate(0, 7.62, 0);
  const abacus = rb(1.6, 0.28, 1.6, 0.04);
  abacus.translate(0, 8.0, 0);
  parts.push(plinth, torus, neck, abacus);
  for (const s of [-1, 1]) {
    const v = new THREE.CylinderGeometry(0.28, 0.28, 1.5, 16);
    v.rotateX(Math.PI / 2);
    v.translate(s * 0.62, 7.78, 0);
    parts.push(v);
  }
  for (const g of parts) if (!g.attributes.color) shade(g, () => 0.92);
  const rubble = boulders([
    [1.2, 0.2, 0.6, 0.45],
    [-1.0, 0.18, -0.5, 0.38],
  ]);
  return [finish(parts), rubble];
}

// --- Stone head: a long-faced monolith with a red topknot -------------------
function moai(): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0) => {
    g.rotateX(rx);
    g.translate(x, y, z);
    parts.push(g);
  };
  add(rb(2.4, 0.9, 1.5, 0.3), 0, 0.45, 0);
  add(rb(1.6, 3.3, 1.3, 0.35), 0, 2.45, 0);
  add(rb(1.75, 0.38, 0.5, 0.15), 0, 3.35, 0.55);
  add(rb(0.42, 1.35, 0.55, 0.15), 0, 2.55, 0.72, -0.12);
  add(rb(0.5, 0.18, 0.45, 0.08), 0, 1.9, 0.8);
  add(rb(1.0, 0.16, 0.25, 0.06), 0, 1.62, 0.66);
  add(rb(1.35, 0.55, 1.1, 0.2), 0, 1.25, 0.2);
  for (const s of [-1, 1]) {
    add(rb(0.22, 1.2, 0.45, 0.08), s * 0.86, 2.7, -0.05);
    // Deep-set eye hollows.
    const e = rb(0.45, 0.22, 0.12, 0.05);
    shade(e, () => 0.35);
    add(e, s * 0.4, 3.08, 0.66);
  }
  for (const g of parts) if (!g.attributes.color) shade(g, (x, y, z) => 0.78 + 0.18 * rockNoise(x * 3, y * 2, z * 3, 7.1));
  const hat = new THREE.CylinderGeometry(0.72, 0.8, 0.7, 18);
  hat.translate(0, 4.45, -0.05);
  return [finish(parts), finish([hat])];
}

// --- Basalt: a cluster of hexagonal columns ----------------------------------
function basalt(): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const parts: THREE.BufferGeometry[] = [];
  const cols: [number, number, number][] = [
    [0, 0, 6.2],
    [0.78, 0.2, 4.8],
    [-0.7, 0.35, 5.4],
    [0.3, -0.78, 3.6],
    [-0.45, -0.7, 4.2],
    [0.9, -0.6, 2.4],
    [-1.1, -0.2, 2.8],
  ];
  for (const [x, z, h] of cols) {
    const c = new THREE.CylinderGeometry(0.44, 0.46, h, 6);
    c.translate(x, h / 2, z);
    shade(c, (_x, y) => 0.6 + 0.4 * Math.min(1, y / 6) + (y > h - 0.05 ? 0.25 : 0));
    parts.push(c);
  }
  return [
    finish(parts),
    boulders([
      [1.4, 0.2, 0.5, 0.5],
      [-1.5, 0.18, 0.8, 0.42],
      [0.2, 0.15, 1.3, 0.38],
    ]),
  ];
}

const DEFS: Record<PropKind, { build: () => [THREE.BufferGeometry, THREE.BufferGeometry]; a: number; hitW: number; hitH: number; rockTint: boolean; facing: boolean; flatB: boolean; tintB?: boolean }> = {
  spire: { build: spire, a: 0xa7835a, hitW: 1.0, hitH: 6.3, rockTint: true, facing: false, flatB: true },
  stack: { build: stack, a: 0x6e6660, hitW: 1.25, hitH: 7.6, rockTint: true, facing: false, flatB: true },
  palm: { build: palm, a: 0x8a6a4a, hitW: 0.45, hitH: 7.0, rockTint: false, facing: false, flatB: false },
  shroom: { build: shroom, a: 0xeee0cc, hitW: 0.8, hitH: 6.4, rockTint: false, facing: false, flatB: false },
  column: { build: column, a: 0xdcd2c0, hitW: 0.8, hitH: 8.1, rockTint: false, facing: false, flatB: true, tintB: false },
  moai: { build: moai, a: 0x8a8278, hitW: 1.2, hitH: 4.8, rockTint: false, facing: true, flatB: false },
  basalt: { build: basalt, a: 0x2e2a28, hitW: 1.2, hitH: 6.0, rockTint: true, facing: false, flatB: true },
};

/** Builds every scenery kind as an instanced pair. */
export function createPropMeshes(capacity: number): PropMeshes[] {
  return (Object.keys(DEFS) as PropKind[]).map((kind) => {
    const d = DEFS[kind];
    const [ga, gb] = d.build();
    const matA = new THREE.MeshStandardMaterial({ color: d.a, vertexColors: true, roughness: 0.92, metalness: 0 });
    const matB = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.8, metalness: 0, flatShading: d.flatB });
    const a = new THREE.InstancedMesh(ga, matA, capacity);
    const b = new THREE.InstancedMesh(gb, matB, capacity);
    for (const m of [a, b]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.visible = false;
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
    }
    b.setColorAt(0, new THREE.Color(1, 1, 1));
    b.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    return { kind, a, b, hitW: d.hitW, hitH: d.hitH, rockTint: d.rockTint, tintB: d.tintB ?? true, facing: d.facing };
  });
}
