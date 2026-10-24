import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { SoundSynth } from '../audio/SoundSynth';
import type { ModifierEffects } from '../procgen/SectorBuilder';
import { segPointDist2, type Hittable, type ParticleSystem, type ProjectileSystem, type SpriteBatch } from './ProjectileSystem';

/** Everything an enemy may read or drive during its update. */
export interface GameContext {
  scene: THREE.Scene;
  time: number;
  railSpeed: number;
  sector: number;
  player: { pos: THREE.Vector3; vel: THREE.Vector3; alive: boolean };
  projectiles: ProjectileSystem;
  particles: ParticleSystem;
  batch: SpriteBatch;
  sfx: SoundSynth;
  fx: ModifierEffects;
  enemies: EnemyManager;
  wyrmWriter: InstanceWriter;
  /** Body colour for instanced swarm enemies (sector accent). */
  accentColor: THREE.Color;
}

const _v = new THREE.Vector3();

/** Shared behaviour for every hostile: health, flash, swept hit tests, rewards. */
export abstract class Enemy implements Hittable {
  alive = true;
  readonly pos = new THREE.Vector3();
  hp: number;
  maxHp: number;
  age = 0;
  flash = 0;
  /** Accepts hits / contact only while true (e.g. not while waiting to enter). */
  active = true;
  isBoss = false;
  contactDamage = 20;
  /** Index of the sub-part struck by the most recent successful sweepHit (-1 = main hull). */
  protected lastPart = -1;

  constructor(
    readonly kind: string,
    hp: number,
    public radius: number,
    readonly points: number,
    readonly cost: number,
  ) {
    this.hp = hp;
    this.maxHp = hp;
  }

  abstract update(dt: number, ctx: GameContext): void;
  /** Removes scene graph objects. Called exactly once after death/despawn. */
  abstract dispose(ctx: GameContext): void;

  sweepHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): boolean {
    if (!this.active) return false;
    const rr = this.radius + r;
    this.lastPart = -1;
    return segPointDist2(ax, ay, az, bx, by, bz, this.pos.x, this.pos.y, this.pos.z) < rr * rr;
  }

  /** Applies damage; returns true if this blow destroyed the enemy. */
  damage(amount: number, ctx: GameContext): boolean {
    if (!this.alive) return false;
    this.hp -= amount;
    this.flash = 1;
    if (this.hp <= 0) {
      this.kill(ctx);
      return true;
    }
    return false;
  }

  kill(ctx: GameContext): void {
    if (!this.alive) return;
    this.alive = false;
    this.onDeath(ctx);
    if (ctx.fx.volatile && !this.isBoss) {
      // Volatile modifier: shrapnel ring.
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + ctx.time;
        ctx.projectiles.spawnEnemy(this.pos.x, this.pos.y, this.pos.z, Math.cos(a) * 5, Math.sin(a) * 5, 14, {
          color: 0xffb347,
          size: 0.8,
          dmg: 8,
        });
      }
    }
    bus.emit('enemy:killed', { x: this.pos.x, y: this.pos.y, z: this.pos.z, points: this.points, kind: this.kind });
  }

  /** Leaves the field without reward. */
  despawn(): void {
    this.alive = false;
  }

  protected onDeath(ctx: GameContext): void {
    ctx.particles.explosion(this.pos.x, this.pos.y, this.pos.z, Math.max(1, this.radius * 0.9));
  }

  /** Fires an aimed shot at the player's predicted position. */
  protected fireAt(
    ctx: GameContext,
    from: THREE.Vector3,
    speed: number,
    lead = 0.6,
    opts: Parameters<ProjectileSystem['spawnEnemy']>[6] = {},
    yaw = 0,
  ): void {
    const p = ctx.player.pos;
    const s = speed * ctx.fx.bulletSpeedMul;
    const dist = from.distanceTo(p);
    const tFlight = dist / s;
    _v.set(p.x + ctx.player.vel.x * tFlight * lead, p.y + 0.9 + ctx.player.vel.y * tFlight * lead, p.z).sub(from);
    if (yaw !== 0) _v.applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
    _v.normalize().multiplyScalar(speed);
    ctx.projectiles.spawnEnemy(from.x, from.y, from.z, _v.x, _v.y, _v.z, opts);
  }
}

/** Writes per-frame transforms into a shared InstancedMesh (one draw call per type). */
export class InstanceWriter {
  private n = 0;
  private readonly m = new THREE.Matrix4();
  private readonly c = new THREE.Color();

  constructor(readonly mesh: THREE.InstancedMesh) {}

  begin(): void {
    this.n = 0;
  }

  write(pos: THREE.Vector3, quat: THREE.Quaternion, scale: THREE.Vector3, r: number, g: number, b: number): void {
    if (this.n >= this.mesh.instanceMatrix.count) return;
    this.m.compose(pos, quat, scale);
    this.mesh.setMatrixAt(this.n, this.m);
    this.mesh.setColorAt(this.n, this.c.setRGB(r, g, b));
    this.n++;
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

/** Cubic Hermite interpolation used for enemy fly-in paths. */
export function hermite(
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  m0: THREE.Vector3,
  m1: THREE.Vector3,
  t: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return out.set(
    h00 * p0.x + h10 * m0.x + h01 * p1.x + h11 * m1.x,
    h00 * p0.y + h10 * m0.y + h01 * p1.y + h11 * m1.y,
    h00 * p0.z + h10 * m0.z + h01 * p1.z + h11 * m1.z,
  );
}

/** Owns the live enemy list, contact checks and spatial queries. */
export class EnemyManager {
  readonly list: Enemy[] = [];

  add(e: Enemy): void {
    this.list.push(e);
  }

  aliveCost(): number {
    let c = 0;
    for (const e of this.list) if (e.alive && !e.isBoss) c += e.cost;
    return c;
  }

  update(dt: number, ctx: GameContext, onContact: (e: Enemy) => void, playerRadius: number): void {
    const p = ctx.player.pos;
    const py = p.y + 0.9;
    for (const e of this.list) {
      if (!e.alive) continue;
      e.age += dt;
      e.flash = Math.max(0, e.flash - dt * 8);
      e.update(dt, ctx);
      if (e.alive && ctx.player.alive && e.sweepHit(p.x, py, p.z, p.x, py, p.z, playerRadius)) onContact(e);
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (!e.alive) {
        e.dispose(ctx);
        this.list.splice(i, 1);
      }
    }
  }

  /** Up to `count` nearest live enemies within `range` of a point, excluding one. */
  nearest(x: number, y: number, z: number, range: number, count: number, exclude: Enemy | null, out: Enemy[]): Enemy[] {
    out.length = 0;
    const r2 = range * range;
    const cands: { e: Enemy; d: number }[] = [];
    for (const e of this.list) {
      if (!e.alive || !e.active || e === exclude) continue;
      const d = (e.pos.x - x) ** 2 + (e.pos.y - y) ** 2 + (e.pos.z - z) ** 2;
      if (d < r2) cands.push({ e, d });
    }
    cands.sort((a, b) => a.d - b.d);
    for (let i = 0; i < Math.min(count, cands.length); i++) out.push(cands[i].e);
    return out;
  }

  clear(ctx: GameContext): void {
    for (const e of this.list) {
      e.alive = false;
      e.dispose(ctx);
    }
    this.list.length = 0;
  }
}
