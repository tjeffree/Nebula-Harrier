import * as THREE from 'three';
import type { RunStats } from '../roguelite/BoonRegistry';
import type { Enemy, GameContext } from './EnemyBase';

/** Seconds the lash takes to cross the arc, then to fade out. */
const SWING = 0.2;
const FADE = 0.2;
/** Points along the drawn whip. */
const N = 28;
/** Samples across the swept fan. */
const M = 28;
/** Thickness of the lash for hit tests. */
const HIT_R = 1.5;
/** The lash strikes as a blade: three parallel edges this far apart vertically. */
const BLADE = [0, 1.7, -1.7];
/** Height band (either side of the lash) inside which hostile fire is cut. */
const CUT_Y = 3.0;

export interface WhipContext {
  game: GameContext;
  stats: RunStats;
  /** Called once per enemy struck in a swing. */
  onHit: (e: Enemy, dmg: number) => void;
}

function makeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0x8ff4ff) } },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      varying float vA;
      void main() { vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vA;
      void main() { gl_FragColor = vec4(mix(uColor, vec3(1.0), vA * vA * 0.6) * vA * 3.0, 1.0); }`,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function strip(count: number, mat: THREE.ShaderMaterial): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(count * 2), 1).setUsage(THREE.DynamicDrawUsage));
  const idx: number[] = [];
  for (let i = 0; i < count - 1; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  geo.setIndex(idx);
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = 11;
  m.visible = false;
  return m;
}

/**
 * The heroine's hard-light whip: a long lash of solid light that sweeps a
 * wide horizontal arc ahead of her at chest height, striking everything it
 * crosses once per swing. Optionally slices hostile fire out of the air.
 */
export class HardLightWhip {
  readonly group = new THREE.Group();
  cooldownLeft = 0;
  private readonly mat = makeMaterial();
  private readonly ribbon = strip(N + 1, this.mat);
  private readonly fan = strip(M + 1, this.mat);
  private t = -1;
  private dir = 1;
  private prevAngle = 0;
  private readonly origin = new THREE.Vector3();
  private readonly hit = new Set<Enemy>();

  constructor() {
    this.group.add(this.fan, this.ribbon);
  }

  setColor(hex: number): void {
    (this.mat.uniforms.uColor.value as THREE.Color).set(hex);
  }

  /** 0 = just struck, 1 = ready. */
  readiness(stats: RunStats): number {
    return 1 - this.cooldownLeft / stats.whipCooldown;
  }

  get swinging(): boolean {
    return this.t >= 0 && this.t < SWING;
  }

  /** Arm pose for the swing: -1 wound up on one side, +1 followed through on the other. */
  get pose(): number {
    if (this.t < 0) return 0;
    const k = Math.min(1, this.t / SWING);
    const follow = this.t > SWING ? Math.max(0, 1 - (this.t - SWING) / (FADE * 2)) : 1;
    return this.dir * (-1 + 2 * k) * follow;
  }

  reset(): void {
    this.t = -1;
    this.cooldownLeft = 0;
    this.ribbon.visible = this.fan.visible = false;
  }

  /** Starts a swing if ready. */
  tryStrike(stats: RunStats): boolean {
    if (this.cooldownLeft > 0) return false;
    this.cooldownLeft = stats.whipCooldown;
    this.t = 0;
    this.dir = -this.dir;
    this.hit.clear();
    this.prevAngle = this.angle(0, stats);
    return true;
  }

  /** Readies the whip immediately (Riposte synergy). */
  ready(): void {
    this.cooldownLeft = 0;
  }

  private angle(t: number, stats: RunStats): number {
    const k = Math.max(0, Math.min(1, t / SWING));
    const e = k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k);
    return this.dir * stats.whipArc * (-1 + 2 * e);
  }

  /** Reach as the lash unfurls over the first part of the swing. */
  private reach(t: number, stats: RunStats): number {
    const k = Math.min(1, t / (SWING * 0.45));
    return stats.whipReach * (1 - (1 - k) * (1 - k));
  }

  update(dt: number, hand: THREE.Vector3, c: WhipContext): void {
    this.cooldownLeft = Math.max(0, this.cooldownLeft - dt);
    if (this.t < 0) return;
    const s = c.stats;
    this.t += dt;
    if (this.t > SWING + FADE) {
      this.t = -1;
      this.ribbon.visible = this.fan.visible = false;
      return;
    }
    this.origin.copy(hand);
    const now = this.angle(this.t, s);
    const L = this.reach(this.t, s);
    if (this.t - dt < SWING) this.strike(this.prevAngle, now, L, c);
    this.prevAngle = now;
    this.draw(now, L, s);
  }

  /** Sweeps the straight lash from angle a0 to a1, hitting each enemy once. */
  private strike(a0: number, a1: number, L: number, c: WhipContext): void {
    const g = c.game;
    const o = this.origin;
    const steps = Math.max(1, Math.ceil((Math.abs(a1 - a0) * L) / 1.2));
    for (let k = 1; k <= steps; k++) {
      const a = a0 + ((a1 - a0) * k) / steps;
      const tx = o.x + Math.sin(a) * L;
      const tz = o.z - Math.cos(a) * L;
      for (const e of g.enemies.list) {
        if (!e.alive || !e.active || this.hit.has(e) || e.pos.z > o.z + 2) continue;
        for (const dy of BLADE) {
          if (e.sweepHit(o.x, o.y + dy, o.z, tx, o.y + dy, tz, HIT_R)) {
            this.hit.add(e);
            c.onHit(e, c.stats.whipDamage);
            break;
          }
        }
      }
    }
    if (c.stats.whipCutsBullets > 0) this.cut(Math.min(a0, a1), Math.max(a0, a1), L, g);
  }

  /** Slices hostile bolts inside the swept wedge out of the air. */
  private cut(lo: number, hi: number, L: number, g: GameContext): void {
    const b = g.projectiles.enemy;
    const o = this.origin;
    for (let i = b.count - 1; i >= 0; i--) {
      const dx = b.x[i] - o.x;
      const dz = b.z[i] - o.z;
      if (dz > 1.5 || Math.abs(b.y[i] - o.y) > CUT_Y) continue;
      const d = Math.hypot(dx, dz);
      if (d > L + 0.6) continue;
      const a = Math.atan2(dx, -dz);
      const tol = 1.0 / Math.max(d, 1);
      if (a < lo - tol || a > hi + tol) continue;
      g.particles.spark(b.x[i], b.y[i], b.z[i], 0.6, 1, 1);
      b.remove(i);
    }
  }

  private draw(now: number, L: number, s: RunStats): void {
    const o = this.origin;
    const fade = this.t > SWING ? 1 - (this.t - SWING) / FADE : 1;
    // Lash: a ribbon whose far end lags behind the hand, so it curls like a whip.
    const rp = this.ribbon.geometry.attributes.position as THREE.BufferAttribute;
    const ra = this.ribbon.geometry.attributes.aAlpha as THREE.BufferAttribute;
    const lag = 0.06;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const a = this.angle(this.t - lag * u, s);
      const r = L * u;
      const x = o.x + Math.sin(a) * r;
      const z = o.z - Math.cos(a) * r;
      const y = o.y + Math.sin(u * Math.PI) * 0.35 * fade;
      const w = (0.45 - u * 0.3) * (0.7 + 0.3 * fade);
      rp.setXYZ(i * 2, x, y + w, z);
      rp.setXYZ(i * 2 + 1, x, y - w, z);
      const alpha = fade * (0.55 + 0.45 * Math.sin(u * Math.PI * 0.9 + 0.2));
      ra.setX(i * 2, alpha);
      ra.setX(i * 2 + 1, alpha);
    }
    rp.needsUpdate = ra.needsUpdate = true;
    // Afterimage: a translucent fan over the arc swept so far, brightest at the leading edge.
    const fp = this.fan.geometry.attributes.position as THREE.BufferAttribute;
    const fa = this.fan.geometry.attributes.aAlpha as THREE.BufferAttribute;
    const start = this.angle(0, s);
    for (let j = 0; j <= M; j++) {
      const k = j / M;
      const a = start + (now - start) * k;
      const sn = Math.sin(a);
      const cs = Math.cos(a);
      fp.setXYZ(j * 2, o.x + sn * L * 0.12, o.y, o.z - cs * L * 0.12);
      fp.setXYZ(j * 2 + 1, o.x + sn * L, o.y, o.z - cs * L);
      fa.setX(j * 2, 0);
      fa.setX(j * 2 + 1, 0.22 * k * k * fade);
    }
    fp.needsUpdate = fa.needsUpdate = true;
    this.ribbon.visible = this.fan.visible = true;
  }
}
