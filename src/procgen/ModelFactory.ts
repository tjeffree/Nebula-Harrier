import * as THREE from 'three';
import {
  createCrystalMaterial,
  createGroundMaterial,
  createNeonLineMaterial,
  createSkyMaterial,
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
  GLOW: 15,
} as const;

/** Loads the baked sprite atlas, falling back to a runtime-drawn glow atlas if missing. */
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

function drawFallbackAtlas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 16; i++) {
    const x = (i % 4) * 64 + 32;
    const y = Math.floor(i / 4) * 64 + 32;
    const grad = g.createRadialGradient(x, y, 0, x, y, 30);
    const hot = i >= ATLAS.EXPLOSION_START && i < ATLAS.EXPLOSION_START + ATLAS.EXPLOSION_FRAMES;
    grad.addColorStop(0, '#fff');
    grad.addColorStop(0.4, hot ? 'rgba(255,150,80,0.7)' : 'rgba(255,255,255,0.5)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(x - 32, y - 32, 64, 64);
  }
  return c;
}

/** Faceted (flat-normal) copy of a geometry for the crystal look. */
function facet(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
}

export function addNeonEdges(mesh: THREE.Mesh, color: THREE.ColorRepresentation, threshold = 20): THREE.LineSegments {
  const lines = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, threshold), createNeonLineMaterial(color));
  mesh.add(lines);
  return lines;
}

// ---------------------------------------------------------------------------
// Player Harrier
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

export function createPlayerModel(accent: number = 0x29f0ff, trim: number = 0xff2bd6): PlayerModel {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const hull = createCrystalMaterial({ base: 0x1c1238, edge: accent, iridescence: 0.8 });
  const dark = createCrystalMaterial({ base: 0x0d0820, edge: trim, iridescence: 0.4 });
  const glow = createCrystalMaterial({ base: new THREE.Color(accent).multiplyScalar(0.8), edge: 0xffffff, iridescence: 0 });
  const materials = [hull, dark, glow];

  // Angular exo-suit torso: extruded V-profile.
  const s = new THREE.Shape();
  s.moveTo(-0.42, 0.0);
  s.lineTo(-0.58, 0.42);
  s.lineTo(-0.46, 0.78);
  s.lineTo(-0.16, 0.9);
  s.lineTo(0.16, 0.9);
  s.lineTo(0.46, 0.78);
  s.lineTo(0.58, 0.42);
  s.lineTo(0.42, 0.0);
  s.lineTo(0.18, -0.22);
  s.lineTo(-0.18, -0.22);
  s.closePath();
  const torsoGeo = new THREE.ExtrudeGeometry(s, {
    depth: 0.42,
    bevelEnabled: true,
    bevelThickness: 0.08,
    bevelSize: 0.06,
    bevelSegments: 1,
  });
  torsoGeo.translate(0, 0, -0.21);
  const torso = new THREE.Mesh(facet(torsoGeo), hull);
  torso.position.y = 0.95;
  body.add(torso);
  addNeonEdges(torso, accent, 30);

  // Spine plate with glowing core visible from behind.
  const core = new THREE.Mesh(facet(new THREE.OctahedronGeometry(0.17, 0)), glow);
  core.position.set(0, 1.4, 0.3);
  core.scale.set(1, 1.4, 0.6);
  body.add(core);

  // Helmet + visor.
  const head = new THREE.Mesh(facet(new THREE.IcosahedronGeometry(0.27, 0)), dark);
  head.position.set(0, 2.08, -0.02);
  head.scale.set(1, 1.1, 1.15);
  body.add(head);
  addNeonEdges(head, trim, 25);
  const fin = new THREE.Mesh(facet(new THREE.ConeGeometry(0.06, 0.4, 4)), hull);
  fin.position.set(0, 2.3, 0.12);
  fin.rotation.x = -0.9;
  body.add(fin);

  // Jet nacelles (backpack).
  const nozzles: THREE.Object3D[] = [];
  for (const side of [-1, 1]) {
    const n = new THREE.Mesh(facet(new THREE.CylinderGeometry(0.13, 0.2, 0.95, 6)), dark);
    n.position.set(side * 0.36, 1.45, 0.38);
    n.rotation.set(-0.35, 0, side * -0.18);
    body.add(n);
    addNeonEdges(n, trim, 25);
    const wing = new THREE.Mesh(facet(new THREE.BoxGeometry(0.75, 0.05, 0.32)), hull);
    wing.position.set(side * 0.55, 0.38, 0.0);
    wing.rotation.z = side * -0.5;
    n.add(wing);
    const noz = new THREE.Object3D();
    noz.position.set(0, -0.55, 0);
    n.add(noz);
    nozzles.push(noz);
  }

  // Legs (hip pivots) with knee pivots for procedural running.
  const mkLeg = (side: number) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.22, 0.78, 0);
    const thigh = new THREE.Mesh(facet(new THREE.BoxGeometry(0.22, 0.48, 0.26)), hull);
    thigh.position.y = -0.24;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -0.48;
    hip.add(knee);
    const shin = new THREE.Mesh(facet(new THREE.CylinderGeometry(0.13, 0.08, 0.5, 5)), dark);
    shin.position.y = -0.25;
    knee.add(shin);
    addNeonEdges(shin, accent, 25);
    const boot = new THREE.Mesh(facet(new THREE.BoxGeometry(0.2, 0.08, 0.34)), hull);
    boot.position.set(0, -0.5, -0.06);
    knee.add(boot);
    body.add(hip);
    return { hip, knee };
  };
  const L = mkLeg(-1);
  const R = mkLeg(1);

  // Left arm + right-hand arm cannon.
  const armL = new THREE.Group();
  armL.position.set(-0.62, 1.62, 0);
  const upperL = new THREE.Mesh(facet(new THREE.BoxGeometry(0.16, 0.55, 0.18)), dark);
  upperL.position.y = -0.27;
  armL.add(upperL);
  armL.rotation.z = -0.25;
  body.add(armL);

  const gun = new THREE.Group();
  gun.position.set(0.62, 1.5, -0.05);
  const barrel = new THREE.Mesh(facet(new THREE.CylinderGeometry(0.09, 0.14, 1.25, 6)), hull);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = -0.45;
  gun.add(barrel);
  addNeonEdges(barrel, accent, 25);
  const housing = new THREE.Mesh(facet(new THREE.BoxGeometry(0.26, 0.28, 0.5)), dark);
  gun.add(housing);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -1.1);
  gun.add(muzzle);
  body.add(gun);

  root.scale.setScalar(1.0);
  return {
    root,
    body,
    legL: L.hip,
    legR: R.hip,
    shinL: L.knee,
    shinR: R.knee,
    armL,
    gun,
    nozzles,
    muzzle,
    materials,
  };
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
export function createGround(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(60, 200, 30, 100);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, createGroundMaterial());
  mesh.position.z = -90; // spans z = +10 .. -190
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

export function createSky(): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), createSkyMaterial());
  mesh.frustumCulled = false;
  mesh.renderOrder = -2;
  return mesh;
}

export function createSpireInstanced(capacity: number): THREE.InstancedMesh {
  const geo = facet(new THREE.OctahedronGeometry(1, 0));
  geo.scale(0.9, 4.2, 0.9);
  geo.translate(0, 3.2, 0);
  const mat = createCrystalMaterial({ base: 0x140a2a, edge: 0xff2bd6, iridescence: 0.9 });
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, new THREE.Color(1, 1, 1));
  mesh.count = 0;
  mesh.frustumCulled = false;
  return mesh;
}

// ---------------------------------------------------------------------------
// Enemies
// ---------------------------------------------------------------------------
export function createWyrmInstanced(capacity: number): THREE.InstancedMesh {
  const geo = facet(new THREE.OctahedronGeometry(1, 0));
  geo.scale(0.95, 0.55, 1.25);
  const mat = createCrystalMaterial({ base: 0x2a0b26, edge: 0xffffff, iridescence: 0.7 });
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
  lines: THREE.ShaderMaterial[];
}

export function createSentinelModel(): SentinelModel {
  const root = new THREE.Group();
  const mat = createCrystalMaterial({ base: 0x10162e, edge: 0x5cff9d, iridescence: 0.5 });
  const emitMat = createCrystalMaterial({ base: 0xff3366, edge: 0xffffff, iridescence: 0 });
  const base = new THREE.Mesh(facet(new THREE.CylinderGeometry(1.2, 1.7, 0.6, 6)), mat);
  base.position.y = 0.3;
  const col = new THREE.Mesh(facet(new THREE.CylinderGeometry(0.32, 0.55, 3.2, 6)), mat);
  col.position.y = 2.1;
  const head = new THREE.Group();
  head.position.y = 4.0;
  const headMesh = new THREE.Mesh(facet(new THREE.OctahedronGeometry(0.95, 0)), mat);
  headMesh.scale.set(1.3, 0.7, 1.3);
  head.add(headMesh);
  const emitter = new THREE.Mesh(facet(new THREE.IcosahedronGeometry(0.3, 0)), emitMat);
  emitter.position.z = 0.9;
  head.add(emitter);
  root.add(base, col, head);
  const lines = [addNeonEdges(base, 0x5cff9d), addNeonEdges(col, 0x5cff9d), addNeonEdges(headMesh, 0x5cff9d)].map(
    (l) => l.material as THREE.ShaderMaterial,
  );
  return { root, head, emitter, materials: [mat, emitMat], lines };
}

export interface TitanModel {
  root: THREE.Group;
  core: THREE.Mesh;
  armor: THREE.Group;
  plates: THREE.Mesh[];
  coreMat: THREE.ShaderMaterial;
  plateMats: THREE.ShaderMaterial[];
}

export function createTitanModel(): TitanModel {
  const root = new THREE.Group();
  const coreMat = createCrystalMaterial({ base: 0x2b0a3a, edge: 0xffb347, iridescence: 1.0 });
  const core = new THREE.Mesh(facet(new THREE.IcosahedronGeometry(1.6, 0)), coreMat);
  root.add(core);
  addNeonEdges(core, 0xffb347);
  const armor = new THREE.Group();
  root.add(armor);
  const plates: THREE.Mesh[] = [];
  const plateMats: THREE.ShaderMaterial[] = [];
  const plateGeo = facet(new THREE.OctahedronGeometry(1, 0));
  plateGeo.scale(0.7, 1.3, 0.35);
  const PLATES = 6;
  for (let i = 0; i < PLATES; i++) {
    const m = createCrystalMaterial({ base: 0x170c2c, edge: 0xff2bd6, iridescence: 0.6 });
    const p = new THREE.Mesh(plateGeo, m);
    const a = (i / PLATES) * Math.PI * 2;
    p.position.set(Math.cos(a) * 2.6, Math.sin(a) * 2.6, 0.4);
    p.rotation.z = a + Math.PI / 2;
    armor.add(p);
    plates.push(p);
    plateMats.push(m);
  }
  return { root, core, armor, plates, coreMat, plateMats };
}

export interface BossModel {
  root: THREE.Group;
  core: THREE.Mesh;
  ringA: THREE.Group;
  ringB: THREE.Group;
  pods: THREE.Mesh[];
  materials: THREE.ShaderMaterial[];
  lineMats: THREE.ShaderMaterial[];
}

export function createBossModel(edge: number, accent: number): BossModel {
  const root = new THREE.Group();
  const coreMat = createCrystalMaterial({ base: 0x1d0a33, edge, iridescence: 1.1 });
  const shellMat = createCrystalMaterial({ base: 0x0e0820, edge: accent, iridescence: 0.6 });
  const core = new THREE.Mesh(facet(new THREE.DodecahedronGeometry(3.0, 0)), coreMat);
  root.add(core);
  const lineMats: THREE.ShaderMaterial[] = [addNeonEdges(core, edge).material as THREE.ShaderMaterial];

  const ringA = new THREE.Group();
  const ringMeshA = new THREE.Mesh(facet(new THREE.TorusGeometry(5.4, 0.3, 4, 10)), shellMat);
  ringA.add(ringMeshA);
  lineMats.push(addNeonEdges(ringMeshA, accent).material as THREE.ShaderMaterial);
  root.add(ringA);

  const ringB = new THREE.Group();
  const ringMeshB = new THREE.Mesh(facet(new THREE.TorusGeometry(4.2, 0.22, 4, 8)), shellMat);
  ringMeshB.rotation.x = Math.PI / 2;
  ringB.add(ringMeshB);
  lineMats.push(addNeonEdges(ringMeshB, edge).material as THREE.ShaderMaterial);
  root.add(ringB);

  const pods: THREE.Mesh[] = [];
  const podGeo = facet(new THREE.OctahedronGeometry(1.0, 0));
  podGeo.scale(1, 1.6, 1);
  for (let i = 0; i < 4; i++) {
    const p = new THREE.Mesh(podGeo, shellMat);
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    p.position.set(Math.cos(a) * 5.4, Math.sin(a) * 5.4, 0);
    p.rotation.z = a;
    ringA.add(p);
    pods.push(p);
  }
  // Crown spikes.
  const spikeGeo = facet(new THREE.ConeGeometry(0.5, 3.2, 4));
  for (let i = 0; i < 5; i++) {
    const sp = new THREE.Mesh(spikeGeo, shellMat);
    const a = Math.PI / 2 + (i - 2) * 0.38;
    sp.position.set(Math.cos(a) * 3.3, Math.sin(a) * 3.3, 0);
    sp.rotation.z = a - Math.PI / 2;
    root.add(sp);
  }
  return { root, core, ringA, ringB, pods, materials: [coreMat, shellMat], lineMats };
}
