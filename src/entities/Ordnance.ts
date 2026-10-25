import { ATLAS } from '../procgen/ModelFactory';
import type { RunStats } from '../roguelite/BoonRegistry';
import type { Enemy, GameContext } from './EnemyBase';
import type { ArcRenderer } from './ProjectileSystem';

export type SecondaryId = 'nova' | 'swarm' | 'arc';

export interface SecondaryDef {
  id: SecondaryId;
  name: string;
  /** Fits the HUD label column and the touch button. */
  short: string;
  blurb: string;
  cooldown: number;
  color: [number, number, number];
}

export const SECONDARIES: Record<SecondaryId, SecondaryDef> = {
  nova: {
    id: 'nova',
    name: 'Nova Bomb',
    short: 'Nova',
    blurb: 'Detonates ahead, wiping hostile fire and gutting everything nearby.',
    cooldown: 10,
    color: [1, 0.72, 0.3],
  },
  swarm: {
    id: 'swarm',
    name: 'Swarm Missiles',
    short: 'Swarm',
    blurb: 'Six seekers that lock onto the nearest targets.',
    cooldown: 6,
    color: [1, 0.45, 0.3],
  },
  arc: {
    id: 'arc',
    name: 'Arc Storm',
    short: 'Arc',
    blurb: 'Lightning leaps to up to eight targets ahead.',
    cooldown: 7,
    color: [0.55, 0.85, 1],
  },
};

const IDS = Object.keys(SECONDARIES) as SecondaryId[];

interface Missile {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  target: Enemy | null;
  life: number;
}

interface Pod {
  id: SecondaryId;
  x: number;
  y: number;
  z: number;
  age: number;
}

export interface OrdnanceContext {
  game: GameContext;
  arcs: ArcRenderer;
  stats: RunStats;
}

const MISSILE_SPEED = 55;
const POD_RADIUS = 1.9;

/**
 * The secondary weapon slot: one equipped ordnance type on a cooldown, the
 * missiles it has in flight, and weapon pods dropped by kills that swap it.
 */
export class Ordnance {
  equipped: SecondaryId | null = null;
  cooldownLeft = 0;
  /** Called when the player flies through a pod. */
  onPickup: (id: SecondaryId) => void = () => {};
  private readonly missiles: Missile[] = [];
  private readonly pods: Pod[] = [];
  private readonly near: Enemy[] = [];

  cooldown(stats: RunStats): number {
    return this.equipped ? SECONDARIES[this.equipped].cooldown * stats.secondaryCdMul : 0;
  }

  /** 0 = just fired, 1 = ready. */
  readiness(stats: RunStats): number {
    const cd = this.cooldown(stats);
    return cd > 0 ? 1 - this.cooldownLeft / cd : 0;
  }

  reset(start: SecondaryId | null): void {
    this.equipped = start;
    this.cooldownLeft = 0;
    this.clearField();
  }

  /** Drops in-flight missiles and pods (between sectors); keeps the equipped weapon. */
  clearField(): void {
    this.missiles.length = 0;
    this.pods.length = 0;
  }

  /** Fires from the given muzzle point; false if empty or still cooling. */
  tryFire(x: number, y: number, z: number, c: OrdnanceContext): boolean {
    if (!this.equipped || this.cooldownLeft > 0) return false;
    this.cooldownLeft = this.cooldown(c.stats);
    const g = c.game;
    const dmg = c.stats.damage * c.stats.secondaryDmgMul;
    switch (this.equipped) {
      case 'nova': {
        const bz = z - 18;
        for (const e of g.enemies.list) {
          if (!e.alive || !e.active) continue;
          const d2 = (e.pos.x - x) ** 2 + (e.pos.y - y) ** 2 + (e.pos.z - bz) ** 2;
          if (d2 < 14 * 14) e.damage(30 * dmg, g);
        }
        g.projectiles.clearEnemyBullets(g.particles);
        g.particles.explosion(x, y, bz, 4, 1, 0.72, 0.3);
        g.particles.explosion(x, y, bz - 6, 2.5, 1, 0.85, 0.5);
        g.sfx.explosion(2.2);
        break;
      }
      case 'swarm':
        for (let i = 0; i < 6; i++) {
          const a = (i / 5 - 0.5) * 2.2;
          this.missiles.push({ x, y, z, vx: Math.sin(a) * 18, vy: 10 + Math.random() * 6, vz: -20, target: null, life: 3 });
        }
        g.sfx.dash();
        g.sfx.laser(0.55);
        break;
      case 'arc': {
        const hit = this.near;
        hit.length = 0;
        for (const e of g.enemies.list) {
          if (e.alive && e.active && e.pos.z < z - 3 && e.pos.z > z - 110) hit.push(e);
        }
        hit.sort((a, b) => b.pos.z - a.pos.z);
        hit.length = Math.min(hit.length, 8);
        let px = x;
        let py = y;
        let pz = z;
        for (const e of hit) {
          c.arcs.add(px, py, pz, e.pos.x, e.pos.y, e.pos.z);
          c.arcs.add(x, y, z, e.pos.x, e.pos.y, e.pos.z);
          e.damage(12 * dmg, g);
          g.particles.burst(e.pos.x, e.pos.y, e.pos.z, 10, 10, 0.55, 0.85, 1);
          px = e.pos.x;
          py = e.pos.y;
          pz = e.pos.z;
        }
        g.particles.burst(x, y, z, 16, 8, 0.55, 0.85, 1);
        g.sfx.chain();
        break;
      }
    }
    return true;
  }

  /** Rolls for a weapon pod where an enemy died. */
  maybeDrop(x: number, y: number, z: number, kind: string): void {
    if (kind === 'boss' || this.pods.length > 0) return;
    const big = kind === 'titan' || kind === 'sentinel';
    const chance = big ? 0.4 : this.equipped ? 0.04 : 0.12;
    if (Math.random() >= chance) return;
    const pool = IDS.filter((id) => id !== this.equipped);
    const id = pool[Math.floor(Math.random() * pool.length)];
    this.pods.push({ id, x: Math.max(-9, Math.min(9, x)), y: Math.max(0.8, Math.min(7, y)), z, age: 0 });
  }

  update(dt: number, px: number, py: number, pz: number, c: OrdnanceContext): void {
    this.cooldownLeft = Math.max(0, this.cooldownLeft - dt);
    this.updateMissiles(dt, c);
    this.updatePods(dt, px, py, pz, c.game);
  }

  private updateMissiles(dt: number, c: OrdnanceContext): void {
    const g = c.game;
    const dmg = c.stats.damage * c.stats.secondaryDmgMul;
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.life -= dt;
      if (!m.target || !m.target.alive || !m.target.active) m.target = this.acquire(m, g);
      if (m.target && m.life < 2.85) {
        const t = m.target.pos;
        const dx = t.x - m.x;
        const dy = t.y - m.y;
        const dz = t.z - m.z;
        const len = Math.hypot(dx, dy, dz) || 1;
        const k = Math.min(1, dt * 7);
        m.vx += ((dx / len) * MISSILE_SPEED - m.vx) * k;
        m.vy += ((dy / len) * MISSILE_SPEED - m.vy) * k;
        m.vz += ((dz / len) * MISSILE_SPEED - m.vz) * k;
      } else {
        m.vy -= 12 * dt;
        m.vz -= 40 * dt;
      }
      const ax = m.x;
      const ay = m.y;
      const az = m.z;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.z += m.vz * dt;
      let struck: Enemy | null = null;
      for (const e of g.enemies.list) {
        if (e.alive && e.sweepHit(ax, ay, az, m.x, m.y, m.z, 0.5)) {
          struck = e;
          break;
        }
      }
      if (struck || m.life <= 0 || m.y < 0) {
        if (struck) struck.damage(6 * dmg, g);
        for (const e of g.enemies.list) {
          if (e !== struck && e.alive && e.active && (e.pos.x - m.x) ** 2 + (e.pos.y - m.y) ** 2 + (e.pos.z - m.z) ** 2 < 3 * 3) e.damage(2 * dmg, g);
        }
        g.particles.explosion(m.x, m.y, m.z, 0.9, 1, 0.55, 0.3);
        g.sfx.explosion(0.6);
        this.missiles.splice(i, 1);
        continue;
      }
      g.particles.emit(m.x, m.y, m.z, 0, 0, 0, 0.35, 0.35, 0.9, 0.75, 0.72, 0.7);
      g.batch.push(m.x, m.y, m.z, ATLAS.PLAYER_BOLT, 0.9, 0.9, 0, 2, 1.1, 0.6, 1);
    }
  }

  /** Nearest live enemy ahead of the missile that no other missile is already chasing, if possible. */
  private acquire(m: Missile, g: GameContext): Enemy | null {
    let best: Enemy | null = null;
    let bestD = Infinity;
    for (const e of g.enemies.list) {
      if (!e.alive || !e.active || e.pos.z > m.z + 2) continue;
      const taken = this.missiles.some((o) => o !== m && o.target === e);
      const d = (e.pos.x - m.x) ** 2 + (e.pos.y - m.y) ** 2 + (e.pos.z - m.z) ** 2 * 0.25 + (taken ? 400 : 0);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private updatePods(dt: number, px: number, py: number, pz: number, g: GameContext): void {
    for (let i = this.pods.length - 1; i >= 0; i--) {
      const p = this.pods[i];
      p.age += dt;
      // Drift toward the camera so the player can steer through it.
      p.z += Math.max(10, g.railSpeed * 0.35) * dt;
      if ((p.x - px) ** 2 + (p.y - py) ** 2 + (p.z - pz) ** 2 < POD_RADIUS * POD_RADIUS) {
        this.equipped = p.id;
        this.cooldownLeft = 0;
        g.particles.burst(p.x, p.y, p.z, 24, 9, ...SECONDARIES[p.id].color);
        this.pods.splice(i, 1);
        this.onPickup(p.id);
        continue;
      }
      if (p.z > pz + 6) {
        this.pods.splice(i, 1);
        continue;
      }
      const [r, gg, b] = SECONDARIES[p.id].color;
      const bob = Math.sin(p.age * 5) * 0.2;
      const pulse = 1 + Math.sin(p.age * 9) * 0.08;
      g.batch.push(p.x, p.y + bob, p.z, ATLAS.RING, 3.4 * pulse, 3.4 * pulse, p.age * 2, r * 3, gg * 3, b * 3, 1);
      g.batch.push(p.x, p.y + bob, p.z, ATLAS.MINE, 1.8, 1.8, -p.age * 3, r * 3.5, gg * 3.5, b * 3.5, 1);
      g.batch.push(p.x, p.y + bob, p.z, ATLAS.PUFF, 2.6, 2.6, 0, r * 1.5, gg * 1.5, b * 1.5, 0.35);
    }
  }
}
