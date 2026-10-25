import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  createBlobShadowMaterial,
  createGroundMaterial,
  createInstancedHullMaterial,
  createSkyMaterial,
  createSurfaceMaterial,
  type SurfaceMaterial,
} from './Shaders';

/** Baked atlas layout (4x4). Must match tools/bake-sprites.mjs. */
export const ATLAS = {
  COLS: 4,
  PLAYER_BOLT: 0,
  ENEMY_ORB: 1,
  ENEMY_NEEDLE: 2,
  SPARK: 3,
  EXPLOSION_START: 4,
  EXPLOSION_FRAMES: 8,
  MINE: 12,
  WYRM_LOD: 13,
  RING: 14,
  PUFF: 15,
} as const;

/** Loads the baked sprite atlas, falling back to a runtime-drawn atlas if missing. */
export function loadAtlas(): THREE.Texture {
  const tex = new THREE.TextureLoader().load(
    `${import.meta.env.BASE_URL}sprites/atlas.png`,
    undefined,
    undefined,
    () => {
      console.warn('[atlas] baked atlas missing; run `npm run bake`. Using runtime fallback.');
      tex.image = drawFallbackAtlas();
      tex.needsUpdate = true;
    },
  );
  // The atlas holds encoded channels (and sRGB fire in the flipbook, which the shader decodes).
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/** Plain tinted discs in the same R=whiteness / G=brightness encoding as the bake. */
function drawFallbackAtlas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 16; i++) {
    const x = (i % 4) * 64 + 32;
    const y = Math.floor(i / 4) * 64 + 32;
    const hot = i >= ATLAS.EXPLOSION_START && i < ATLAS.EXPLOSION_START + ATLAS.EXPLOSION_FRAMES;
    const grad = g.createRadialGradient(x, y, 0, x, y, 28);
    grad.addColorStop(0, hot ? '#fff3c0' : '#ffffff');
    grad.addColorStop(0.5, hot ? '#ffa030' : '#00ff00');
    grad.addColorStop(1, hot ? 'rgba(255,90,30,0)' : 'rgba(0,255,0,0)');
    g.fillStyle = grad;
    g.fillRect(x - 32, y - 32, 64, 64);
  }
  return c;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
/** Chamfered box: the basic hard-surface panel. */
const rb = (w: number, h: number, d: number, r = 0.05) => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2.1, h / 2.1, d / 2.1));

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  parent.add(m);
  return m;
}

/** Deterministic 3D value-noise stand-in (sum of sines) for displacing rock. */
function rockNoise(x: number, y: number, z: number, seed: number): number {
  return (
    Math.sin(x * 1.7 + seed) * Math.sin(y * 1.3 + seed * 2.1) * 0.5 +
    Math.sin(z * 2.3 - seed) * Math.sin(x * 2.9 + y * 0.7) * 0.3 +
    Math.sin(y * 4.1 + z * 3.3 + seed * 0.7) * 0.2
  );
}

/** Additive exhaust cone: white-hot at the nozzle, fading to the tint. */
function createFlameMaterial(color: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uPower: { value: 3 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uPower;
      varying vec2 vUv;
      void main() {
        float t = 1.0 - vUv.y;
        float a = pow(t, 1.6);
        gl_FragColor = vec4(mix(uColor, vec3(1.0), pow(t, 5.0)) * a * uPower, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

// ---------------------------------------------------------------------------
// Player Harrier: armoured jet trooper. Composite plates over a dark
// undersuit, a metal jetpack with twin thrust pods and a long rifle.
// ---------------------------------------------------------------------------
export interface PlayerModel {
  root: THREE.Group;
  body: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  shinL: THREE.Group;
  shinR: THREE.Group;
  armL: THREE.Group;
  gun: THREE.Group;
  nozzles: THREE.Object3D[];
  flames: THREE.Mesh[];
  muzzle: THREE.Object3D;
  materials: SurfaceMaterial[];
}

export function createPlayerModel(accent: number = 0xe8742c, trim: number = 0xffb35a): PlayerModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const armor = createSurfaceMaterial({ color: 0x8e949b, roughness: 0.6, metalness: 0.12 });
  const suit = createSurfaceMaterial({ color: 0x2a2d31, roughness: 0.75, metalness: 0.2 });
  const metal = createSurfaceMaterial({ color: 0x6d7178, roughness: 0.32, metalness: 1 });
  const paint = createSurfaceMaterial({ color: accent, roughness: 0.45, metalness: 0.1 });
  const glow = createSurfaceMaterial({ color: trim, emissive: 0.8, roughness: 0.3 });
  const materials = [armor, suit, metal, paint, glow];

  // Torso, abdomen, hips, shoulder plates.
  mesh(rb(0.78, 0.6, 0.46, 0.1), armor, body, 0, 1.46, 0);
  mesh(rb(0.5, 0.34, 0.36, 0.06), suit, body, 0, 1.03, 0);
  mesh(rb(0.64, 0.24, 0.42, 0.06), armor, body, 0, 0.82, 0);
  mesh(rb(0.66, 0.07, 0.06, 0.02), paint, body, 0, 1.2, 0.24);
  mesh(rb(0.42, 0.22, 0.08, 0.03), armor, body, 0, 1.48, -0.25);
  for (const s of [-1, 1]) {
    mesh(rb(0.38, 0.3, 0.46, 0.09), armor, body, s * 0.55, 1.64, 0, 0, 0, s * -0.12);
    mesh(rb(0.39, 0.06, 0.47, 0.02), paint, body, s * 0.56, 1.73, 0, 0, 0, s * -0.12);
  }

  // Helmet with visor slit.
  mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.16, 12), suit, body, 0, 1.83, 0);
  mesh(rb(0.36, 0.38, 0.42, 0.13), armor, body, 0, 2.03, 0.02);
  mesh(rb(0.05, 0.14, 0.34, 0.02), suit, body, 0, 2.24, 0.04);
  mesh(rb(0.3, 0.07, 0.04, 0.015), glow, body, 0, 2.03, -0.2);

  // Jetpack core and twin thrust pods.
  mesh(rb(0.52, 0.64, 0.26, 0.06), metal, body, 0, 1.46, 0.34);
  mesh(rb(0.3, 0.08, 0.05, 0.02), glow, body, 0, 1.6, 0.48);
  const nozzles: THREE.Object3D[] = [];
  const flames: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const pod = new THREE.Group();
    pod.position.set(s * 0.32, 1.4, 0.5);
    pod.rotation.x = 0.18;
    body.add(pod);
    mesh(new THREE.CylinderGeometry(0.15, 0.17, 0.74, 20), armor, pod);
    mesh(new THREE.CylinderGeometry(0.155, 0.155, 0.06, 20), paint, pod, 0, 0.18, 0);
    mesh(new THREE.CylinderGeometry(0.14, 0.11, 0.16, 20), metal, pod, 0, -0.44, 0);
    mesh(new THREE.TorusGeometry(0.1, 0.022, 8, 24), glow, pod, 0, -0.52, 0, Math.PI / 2);
    mesh(rb(0.04, 0.42, 0.34, 0.015), suit, pod, s * 0.17, 0.05, 0.02);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.1, 1.2, 20, 1, true), createFlameMaterial(trim));
    flame.rotation.x = Math.PI;
    flame.position.y = -1.12;
    flame.renderOrder = 12;
    pod.add(flame);
    flames.push(flame);
    const noz = new THREE.Object3D();
    noz.position.set(0, -0.55, 0);
    pod.add(noz);
    nozzles.push(noz);
  }

  // Legs: hip pivots with knee pivots for the procedural gait.
  const mkLeg = (side: number) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.19, 0.76, 0);
    body.add(hip);
    mesh(rb(0.25, 0.46, 0.29, 0.07), armor, hip, 0, -0.22, 0);
    const knee = new THREE.Group();
    knee.position.y = -0.46;
    hip.add(knee);
    mesh(rb(0.2, 0.17, 0.2, 0.05), paint, knee, 0, 0, -0.05);
    mesh(rb(0.22, 0.42, 0.26, 0.07), armor, knee, 0, -0.24, 0);
    mesh(rb(0.24, 0.14, 0.4, 0.05), suit, knee, 0, -0.5, -0.07);
    return { hip, knee };
  };
  const L = mkLeg(-1);
  const R = mkLeg(1);

  // Left arm hangs free; right arm carries the rifle.
  const armL = new THREE.Group();
  armL.position.set(-0.6, 1.58, 0);
  mesh(rb(0.2, 0.42, 0.22, 0.06), suit, armL, 0, -0.24, 0);
  mesh(rb(0.23, 0.38, 0.25, 0.07), armor, armL, -0.02, -0.6, -0.04);
  armL.rotation.z = -0.18;
  body.add(armL);
  mesh(rb(0.2, 0.4, 0.22, 0.06), suit, body, 0.6, 1.36, -0.12, -0.9, 0, -0.1);
  mesh(rb(0.24, 0.24, 0.42, 0.07), armor, body, 0.6, 1.21, -0.42);

  const gun = new THREE.Group();
  gun.position.set(0.6, 1.27, -0.55);
  mesh(rb(0.17, 0.22, 0.82, 0.04), metal, gun, 0, 0, -0.1);
  mesh(rb(0.14, 0.16, 0.46, 0.04), armor, gun, 0, 0.12, -0.32);
  mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.62, 12), suit, gun, 0, 0, -0.78, Math.PI / 2);
  mesh(rb(0.025, 0.035, 0.5, 0.01), glow, gun, 0.09, 0.02, -0.18);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -1.12);
  gun.add(muzzle);
  body.add(gun);

  return { root, body, legL: L.hip, legR: R.hip, shinL: L.knee, shinR: R.knee, armL, gun, nozzles, flames, muzzle, materials };
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
export function createGround(): THREE.Mesh {
  // Wide enough to carry the canyon walls out to the horizon; dense enough for the ridges.
  const geo = new THREE.PlaneGeometry(260, 200, 130, 160);
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, createGroundMaterial());
  m.position.z = -90; // spans z = +10 .. -190
  m.frustumCulled = false;
  m.receiveShadow = true;
  m.renderOrder = -1;
  return m;
}

export function createSky(): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(600, 64, 32), createSkyMaterial());
  m.frustumCulled = false;
  m.renderOrder = -2;
  return m;
}

export function createBlobShadow(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(2, 2);
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, createBlobShadowMaterial());
  m.renderOrder = 1;
  return m;
}

export interface TreeMeshes {
  /** Eroded rock spires (tinted per sector through the material colour). */
  trunks: THREE.InstancedMesh;
  /** Boulder clusters at each spire's foot (tinted per instance). */
  canopies: THREE.InstancedMesh;
}

function spireGeometry(): THREE.BufferGeometry {
  const H = 6.4;
  const geo = new THREE.CylinderGeometry(0.85, 1.4, H, 22, 18);
  geo.translate(0, H / 2, 0);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const cols: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const a = Math.atan2(z, x);
    const n = rockNoise(Math.cos(a) * 2, y * 0.55, Math.sin(a) * 2, 3.7);
    // Wind-cut ledges: radius steps in and out with height.
    const ledge = 0.06 * Math.sign(Math.sin(y * 1.9)) * Math.min(1, Math.abs(Math.sin(y * 1.9)) * 4);
    const k = 1 + n * 0.22 + ledge;
    const top = y > H - 0.05 ? (n - 0.2) * 0.5 : 0;
    pos.setXYZ(i, x * k, y + top, z * k);
    // Sedimentary bands (grey levels multiply the sector rock colour).
    const band = 0.82 + 0.18 * Math.sin(y * 2.4 + n * 2.0) + 0.08 * n;
    const base = 0.8 + 0.25 * Math.min(1, y / H);
    cols.push(band * base, band * base * 0.97, band * base * 0.93);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  return geo;
}

function boulderGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const spots: [number, number, number, number][] = [
    [1.3, 0.25, 0.4, 0.75],
    [-1.1, 0.2, 0.7, 0.6],
    [0.2, 0.15, -1.35, 0.55],
    [-0.6, 0.12, -1.0, 0.4],
  ];
  for (const [x, y, z, r] of spots) {
    const g = new THREE.DodecahedronGeometry(r, 0);
    g.scale(1.25, 0.75, 1.05);
    g.rotateY(x * 2 + z);
    g.translate(x, y, z);
    parts.push(g.index ? g.toNonIndexed() : g);
  }
  const merged = mergeGeometries(parts)!;
  merged.computeVertexNormals();
  return merged;
}

/** Eroded rock spires + boulder skirts, both instanced. */
export function createTreeInstanced(capacity: number): TreeMeshes {
  const rock = new THREE.MeshStandardMaterial({ color: 0xa7835a, vertexColors: true, roughness: 0.95, metalness: 0 });
  const trunks = new THREE.InstancedMesh(spireGeometry(), rock, capacity);
  const stone = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, flatShading: true });
  const canopies = new THREE.InstancedMesh(boulderGeometry(), stone, capacity);
  for (const m of [trunks, canopies]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = true;
    m.receiveShadow = true;
  }
  canopies.setColorAt(0, new THREE.Color(1, 1, 1));
  canopies.instanceColor!.setUsage(THREE.DynamicDrawUsage);
  return { trunks, canopies };
}

// ---------------------------------------------------------------------------
// Enemies
// ---------------------------------------------------------------------------
function tinted(geo: THREE.BufferGeometry, tint: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.setAttribute('aTint', new THREE.Float32BufferAttribute(new Array(g.attributes.position.count).fill(tint), 1));
  return g;
}

/**
 * One wyrm segment, nose along +Z: a hexagonal armoured hull with accent
 * side plates, a dorsal blade and a forward sensor strip.
 */
function wyrmSegmentGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const hull = new THREE.CylinderGeometry(0.5, 0.6, 1.0, 6);
  hull.rotateX(Math.PI / 2);
  hull.rotateZ(Math.PI / 6);
  hull.scale(1.15, 0.8, 1);
  parts.push(tinted(hull, 0));
  const nose = new THREE.CylinderGeometry(0.0, 0.5, 0.4, 6);
  nose.rotateX(Math.PI / 2);
  nose.rotateZ(Math.PI / 6);
  nose.scale(1.15, 0.8, 1);
  nose.translate(0, 0, 0.7);
  parts.push(tinted(nose, 0));
  for (const s of [-1, 1]) {
    const plate = rb(0.16, 0.42, 0.86, 0.04);
    plate.rotateZ(s * 0.25);
    plate.translate(s * 0.62, 0.02, -0.02);
    parts.push(tinted(plate, 1));
    const vane = new THREE.BoxGeometry(0.5, 0.05, 0.42);
    vane.rotateY(s * 0.5);
    vane.translate(s * 0.88, -0.1, -0.25);
    parts.push(tinted(vane, 0));
  }
  const blade = new THREE.BoxGeometry(0.06, 0.38, 0.66);
  blade.translate(0, 0.5, -0.12);
  parts.push(tinted(blade, 1));
  const eye = new THREE.BoxGeometry(0.46, 0.07, 0.06);
  eye.translate(0, 0.12, 0.62);
  parts.push(tinted(eye, 2));
  const merged = mergeGeometries(parts)!;
  merged.scale(1.3, 1.3, 1.1);
  merged.computeVertexNormals();
  return merged;
}

export function createWyrmInstanced(capacity: number): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(wyrmSegmentGeometry(), createInstancedHullMaterial(0x41464e), capacity);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.setColorAt(0, new THREE.Color(1, 1, 1));
  m.instanceColor!.setUsage(THREE.DynamicDrawUsage);
  m.count = 0;
  m.frustumCulled = false;
  m.castShadow = true;
  return m;
}

export interface SentinelModel {
  root: THREE.Group;
  head: THREE.Group;
  emitter: THREE.Mesh;
  materials: SurfaceMaterial[];
}

/** Ground turret: hexagonal footing, armoured mast and a sensor head with a lens. */
export function createSentinelModel(): SentinelModel {
  const root = new THREE.Group();
  const shell = createSurfaceMaterial({ color: 0x4a4f57, roughness: 0.45, metalness: 0.6 });
  const eye = createSurfaceMaterial({ color: 0xff4a2a, emissive: 0.9, roughness: 0.2 });
  const white = createSurfaceMaterial({ color: 0xb9b4aa, roughness: 0.6, metalness: 0.15 });
  mesh(new THREE.CylinderGeometry(1.5, 1.75, 0.55, 6), shell, root, 0, 0.28, 0);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    mesh(rb(0.5, 0.7, 1.2, 0.05), white, root, Math.cos(a) * 1.25, 0.6, Math.sin(a) * 1.25, 0, -a, 0);
  }
  mesh(new THREE.CylinderGeometry(0.32, 0.5, 3.2, 8), white, root, 0, 2.1, 0);
  mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.22, 8), shell, root, 0, 3.3, 0);
  const head = new THREE.Group();
  head.position.y = 4.0;
  mesh(rb(1.9, 1.25, 1.9, 0.18), shell, head);
  mesh(rb(2.0, 0.12, 1.4, 0.04), white, head, 0, 0.35, 0);
  mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.3, 20), white, head, 0, 0, 0.98, Math.PI / 2);
  const emitter = mesh(new THREE.SphereGeometry(0.34, 24, 16), eye, head, 0, 0, 1.08);
  emitter.scale.set(1, 1, 0.5);
  root.add(head);
  return { root, head, emitter, materials: [shell, eye, white] };
}

export interface TitanModel {
  root: THREE.Group;
  core: THREE.Mesh;
  armor: THREE.Group;
  plates: THREE.Mesh[];
  coreMat: SurfaceMaterial;
  plateMats: SurfaceMaterial[];
  extraMats: SurfaceMaterial[];
}

/** Faceted reactor core behind a rotating collar of six armour plates. */
export function createTitanModel(): TitanModel {
  const root = new THREE.Group();
  const coreMat = createSurfaceMaterial({ color: 0x3a3f46, roughness: 0.35, metalness: 0.8, flatShading: true, rim: 0x6a4a3a, rimStrength: 0.8 });
  const core = mesh(new THREE.IcosahedronGeometry(1.6, 1), coreMat, root);
  const eyeMat = createSurfaceMaterial({ color: 0xffb04a, emissive: 1, roughness: 0.2 });
  const lens = mesh(new THREE.SphereGeometry(0.55, 24, 16), eyeMat, core, 0, 0, 1.38);
  lens.scale.set(1, 1, 0.5);
  const trimMat = createSurfaceMaterial({ color: 0x23262b, roughness: 0.5, metalness: 0.7 });
  mesh(new THREE.TorusGeometry(0.75, 0.09, 10, 40), trimMat, core, 0, 0, 1.3);
  const armor = new THREE.Group();
  root.add(armor);
  const plates: THREE.Mesh[] = [];
  const plateMats: SurfaceMaterial[] = [];
  const plateGeo = rb(0.95, 1.7, 0.7, 0.1);
  const stripeGeo = rb(0.22, 1.2, 0.06, 0.02);
  const stripeMat = createSurfaceMaterial({ color: 0xe8742c, roughness: 0.45 });
  const PLATES = 6;
  for (let i = 0; i < PLATES; i++) {
    const m = createSurfaceMaterial({ color: i % 2 ? 0x5a5f66 : 0x4a4f56, roughness: 0.42, metalness: 0.6 });
    const p = mesh(plateGeo, m, armor);
    const a = (i / PLATES) * Math.PI * 2;
    p.position.set(Math.cos(a) * 2.6, Math.sin(a) * 2.6, 0.4);
    p.rotation.z = a + Math.PI / 2;
    mesh(stripeGeo, stripeMat, p, 0, 0, 0.36);
    plates.push(p);
    plateMats.push(m);
  }
  return { root, core, armor, plates, coreMat, plateMats, extraMats: [eyeMat, trimMat, stripeMat] };
}

export interface BossModel {
  root: THREE.Group;
  core: THREE.Mesh;
  ringA: THREE.Group;
  ringB: THREE.Group;
  pods: THREE.Mesh[];
  materials: SurfaceMaterial[];
}

/**
 * Capital construct: an armoured sphere with a glowing sensor iris, an outer
 * segmented ring carrying four weapon pods, an inner energy ring and a crown
 * of antenna blades. colorA lights the iris and ring; colorB marks the pods.
 */
export function createBossModel(colorA: number, colorB: number): BossModel {
  const root = new THREE.Group();
  const coreMat = createSurfaceMaterial({ color: 0x3a3e45, roughness: 0.32, metalness: 0.85, rim: colorA, rimStrength: 0.45 });
  const shellMat = createSurfaceMaterial({ color: 0x6a6e74, roughness: 0.45, metalness: 0.55 });
  const podMat = createSurfaceMaterial({ color: colorB, roughness: 0.4, metalness: 0.3 });
  const eyeMat = createSurfaceMaterial({ color: colorA, emissive: 1, roughness: 0.2 });
  const pupilMat = createSurfaceMaterial({ color: 0x15171b, roughness: 0.3, metalness: 0.9 });

  const core = mesh(new THREE.IcosahedronGeometry(3.0, 3), coreMat, root);
  // Armour bands around the sphere.
  for (const rx of [0, Math.PI / 2]) mesh(new THREE.TorusGeometry(3.02, 0.16, 8, 64), shellMat, core, 0, 0, 0, rx);
  // Sensor: dark bezel, glowing iris, black aperture.
  mesh(new THREE.CylinderGeometry(1.6, 1.8, 0.5, 32), pupilMat, root, 0, 0, 2.75, Math.PI / 2);
  const iris = mesh(new THREE.CylinderGeometry(1.15, 1.15, 0.2, 32), eyeMat, root, 0, 0, 3.0, Math.PI / 2);
  iris.castShadow = false;
  mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.24, 24), pupilMat, root, 0, 0, 3.06, Math.PI / 2);

  const ringA = new THREE.Group();
  mesh(new THREE.TorusGeometry(5.4, 0.28, 10, 96), shellMat, ringA);
  const blockGeo = rb(1.1, 0.8, 0.9, 0.08);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    mesh(blockGeo, i % 3 === 0 ? coreMat : shellMat, ringA, Math.cos(a) * 5.4, Math.sin(a) * 5.4, 0, 0, 0, a);
  }
  root.add(ringA);
  const ringB = new THREE.Group();
  mesh(new THREE.TorusGeometry(4.2, 0.12, 8, 72), eyeMat, ringB, 0, 0, 0, Math.PI / 2);
  root.add(ringB);

  const pods: THREE.Mesh[] = [];
  const podGeo = rb(1.4, 2.2, 1.5, 0.15);
  const barrelGeo = new THREE.CylinderGeometry(0.16, 0.2, 1.2, 12);
  for (let i = 0; i < 4; i++) {
    const p = mesh(podGeo, podMat, ringA);
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    p.position.set(Math.cos(a) * 5.4, Math.sin(a) * 5.4, 0.3);
    p.rotation.z = a;
    for (const s of [-1, 1]) mesh(barrelGeo, pupilMat, p, s * 0.35, 0, 0.9, Math.PI / 2);
    pods.push(p);
  }
  // Antenna blades.
  const bladeGeo = rb(0.22, 2.6, 0.5, 0.05);
  for (let i = 0; i < 5; i++) {
    const a = Math.PI / 2 + (i - 2) * 0.36;
    const b = mesh(bladeGeo, shellMat, root, Math.cos(a) * 3.6, Math.sin(a) * 3.6, -0.6);
    b.rotation.z = a - Math.PI / 2;
  }
  return { root, core, ringA, ringB, pods, materials: [coreMat, shellMat, podMat, eyeMat, pupilMat] };
}
