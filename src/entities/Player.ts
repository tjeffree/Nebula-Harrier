import * as THREE from 'three';
import { bus } from '../core/EventBus';
import type { InputManager } from '../core/InputManager';
import type { SoundSynth } from '../audio/SoundSynth';
import { ATLAS, createPlayerModel, type PlayerModel } from '../procgen/ModelFactory';
import type { Archetype, RunStats } from '../roguelite/BoonRegistry';
import type { ParticleSystem, PlayerTarget, ProjectileSystem, SpriteBatch } from './ProjectileSystem';

/** Kinematic constants from the spec. */
export const ACCEL = 48.0;
export const DAMPING = 6.5;
export const BOUNDS = { minX: -9.5, maxX: 9.5, minY: 0.2, maxY: 7.5 };
const GROUND_Y = 0.25;
/** Depth of the Harrier's rail plane; slightly ahead of z=0 so the full model stays in frame at max altitude. */
export const PLAYER_Z = -2.5;
const DASH_IMPULSE = 30;
/** Collision sphere centre sits at chest height above the feet. */
const CHEST = 0.9;

export interface PlayerUpdateContext {
  input: InputManager;
  projectiles: ProjectileSystem;
  particles: ParticleSystem;
  sfx: SoundSynth;
  camera: THREE.Camera;
  railSpeed: number;
  controlsEnabled: boolean;
  /** Soft aim-assist: returns a target point near the firing line, or null. */
  aimAssist?: (x: number, y: number, z: number) => THREE.Vector3 | null;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _c = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** The Harrier: momentum physics, procedural running/banking, weapons, dash. */
export class Player implements PlayerTarget {
  model!: PlayerModel;
  readonly pos = new THREE.Vector3(0, BOUNDS.minY, PLAYER_Z);
  readonly vel = new THREE.Vector3();
  readonly radius = 0.55;
  hp = 100;
  heat = 0;
  overheated = false;
  alive = true;
  shieldUp = false;
  dashCooldownLeft = 0;
  stats!: RunStats;

  private fireCd = 0;
  private invuln = 0;
  private hitInvuln = 0;
  private shieldT = 0;
  private runPhase = 0;
  private dashSpin = 0;
  private dashSpinDir = 1;
  private jetAcc = 0;
  private boltColor = 0xffd23f;

  constructor(private readonly scene: THREE.Scene) {}

  get x(): number {
    return this.pos.x;
  }
  get y(): number {
    return this.pos.y + CHEST;
  }
  get z(): number {
    return this.pos.z;
  }

  setArchetype(a: Archetype): void {
    if (this.model) {
      this.scene.remove(this.model.root);
      for (const m of this.model.materials) m.dispose();
    }
    this.model = createPlayerModel(a.accent, a.trim);
    this.boltColor = a.bolt;
    this.scene.add(this.model.root);
  }

  applyStats(stats: RunStats, healFrac = 0): void {
    const prevMax = this.stats?.maxHp ?? stats.maxHp;
    this.stats = stats;
    if (stats.maxHp > prevMax) this.hp += stats.maxHp - prevMax;
    this.hp = Math.min(stats.maxHp, this.hp + stats.maxHp * healFrac);
  }

  reset(stats: RunStats): void {
    this.stats = stats;
    this.hp = stats.maxHp;
    this.heat = 0;
    this.overheated = false;
    this.alive = true;
    this.pos.set(0, BOUNDS.minY, PLAYER_Z);
    this.vel.set(0, 0, 0);
    this.invuln = 0;
    this.hitInvuln = 0;
    this.dashCooldownLeft = 0;
    this.shieldT = 0;
    this.shieldUp = false;
    this.model.root.visible = true;
  }

  vulnerable(): boolean {
    return this.alive && this.invuln <= 0 && this.hitInvuln <= 0;
  }

  takeDamage(amount: number): void {
    if (!this.vulnerable()) return;
    if (this.shieldUp) {
      this.shieldUp = false;
      this.shieldT = 0;
      this.hitInvuln = 0.6;
      bus.emit('player:hit', { damage: 0, hp: this.hp });
      return;
    }
    this.hp -= amount;
    this.hitInvuln = 0.9;
    bus.emit('player:hit', { damage: amount, hp: this.hp });
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
      this.model.root.visible = false;
      bus.emit('player:died', {});
    }
  }

  update(dt: number, ctx: PlayerUpdateContext): void {
    if (!this.alive) return;
    const { input } = ctx;
    const s = this.stats;

    // --- Inertia model ---------------------------------------------------
    //   v(t+1) = (v(t) + a_input·Δt) · (1 − γ·Δt)
    //   p(t+1) = p(t) + v(t+1)·Δt
    const ax = ctx.controlsEnabled ? input.moveX * ACCEL : 0;
    const ay = ctx.controlsEnabled ? input.moveY * ACCEL : 0;
    const damp = 1 - DAMPING * dt;
    this.vel.x = (this.vel.x + ax * dt) * damp;
    this.vel.y = (this.vel.y + ay * dt) * damp;

    // --- Evade / dash ------------------------------------------------------
    this.dashCooldownLeft = Math.max(0, this.dashCooldownLeft - dt);
    const dash = input.consumeDash();
    if (dash && ctx.controlsEnabled && this.dashCooldownLeft <= 0) {
      this.vel.x += dash.x * DASH_IMPULSE;
      this.vel.y += dash.y * DASH_IMPULSE;
      this.dashCooldownLeft = s.dashCooldown;
      this.invuln = Math.max(this.invuln, s.dashInvuln);
      this.dashSpin = 1;
      this.dashSpinDir = dash.x >= 0 ? -1 : 1;
      ctx.sfx.dash();
      bus.emit('player:dash', { x: this.pos.x, y: this.pos.y + CHEST });
      for (let i = 0; i < 14; i++) {
        ctx.particles.emit(
          this.pos.x + (Math.random() - 0.5),
          this.pos.y + CHEST + (Math.random() - 0.5) * 1.5,
          this.pos.z,
          -dash.x * 10 + (Math.random() - 0.5) * 3,
          -dash.y * 10 + (Math.random() - 0.5) * 3,
          4,
          0.45,
          0.9,
          0.2,
          0.92,
          0.97,
          1,
        );
      }
    }

    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    if (this.pos.x < BOUNDS.minX) {
      this.pos.x = BOUNDS.minX;
      this.vel.x = Math.max(0, this.vel.x);
    } else if (this.pos.x > BOUNDS.maxX) {
      this.pos.x = BOUNDS.maxX;
      this.vel.x = Math.min(0, this.vel.x);
    }
    if (this.pos.y < BOUNDS.minY) {
      this.pos.y = BOUNDS.minY;
      this.vel.y = Math.max(0, this.vel.y);
    } else if (this.pos.y > BOUNDS.maxY) {
      this.pos.y = BOUNDS.maxY;
      this.vel.y = Math.min(0, this.vel.y);
    }

    this.invuln = Math.max(0, this.invuln - dt);
    this.hitInvuln = Math.max(0, this.hitInvuln - dt);
    if (s.shieldInterval > 0 && !this.shieldUp) {
      this.shieldT += dt;
      if (this.shieldT >= s.shieldInterval) this.shieldUp = true;
    }

    // --- Weapons -----------------------------------------------------------
    this.fireCd -= dt;
    const firing = ctx.controlsEnabled && input.fire && !this.overheated;
    if (firing && this.fireCd <= 0) {
      this.fireCd = Math.max(this.fireCd + s.fireInterval, 0);
      this.fire(ctx);
    }
    if (this.fireCd < 0) this.fireCd = 0;
    this.heat = Math.max(0, this.heat - s.coolRate * dt * (firing ? 0.35 : 1));
    if (this.overheated && this.heat <= 0.3) this.overheated = false;

    this.animate(dt, ctx);
  }

  private fire(ctx: PlayerUpdateContext): void {
    const s = this.stats;
    this.model.root.updateMatrixWorld();
    this.model.muzzle.getWorldPosition(_a);
    // Shots run parallel to the rail (-Z) from chest height, converging on the
    // vanishing point on screen as in classic super-scaler shooters.
    _a.set(this.pos.x + 0.25, this.pos.y + CHEST + 0.4, _a.z);
    _dir.set(0, 0, -1);
    const target = ctx.aimAssist?.(_a.x, _a.y, _a.z);
    if (target) _dir.subVectors(target, _a).normalize().lerp(_c.set(0, 0, -1), 0.35).normalize();
    const ways = s.spreadWays;
    const dmg = s.damage * (ways > 1 ? s.spreadDamageMul : 1);
    for (let i = 0; i < ways; i++) {
      const off = ways === 1 ? 0 : (i / (ways - 1) - 0.5) * (ways === 3 ? 0.16 : 0.26);
      _b.copy(_dir).applyAxisAngle(UP, off + (Math.random() - 0.5) * s.jitter);
      _b.y += (Math.random() - 0.5) * s.jitter;
      _b.normalize().multiplyScalar(s.projSpeed);
      ctx.projectiles.spawnPlayer(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, dmg, ways > 1 ? 0.9 : 1.1, this.boltColor);
    }
    const bc = this.boltColor;
    ctx.particles.emit(_a.x, _a.y, _a.z, 0, 0, -4, 0.07, 1.1, 0.4, ((bc >> 16) & 255) / 255, ((bc >> 8) & 255) / 255, (bc & 255) / 255, ATLAS.SPARK);
    ctx.sfx.laser(ways > 1 ? 1.15 : 1);
    this.heat += s.heatPerShot;
    if (this.heat >= 1) {
      this.heat = 1;
      this.overheated = true;
      ctx.sfx.overheat();
      bus.emit('player:overheat', {});
    }
    bus.emit('player:fire', { heat: this.heat });
  }

  private animate(dt: number, ctx: PlayerUpdateContext): void {
    const m = this.model;
    m.root.position.copy(this.pos);
    // Banking: roll from X velocity, pitch from Y velocity.
    this.dashSpin = Math.max(0, this.dashSpin - dt * 3.2);
    const spin = (1 - this.dashSpin) * Math.PI * 2 * (this.dashSpin > 0 ? 1 : 0);
    m.root.rotation.z = -this.vel.x * 0.045 + spin * this.dashSpinDir;
    m.root.rotation.x = this.vel.y * 0.02;
    m.root.rotation.y = this.vel.x * 0.015;

    const grounded = this.pos.y <= GROUND_Y;
    if (grounded) {
      // Running gait driven by rail speed.
      this.runPhase += dt * ctx.railSpeed * 0.32;
      const sn = Math.sin(this.runPhase);
      m.legL.rotation.x = sn * 0.85;
      m.legR.rotation.x = -sn * 0.85;
      m.shinL.rotation.x = Math.max(0, -sn) * 1.3 + 0.1;
      m.shinR.rotation.x = Math.max(0, sn) * 1.3 + 0.1;
      m.armL.rotation.x = -sn * 0.6;
      m.body.position.y = Math.abs(Math.cos(this.runPhase)) * 0.09;
      m.body.rotation.x = -0.08;
    } else {
      // Airborne: tuck legs back, lean into flight.
      const k = Math.min(1, dt * 8);
      m.legL.rotation.x += (0.55 - m.legL.rotation.x) * k;
      m.legR.rotation.x += (0.35 - m.legR.rotation.x) * k;
      m.shinL.rotation.x += (0.9 - m.shinL.rotation.x) * k;
      m.shinR.rotation.x += (0.7 - m.shinR.rotation.x) * k;
      m.armL.rotation.x += (-0.3 - m.armL.rotation.x) * k;
      m.body.position.y += (Math.sin(performance.now() * 0.004) * 0.05 - m.body.position.y) * k;
      m.body.rotation.x += (-0.22 - m.body.rotation.x) * k;
    }

    // Hit flicker.
    m.root.visible = this.hitInvuln <= 0 || Math.floor(this.hitInvuln * 20) % 2 === 0;

    // Jet nacelle exhaust (vector particles).
    this.jetAcc += dt;
    const interval = grounded ? 0.05 : 0.016;
    while (this.jetAcc >= interval) {
      this.jetAcc -= interval;
      for (const n of m.nozzles) {
        n.getWorldPosition(_a);
        const thrust = grounded ? 0.5 : 1;
        ctx.particles.emit(
          _a.x + (Math.random() - 0.5) * 0.1,
          _a.y,
          _a.z + 0.1,
          (Math.random() - 0.5) * 1.5 - this.vel.x * 0.3,
          -3 * thrust - Math.random() * 2,
          6 + Math.random() * 4,
          0.2,
          0.35 * thrust,
          0.65 * thrust,
          1,
          1,
          1,
        );
      }
    }
    for (const mat of m.materials) mat.uniforms.uFlash.value = this.invuln > 0 ? 0.35 : 0;
  }

  renderSprites(batch: SpriteBatch, time: number): void {
    if (!this.alive) return;
    if (this.shieldUp) {
      const p = 1 + Math.sin(time * 6) * 0.05;
      batch.push(this.pos.x, this.pos.y + CHEST, this.pos.z + 0.4, ATLAS.RING, 2.6 * p, 2.6 * p, time, 0.2, 0.85, 1, 0.6);
    }
    if (this.overheated) {
      batch.push(this.pos.x + 0.6, this.pos.y + 1.6 + Math.sin(time * 9) * 0.1, this.pos.z, ATLAS.PUFF, 1.3, 1.3, time, 0.85, 0.85, 0.9, 0.6 + 0.3 * Math.sin(time * 20));
    }
  }
}
