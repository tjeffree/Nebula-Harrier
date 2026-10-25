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
  private sprayAcc = 0;
  private boltColor = 0xffd23f;
  /** Flying over open sea: skim instead of running. */
  overWater = false;
  /** Whip swing pose from the whip (-1..1), drives the left arm. */
  whipPose = 0;
  whipDrawn = false;

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
      for (const f of this.model.flames) (f.material as THREE.Material).dispose();
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
    if (ctx.controlsEnabled && input.fire && this.fireCd <= 0) {
      this.fireCd = Math.max(this.fireCd + s.fireInterval, 0);
      this.fire(ctx);
    }
    if (this.fireCd < 0) this.fireCd = 0;

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
  }

  /** Where secondary ordnance launches from: just above the Harrier's shoulder. */
  launchPoint(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x, this.pos.y + CHEST + 0.6, this.pos.z - 0.5);
  }

  /** Where the whip lash leaves her hand; held at chest height so the strike band is predictable. */
  whipOrigin(out: THREE.Vector3): THREE.Vector3 {
    this.model.whipHand.getWorldPosition(out);
    out.y = this.pos.y + CHEST + 0.3;
    return out;
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

    const grounded = this.pos.y <= GROUND_Y && !this.overWater;
    if (grounded) {
      // Running gait driven by rail speed.
      this.runPhase += dt * ctx.railSpeed * 0.32;
      const sn = Math.sin(this.runPhase);
      m.legL.rotation.x = sn * 0.85;
      m.legR.rotation.x = -sn * 0.85;
      // Knees fold backward (shin swings toward +Z).
      m.shinL.rotation.x = -Math.max(0, -sn) * 1.3 - 0.1;
      m.shinR.rotation.x = -Math.max(0, sn) * 1.3 - 0.1;
      m.armL.rotation.x = -sn * 0.6;
      m.body.position.y = Math.abs(Math.cos(this.runPhase)) * 0.09;
      m.body.rotation.x = -0.08;
    } else {
      // Airborne: legs trail behind with bent knees, body leans into flight.
      const k = Math.min(1, dt * 8);
      m.legL.rotation.x += (0.15 - m.legL.rotation.x) * k;
      m.legR.rotation.x += (-0.1 - m.legR.rotation.x) * k;
      m.shinL.rotation.x += (-0.85 - m.shinL.rotation.x) * k;
      m.shinR.rotation.x += (-0.55 - m.shinR.rotation.x) * k;
      m.armL.rotation.x += (-0.3 - m.armL.rotation.x) * k;
      m.body.position.y += (Math.sin(performance.now() * 0.004) * 0.05 - m.body.position.y) * k;
      m.body.rotation.x += (-0.3 - m.body.rotation.x) * k;
    }
    // Whip arm: raised forward and swept across the body with the lash.
    const wp = this.whipPose;
    if (wp !== 0) {
      m.armL.rotation.x = -1.35;
      m.armL.rotation.y = wp * 0.9;
      m.armL.rotation.z = -0.12 - wp * 0.25;
      m.body.rotation.y = wp * 0.3;
    } else {
      const k = Math.min(1, dt * 10);
      m.armL.rotation.y += -m.armL.rotation.y * k;
      m.armL.rotation.z += (-0.12 - m.armL.rotation.z) * k;
      m.body.rotation.y += -m.body.rotation.y * k;
    }
    m.whipGlow.uniforms.uFlash.value = this.whipDrawn ? 0.6 : 0;
    // Ponytail and scarf stream behind, lifting with speed and flicking as she moves.
    const t = performance.now() * 0.001;
    const lift = grounded ? 0.15 : 0.55;
    for (let i = 0; i < m.hair.length; i++) {
      m.hair[i].rotation.x = (i === 0 ? 0.9 - lift : 0.15 - lift * 0.15) + Math.sin(t * 9 - i * 1.1) * 0.08 + this.vel.y * 0.01;
      m.hair[i].rotation.y = Math.sin(t * 6 - i * 0.9) * 0.12 - this.vel.x * 0.012;
    }
    for (let i = 0; i < m.scarf.length; i++) {
      m.scarf[i].rotation.x = (i === 0 ? 0.2 - lift * 0.4 : 0.05) + Math.sin(t * 11 - i * 1.3) * 0.18;
      m.scarf[i].rotation.y = Math.sin(t * 7 - i * 1.0) * 0.25 - this.vel.x * 0.015;
    }
    // Thrust flames flicker, and burn shorter while running on the ground.
    const thrustLen = grounded ? 0.45 : 1;
    for (const f of m.flames) {
      f.scale.set(1, thrustLen * (0.85 + Math.random() * 0.3), 1);
      (f.material as THREE.ShaderMaterial).uniforms.uPower.value = 2.4 + Math.random() * 0.8;
    }

    // Hit flicker.
    m.root.visible = this.hitInvuln <= 0 || Math.floor(this.hitInvuln * 20) % 2 === 0;

    // Skimming the sea: the jets kick up a wake of spray.
    if (this.overWater && this.pos.y < 2.2) {
      this.sprayAcc += dt;
      const k = 1 - this.pos.y / 2.2;
      while (this.sprayAcc >= 0.025) {
        this.sprayAcc -= 0.025;
        const sx = this.pos.x + (Math.random() - 0.5) * 0.8;
        ctx.particles.emit(sx, 0.1, this.pos.z + 0.6, (Math.random() - 0.5) * 4, 2 + Math.random() * 4 * k, 6 + Math.random() * 6, 0.4, 0.25, 0.8 * k + 0.2, 0.9, 0.95, 1, undefined, 2.5);
      }
    }

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
          0.25,
          0.3 * thrust,
          0.8 * thrust,
          0.62,
          0.6,
          0.58,
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
  }
}
