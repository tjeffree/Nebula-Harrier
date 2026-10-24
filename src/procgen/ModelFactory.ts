import * as THREE from 'three';
import { createBlobShadowMaterial, createGroundMaterial, createSkyMaterial, createToonMaterial } from './Shaders';

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

/** Sphere with gentle sinusoidal bumps — reads as a soft, puffy organic shape. */
function puffySphere(radius: number, bump: number, wSeg = 24, hSeg = 16): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(radius, wSeg, hSeg);
  const p = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const k = 1 + bump * Math.sin(v.x * 5.1) * Math.sin(v.y * 4.3 + 1.0) * Math.sin(v.z * 5.7 + 2.0);
    v.multiplyScalar(radius * k);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// Player Harrier: rounded hero suit with jetpack and arm blaster.
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
  muzzle: THREE.Object3D;
  materials: THREE.ShaderMaterial[];
}

export function createPlayerModel(accent: number = 0xff4f6d, trim: number = 0x2fd3ff): PlayerModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const suit = createToonMaterial({ color: 0xf6f8ff, rim: 0xbfe6ff, gloss: 0.7 });
  const paint = createToonMaterial({ color: accent, rim: 0xffffff, gloss: 0.9 });
  const joint = createToonMaterial({ color: 0x343d5c, rim: trim, gloss: 0.4 });
  const glow = createToonMaterial({ color: trim, rim: 0xffffff, gloss: 1, emissive: 0.85 });
  const materials = [suit, paint, joint, glow];
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };

  // Torso, belt, shoulders.
  const torso = mesh(new THREE.CapsuleGeometry(0.36, 0.45, 8, 20), suit, body, 0, 1.3, 0);
  torso.scale.set(1.15, 1, 0.85);
  const chest = mesh(new THREE.SphereGeometry(0.3, 20, 14), paint, body, 0, 1.45, -0.18);
  chest.scale.set(1.3, 0.9, 0.6);
  const belt = mesh(new THREE.TorusGeometry(0.36, 0.07, 10, 28), joint, body, 0, 0.98, 0);
  belt.rotation.x = Math.PI / 2;
  belt.scale.set(1.12, 0.9, 1);
  for (const side of [-1, 1]) mesh(new THREE.SphereGeometry(0.2, 18, 12), paint, body, side * 0.47, 1.68, 0).scale.set(1, 0.8, 1);

  // Helmet with accent stripe and glowing antenna tip.
  const helmet = mesh(new THREE.SphereGeometry(0.3, 28, 20), suit, body, 0, 2.08, 0);
  helmet.scale.set(1, 1.05, 1.05);
  const stripe = mesh(new THREE.TorusGeometry(0.305, 0.045, 10, 32, Math.PI), paint, body, 0, 2.08, 0);
  stripe.rotation.set(0, Math.PI / 2, 0);
  const visor = mesh(new THREE.SphereGeometry(0.22, 20, 14), joint, body, 0, 2.08, -0.16);
  visor.scale.set(1.15, 0.6, 0.7);
  mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.35, 8), joint, body, 0.15, 2.42, 0.05).rotation.z = -0.3;
  mesh(new THREE.SphereGeometry(0.06, 12, 8), glow, body, 0.2, 2.58, 0.05);

  // Jetpack: central pack + twin thrusters.
  const pack = mesh(new THREE.CapsuleGeometry(0.22, 0.35, 6, 16), suit, body, 0, 1.45, 0.34);
  pack.scale.set(1.4, 1, 0.8);
  const nozzles: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const t = mesh(new THREE.CapsuleGeometry(0.14, 0.5, 6, 16), paint, body, side * 0.33, 1.4, 0.42);
    t.rotation.x = -0.2;
    const ring = mesh(new THREE.TorusGeometry(0.13, 0.04, 8, 20), joint, t, 0, -0.38, 0);
    ring.rotation.x = Math.PI / 2;
    mesh(new THREE.SphereGeometry(0.1, 14, 10), glow, t, 0, -0.42, 0);
    const wing = mesh(new THREE.CapsuleGeometry(0.06, 0.55, 4, 10), paint, t, side * 0.3, 0.1, 0);
    wing.rotation.z = side * 1.1;
    const noz = new THREE.Object3D();
    noz.position.set(0, -0.5, 0);
    t.add(noz);
    nozzles.push(noz);
  }

  // Legs (hip pivots) with knee pivots for procedural running.
  const mkLeg = (side: number) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.2, 0.92, 0);
    mesh(new THREE.CapsuleGeometry(0.13, 0.3, 6, 14), suit, hip, 0, -0.24, 0);
    const knee = new THREE.Group();
    knee.position.y = -0.5;
    hip.add(knee);
    mesh(new THREE.SphereGeometry(0.12, 14, 10), joint, knee, 0, 0, 0);
    mesh(new THREE.CapsuleGeometry(0.11, 0.3, 6, 14), paint, knee, 0, -0.24, 0);
    const boot = mesh(new THREE.SphereGeometry(0.16, 18, 12), suit, knee, 0, -0.5, -0.06);
    boot.scale.set(0.95, 0.6, 1.45);
    body.add(hip);
    return { hip, knee };
  };
  const L = mkLeg(-1);
  const R = mkLeg(1);

  // Left arm + right arm blaster.
  const armL = new THREE.Group();
  armL.position.set(-0.55, 1.62, 0);
  mesh(new THREE.CapsuleGeometry(0.1, 0.45, 6, 12), suit, armL, 0, -0.3, 0);
  mesh(new THREE.SphereGeometry(0.11, 12, 10), paint, armL, 0, -0.62, 0);
  armL.rotation.z = -0.25;
  body.add(armL);

  const gun = new THREE.Group();
  gun.position.set(0.58, 1.5, -0.05);
  const barrel = mesh(new THREE.CylinderGeometry(0.1, 0.14, 1.1, 24), suit, gun, 0, 0, -0.45);
  barrel.rotation.x = Math.PI / 2;
  mesh(new THREE.TorusGeometry(0.13, 0.04, 8, 24), paint, gun, 0, 0, -0.65);
  const housing = mesh(new THREE.CapsuleGeometry(0.16, 0.3, 6, 16), paint, gun, 0, 0, 0.02);
  housing.rotation.x = Math.PI / 2;
  mesh(new THREE.SphereGeometry(0.09, 14, 10), glow, gun, 0, 0, -1.02);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -1.1);
  gun.add(muzzle);
  body.add(gun);

  return { root, body, legL: L.hip, legR: R.hip, shinL: L.knee, shinR: R.knee, armL, gun, nozzles, muzzle, materials };
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
export function createGround(): THREE.Mesh {
  // Wide enough to carry the rolling side hills out to the horizon.
  const geo = new THREE.PlaneGeometry(260, 200, 64, 100);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, createGroundMaterial());
  mesh.position.z = -90; // spans z = +10 .. -190
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

export function createSky(): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), createSkyMaterial());
  mesh.frustumCulled = false;
  mesh.renderOrder = -2;
  return mesh;
}

export function createBlobShadow(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(2, 2);
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, createBlobShadowMaterial());
  m.renderOrder = 1;
  return m;
}

export interface TreeMeshes {
  trunks: THREE.InstancedMesh;
  canopies: THREE.InstancedMesh;
}

/** Puffy lollipop trees: instanced trunks + instanced canopies (tinted per instance). */
export function createTreeInstanced(capacity: number): TreeMeshes {
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.38, 3.4, 14);
  trunkGeo.translate(0, 1.7, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, createToonMaterial({ color: 0x9a6a48, gloss: 0.1, rim: 0xffe0c0 }), capacity);
  const canopyGeo = puffySphere(1.7, 0.14, 28, 18);
  canopyGeo.scale(1.15, 1, 1.15);
  canopyGeo.translate(0, 4.6, 0);
  const canopies = new THREE.InstancedMesh(canopyGeo, createToonMaterial({ color: 0xffffff, gloss: 0.25, rim: 0xffffff }), capacity);
  for (const m of [trunks, canopies]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.frustumCulled = false;
  }
  canopies.setColorAt(0, new THREE.Color(1, 1, 1));
  canopies.instanceColor!.setUsage(THREE.DynamicDrawUsage);
  return { trunks, canopies };
}

// ---------------------------------------------------------------------------
// Enemies
// ---------------------------------------------------------------------------
export function createWyrmInstanced(capacity: number): THREE.InstancedMesh {
  const geo = new THREE.SphereGeometry(1, 22, 16);
  geo.scale(0.9, 0.78, 1.05);
  const mat = createToonMaterial({ color: 0xffffff, gloss: 0.9, rim: 0xffffff });
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, new THREE.Color(1, 1, 1));
  mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  return mesh;
}

export interface SentinelModel {
  root: THREE.Group;
  head: THREE.Group;
  emitter: THREE.Mesh;
  materials: THREE.ShaderMaterial[];
}

export function createSentinelModel(): SentinelModel {
  const root = new THREE.Group();
  const shell = createToonMaterial({ color: 0x6c7bff, rim: 0xd8dcff, gloss: 0.8 });
  const white = createToonMaterial({ color: 0xf6f8ff, rim: 0xbfe6ff, gloss: 0.7 });
  const eye = createToonMaterial({ color: 0xff3d6e, rim: 0xffffff, gloss: 1, emissive: 0.6 });
  const base = new THREE.Mesh(
    new THREE.LatheGeometry(
      [new THREE.Vector2(0, 0), new THREE.Vector2(1.7, 0), new THREE.Vector2(1.6, 0.35), new THREE.Vector2(1.0, 0.65), new THREE.Vector2(0, 0.7)],
      40,
    ),
    shell,
  );
  const col = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.5, 3.2, 28), white);
  col.position.y = 2.1;
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.12, 12, 32), shell);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 3.3;
  const head = new THREE.Group();
  head.position.y = 4.0;
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(1.0, 36, 24), shell);
  headMesh.scale.set(1.15, 0.85, 1.15);
  head.add(headMesh);
  const lens = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.1, 12, 32), white);
  lens.position.z = 0.88;
  head.add(lens);
  const emitter = new THREE.Mesh(new THREE.SphereGeometry(0.36, 24, 16), eye);
  emitter.position.z = 0.85;
  head.add(emitter);
  root.add(base, col, collar, head);
  return { root, head, emitter, materials: [shell, eye, white] };
}

export interface TitanModel {
  root: THREE.Group;
  core: THREE.Mesh;
  armor: THREE.Group;
  plates: THREE.Mesh[];
  coreMat: THREE.ShaderMaterial;
  plateMats: THREE.ShaderMaterial[];
  extraMats: THREE.ShaderMaterial[];
}

export function createTitanModel(): TitanModel {
  const root = new THREE.Group();
  const coreMat = createToonMaterial({ color: 0x9b5cff, rim: 0xffd6ff, gloss: 1 });
  const core = new THREE.Mesh(new THREE.SphereGeometry(1.6, 40, 28), coreMat);
  root.add(core);
  const eyeMat = createToonMaterial({ color: 0xfff1a8, rim: 0xffffff, gloss: 1, emissive: 0.7 });
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 16), eyeMat);
  eye.position.z = 1.3;
  eye.scale.set(1, 1, 0.6);
  core.add(eye);
  const armor = new THREE.Group();
  root.add(armor);
  const plates: THREE.Mesh[] = [];
  const plateMats: THREE.ShaderMaterial[] = [];
  const plateGeo = new THREE.CapsuleGeometry(0.42, 1.1, 8, 18);
  const PLATES = 6;
  for (let i = 0; i < PLATES; i++) {
    const m = createToonMaterial({ color: 0xffb020, rim: 0xfff0c0, gloss: 0.9 });
    const p = new THREE.Mesh(plateGeo, m);
    const a = (i / PLATES) * Math.PI * 2;
    p.position.set(Math.cos(a) * 2.6, Math.sin(a) * 2.6, 0.4);
    p.rotation.z = a + Math.PI / 2;
    armor.add(p);
    plates.push(p);
    plateMats.push(m);
  }
  return { root, core, armor, plates, coreMat, plateMats, extraMats: [eyeMat] };
}

export interface BossModel {
  root: THREE.Group;
  core: THREE.Mesh;
  ringA: THREE.Group;
  ringB: THREE.Group;
  pods: THREE.Mesh[];
  materials: THREE.ShaderMaterial[];
}

export function createBossModel(colorA: number, colorB: number): BossModel {
  const root = new THREE.Group();
  const coreMat = createToonMaterial({ color: colorA, rim: 0xffffff, gloss: 1 });
  const shellMat = createToonMaterial({ color: 0xf6f8ff, rim: 0xd0ecff, gloss: 0.8 });
  const podMat = createToonMaterial({ color: colorB, rim: 0xffffff, gloss: 0.9 });
  const eyeMat = createToonMaterial({ color: 0xffffff, rim: 0xffffff, gloss: 1, emissive: 0.4 });
  const pupilMat = createToonMaterial({ color: 0x1d2340, rim: colorA, gloss: 1 });

  const core = new THREE.Mesh(new THREE.SphereGeometry(3.0, 48, 32), coreMat);
  root.add(core);
  // A big, expressive eye facing the player.
  const eye = new THREE.Mesh(new THREE.SphereGeometry(1.25, 32, 20), eyeMat);
  eye.position.z = 2.35;
  eye.scale.set(1, 1, 0.55);
  root.add(eye);
  const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 16), pupilMat);
  pupil.position.z = 2.95;
  pupil.scale.set(1, 1.25, 0.5);
  root.add(pupil);

  const ringA = new THREE.Group();
  ringA.add(new THREE.Mesh(new THREE.TorusGeometry(5.4, 0.42, 18, 72), shellMat));
  root.add(ringA);
  const ringB = new THREE.Group();
  const rb = new THREE.Mesh(new THREE.TorusGeometry(4.2, 0.3, 14, 56), podMat);
  rb.rotation.x = Math.PI / 2;
  ringB.add(rb);
  root.add(ringB);

  const pods: THREE.Mesh[] = [];
  const podGeo = new THREE.SphereGeometry(1.0, 28, 18);
  podGeo.scale(1, 1.4, 1);
  for (let i = 0; i < 4; i++) {
    const p = new THREE.Mesh(podGeo, podMat);
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    p.position.set(Math.cos(a) * 5.4, Math.sin(a) * 5.4, 0);
    p.rotation.z = a;
    ringA.add(p);
    pods.push(p);
  }
  // Rounded crown horns.
  const hornGeo = new THREE.CapsuleGeometry(0.42, 2.2, 8, 16);
  for (let i = 0; i < 5; i++) {
    const h = new THREE.Mesh(hornGeo, shellMat);
    const a = Math.PI / 2 + (i - 2) * 0.38;
    h.position.set(Math.cos(a) * 3.5, Math.sin(a) * 3.5, -0.4);
    h.rotation.z = a - Math.PI / 2;
    root.add(h);
  }
  return { root, core, ringA, ringB, pods, materials: [coreMat, shellMat, podMat, eyeMat, pupilMat] };
}
