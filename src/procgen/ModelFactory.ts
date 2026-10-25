import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { createBlobShadowMaterial, createGroundMaterial, createSkyMaterial, createSurfaceMaterial, type SurfaceMaterial } from './Shaders';

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
  FLOCK_LOD: 13,
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
// Geometry helpers (shared with the creature and scenery factories)
// ---------------------------------------------------------------------------
/** Chamfered box. */
export const rb = (w: number, h: number, d: number, r = 0.05) => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2.1, h / 2.1, d / 2.1));

/** Ellipsoid: a sphere scaled to the given radii. */
export function ellipsoid(rx: number, ry: number, rz: number, w = 20, h = 14): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, w, h);
  g.scale(rx, ry, rz);
  return g;
}

export function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  parent.add(m);
  return m;
}

/** A thin solid cut from a 2D outline (fins, wings, frills); the outline lies in XY. */
export function plate(points: [number, number][], depth = 0.05): THREE.BufferGeometry {
  const s = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** Deterministic 3D value-noise stand-in (sum of sines) for displacing rock. */
export function rockNoise(x: number, y: number, z: number, seed: number): number {
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
// The heroine: a sky-adventurer in a flight jacket, cargo trousers and boots,
// goggles pushed up on her head, a long ponytail and scarf streaming behind,
// a brass twin-tank rocket pack, a blaster in her right hand and the
// hard-light whip emitter in her left.
// ---------------------------------------------------------------------------
export interface PlayerModel {
  root: THREE.Group;
  body: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  shinL: THREE.Group;
  shinR: THREE.Group;
  /** Whip arm (left). */
  armL: THREE.Group;
  gun: THREE.Group;
  /** Ponytail and scarf chains, for secondary motion. */
  hair: THREE.Group[];
  scarf: THREE.Group[];
  /** Tip of the whip emitter in her left hand. */
  whipHand: THREE.Object3D;
  /** Emitter glow; brightens while the whip is drawn. */
  whipGlow: SurfaceMaterial;
  nozzles: THREE.Object3D[];
  flames: THREE.Mesh[];
  muzzle: THREE.Object3D;
  materials: SurfaceMaterial[];
}

export function createPlayerModel(accent: number = 0xe8742c, trim: number = 0xffb35a): PlayerModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const skin = createSurfaceMaterial({ color: 0xd09a74, roughness: 0.6 });
  const jacket = createSurfaceMaterial({ color: 0x7a4a2c, roughness: 0.72, rim: 0xffd2a8, rimStrength: 0.45 });
  const pants = createSurfaceMaterial({ color: 0x5a5a42, roughness: 0.85 });
  const leather = createSurfaceMaterial({ color: 0x3a2618, roughness: 0.55 });
  const brass = createSurfaceMaterial({ color: 0xc08a3a, roughness: 0.32, metalness: 1 });
  const hairMat = createSurfaceMaterial({ color: 0x5a2414, roughness: 0.55, rim: 0xffb07a, rimStrength: 0.6 });
  const scarfMat = createSurfaceMaterial({ color: accent, roughness: 0.7 });
  const glow = createSurfaceMaterial({ color: trim, emissive: 0.8, roughness: 0.3 });
  const whipGlow = createSurfaceMaterial({ color: trim, emissive: 0.5, roughness: 0.3 });
  const shirt = createSurfaceMaterial({ color: 0xe8dcc0, roughness: 0.8 });
  const materials = [skin, jacket, pants, leather, brass, hairMat, scarfMat, glow, whipGlow, shirt];

  // Torso: open flight jacket over a shirt, cinched waist, belt with pouches.
  mesh(rb(0.56, 0.46, 0.34, 0.12), jacket, body, 0, 1.5, 0);
  mesh(rb(0.24, 0.38, 0.06, 0.03), shirt, body, 0, 1.52, -0.16);
  mesh(rb(0.4, 0.28, 0.27, 0.1), shirt, body, 0, 1.17, 0);
  for (const s of [-1, 1]) mesh(rb(0.13, 0.42, 0.3, 0.05), jacket, body, s * 0.16, 1.2, 0, 0, 0, s * 0.08);
  mesh(rb(0.5, 0.26, 0.34, 0.1), pants, body, 0, 0.9, 0);
  mesh(rb(0.52, 0.08, 0.36, 0.03), leather, body, 0, 1.02, 0);
  mesh(rb(0.1, 0.08, 0.04, 0.015), brass, body, 0, 1.02, -0.19);
  for (const s of [-1, 1]) mesh(rb(0.12, 0.14, 0.12, 0.03), leather, body, s * 0.27, 0.96, -0.04);
  // Shoulders and fleece collar.
  for (const s of [-1, 1]) mesh(ellipsoid(0.13, 0.11, 0.15), jacket, body, s * 0.3, 1.68, 0);
  mesh(new THREE.TorusGeometry(0.15, 0.06, 8, 20), shirt, body, 0, 1.76, 0.02, Math.PI / 2);

  // Head: face, swept-back hair, goggles on the brow.
  mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.14, 10), skin, body, 0, 1.84, 0);
  const head = new THREE.Group();
  head.position.set(0, 2.03, 0);
  body.add(head);
  mesh(ellipsoid(0.16, 0.2, 0.17), skin, head);
  mesh(ellipsoid(0.175, 0.19, 0.17), hairMat, head, 0, 0.04, 0.04);
  mesh(rb(0.3, 0.12, 0.08, 0.04), hairMat, head, 0, 0.12, -0.11, 0.3);
  mesh(new THREE.TorusGeometry(0.175, 0.02, 6, 24), leather, head, 0, 0.11, 0, Math.PI / 2 - 0.25);
  for (const s of [-1, 1]) {
    mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.05, 14), brass, head, s * 0.07, 0.15, -0.15, Math.PI / 2 - 0.5);
    mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.02, 14), glow, head, s * 0.07, 0.166, -0.17, Math.PI / 2 - 0.5);
  }
  // Ponytail: a chain of tapering locks hanging from the crown.
  const hair: THREE.Group[] = [];
  let parent: THREE.Object3D = head;
  let off = new THREE.Vector3(0, 0.1, 0.16);
  for (let i = 0; i < 4; i++) {
    const g = new THREE.Group();
    g.position.copy(off);
    parent.add(g);
    const r = 0.075 - i * 0.012;
    mesh(ellipsoid(r, r * 0.9, 0.13), hairMat, g, 0, 0, 0.1);
    hair.push(g);
    parent = g;
    off = new THREE.Vector3(0, 0, 0.19);
  }
  // Scarf tails streaming from the collar.
  const scarf: THREE.Group[] = [];
  parent = body;
  off = new THREE.Vector3(0.08, 1.74, 0.16);
  mesh(new THREE.TorusGeometry(0.13, 0.05, 8, 20), scarfMat, body, 0, 1.78, 0, Math.PI / 2 + 0.1);
  for (let i = 0; i < 4; i++) {
    const g = new THREE.Group();
    g.position.copy(off);
    parent.add(g);
    mesh(rb(0.14 - i * 0.015, 0.03, 0.22, 0.012), scarfMat, g, 0, 0, 0.1);
    scarf.push(g);
    parent = g;
    off = new THREE.Vector3(0, 0, 0.21);
  }

  // Rocket pack: twin brass tanks on a leather harness.
  mesh(rb(0.36, 0.5, 0.12, 0.04), leather, body, 0, 1.45, 0.22);
  for (const s of [-1, 1]) mesh(rb(0.06, 0.5, 0.05, 0.02), leather, body, s * 0.15, 1.5, -0.17);
  const nozzles: THREE.Object3D[] = [];
  const flames: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const pod = new THREE.Group();
    pod.position.set(s * 0.17, 1.42, 0.36);
    pod.rotation.x = 0.18;
    body.add(pod);
    mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.62, 18), brass, pod);
    mesh(new THREE.SphereGeometry(0.13, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), brass, pod, 0, 0.31, 0);
    for (const y of [-0.15, 0.15]) mesh(new THREE.TorusGeometry(0.135, 0.016, 6, 20), leather, pod, 0, y, 0, Math.PI / 2);
    mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.14, 18), leather, pod, 0, -0.37, 0);
    mesh(new THREE.TorusGeometry(0.085, 0.02, 8, 20), glow, pod, 0, -0.45, 0, Math.PI / 2);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.09, 1.1, 20, 1, true), createFlameMaterial(trim));
    flame.rotation.x = Math.PI;
    flame.position.y = -1.0;
    flame.renderOrder = 12;
    pod.add(flame);
    flames.push(flame);
    const noz = new THREE.Object3D();
    noz.position.set(0, -0.48, 0);
    pod.add(noz);
    nozzles.push(noz);
  }

  // Legs: hip pivots with knee pivots for the procedural gait.
  const mkLeg = (side: number) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.13, 0.8, 0);
    body.add(hip);
    mesh(rb(0.19, 0.46, 0.21, 0.08), pants, hip, 0, -0.22, 0);
    mesh(rb(0.1, 0.14, 0.06, 0.02), pants, hip, side * 0.09, -0.24, -0.02);
    const knee = new THREE.Group();
    knee.position.y = -0.46;
    hip.add(knee);
    mesh(rb(0.16, 0.2, 0.18, 0.06), pants, knee, 0, -0.08, 0);
    mesh(rb(0.17, 0.32, 0.2, 0.06), leather, knee, 0, -0.32, 0);
    mesh(rb(0.18, 0.04, 0.21, 0.015), brass, knee, 0, -0.18, 0);
    mesh(rb(0.16, 0.1, 0.3, 0.04), leather, knee, 0, -0.5, -0.06);
    return { hip, knee };
  };
  const L = mkLeg(-1);
  const R = mkLeg(1);

  // Left arm hangs ready with the whip emitter.
  const armL = new THREE.Group();
  armL.position.set(-0.34, 1.62, 0);
  mesh(rb(0.14, 0.38, 0.15, 0.06), jacket, armL, 0, -0.2, 0);
  mesh(rb(0.12, 0.32, 0.13, 0.05), skin, armL, -0.01, -0.52, -0.02);
  mesh(rb(0.13, 0.12, 0.14, 0.04), leather, armL, -0.01, -0.7, -0.02);
  mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.26, 10), brass, armL, -0.01, -0.82, -0.08, Math.PI / 2 - 0.4);
  const tip = mesh(new THREE.SphereGeometry(0.05, 12, 8), whipGlow, armL, -0.01, -0.87, -0.2);
  tip.castShadow = false;
  const whipHand = new THREE.Object3D();
  whipHand.position.set(-0.01, -0.88, -0.22);
  armL.add(whipHand);
  armL.rotation.z = -0.12;
  body.add(armL);

  // Right arm extended forward with the blaster.
  mesh(rb(0.14, 0.36, 0.15, 0.06), jacket, body, 0.35, 1.4, -0.12, -0.9, 0, -0.1);
  mesh(rb(0.12, 0.12, 0.34, 0.05), skin, body, 0.36, 1.25, -0.38);
  const gun = new THREE.Group();
  gun.position.set(0.36, 1.3, -0.58);
  mesh(rb(0.1, 0.16, 0.36, 0.03), leather, gun, 0, -0.02, 0.02);
  mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.42, 14), brass, gun, 0, 0.05, -0.18, Math.PI / 2);
  for (const z of [-0.08, -0.2, -0.32]) mesh(new THREE.TorusGeometry(0.055, 0.012, 6, 16), leather, gun, 0, 0.05, z);
  mesh(rb(0.03, 0.03, 0.22, 0.01), glow, gun, 0, 0.11, -0.1);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.05, -0.42);
  gun.add(muzzle);
  body.add(gun);

  return { root, body, legL: L.hip, legR: R.hip, shinL: L.knee, shinR: R.knee, armL, gun, hair, scarf, whipHand, whipGlow, nozzles, flames, muzzle, materials };
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
export function createGround(): THREE.Mesh {
  // Wide enough to carry the valley walls out to the horizon; dense enough for the ridges.
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
