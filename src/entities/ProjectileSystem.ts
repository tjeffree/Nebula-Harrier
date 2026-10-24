import * as THREE from 'three';
import { createSpriteMaterial } from '../procgen/Shaders';
import { ATLAS } from '../procgen/ModelFactory';

// ---------------------------------------------------------------------------
// SpriteBatch: one InstancedMesh (one draw call) for every billboard in the
// frame — bullets, particles, mines, distant LODs — sampling the baked atlas.
// ---------------------------------------------------------------------------
export class SpriteBatch {
  readonly mesh: THREE.InstancedMesh;
  private readonly pos: Float32Array;
  private readonly params: Float32Array;
  private readonly color: Float32Array;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aParams: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private n = 0;

  constructor(readonly capacity: number, atlas: THREE.Texture) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.pos = new Float32Array(capacity * 3);
    this.params = new Float32Array(capacity * 4);
    this.color = new Float32Array(capacity * 4);
    this.aPos = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aParams = new THREE.InstancedBufferAttribute(this.params, 4).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.InstancedBufferAttribute(this.color, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', this.aPos);
    geo.setAttribute('aParams', this.aParams);
    geo.setAttribute('aColor', this.aColor);
    this.mesh = new THREE.InstancedMesh(geo, createSpriteMaterial(atlas, ATLAS.COLS), capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 10;
  }

  begin(): void {
    this.n = 0;
  }

  push(
    x: number,
    y: number,
    z: number,
    cell: number,
    sx: number,
    sy: number,
    rot: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    if (this.n >= this.capacity) return;
    const i = this.n++;
    const p3 = i * 3;
    const p4 = i * 4;
    this.pos[p3] = x;
    this.pos[p3 + 1] = y;
    this.pos[p3 + 2] = z;
    this.params[p4] = cell;
    this.params[p4 + 1] = sx;
    this.params[p4 + 2] = sy;
    this.params[p4 + 3] = rot;
    this.color[p4] = r;
    this.color[p4 + 1] = g;
    this.color[p4 + 2] = b;
    this.color[p4 + 3] = a;
  }

  end(): void {
    const n = this.n;
    this.mesh.count = n;
    if (n === 0) return;
    for (const [attr, size] of [
      [this.aPos, 3],
      [this.aParams, 4],
      [this.aColor, 4],
    ] as const) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * size);
      attr.needsUpdate = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Collision interfaces
// ---------------------------------------------------------------------------
export interface Hittable {
  alive: boolean;
  /** Swept-sphere test against segment a->b; returns true on contact. */
  sweepHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): boolean;
}

export interface PlayerTarget {
  x: number;
  y: number;
  z: number;
  radius: number;
  vulnerable(): boolean;
  takeDamage(amount: number): void;
}

/** Closest-approach distance² between segment a->b and point c. */
export function segPointDist2(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = l2 > 1e-9 ? ((cx - ax) * dx + (cy - ay) * dy + (cz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t - cx;
  const py = ay + dy * t - cy;
  const pz = az + dz * t - cz;
  return px * px + py * py + pz * pz;
}

// ---------------------------------------------------------------------------
// Bullet pools (struct-of-arrays, swap-remove, zero per-frame allocation)
// ---------------------------------------------------------------------------
class BulletPool {
  count = 0;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly life: Float32Array;
  readonly dmg: Float32Array;
  readonly size: Float32Array;
  readonly cell: Uint8Array;
  readonly homing: Float32Array;
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;

  constructor(readonly capacity: number) {
    const f = () => new Float32Array(capacity);
    this.x = f();
    this.y = f();
    this.z = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.life = f();
    this.dmg = f();
    this.size = f();
    this.homing = f();
    this.r = f();
    this.g = f();
    this.b = f();
    this.cell = new Uint8Array(capacity);
  }

  add(): number {
    if (this.count >= this.capacity) return -1;
    return this.count++;
  }

  remove(i: number): void {
    const j = --this.count;
    if (i === j) return;
    this.x[i] = this.x[j];
    this.y[i] = this.y[j];
    this.z[i] = this.z[j];
    this.vx[i] = this.vx[j];
    this.vy[i] = this.vy[j];
    this.vz[i] = this.vz[j];
    this.life[i] = this.life[j];
    this.dmg[i] = this.dmg[j];
    this.size[i] = this.size[j];
    this.cell[i] = this.cell[j];
    this.homing[i] = this.homing[j];
    this.r[i] = this.r[j];
    this.g[i] = this.g[j];
    this.b[i] = this.b[j];
  }
}

export type PlayerHitCallback = (target: Hittable, x: number, y: number, z: number, damage: number) => void;

/**
 * Instanced bullet manager for player and hostile fire. Rendering goes through
 * the shared SpriteBatch so thousands of bullets cost a single draw call.
 */
export class ProjectileSystem {
  readonly player = new BulletPool(1024);
  readonly enemy = new BulletPool(4096);
  onPlayerBulletHit: PlayerHitCallback = () => {};
  /** Hostile bullets beyond this z (behind the camera plane) are culled. */
  private readonly nearZ = 7;
  private readonly farZ = -190;

  spawnPlayer(x: number, y: number, z: number, vx: number, vy: number, vz: number, dmg: number, size = 1.1): void {
    const p = this.player;
    const i = p.add();
    if (i < 0) return;
    p.x[i] = x;
    p.y[i] = y;
    p.z[i] = z;
    p.vx[i] = vx;
    p.vy[i] = vy;
    p.vz[i] = vz;
    p.dmg[i] = dmg;
    p.life[i] = 2.0;
    p.size[i] = size;
    p.cell[i] = ATLAS.PLAYER_BOLT;
    p.homing[i] = 0;
    p.r[i] = 0.55;
    p.g[i] = 1.6;
    p.b[i] = 2.0;
  }

  spawnEnemy(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    opts: { dmg?: number; homing?: number; needle?: boolean; size?: number; color?: number } = {},
  ): void {
    const e = this.enemy;
    const i = e.add();
    if (i < 0) return;
    e.x[i] = x;
    e.y[i] = y;
    e.z[i] = z;
    e.vx[i] = vx;
    e.vy[i] = vy;
    e.vz[i] = vz;
    e.dmg[i] = opts.dmg ?? 12;
    e.life[i] = 9;
    e.size[i] = opts.size ?? (opts.needle ? 1.3 : 1.0);
    e.cell[i] = opts.needle ? ATLAS.ENEMY_NEEDLE : ATLAS.ENEMY_ORB;
    e.homing[i] = opts.homing ?? 0;
    const c = opts.color ?? 0xff4fa0;
    e.r[i] = (((c >> 16) & 255) / 255) * 1.8;
    e.g[i] = (((c >> 8) & 255) / 255) * 1.8;
    e.b[i] = ((c & 255) / 255) * 1.8;
  }

  /** Converts every hostile bullet into a spark (e.g. on boss death / bomb). */
  clearEnemyBullets(particles?: ParticleSystem): void {
    const e = this.enemy;
    if (particles) {
      for (let i = 0; i < e.count; i++) particles.spark(e.x[i], e.y[i], e.z[i], e.r[i], e.g[i], e.b[i]);
    }
    e.count = 0;
  }

  clearAll(): void {
    this.player.count = 0;
    this.enemy.count = 0;
  }

  update(dt: number, targets: readonly Hittable[], playerT: PlayerTarget, speedMul: number): void {
    // Player bolts: integrate, then swept-sphere test against enemy hulls.
    const p = this.player;
    for (let i = p.count - 1; i >= 0; i--) {
      const ax = p.x[i];
      const ay = p.y[i];
      const az = p.z[i];
      const bx = ax + p.vx[i] * dt;
      const by = ay + p.vy[i] * dt;
      const bz = az + p.vz[i] * dt;
      p.x[i] = bx;
      p.y[i] = by;
      p.z[i] = bz;
      p.life[i] -= dt;
      let dead = p.life[i] <= 0 || bz < this.farZ || by < -1;
      if (!dead) {
        for (let k = 0; k < targets.length; k++) {
          const t = targets[k];
          if (!t.alive) continue;
          if (t.sweepHit(ax, ay, az, bx, by, bz, 0.4)) {
            this.onPlayerBulletHit(t, bx, by, bz, p.dmg[i]);
            dead = true;
            break;
          }
        }
      }
      if (dead) p.remove(i);
    }

    // Hostile bullets: integrate with optional homing, test against the player.
    const e = this.enemy;
    const pr = playerT.radius;
    const canHit = playerT.vulnerable();
    for (let i = e.count - 1; i >= 0; i--) {
      if (e.homing[i] > 0) {
        const speed = Math.hypot(e.vx[i], e.vy[i], e.vz[i]);
        const dx = playerT.x - e.x[i];
        const dy = playerT.y - e.y[i];
        const dz = playerT.z - e.z[i];
        const dl = Math.hypot(dx, dy, dz) || 1;
        const k = Math.min(1, e.homing[i] * dt);
        e.vx[i] += ((dx / dl) * speed - e.vx[i]) * k;
        e.vy[i] += ((dy / dl) * speed - e.vy[i]) * k;
        e.vz[i] += ((dz / dl) * speed - e.vz[i]) * k;
        e.homing[i] = Math.max(0, e.homing[i] - dt * 0.9);
      }
      const ax = e.x[i];
      const ay = e.y[i];
      const az = e.z[i];
      const s = dt * speedMul;
      const bx = ax + e.vx[i] * s;
      const by = ay + e.vy[i] * s;
      const bz = az + e.vz[i] * s;
      e.x[i] = bx;
      e.y[i] = by;
      e.z[i] = bz;
      e.life[i] -= dt;
      let dead = e.life[i] <= 0 || bz > this.nearZ || by < -2 || Math.abs(bx) > 40;
      if (!dead && canHit) {
        const rr = pr + 0.3 * e.size[i];
        if (segPointDist2(ax, ay, az, bx, by, bz, playerT.x, playerT.y, playerT.z) < rr * rr) {
          playerT.takeDamage(e.dmg[i]);
          dead = true;
        }
      }
      if (dead) e.remove(i);
    }
  }

  render(batch: SpriteBatch, time: number): void {
    const p = this.player;
    for (let i = 0; i < p.count; i++) {
      const s = p.size[i];
      batch.push(p.x[i], p.y[i], p.z[i], p.cell[i], s * 0.7, s * 1.5, 0, p.r[i], p.g[i], p.b[i], 1);
    }
    const e = this.enemy;
    for (let i = 0; i < e.count; i++) {
      const s = e.size[i];
      const needle = e.cell[i] === ATLAS.ENEMY_NEEDLE;
      const rot = needle ? Math.atan2(e.vy[i], e.vx[i]) - Math.PI / 2 : time * 4 + i;
      const pulse = 1 + 0.15 * Math.sin(time * 18 + i);
      batch.push(
        e.x[i],
        e.y[i],
        e.z[i],
        e.cell[i],
        s * (needle ? 0.5 : pulse),
        s * (needle ? 1.8 : pulse),
        rot,
        e.r[i],
        e.g[i],
        e.b[i],
        1,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Particle system
// ---------------------------------------------------------------------------
const P_FIELDS = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'life', 'max', 's0', 's1', 'r', 'g', 'b', 'drag', 'rot', 'vr', 'cell', 'anim', 'stretch'] as const;
type PField = (typeof P_FIELDS)[number];

export class ParticleSystem {
  count = 0;
  private readonly f: Record<PField, Float32Array>;

  constructor(readonly capacity = 4096) {
    this.f = {} as Record<PField, Float32Array>;
    for (const k of P_FIELDS) this.f[k] = new Float32Array(capacity);
  }

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    s0: number,
    s1: number,
    r: number,
    g: number,
    b: number,
    cell: number = ATLAS.GLOW,
    drag = 2,
    anim = 0,
    stretch = 0,
  ): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    const f = this.f;
    f.x[i] = x;
    f.y[i] = y;
    f.z[i] = z;
    f.vx[i] = vx;
    f.vy[i] = vy;
    f.vz[i] = vz;
    f.life[i] = life;
    f.max[i] = life;
    f.s0[i] = s0;
    f.s1[i] = s1;
    f.r[i] = r;
    f.g[i] = g;
    f.b[i] = b;
    f.drag[i] = drag;
    f.rot[i] = Math.random() * Math.PI * 2;
    f.vr[i] = (Math.random() - 0.5) * 6;
    f.cell[i] = cell;
    f.anim[i] = anim;
    f.stretch[i] = stretch;
  }

  spark(x: number, y: number, z: number, r = 1, g = 1, b = 1): void {
    const a = Math.random() * Math.PI * 2;
    const s = 4 + Math.random() * 8;
    this.emit(x, y, z, Math.cos(a) * s, Math.sin(a) * s, (Math.random() - 0.3) * 6, 0.35, 0.7, 0.05, r, g, b, ATLAS.SPARK, 4);
  }

  burst(x: number, y: number, z: number, n: number, speed: number, r: number, g: number, b: number, life = 0.6): void {
    for (let k = 0; k < n; k++) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const q = Math.sqrt(1 - u * u);
      const s = speed * (0.4 + Math.random() * 0.6);
      this.emit(x, y, z, q * Math.cos(a) * s, q * Math.sin(a) * s, u * s, life * (0.6 + Math.random() * 0.6), 0.6, 0.05, r, g, b, ATLAS.SPARK, 3);
    }
  }

  /** Flipbook explosion + shockwave ring + debris sparks. */
  explosion(x: number, y: number, z: number, scale: number, r = 1.4, g = 0.6, b = 1.6): void {
    this.emit(x, y, z, 0, 0, 0, 0.55, 3.2 * scale, 6.5 * scale, 1.3, 1.3, 1.3, ATLAS.EXPLOSION_START, 0, 1);
    this.emit(x, y, z, 0, 0, 0, 0.4, 1 * scale, 9 * scale, r, g, b, ATLAS.RING, 0);
    const n = Math.min(40, Math.round(10 + scale * 8));
    this.burst(x, y, z, n, 14 * Math.sqrt(scale), r, g, b, 0.7);
    for (let k = 0; k < 3 * scale; k++) {
      const ox = (Math.random() - 0.5) * 2 * scale;
      const oy = (Math.random() - 0.5) * 2 * scale;
      this.emit(x + ox, y + oy, z, ox * 2, oy * 2, 4, 0.5 + Math.random() * 0.3, 1.5 * scale, 4 * scale, 1.2, 1.2, 1.2, ATLAS.EXPLOSION_START, 1, 1);
    }
  }

  clear(): void {
    this.count = 0;
  }

  update(dt: number, scrollSpeed: number): void {
    const f = this.f;
    for (let i = this.count - 1; i >= 0; i--) {
      f.life[i] -= dt;
      if (f.life[i] <= 0) {
        const j = --this.count;
        if (i !== j) for (const k of P_FIELDS) f[k][i] = f[k][j];
        continue;
      }
      const d = Math.max(0, 1 - f.drag[i] * dt);
      f.vx[i] *= d;
      f.vy[i] *= d;
      f.vz[i] *= d;
      f.x[i] += f.vx[i] * dt;
      f.y[i] += f.vy[i] * dt;
      // World-anchored particles drift with the rail scroll.
      f.z[i] += (f.vz[i] + scrollSpeed * 0.35) * dt;
      f.rot[i] += f.vr[i] * dt;
    }
  }

  render(batch: SpriteBatch): void {
    const f = this.f;
    for (let i = 0; i < this.count; i++) {
      const t = 1 - f.life[i] / f.max[i];
      const s = f.s0[i] + (f.s1[i] - f.s0[i]) * t;
      let cell = f.cell[i];
      let a = 1 - t;
      if (f.anim[i] > 0) {
        cell = ATLAS.EXPLOSION_START + Math.min(ATLAS.EXPLOSION_FRAMES - 1, Math.floor(t * ATLAS.EXPLOSION_FRAMES));
        a = 1;
      }
      const sy = f.stretch[i] > 0 ? s * f.stretch[i] : s;
      batch.push(f.x[i], f.y[i], f.z[i], cell, s, sy, f.stretch[i] > 0 ? 0 : f.rot[i], f.r[i], f.g[i], f.b[i], a);
    }
  }
}

// ---------------------------------------------------------------------------
// Chain-lightning arcs (dynamic line segments, single draw call)
// ---------------------------------------------------------------------------
export class ArcRenderer {
  readonly lines: THREE.LineSegments;
  private readonly positions: Float32Array;
  private readonly attr: THREE.BufferAttribute;
  private arcs: { ax: number; ay: number; az: number; bx: number; by: number; bz: number; life: number }[] = [];
  private static readonly SEGS = 7;
  private static readonly MAX_ARCS = 96;

  constructor() {
    this.positions = new Float32Array(ArcRenderer.MAX_ARCS * ArcRenderer.SEGS * 2 * 3);
    const geo = new THREE.BufferGeometry();
    this.attr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.attr);
    geo.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({
        color: new THREE.Color(0.7, 1.4, 2.0),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 11;
  }

  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    if (this.arcs.length >= ArcRenderer.MAX_ARCS) this.arcs.shift();
    this.arcs.push({ ax, ay, az, bx, by, bz, life: 0.14 });
  }

  clear(): void {
    this.arcs.length = 0;
    this.lines.geometry.setDrawRange(0, 0);
  }

  update(dt: number): void {
    const S = ArcRenderer.SEGS;
    let v = 0;
    const P = this.positions;
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const a = this.arcs[i];
      a.life -= dt;
      if (a.life <= 0) this.arcs.splice(i, 1);
    }
    for (const a of this.arcs) {
      let px = a.ax;
      let py = a.ay;
      let pz = a.az;
      for (let s = 1; s <= S; s++) {
        const t = s / S;
        const j = s === S ? 0 : 0.6;
        const nx = a.ax + (a.bx - a.ax) * t + (Math.random() - 0.5) * j;
        const ny = a.ay + (a.by - a.ay) * t + (Math.random() - 0.5) * j;
        const nz = a.az + (a.bz - a.az) * t + (Math.random() - 0.5) * j;
        P[v++] = px;
        P[v++] = py;
        P[v++] = pz;
        P[v++] = nx;
        P[v++] = ny;
        P[v++] = nz;
        px = nx;
        py = ny;
        pz = nz;
      }
    }
    this.lines.geometry.setDrawRange(0, v / 3);
    if (v > 0) {
      this.attr.clearUpdateRanges();
      this.attr.addUpdateRange(0, v);
      this.attr.needsUpdate = true;
    }
  }
}
