import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ellipsoid, mesh, plate, rb } from './ModelFactory';
import { createInstancedHullMaterial, createSurfaceMaterial, type SurfaceMaterial } from './Shaders';
import type { BossKind } from './SectorBuilder';

// Every creature faces +Z in model space (toward the camera when charging).

const BONE = 0xe6dcc4;

// ---------------------------------------------------------------------------
// Instanced swarm geometry. `aTint` picks hide (0), markings (1) or glowing
// eyes (2); see createInstancedHullMaterial.
// ---------------------------------------------------------------------------
function tinted(geo: THREE.BufferGeometry, tint: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g.attributes.uv) g.deleteAttribute('uv');
  g.setAttribute('aTint', new THREE.Float32BufferAttribute(new Array(g.attributes.position.count).fill(tint), 1));
  return g;
}

function at(geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  geo.rotateX(rx);
  geo.rotateY(ry);
  geo.rotateZ(rz);
  geo.translate(x, y, z);
  return geo;
}

/** Outline in XY laid flat into the XZ plane (outline +y points to -z, i.e. backward). */
const flat = (pts: [number, number][], depth = 0.05) => plate(pts, depth).rotateX(-Math.PI / 2);
/** Outline in XY stood up in the YZ plane (outline +x points to +z, forward). */
const upright = (pts: [number, number][], depth = 0.05) => plate(pts, depth).rotateY(-Math.PI / 2);

/** A tapered rod between two points. */
function rod(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1 = r0): THREE.BufferGeometry {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.CylinderGeometry(r1, r0, d.length(), 8);
  g.translate(0, d.length() / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate(a.x, a.y, a.z);
  return g;
}

/** Mirror image across X with the triangle winding restored. */
function mirrorX(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = (src.index ? src.toNonIndexed() : src.clone()).scale(-1, 1, 1);
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name] as THREE.BufferAttribute;
    const n = a.itemSize;
    for (let t = 0; t < a.count; t += 3) {
      for (let k = 0; k < n; k++) {
        const v1 = a.array[(t + 1) * n + k];
        (a.array as Float32Array)[(t + 1) * n + k] = a.array[(t + 2) * n + k];
        (a.array as Float32Array)[(t + 2) * n + k] = v1;
      }
    }
  }
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)))!;
}

function instanced(geo: THREE.BufferGeometry, capacity: number, side: THREE.Side = THREE.FrontSide): THREE.InstancedMesh {
  const mat = createInstancedHullMaterial(0x4a4a44);
  mat.side = side;
  const m = new THREE.InstancedMesh(geo, mat, capacity);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.setColorAt(0, new THREE.Color(1, 1, 1));
  m.instanceColor!.setUsage(THREE.DynamicDrawUsage);
  m.count = 0;
  m.frustumCulled = false;
  m.castShadow = true;
  return m;
}

export interface SwarmMeshes {
  /** Razorwing torso + head; wings are separate so they can flap. */
  flockBody: THREE.InstancedMesh;
  wingL: THREE.InstancedMesh;
  wingR: THREE.InstancedMesh;
  /** Leaping spinefish. */
  leaper: THREE.InstancedMesh;
  /** Body segment of the sky / sea serpents. */
  segment: THREE.InstancedMesh;
}

/** Razorwing: a leathery, beaked flyer (wings pivot at x = 0). */
function razorwingBody(): THREE.BufferGeometry {
  return merge([
    tinted(ellipsoid(0.42, 0.36, 0.8), 0),
    tinted(at(ellipsoid(0.34, 0.24, 0.66), 0, -0.13, 0.05), 1),
    tinted(at(ellipsoid(0.3, 0.27, 0.34), 0, 0.1, 0.78), 0),
    tinted(at(new THREE.ConeGeometry(0.13, 0.55, 8), 0, 0.02, 1.25, Math.PI / 2), 1),
    tinted(at(new THREE.SphereGeometry(0.075, 8, 6), 0.15, 0.18, 0.98), 2),
    tinted(at(new THREE.SphereGeometry(0.075, 8, 6), -0.15, 0.18, 0.98), 2),
    tinted(at(upright([[0.3, 0], [-0.55, 0.12], [-0.25, 0.42]], 0.06), 0, 0.28, 0.72), 1),
    tinted(at(new THREE.ConeGeometry(0.18, 1.0, 8), 0, 0.05, -1.05, -Math.PI / 2), 0),
    tinted(at(flat([[-0.45, 0], [0, -0.1], [0.45, 0], [0, 0.45]], 0.04), 0, 0.05, -1.55), 1),
  ]);
}

function razorwingWing(): THREE.BufferGeometry {
  const membrane = flat([
    [0, -0.32],
    [0.9, -0.45],
    [2.05, 0.1],
    [1.55, 0.3],
    [1.35, 0.15],
    [0.95, 0.62],
    [0.55, 0.42],
    [0, 0.5],
  ], 0.04);
  const v = (x: number, z: number) => new THREE.Vector3(x, 0.02, z);
  return merge([
    tinted(membrane, 1),
    tinted(rod(v(0, 0.32), v(0.9, 0.45), 0.07, 0.06), 0),
    tinted(rod(v(0.9, 0.45), v(2.05, -0.1), 0.06, 0.02), 0),
  ]);
}

function leaperGeometry(): THREE.BufferGeometry {
  const fin = flat([[0.15, -0.45], [1.6, -0.1], [1.45, 0.32], [0.15, 0.18]], 0.04);
  const finL = tinted(at(fin, 0, 0.02, 0.2), 1);
  return merge([
    tinted(ellipsoid(0.3, 0.36, 1.05), 0),
    tinted(at(ellipsoid(0.24, 0.22, 0.9), 0, -0.13, 0.05), 1),
    tinted(at(new THREE.SphereGeometry(0.085, 8, 6), 0.2, 0.1, 0.7), 2),
    tinted(at(new THREE.SphereGeometry(0.085, 8, 6), -0.2, 0.1, 0.7), 2),
    finL,
    mirrorX(finL),
    tinted(upright([[-0.85, 0], [-1.65, 0.6], [-1.35, 0], [-1.65, -0.55]], 0.06), 1),
    tinted(upright([[0.3, 0.3], [-0.4, 0.78], [-0.6, 0.28]], 0.05), 1),
  ]);
}

function segmentGeometry(): THREE.BufferGeometry {
  return merge([
    tinted(ellipsoid(0.9, 0.8, 0.88), 0),
    tinted(at(ellipsoid(0.74, 0.5, 0.76), 0, -0.34, 0.02), 1),
    tinted(at(upright([[0.45, 0], [-0.25, 0.75], [-0.5, 0]], 0.07), 0, 0.68, 0), 1),
    tinted(at(new THREE.ConeGeometry(0.14, 0.5, 6), 0.85, 0.1, 0, 0, 0, -Math.PI / 2), 1),
    tinted(at(new THREE.ConeGeometry(0.14, 0.5, 6), -0.85, 0.1, 0, 0, 0, Math.PI / 2), 1),
  ]);
}

export function createSwarmMeshes(): SwarmMeshes {
  const wing = razorwingWing();
  return {
    flockBody: instanced(razorwingBody(), 256),
    wingL: instanced(wing, 256),
    wingR: instanced(mirrorX(wing), 256),
    leaper: instanced(leaperGeometry(), 128),
    segment: instanced(segmentGeometry(), 384),
  };
}

// ---------------------------------------------------------------------------
// Individual creature models
// ---------------------------------------------------------------------------
interface CreaturePalette {
  hide: SurfaceMaterial;
  marking: SurfaceMaterial;
  glow: SurfaceMaterial;
  bone: SurfaceMaterial;
}

function creaturePalette(hide: number, marking: number, glowMarkings = false): CreaturePalette {
  return {
    hide: createSurfaceMaterial({ color: hide, roughness: 0.72, rim: marking, rimStrength: 0.35 }),
    marking: createSurfaceMaterial({ color: marking, roughness: 0.55, emissive: glowMarkings ? 0.45 : 0 }),
    glow: createSurfaceMaterial({ color: marking, emissive: 1, roughness: 0.2 }),
    bone: createSurfaceMaterial({ color: BONE, roughness: 0.5 }),
  };
}

export interface HeadModel {
  root: THREE.Group;
  jaw: THREE.Group;
  /** Where breath and bolts leave the mouth. */
  mouth: THREE.Object3D;
}

/** Reptilian head: long snout, hinged jaw, glowing eyes and maw, optional horns and frills. */
function buildHead(p: CreaturePalette, opts: { horns?: boolean; frill?: boolean; antennae?: boolean }): HeadModel {
  const root = new THREE.Group();
  mesh(ellipsoid(0.85, 0.68, 1.05), p.hide, root);
  mesh(ellipsoid(0.58, 0.4, 0.82), p.hide, root, 0, -0.04, 0.92);
  mesh(ellipsoid(0.5, 0.2, 0.7), p.marking, root, 0, 0.32, 0.55);
  for (const s of [-1, 1]) {
    const eye = mesh(new THREE.SphereGeometry(0.15, 12, 8), p.glow, root, s * 0.5, 0.28, 0.62);
    eye.castShadow = false;
    mesh(rb(0.45, 0.12, 0.3, 0.05), p.hide, root, s * 0.45, 0.43, 0.58, 0, 0, s * -0.3);
    for (let i = 0; i < 4; i++) mesh(new THREE.ConeGeometry(0.05, 0.2, 5), p.bone, root, s * (0.38 - i * 0.04), -0.32, 0.6 + i * 0.28, Math.PI);
    if (opts.horns) mesh(new THREE.ConeGeometry(0.17, 1.4, 8), p.bone, root, s * 0.45, 0.55, -0.55, -2.0, 0, s * -0.25);
    if (opts.frill) mesh(flat([[0, -0.3], [1.1, 0.2], [0.9, 0.6], [0.4, 0.5], [0, 0.45]], 0.05), p.marking, root, s * 0.6, 0.05, -0.35, 0, 0, s * 0.5).scale.x = s;
    if (opts.antennae) mesh(new THREE.CylinderGeometry(0.03, 0.05, 1.6, 6), p.bone, root, s * 0.3, 0.9, 0.5, 0.6, 0, s * -0.3);
  }
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.3, 0.1);
  root.add(jaw);
  mesh(ellipsoid(0.52, 0.22, 0.95), p.hide, jaw, 0, -0.08, 0.75);
  mesh(ellipsoid(0.4, 0.14, 0.8), p.marking, jaw, 0, -0.18, 0.7);
  const maw = mesh(new THREE.SphereGeometry(0.28, 14, 10), p.glow, root, 0, -0.28, 1.1);
  maw.castShadow = false;
  const mouth = new THREE.Object3D();
  mouth.position.set(0, -0.3, 1.6);
  root.add(mouth);
  return { root, jaw, mouth };
}

export interface SerpentHeadModel extends HeadModel {
  materials: SurfaceMaterial[];
}

export function createSerpentHeadModel(hide: number, marking: number, aquatic: boolean): SerpentHeadModel {
  const p = creaturePalette(hide, marking);
  const h = buildHead(p, { horns: !aquatic, frill: aquatic });
  return { ...h, materials: [p.hide, p.marking, p.glow, p.bone] };
}

// --- Hydra stalk: a long neck rising from a burrow, spitting from a frilled head.
export interface StalkModel {
  root: THREE.Group;
  neck: THREE.Group[];
  head: HeadModel;
  materials: SurfaceMaterial[];
}

export function createStalkModel(hide: number, marking: number): StalkModel {
  const p = creaturePalette(hide, marking);
  const root = new THREE.Group();
  // Burrow mound / churned water ring at the base.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const m = mesh(new THREE.DodecahedronGeometry(0.6, 0), p.hide, root, Math.cos(a) * 1.1, 0.1, Math.sin(a) * 1.1);
    m.scale.set(1.2, 0.55, 1);
  }
  const neck: THREE.Group[] = [];
  let parent: THREE.Object3D = root;
  for (let i = 0; i < 6; i++) {
    const g = new THREE.Group();
    g.position.y = i === 0 ? 0.2 : 0.78;
    parent.add(g);
    const r = 0.62 - i * 0.05;
    mesh(ellipsoid(r, 0.52, r), p.hide, g, 0, 0.39, 0);
    mesh(ellipsoid(r * 0.75, 0.42, 0.2), p.marking, g, 0, 0.39, r * 0.82);
    mesh(new THREE.ConeGeometry(0.1, 0.4, 6), p.bone, g, 0, 0.5, -r * 0.95, -1.2);
    neck.push(g);
    parent = g;
  }
  const head = buildHead(p, { frill: true });
  head.root.position.y = 1.0;
  head.root.scale.setScalar(0.9);
  parent.add(head.root);
  // Crest fan behind the head.
  mesh(plate([[-1.1, 0], [-0.9, 0.7], [-0.35, 1.15], [0.35, 1.15], [0.9, 0.7], [1.1, 0]], 0.05), p.marking, head.root, 0, 0.25, -0.55, -0.35);
  return { root, neck, head, materials: [p.hide, p.marking, p.glow, p.bone] };
}

// --- One-eyed mammoth: shaggy, tusked and armoured with bony plates. -----------
export interface MammothModel {
  root: THREE.Group;
  head: THREE.Group;
  trunk: THREE.Group[];
  /** Hip pivots: front-left, front-right, back-left, back-right. */
  legs: THREE.Group[];
  knees: THREE.Group[];
  /** Breakable armour: two tusks, the brow plate and two shoulder plates. */
  parts: THREE.Mesh[];
  partMats: SurfaceMaterial[];
  eye: SurfaceMaterial;
  mouth: THREE.Object3D;
  materials: SurfaceMaterial[];
}

export function createMammothModel(hide: number, marking: number): MammothModel {
  const p = creaturePalette(hide, marking);
  const fur = createSurfaceMaterial({ color: new THREE.Color(hide).multiplyScalar(0.7).getHex(), roughness: 0.95, flatShading: true });
  const root = new THREE.Group();
  mesh(ellipsoid(1.9, 1.7, 2.6, 24, 16), p.hide, root, 0, 4.3, 0);
  mesh(ellipsoid(1.5, 1.2, 1.4), p.hide, root, 0, 5.3, 1.0);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const m = mesh(new THREE.DodecahedronGeometry(0.75, 0), fur, root, Math.cos(a) * 1.75, 3.2 + (i % 2) * 0.25, Math.sin(a) * 2.3);
    m.scale.set(0.8, 1.3, 0.8);
  }
  for (let i = 0; i < 5; i++) mesh(new THREE.ConeGeometry(0.25, 0.9, 6), p.bone, root, 0, 5.9 - i * 0.15, 0.6 - i * 0.7, -0.6);
  mesh(new THREE.CylinderGeometry(0.08, 0.2, 1.4, 6), p.hide, root, 0, 4.2, -2.8, -2.4);

  const legs: THREE.Group[] = [];
  const knees: THREE.Group[] = [];
  for (const [x, z] of [
    [-1.15, 1.4],
    [1.15, 1.4],
    [-1.15, -1.5],
    [1.15, -1.5],
  ]) {
    const hip = new THREE.Group();
    hip.position.set(x, 3.3, z);
    root.add(hip);
    mesh(new THREE.CylinderGeometry(0.62, 0.52, 1.7, 12), p.hide, hip, 0, -0.85, 0);
    mesh(new THREE.DodecahedronGeometry(0.62, 0), fur, hip, 0, -0.2, 0).scale.set(1, 1.2, 1);
    const knee = new THREE.Group();
    knee.position.y = -1.7;
    hip.add(knee);
    mesh(new THREE.CylinderGeometry(0.5, 0.58, 1.45, 12), p.hide, knee, 0, -0.72, 0);
    mesh(new THREE.CylinderGeometry(0.66, 0.7, 0.22, 12), p.bone, knee, 0, -1.48, 0.05);
    legs.push(hip);
    knees.push(knee);
  }

  const head = new THREE.Group();
  head.position.set(0, 4.9, 2.5);
  root.add(head);
  mesh(ellipsoid(1.2, 1.25, 1.1), p.hide, head);
  mesh(ellipsoid(0.95, 0.8, 0.9), p.hide, head, 0, 0.85, -0.1);
  for (const s of [-1, 1]) {
    const ear = mesh(ellipsoid(0.95, 1.05, 0.14), p.hide, head, s * 1.15, 0.05, -0.25, 0, s * 0.5, s * 0.2);
    ear.castShadow = true;
  }
  // The single great eye.
  mesh(new THREE.TorusGeometry(0.46, 0.12, 10, 24), p.hide, head, 0, 0.3, 1.0);
  const eye = createSurfaceMaterial({ color: marking, emissive: 1, roughness: 0.15 });
  const eyeBall = mesh(new THREE.SphereGeometry(0.42, 20, 14), eye, head, 0, 0.3, 0.92);
  eyeBall.scale.z = 0.6;
  eyeBall.castShadow = false;
  mesh(new THREE.SphereGeometry(0.16, 12, 8), createSurfaceMaterial({ color: 0x120c0a, roughness: 0.2 }), head, 0, 0.3, 1.15);
  const mouth = new THREE.Object3D();
  mouth.position.set(0, -0.4, 1.6);
  head.add(mouth);

  // Trunk: a hanging chain that sways.
  const trunk: THREE.Group[] = [];
  let parent: THREE.Object3D = head;
  for (let i = 0; i < 6; i++) {
    const g = new THREE.Group();
    g.position.set(0, i === 0 ? -0.4 : -0.55, i === 0 ? 1.0 : 0);
    g.rotation.x = i === 0 ? 0.5 : 0.18;
    parent.add(g);
    const r = 0.42 - i * 0.05;
    mesh(new THREE.CylinderGeometry(r, r * 1.1, 0.62, 10), p.hide, g, 0, -0.27, 0);
    trunk.push(g);
    parent = g;
  }

  const partMats: SurfaceMaterial[] = [];
  const parts: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(s * 0.55, -0.55, 0.75),
      new THREE.Vector3(s * 0.95, -1.6, 1.9),
      new THREE.Vector3(s * 0.75, -1.35, 3.0),
      new THREE.Vector3(s * 0.25, -0.55, 3.35),
    ]);
    const tube = new THREE.TubeGeometry(curve, 24, 0.2, 10);
    // Taper toward the tip.
    const pos = tube.attributes.position as THREE.BufferAttribute;
    const pt = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const t = Math.floor(i / 11) / 24;
      curve.getPoint(t, pt);
      const k = 1 - t * 0.75;
      pos.setXYZ(i, pt.x + (pos.getX(i) - pt.x) * k, pt.y + (pos.getY(i) - pt.y) * k, pt.z + (pos.getZ(i) - pt.z) * k);
    }
    tube.computeVertexNormals();
    const m = createSurfaceMaterial({ color: BONE, roughness: 0.4 });
    parts.push(mesh(tube, m, head));
    partMats.push(m);
  }
  const browMat = createSurfaceMaterial({ color: BONE, roughness: 0.55, flatShading: true });
  parts.push(mesh(rb(1.7, 0.5, 0.7, 0.15), browMat, head, 0, 0.95, 0.75, 0.5));
  partMats.push(browMat);
  for (const s of [-1, 1]) {
    const m = createSurfaceMaterial({ color: BONE, roughness: 0.55, flatShading: true });
    parts.push(mesh(rb(1.3, 0.45, 1.6, 0.15), m, root, s * 1.35, 5.3, 1.3, 0, 0, s * -0.55));
    partMats.push(m);
  }
  return { root, head, trunk, legs, knees, parts, partMats, eye, mouth, materials: [p.hide, p.marking, p.glow, p.bone, fur, eye] };
}

// ---------------------------------------------------------------------------
// Bosses
// ---------------------------------------------------------------------------
export interface BeastBossModel {
  head: HeadModel;
  /** Body segments in order from the neck back; each is its own group. */
  segments: THREE.Group[];
  /** Wing pivots (left, right) on the shoulders, if any. */
  wings: THREE.Group[];
  /** Leg pivots per segment (crawler). */
  legs: THREE.Group[];
  segRadius: number;
  materials: SurfaceMaterial[];
}

export const BOSS_SEGMENTS = 13;

/** Giant segmented beasts in the Space Harrier mould, dressed per biome. */
export function createBeastBossModel(kind: Exclude<BossKind, 'stonehead'>, hide: number, marking: number): BeastBossModel {
  const p = creaturePalette(hide, marking, kind === 'firedrake');
  const head = buildHead(p, {
    horns: kind !== 'leviathan' && kind !== 'crawler',
    frill: kind === 'leviathan' || kind === 'firedrake',
    antennae: kind === 'crawler',
  });
  head.root.scale.setScalar(2.4);
  const R = 1.55;
  const segGeo = ellipsoid(R, R * 0.9, R * 0.95, 22, 14);
  const bellyGeo = ellipsoid(R * 0.8, R * 0.55, R * 0.85);
  const segments: THREE.Group[] = [];
  const legs: THREE.Group[] = [];
  for (let i = 0; i < BOSS_SEGMENTS; i++) {
    const g = new THREE.Group();
    const s = 1 - (i / BOSS_SEGMENTS) * 0.55;
    g.scale.setScalar(s);
    mesh(segGeo, p.hide, g);
    mesh(bellyGeo, p.marking, g, 0, -R * 0.4, 0.05);
    switch (kind) {
      case 'leviathan':
        mesh(upright([[0.8, 0], [-0.4, 1.4], [-1.0, 0]], 0.08), p.marking, g, 0, R * 0.8, 0);
        if (i % 3 === 1) for (const sd of [-1, 1]) mesh(flat([[0, -0.4], [1.6, 0.3], [0, 0.6]], 0.06), p.marking, g, sd * R * 0.85, -0.2, 0).scale.x = sd;
        break;
      case 'crawler':
        mesh(rb(R * 1.7, 0.35, R * 1.4, 0.15), p.marking, g, 0, R * 0.78, 0, 0.1);
        for (const sd of [-1, 1]) {
          const hip = new THREE.Group();
          hip.position.set(sd * R * 0.8, -R * 0.3, 0);
          g.add(hip);
          mesh(new THREE.CylinderGeometry(0.16, 0.24, 1.8, 8), p.hide, hip, sd * 0.6, -0.6, 0, 0, 0, sd * 0.9);
          mesh(new THREE.ConeGeometry(0.16, 1.1, 8), p.bone, hip, sd * 1.25, -1.6, 0, Math.PI, 0, -sd * 0.2);
          legs.push(hip);
        }
        break;
      case 'serpent':
        mesh(rb(R * 0.9, 0.3, R * 1.2, 0.1), p.bone, g, 0, R * 0.85, 0, 0.15);
        for (const sd of [-1, 1]) mesh(new THREE.ConeGeometry(0.2, 0.8, 6), p.bone, g, sd * R * 0.9, R * 0.3, 0, 0, 0, -sd * 1.2);
        break;
      case 'wyvern':
      case 'firedrake':
        for (let k = 0; k < 2; k++) mesh(new THREE.ConeGeometry(0.28, 1.1, 6), kind === 'firedrake' ? p.marking : p.bone, g, 0, R * 0.95, (k - 0.5) * 0.9, -0.5);
        break;
    }
    segments.push(g);
  }
  const wings: THREE.Group[] = [];
  if (kind === 'wyvern' || kind === 'firedrake') {
    const outline: [number, number][] = [
      [0, -1.0],
      [3.2, -1.6],
      [7.5, -0.4],
      [6.2, 0.8],
      [5.0, 0.4],
      [4.0, 1.8],
      [2.6, 1.0],
      [1.4, 2.0],
      [0, 1.2],
    ];
    for (const sd of [-1, 1]) {
      const w = new THREE.Group();
      w.position.set(sd * R * 0.8, R * 0.5, 0);
      segments[1].add(w);
      const m = mesh(flat(outline, 0.08), p.marking, w);
      m.scale.x = sd;
      (m.material as THREE.Material).side = THREE.DoubleSide;
      mesh(rod(new THREE.Vector3(0, 0, 1.0), new THREE.Vector3(sd * 3.2, 0, 1.6), 0.28, 0.2), p.hide, w);
      mesh(rod(new THREE.Vector3(sd * 3.2, 0, 1.6), new THREE.Vector3(sd * 7.5, 0, 0.4), 0.2, 0.06), p.hide, w);
      wings.push(w);
    }
  }
  return { head, segments, wings, legs, segRadius: R, materials: [p.hide, p.marking, p.glow, p.bone] };
}

/** The Elder Idol: a vast floating stone head ringed by four rune-stones. */
export interface IdolModel {
  root: THREE.Group;
  jaw: THREE.Group;
  mouth: THREE.Object3D;
  eyes: SurfaceMaterial;
  stoneMat: SurfaceMaterial;
  /** Orbiting rune-stone pivots (each holds one breakable stone). */
  orbit: THREE.Group;
  runes: THREE.Mesh[];
  runeMats: SurfaceMaterial[];
  /** Glowing fissures revealed as it cracks. */
  cracks: THREE.Mesh[];
  materials: SurfaceMaterial[];
}

export function createIdolModel(glowColor: number): IdolModel {
  const stone = createSurfaceMaterial({ color: 0x8a8274, roughness: 0.9, flatShading: true, rim: 0xffd2a8, rimStrength: 0.25 });
  const dark = createSurfaceMaterial({ color: 0x2a2622, roughness: 0.9 });
  const red = createSurfaceMaterial({ color: 0x8a3226, roughness: 0.85, flatShading: true });
  const eyes = createSurfaceMaterial({ color: glowColor, emissive: 1, roughness: 0.2 });
  const root = new THREE.Group();
  mesh(rb(4.6, 7.2, 3.8, 0.6), stone, root, 0, 0, 0);
  mesh(rb(5.0, 1.0, 1.4, 0.35), stone, root, 0, 1.9, 1.7);
  mesh(rb(1.2, 3.2, 1.5, 0.35), stone, root, 0, 0.1, 2.1, -0.12);
  mesh(rb(1.3, 0.4, 1.2, 0.15), stone, root, 0, -1.45, 2.4);
  for (const s of [-1, 1]) {
    mesh(rb(0.6, 3.0, 1.2, 0.2), stone, root, s * 2.5, 0.4, -0.2);
    mesh(rb(1.3, 0.6, 0.3, 0.15), dark, root, s * 1.15, 1.1, 1.92);
    const e = mesh(new THREE.SphereGeometry(0.38, 16, 10), eyes, root, s * 1.15, 1.1, 1.95);
    e.scale.set(1.4, 0.7, 0.5);
    e.castShadow = false;
  }
  mesh(new THREE.CylinderGeometry(2.0, 2.2, 1.8, 18), red, root, 0, 4.4, -0.2);
  const jaw = new THREE.Group();
  jaw.position.set(0, -2.6, 1.0);
  root.add(jaw);
  mesh(rb(3.6, 1.6, 2.6, 0.45), stone, jaw, 0, -0.6, 0.2);
  mesh(rb(2.4, 0.35, 0.5, 0.12), stone, jaw, 0, 0.1, 1.45);
  const maw = mesh(rb(2.2, 0.5, 0.4, 0.15), eyes, root, 0, -2.3, 1.75);
  maw.castShadow = false;
  const mouth = new THREE.Object3D();
  mouth.position.set(0, -2.5, 2.6);
  root.add(mouth);
  const cracks: THREE.Mesh[] = [];
  for (const [x, y, rz, len] of [
    [-1.4, -0.4, 0.4, 2.6],
    [1.5, 0.6, -0.6, 2.2],
    [0.6, 2.6, 0.9, 1.8],
    [-1.8, 2.2, -0.3, 1.4],
  ]) {
    const c = mesh(rb(0.12, len, 0.1, 0.03), eyes, root, x, y, 1.92, 0, 0, rz);
    c.visible = false;
    c.castShadow = false;
    cracks.push(c);
  }
  const orbit = new THREE.Group();
  root.add(orbit);
  const runes: THREE.Mesh[] = [];
  const runeMats: SurfaceMaterial[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const m = createSurfaceMaterial({ color: 0x6e6a62, roughness: 0.85, flatShading: true, rim: glowColor, rimStrength: 0.6 });
    const r = mesh(rb(1.6, 2.2, 0.9, 0.2), m, orbit, Math.cos(a) * 6.2, Math.sin(a) * 6.2, 0.5);
    mesh(rb(0.2, 1.2, 0.12, 0.05), eyes, r, 0, 0, 0.47).castShadow = false;
    mesh(rb(0.8, 0.2, 0.12, 0.05), eyes, r, 0, 0.3, 0.47).castShadow = false;
    runes.push(r);
    runeMats.push(m);
  }
  return { root, jaw, mouth, eyes, stoneMat: stone, orbit, runes, runeMats, cracks, materials: [stone, dark, red, eyes] };
}
