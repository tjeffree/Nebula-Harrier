import * as THREE from 'three';
import { bus } from '../core/EventBus';
import { ATLAS } from '../procgen/ModelFactory';
import {
  BOSS_SEGMENTS,
  createBeastBossModel,
  createIdolModel,
  createMammothModel,
  createSerpentHeadModel,
  createStalkModel,
  type BeastBossModel,
  type IdolModel,
  type MammothModel,
  type SerpentHeadModel,
  type StalkModel,
} from '../procgen/BeastModels';
import type { PropMeshes } from '../procgen/PropModels';
import { ENEMY_COST, type BossKind, type PropKind } from '../procgen/SectorBuilder';
import { globalUniforms, terrainY } from '../procgen/Shaders';
import type { SurfaceMaterial } from '../procgen/Shaders';
import { Enemy, hermite, type GameContext } from './EnemyBase';
import { segPointDist2 } from './ProjectileSystem';

const LOD_Z = -100;
const DESPAWN_FAR = -185;
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();

/** Ground height under a point at the current scroll (0 = sea surface). */
const groundAt = (x: number, z: number) => terrainY(x, z, globalUniforms.uScroll.value);

/** Instance colour for the marking parts, blended toward white by the hit flash. */
function flashed(c: THREE.Color, fl: number, band = 1): [number, number, number] {
  return [c.r * band + (1 - c.r * band) * fl, c.g * band + (1 - c.g * band) * fl, c.b * band + (1 - c.b * band) * fl];
}

function setFlash(mats: readonly SurfaceMaterial[], v: number): void {
  for (const m of mats) m.uniforms.uFlash.value = v;
}

function splash(ctx: GameContext, x: number, z: number, size: number): void {
  for (let i = 0; i < 10 * size; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 2 + Math.random() * 4 * size;
    ctx.particles.emit(x + Math.cos(a) * 0.5, 0.1, z + Math.sin(a) * 0.5, Math.cos(a) * s, 5 + Math.random() * 6 * size, Math.sin(a) * s, 0.7, 0.5 * size, 1.4 * size, 0.92, 0.96, 1, undefined, 1.2);
  }
}

// ===========================================================================
// Razorwing (1 pt): leathery flyers in flocks. Swoop in, spit once, wheel away.
// ===========================================================================
export class Razorwing extends Enemy {
  private phase: 'wait' | 'in' | 'attack' | 'retreat' = 'wait';
  private phaseT = 0;
  private fired = false;
  private readonly start: THREE.Vector3;
  private readonly anchor: THREE.Vector3;
  private readonly prev = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly flapOff = Math.random() * 6;
  private spinR = 0;
  private spinA = 0;

  constructor(
    ctx: GameContext,
    start: THREE.Vector3,
    anchor: THREE.Vector3,
    private delay: number,
    private readonly spinDir: number,
  ) {
    super('flock', 3 * ctx.fx.hpMul, 1.3, 100, ENEMY_COST.flock);
    this.start = start.clone();
    this.anchor = anchor.clone();
    this.pos.copy(start);
    this.active = false;
  }

  update(dt: number, ctx: GameContext): void {
    this.phaseT += dt;
    this.prev.copy(this.pos);
    switch (this.phase) {
      case 'wait':
        if (this.phaseT >= this.delay) {
          this.phase = 'in';
          this.phaseT = 0;
          this.active = true;
        }
        return;
      case 'in': {
        const t = Math.min(1, this.phaseT / 2.3);
        hermite(this.start, this.anchor, _p.set(0, 0, 90), _d.set(0, -4, 8), t, this.pos);
        if (t >= 1) {
          this.phase = 'attack';
          this.phaseT = 0;
        }
        break;
      }
      case 'attack': {
        this.pos.set(
          this.anchor.x + Math.sin(this.age * 2.2) * 0.8,
          this.anchor.y + Math.sin(this.age * 3.1) * 0.4,
          this.anchor.z + Math.sin(this.age * 1.7) * 1.5,
        );
        if (!this.fired && this.phaseT > 0.45 / ctx.fx.fireRateMul) {
          this.fired = true;
          if (ctx.player.alive) this.fireAt(ctx, this.pos, 30, 0.7, { color: 0xb6ff5a });
        }
        if (this.phaseT > 1.4) {
          this.phase = 'retreat';
          this.phaseT = 0;
          this.anchor.copy(this.pos);
        }
        break;
      }
      case 'retreat': {
        this.spinR += dt * 3.5;
        this.spinA += dt * 4.2 * this.spinDir;
        this.pos.set(
          this.anchor.x + Math.cos(this.spinA) * this.spinR - this.spinDir * this.spinR * 0.6,
          Math.max(0.6, this.anchor.y + Math.sin(this.spinA) * this.spinR * 0.6 + this.spinR * 0.35),
          this.anchor.z - this.phaseT * this.phaseT * 22,
        );
        if (this.pos.z < DESPAWN_FAR) this.despawn();
        break;
      }
    }

    // Face the direction of flight, or the Harrier while attacking.
    _d.subVectors(this.pos, this.prev);
    if (this.phase === 'attack' || _d.lengthSq() < 1e-6) {
      const p = ctx.player.pos;
      _d.set(p.x - this.pos.x, p.y + 1 - this.pos.y, p.z - this.pos.z);
    }
    _q.setFromUnitVectors(FWD, _d.normalize());
    this.quat.slerp(_q, Math.min(1, dt * 8));

    const c = ctx.accentColor;
    if (this.pos.z < LOD_Z) {
      ctx.batch.push(this.pos.x, this.pos.y, this.pos.z, ATLAS.FLOCK_LOD, 4.5, 4.5, 0, c.r, c.g, c.b, 1);
      return;
    }
    const [r, g, b] = flashed(c, this.flash);
    _m.compose(this.pos, this.quat, _s.setScalar(1.15));
    ctx.swarm.flockBody.writeMatrix(_m, r, g, b);
    const glide = this.phase === 'in' && this.phaseT > 1.2 ? 0.25 : 1;
    const flap = Math.sin(this.age * 15 + this.flapOff) * 0.75 * glide + 0.1;
    _m2.makeRotationZ(flap).setPosition(0.3, 0.12, 0.05);
    ctx.swarm.wingL.writeMatrix(_m3.multiplyMatrices(_m, _m2), r, g, b);
    _m2.makeRotationZ(-flap).setPosition(-0.3, 0.12, 0.05);
    ctx.swarm.wingR.writeMatrix(_m3.multiplyMatrices(_m, _m2), r, g, b);
  }

  protected override onDeath(ctx: GameContext): void {
    super.onDeath(ctx);
    const c = ctx.accentColor;
    ctx.particles.burst(this.pos.x, this.pos.y, this.pos.z, 10, 7, c.r, c.g, c.b, 0.6);
  }

  dispose(): void {}
}

// ===========================================================================
// Spinefish (1 pt): leap out of the sea across the lane, spit at the apex.
// ===========================================================================
export class Leaper extends Enemy {
  private t = 0;
  private fired = false;
  private wasUnder = true;
  private readonly quat = new THREE.Quaternion();

  constructor(
    ctx: GameContext,
    private readonly side: number,
    private readonly z0: number,
    private readonly apex: number,
    private delay: number,
    private readonly dur: number,
  ) {
    super('leaper', 2 * ctx.fx.hpMul, 1.0, 120, ENEMY_COST.leaper);
    this.active = false;
    this.pos.set(side * 16, -2, z0);
  }

  update(dt: number, ctx: GameContext): void {
    if (this.delay > 0) {
      this.delay -= dt;
      return;
    }
    this.t += dt / this.dur;
    if (this.t >= 1) {
      this.despawn();
      return;
    }
    const t = this.t;
    const base = -2;
    const span = 32;
    this.pos.set(this.side * 16 * (1 - 2 * t), base + (this.apex - base) * 4 * t * (1 - t), this.z0 + t * 10);
    const under = this.pos.y < 0;
    if (under !== this.wasUnder) splash(ctx, this.pos.x, this.pos.z, 0.8);
    this.wasUnder = under;
    this.active = this.pos.y > -0.4;
    if (!this.fired && t > 0.48) {
      this.fired = true;
      if (ctx.player.alive) this.fireAt(ctx, this.pos, 28, 0.6, { color: 0x7af0ff });
    }
    // Nose along the arc.
    _d.set((-this.side * span) / this.dur, ((this.apex - base) * 4 * (1 - 2 * t)) / this.dur, 10 / this.dur).normalize();
    this.quat.setFromUnitVectors(FWD, _d);
    const [r, g, b] = flashed(ctx.accentColor, this.flash);
    _m.compose(this.pos, this.quat, _s.setScalar(1.1));
    ctx.swarm.leaper.writeMatrix(_m, r, g, b);
  }

  protected override onDeath(ctx: GameContext): void {
    super.onDeath(ctx);
    ctx.particles.burst(this.pos.x, this.pos.y, this.pos.z, 10, 6, 0.8, 0.95, 1, 0.5);
  }

  dispose(): void {}
}

// ===========================================================================
// Serpent (5 pts): a long-bodied wyrm that weaves ahead of the Harrier. At sea
// it breaches through the surface in arcs. The head is the weak point; the
// body segments shrug off most damage.
// ===========================================================================
export class Serpent extends Enemy {
  static readonly SEGS = 10;
  static readonly SPACING = 1.55;
  private readonly segs: THREE.Vector3[] = [];
  private readonly model: SerpentHeadModel;
  private readonly target = new THREE.Vector3();
  private readonly prev = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private fireT = 2.4;
  private jaw = 0;
  private leaving = false;
  private t = 0;

  constructor(
    ctx: GameContext,
    private readonly ax: number,
    private readonly ay: number,
    private readonly aquatic: boolean,
  ) {
    super('serpent', 18 * ctx.fx.hpMul, 1.3, 600, ENEMY_COST.serpent);
    this.contactDamage = 22;
    this.model = createSerpentHeadModel(ctx.biome.hide, ctx.biome.marking, aquatic);
    this.pos.set(ax * 1.6, aquatic ? -5 : 12, -175);
    for (let i = 0; i < Serpent.SEGS; i++) this.segs.push(new THREE.Vector3(this.pos.x, this.pos.y, this.pos.z - i * Serpent.SPACING));
    ctx.scene.add(this.model.root);
  }

  update(dt: number, ctx: GameContext): void {
    this.t += dt;
    const t = this.t;
    if (!this.leaving && this.age > 14) this.leaving = true;
    if (this.leaving) {
      this.target.set(this.pos.x, this.aquatic ? -14 : 18, -210);
      if (this.pos.z < DESPAWN_FAR || this.pos.y < -10) this.despawn();
    } else if (this.aquatic) {
      this.target.set(this.ax + Math.sin(t * 0.6) * 8, -2 + 6.5 * Math.sin(t * 1.25), -36 + Math.sin(t * 0.4) * 6);
    } else {
      this.target.set(this.ax + Math.sin(t * 0.9) * 6, this.ay + Math.sin(t * 1.7) * 1.8, -34 + Math.sin(t * 0.55) * 7);
    }
    this.prev.copy(this.pos);
    this.pos.lerp(this.target, Math.min(1, dt * (this.leaving ? 0.9 : 1.6)));
    if (this.aquatic && (this.prev.y < 0) !== (this.pos.y < 0)) splash(ctx, this.pos.x, this.pos.z, 1.4);

    // Breath bolts while the head is clear of the water.
    this.fireT -= dt * ctx.fx.fireRateMul;
    if (this.fireT <= 0 && !this.leaving && this.pos.y > 1.2 && this.pos.z > -70 && ctx.player.alive) {
      this.fireT = 2.2;
      this.jaw = 1;
      this.model.mouth.getWorldPosition(_p);
      for (let i = -1; i <= 1; i++) this.fireAt(ctx, _p, 26, 0.5, { color: 0xffd04a, size: 1.1 }, i * 0.18);
      ctx.sfx.enemyShot(0.8);
    }
    this.jaw = Math.max(0, this.jaw - dt * 2.5);

    // Rope constraint: each segment trails its predecessor at fixed spacing.
    this.segs[0].copy(this.pos);
    for (let i = 1; i < Serpent.SEGS; i++) {
      const prev = this.segs[i - 1];
      const cur = this.segs[i];
      _d.subVectors(cur, prev);
      const len = _d.length();
      if (len > Serpent.SPACING) cur.copy(prev).addScaledVector(_d, Serpent.SPACING / len);
    }

    // Head: along its motion, turning to the Harrier as it spits.
    _d.subVectors(this.pos, this.prev);
    if (_d.lengthSq() < 1e-5) _d.subVectors(this.segs[0], this.segs[1]);
    _d.normalize();
    const p = ctx.player.pos;
    _p.set(p.x - this.pos.x, p.y + 1 - this.pos.y, p.z - this.pos.z).normalize();
    _d.lerp(_p, 0.35 + this.jaw * 0.4).normalize();
    _q.setFromUnitVectors(FWD, _d);
    this.quat.slerp(_q, Math.min(1, dt * 6));
    const m = this.model;
    m.root.position.copy(this.pos);
    m.root.quaternion.copy(this.quat);
    m.root.scale.setScalar(1.05);
    m.jaw.rotation.x = this.jaw * 0.55;
    setFlash(m.materials, this.flash);

    const c = ctx.accentColor;
    const [r, g, b] = flashed(c, this.flash);
    for (let i = 1; i < Serpent.SEGS; i++) {
      _d.subVectors(this.segs[i - 1], this.segs[i]);
      if (_d.lengthSq() < 1e-6) _d.copy(FWD);
      _q.setFromUnitVectors(FWD, _d.normalize());
      const sc = 1.05 - i * 0.055;
      _m.compose(this.segs[i], _q, _s.setScalar(sc));
      ctx.swarm.segment.writeMatrix(_m, r, g, b);
    }
  }

  override sweepHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): boolean {
    if (!this.active) return false;
    const h = this.pos;
    if (!(this.aquatic && h.y < -0.8)) {
      const rr = 1.4 + r;
      if (segPointDist2(ax, ay, az, bx, by, bz, h.x, h.y, h.z) < rr * rr) {
        this.lastPart = -1;
        return true;
      }
    }
    for (let i = 1; i < Serpent.SEGS; i++) {
      const c = this.segs[i];
      if (this.aquatic && c.y < -0.8) continue;
      const rr = 0.95 - i * 0.04 + r;
      if (segPointDist2(ax, ay, az, bx, by, bz, c.x, c.y, c.z) < rr * rr) {
        this.lastPart = i;
        return true;
      }
    }
    return false;
  }

  override damage(amount: number, ctx: GameContext): boolean {
    return super.damage(this.lastPart >= 0 ? amount * 0.35 : amount, ctx);
  }

  protected override onDeath(ctx: GameContext): void {
    ctx.particles.explosion(this.pos.x, this.pos.y, this.pos.z, 1.6);
    const c = ctx.accentColor;
    for (let i = 1; i < Serpent.SEGS; i += 2) {
      const s = this.segs[i];
      if (this.aquatic && s.y < -1) continue;
      ctx.particles.explosion(s.x, s.y, s.z, 0.9 - i * 0.04, c.r, c.g, c.b);
    }
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.model.root);
    for (const m of this.model.materials) m.dispose();
  }
}

// ===========================================================================
// Hydra Stalk (3 pts): bursts up from a burrow (or the sea), sweeps the lane
// with spit, then sinks back down.
// ===========================================================================
export class HydraStalk extends Enemy {
  private readonly model: StalkModel;
  private state: 'approach' | 'rise' | 'charge' | 'sweep' | 'cool' | 'sink' | 'release' = 'approach';
  private stateT = 0;
  private cycles = 0;
  private rise = 0;
  private readonly anchorZ: number;
  private readonly sweepBase = new THREE.Vector3();
  private emitAcc = 0;
  private readonly headPos = new THREE.Vector3();
  private readonly hitPts: THREE.Vector3[];
  private readonly lookAt = new THREE.Vector3();

  constructor(ctx: GameContext, x: number, anchorZ: number) {
    super('stalk', 14 * ctx.fx.hpMul, 1.3, 350, ENEMY_COST.stalk);
    this.model = createStalkModel(ctx.biome.hide, ctx.biome.marking);
    this.pos.set(x, 0, -175);
    this.anchorZ = anchorZ;
    this.hitPts = [0, 1, 2, 3, 4].map(() => new THREE.Vector3());
    this.active = false;
    ctx.scene.add(this.model.root);
  }

  update(dt: number, ctx: GameContext): void {
    this.stateT += dt;
    const rate = ctx.fx.fireRateMul;
    switch (this.state) {
      case 'approach':
        this.pos.z += ctx.railSpeed * 0.9 * dt;
        if (this.pos.z >= this.anchorZ) {
          this.next('rise');
          ctx.sfx.roar(0.7);
          if (ctx.biome.water) splash(ctx, this.pos.x, this.pos.z, 1.8);
          else ctx.particles.explosion(this.pos.x, 0.5, this.pos.z, 1.2, 0.6, 0.5, 0.4);
        }
        break;
      case 'rise':
        this.rise = Math.min(1, this.stateT / 0.7);
        if (this.rise >= 1) this.next('charge');
        break;
      case 'charge': {
        // Telegraph: the maw gathers light.
        if (Math.random() < 0.6) {
          const a = Math.random() * Math.PI * 2;
          ctx.particles.emit(this.headPos.x + Math.cos(a) * 2, this.headPos.y + Math.sin(a) * 2, this.headPos.z + 0.8, -Math.cos(a) * 6, -Math.sin(a) * 6, 0, 0.3, 0.5, 0.1, 2, 1.2, 0.4);
        }
        if (this.stateT > 0.75 / rate) {
          const p = ctx.player.pos;
          const lead = this.headPos.distanceTo(p) / 38;
          this.sweepBase.set(p.x + ctx.player.vel.x * lead, p.y + 0.9 + ctx.player.vel.y * lead * 0.5, p.z);
          this.emitAcc = 0;
          this.next('sweep');
        }
        break;
      }
      case 'sweep': {
        const t = Math.min(1, this.stateT / 1.1);
        this.emitAcc += dt;
        const step = 0.05 / rate;
        while (this.emitAcc >= step) {
          this.emitAcc -= step;
          const off = (t - 0.5) * 0.7 * (this.cycles % 2 === 0 ? 1 : -1);
          _d.subVectors(this.sweepBase, this.headPos).normalize().applyAxisAngle(UP, off).multiplyScalar(38);
          ctx.projectiles.spawnEnemy(this.headPos.x, this.headPos.y, this.headPos.z + 0.9, _d.x, _d.y, _d.z, { needle: true, color: 0xffa02a, dmg: 10 });
        }
        if (t >= 1) {
          this.cycles++;
          this.next(this.cycles >= 3 ? 'sink' : 'cool');
        }
        break;
      }
      case 'cool':
        if (this.stateT > 1.1 / rate) this.next('charge');
        break;
      case 'sink':
        this.rise = Math.max(0, 1 - this.stateT / 0.8);
        if (this.rise <= 0) this.next('release');
        break;
      case 'release':
        this.pos.z += ctx.railSpeed * dt;
        if (this.pos.z > 10) this.despawn();
        break;
    }
    this.active = this.rise > 0.3;

    const m = this.model;
    const ground = ctx.biome.water ? 0 : groundAt(this.pos.x, this.pos.z);
    const e = this.rise * this.rise * (3 - 2 * this.rise);
    m.root.position.set(this.pos.x, ground - 7.5 * (1 - e), this.pos.z);
    m.root.visible = this.rise > 0;
    // Neck sways like a cobra; the head tracks the Harrier.
    for (let i = 0; i < m.neck.length; i++) {
      m.neck[i].rotation.z = Math.sin(this.age * 1.6 + i * 0.6) * 0.07;
      m.neck[i].rotation.x = Math.sin(this.age * 1.1 + i * 0.5) * 0.05 + (i > 2 ? 0.06 : -0.04);
    }
    m.root.updateMatrixWorld();
    const p = ctx.player.pos;
    this.lookAt.set(p.x, p.y + 0.9, p.z);
    m.head.root.lookAt(this.lookAt);
    m.head.root.updateMatrixWorld();
    m.head.mouth.getWorldPosition(this.headPos);
    m.head.root.getWorldPosition(this.hitPts[0]);
    for (let i = 1; i < 5; i++) m.neck[i].getWorldPosition(this.hitPts[i]);
    const charging = this.state === 'charge' ? 0.5 + 0.5 * Math.sin(this.stateT * 40) : 0;
    m.head.jaw.rotation.x = this.state === 'sweep' ? 0.6 : this.state === 'charge' ? 0.3 : 0.05;
    const [hide, marking, glow, bone] = m.materials;
    setFlash([hide, marking, bone], this.flash);
    glow.uniforms.uFlash.value = Math.max(this.flash, charging);
    this.pos.y = this.hitPts[0].y;
  }

  private next(s: HydraStalk['state']): void {
    this.state = s;
    this.stateT = 0;
  }

  override sweepHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): boolean {
    if (!this.active) return false;
    for (let i = 0; i < this.hitPts.length; i++) {
      const c = this.hitPts[i];
      if (c.y < -0.5) continue;
      const rr = (i === 0 ? 1.3 : 0.75) + r;
      if (segPointDist2(ax, ay, az, bx, by, bz, c.x, c.y, c.z) < rr * rr) return true;
    }
    return false;
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.model.root);
    for (const m of this.model.materials) m.dispose();
  }
}

// ===========================================================================
// One-eyed Mammoth (8 pts): stampedes in, stands its ground stomping and
// hurling tusk-volleys, then charges down the lane. Bony armour (tusks, brow,
// shoulder plates) must be broken before its hide takes full damage.
// ===========================================================================
const MAMMOTH_ANCHORS = [new THREE.Vector3(-0.85, -1.4, 2.2), new THREE.Vector3(0.85, -1.4, 2.2), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const MAMMOTH_PART_R = [0.95, 0.95, 1.05, 1.1, 1.1];

export class Mammoth extends Enemy {
  private readonly model: MammothModel;
  private readonly partHp: number[];
  private readonly partPos: THREE.Vector3[];
  private readonly partFlash: number[];
  private state: 'approach' | 'stand' | 'rear' | 'charge' = 'approach';
  private stateT = 0;
  private fireT = 2;
  private stompT = 5;
  private stomp = 0;
  private stride = 0;
  private readonly baseX: number;
  private readonly headPos = new THREE.Vector3();
  private readonly bodyPos = new THREE.Vector3();

  constructor(ctx: GameContext, x: number) {
    super('mammoth', 30 * ctx.fx.hpMul, 2.2, 1000, ENEMY_COST.mammoth);
    this.model = createMammothModel(ctx.biome.hide, ctx.biome.marking);
    this.model.root.scale.setScalar(0.85);
    this.baseX = x;
    this.pos.set(x, 0, -178);
    this.partHp = this.model.parts.map(() => 5 * ctx.fx.hpMul);
    this.partPos = this.model.parts.map(() => new THREE.Vector3());
    this.partFlash = this.model.parts.map(() => 0);
    this.contactDamage = 30;
    ctx.scene.add(this.model.root);
  }

  private get exposed(): boolean {
    return this.partHp.every((h) => h <= 0);
  }

  update(dt: number, ctx: GameContext): void {
    this.stateT += dt;
    let gait = 0;
    switch (this.state) {
      case 'approach':
        this.pos.z += (ctx.railSpeed * 0.9 + 18) * dt;
        gait = 2.2;
        if (this.pos.z >= -48) {
          this.next('stand');
          ctx.sfx.roar(1.3);
        }
        break;
      case 'stand': {
        gait = 0.6;
        this.pos.x = this.baseX + Math.sin(this.stateT * 0.5) * 4;
        this.pos.z = -48 + Math.sin(this.stateT * 0.35) * 3;
        this.fireT -= dt * ctx.fx.fireRateMul;
        if (this.fireT <= 0 && ctx.player.alive) {
          const stage2 = this.exposed;
          this.fireT = stage2 ? 1.6 : 2.4;
          const ways = stage2 ? 7 : 5;
          const spread = stage2 ? 0.55 : 0.42;
          this.model.mouth.getWorldPosition(_p);
          for (let i = 0; i < ways; i++) {
            this.fireAt(ctx, _p, 24, 0.3, { homing: stage2 ? 1.6 : 1.0, color: 0xffc04a, size: 1.15 }, (i / (ways - 1) - 0.5) * spread);
          }
          ctx.sfx.enemyShot(0.8);
        }
        this.stompT -= dt;
        if (this.stompT <= 0) {
          this.stompT = 5.5;
          this.stomp = 1;
        }
        if (this.stomp > 0) {
          const prev = this.stomp;
          this.stomp = Math.max(0, this.stomp - dt * 1.1);
          // Slam: a ring of shockwave bolts rolls out along the ground.
          if (prev > 0.35 && this.stomp <= 0.35) {
            const y = groundAt(this.pos.x, this.pos.z) + 0.6;
            for (let i = 0; i < 18; i++) {
              const a = (i / 18) * Math.PI - Math.PI;
              ctx.projectiles.spawnEnemy(this.pos.x, y, this.pos.z + 2, Math.cos(a) * 10, 0, 16 + Math.abs(Math.sin(a)) * 8, { color: 0xffa03a, size: 1.2 });
            }
            ctx.particles.explosion(this.pos.x, y, this.pos.z + 2, 1.4, 0.75, 0.6, 0.45);
            ctx.sfx.explosion(1.2);
          }
        }
        if (this.stateT > 13) {
          this.next('rear');
          ctx.sfx.roar(1.5);
        }
        break;
      }
      case 'rear':
        gait = 0.3;
        if (this.stateT > 1.1) this.next('charge');
        break;
      case 'charge':
        gait = 3;
        this.pos.z += 34 * dt;
        if (this.pos.z > 14) this.despawn();
        break;
    }

    const m = this.model;
    this.pos.y = groundAt(this.pos.x, this.pos.z);
    this.stride += dt * gait * 3.2;
    const sn = Math.sin(this.stride);
    for (let i = 0; i < 4; i++) {
      const s = (i === 0 || i === 3 ? 1 : -1) * sn;
      m.legs[i].rotation.x = s * 0.38 * Math.min(1, gait);
      m.knees[i].rotation.x = Math.max(0, -s) * 0.5 * Math.min(1, gait);
    }
    const rear = this.state === 'rear' ? Math.sin(Math.min(1, this.stateT / 1.1) * Math.PI) : Math.sin(this.stomp * Math.PI);
    m.root.position.set(this.pos.x, this.pos.y + Math.abs(Math.cos(this.stride)) * 0.15 * Math.min(1, gait), this.pos.z);
    m.root.rotation.x = -rear * 0.32;
    m.root.rotation.y = Math.sin(this.age * 0.7) * 0.08;
    for (let i = 0; i < m.trunk.length; i++) m.trunk[i].rotation.z = Math.sin(this.age * 2 + i * 0.7) * 0.12 * (1 + rear);
    m.head.rotation.x = -rear * 0.25;
    m.root.updateMatrixWorld();
    for (let i = 0; i < m.parts.length; i++) {
      this.partPos[i].copy(MAMMOTH_ANCHORS[i]);
      m.parts[i].localToWorld(this.partPos[i]);
      this.partFlash[i] = Math.max(0, this.partFlash[i] - dt * 8);
      m.partMats[i].uniforms.uFlash.value = this.partFlash[i];
    }
    m.head.getWorldPosition(this.headPos);
    this.bodyPos.set(this.pos.x, this.pos.y + 3.7, this.pos.z);
    const [hide, marking, glow, bone, fur] = m.materials;
    setFlash([hide, marking, bone, fur], this.flash);
    glow.uniforms.uFlash.value = this.flash;
    const pulse = this.exposed ? 0.5 + 0.5 * Math.sin(ctx.time * 10) : 0;
    m.eye.uniforms.uFlash.value = Math.max(this.flash, pulse * 0.6, this.state === 'rear' ? 0.8 : 0);
  }

  private next(s: Mammoth['state']): void {
    this.state = s;
    this.stateT = 0;
  }

  override sweepHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): boolean {
    if (!this.active) return false;
    for (let i = 0; i < this.partPos.length; i++) {
      if (this.partHp[i] <= 0) continue;
      const c = this.partPos[i];
      const rr = MAMMOTH_PART_R[i] + r;
      if (segPointDist2(ax, ay, az, bx, by, bz, c.x, c.y, c.z) < rr * rr) {
        this.lastPart = i;
        return true;
      }
    }
    this.lastPart = -1;
    const h = this.headPos;
    let rr = 1.3 + r;
    if (segPointDist2(ax, ay, az, bx, by, bz, h.x, h.y, h.z) < rr * rr) return true;
    const b = this.bodyPos;
    rr = 2.1 + r;
    return segPointDist2(ax, ay, az, bx, by, bz, b.x, b.y, b.z) < rr * rr;
  }

  override damage(amount: number, ctx: GameContext): boolean {
    const part = this.lastPart;
    if (part >= 0 && this.partHp[part] > 0) {
      this.partHp[part] -= amount;
      this.partFlash[part] = 1;
      if (this.partHp[part] <= 0) {
        const p = this.partPos[part];
        this.model.parts[part].visible = false;
        ctx.particles.explosion(p.x, p.y, p.z, 0.9, 1, 0.92, 0.8);
        ctx.sfx.explosion(0.5);
        ctx.sfx.roar(1.1);
      }
      return false;
    }
    // Bony armour soaks 75% until it is all broken off.
    return super.damage(this.exposed ? amount : amount * 0.25, ctx);
  }

  protected override onDeath(ctx: GameContext): void {
    ctx.particles.explosion(this.bodyPos.x, this.bodyPos.y, this.bodyPos.z, 2.8, 0.85, 0.55, 0.35);
    ctx.particles.explosion(this.headPos.x, this.headPos.y, this.headPos.z, 1.6);
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.model.root);
    for (const m of [...this.model.materials, ...this.model.partMats]) m.dispose();
  }
}

// ===========================================================================
// Bosses: three phases of bullet patterns from the mouth, shielded phase
// changes and summoned flocks. Subclasses supply the body and its motion.
// ===========================================================================
export abstract class Boss extends Enemy {
  phase = 1;
  protected shieldT = 0;
  protected t = 0;
  protected entering = true;
  /** Where patterns are fired from (updated by the subclass). */
  protected readonly muzzle = new THREE.Vector3();
  /** Extra aimed emitters for the phase-1 volleys. */
  protected readonly volleyFrom: THREE.Vector3[] = [];
  private ringT = 1.5;
  private aimT = 1;
  private spiralT = 0;
  private spiralA = 0;
  private sweepT = 3;
  private sweepActive = 0;
  private summonT = 6;
  /** Mouth opening driven by firing, 0..1. */
  protected open = 0;
  onSummon: (count: number) => void = () => {};

  constructor(
    ctx: GameContext,
    readonly title: string,
  ) {
    const hp = 220 * Math.pow(ctx.sector, 1.15) * ctx.fx.hpMul;
    super('boss', hp, 4.2, 5000 * ctx.sector, 0);
    this.isBoss = true;
    this.contactDamage = 40;
    this.active = false;
    bus.emit('boss:spawn', { name: title, maxHp: hp });
  }

  get hpFrac(): number {
    return Math.max(0, this.hp / this.maxHp);
  }

  protected get speed(): number {
    return this.phase === 3 ? 1.35 : this.phase === 2 ? 1.15 : 1;
  }

  /** Shared phase bookkeeping and pattern firing; call after positioning. */
  protected think(dt: number, ctx: GameContext): void {
    const frac = this.hpFrac;
    const want = frac < 0.33 ? 3 : frac < 0.66 ? 2 : 1;
    if (want > this.phase) {
      this.phase = want;
      this.shieldT = 1.2;
      ctx.projectiles.clearEnemyBullets(ctx.particles);
      ctx.particles.explosion(this.pos.x, this.pos.y, this.pos.z, 3, 1, 0.4, 0.75);
      ctx.sfx.roar(2);
      bus.emit('boss:phase', { phase: want });
    }
    if (this.shieldT > 0) this.shieldT -= dt;
    this.open = Math.max(0, this.open - dt * 2);
    if (this.entering || this.shieldT > 0 || !ctx.player.alive) return;
    this.runPatterns(dt * ctx.fx.fireRateMul, ctx);
  }

  protected get flashLevel(): number {
    return Math.max(this.flash, this.shieldT > 0 ? 0.5 + 0.5 * Math.sin(this.t * 30) : 0);
  }

  private runPatterns(dt: number, ctx: GameContext): void {
    const P = this.phase;
    const pos = this.muzzle;
    const col = P === 1 ? 0xff5a3a : P === 2 ? 0xffb347 : 0xff3d5a;

    // Radial rings expanding toward the player.
    this.ringT -= dt;
    if (this.ringT <= 0) {
      this.ringT = P === 1 ? 1.6 : P === 2 ? 2.2 : 1.3;
      const n = P === 3 ? 22 : 16;
      const off = Math.random() * Math.PI;
      for (let i = 0; i < n; i++) {
        const a = off + (i / n) * Math.PI * 2;
        ctx.projectiles.spawnEnemy(pos.x, pos.y, pos.z + 1, Math.cos(a) * 6.5, Math.sin(a) * 6.5, 17, { color: col });
      }
      this.open = 1;
      ctx.sfx.enemyShot(1);
    }

    // Aimed volleys.
    this.aimT -= dt;
    if (this.aimT <= 0) {
      this.aimT = P === 1 ? 0.9 : 2.0;
      if (P === 1) {
        const from = this.volleyFrom.length ? this.volleyFrom : [pos];
        for (const pp of from) this.fireAt(ctx, pp, 28, 0.6, { color: 0x7af0ff });
      } else {
        for (let i = 0; i < 7; i++) this.fireAt(ctx, pos, 24, 0.4, { color: 0x7af0ff, homing: 0.6, size: 1.1 }, (i / 6 - 0.5) * 0.7);
        this.open = 1;
      }
    }

    // Two-arm spiral stream (phase 2+).
    if (P >= 2) {
      this.spiralT -= dt;
      while (this.spiralT <= 0) {
        this.spiralT += P === 3 ? 0.07 : 0.09;
        this.spiralA += 0.37;
        for (let arm = 0; arm < 2; arm++) {
          const a = this.spiralA + arm * Math.PI;
          ctx.projectiles.spawnEnemy(pos.x, pos.y, pos.z + 1, Math.cos(a) * 8, Math.sin(a) * 8, 19, { color: col, size: 0.9 });
        }
      }
    }

    // Phase 3: raking breath sweeps + summoned flocks.
    if (P === 3) {
      this.sweepT -= dt;
      if (this.sweepT <= 0) {
        this.sweepT = 3.5;
        this.sweepActive = 1.0;
      }
      if (this.sweepActive > 0) {
        this.sweepActive -= dt;
        this.open = 1;
        const s = 1 - this.sweepActive;
        for (let k = 0; k < 2; k++) {
          const dir = k === 0 ? 1 : -1;
          _d.set((s - 0.5) * 2 * dir * 14 - pos.x, ctx.player.pos.y + 0.9 - pos.y, -pos.z).normalize().multiplyScalar(40);
          if (Math.random() < 0.6) ctx.projectiles.spawnEnemy(pos.x, pos.y, pos.z, _d.x, _d.y, _d.z, { needle: true, color: 0xff6a2a });
        }
      }
      this.summonT -= dt;
      if (this.summonT <= 0) {
        this.summonT = 7;
        this.onSummon(3);
      }
    }
  }

  override damage(amount: number, ctx: GameContext): boolean {
    if (this.shieldT > 0 || this.entering) return false;
    return super.damage(amount, ctx);
  }

  override kill(ctx: GameContext): void {
    if (!this.alive) return;
    super.kill(ctx);
    bus.emit('boss:killed', { x: this.pos.x, y: this.pos.y, z: this.pos.z });
  }

  protected override onDeath(ctx: GameContext): void {
    ctx.particles.explosion(this.pos.x, this.pos.y, this.pos.z, 5);
  }
}

/** Giant segmented beast: the head is the weak point, the body soaks damage. */
export class BeastBoss extends Boss {
  private readonly model: BeastBossModel;
  private readonly segs: THREE.Vector3[] = [];
  private readonly segR: number[] = [];
  private readonly spacing: number[] = [];
  private readonly look = new THREE.Vector3();
  private readonly aquatic: boolean;

  constructor(
    ctx: GameContext,
    title: string,
    species: Exclude<BossKind, 'stonehead'>,
  ) {
    super(ctx, title);
    this.aquatic = species === 'leviathan';
    this.model = createBeastBossModel(species, ctx.biome.hide, ctx.biome.marking);
    this.pos.set(0, this.aquatic ? -6 : 9, -215);
    ctx.scene.add(this.model.head.root);
    for (let i = 0; i < BOSS_SEGMENTS; i++) {
      const g = this.model.segments[i];
      const sc = g.scale.x;
      this.segs.push(new THREE.Vector3(0, this.pos.y, this.pos.z - 4 - i * 3));
      this.segR.push(this.model.segRadius * sc);
      this.spacing.push(this.model.segRadius * 1.55 * (i === 0 ? 1.6 : sc));
      ctx.scene.add(g);
    }
  }

  update(dt: number, ctx: GameContext): void {
    this.t += dt;
    const sp = this.speed;
    const prevY = this.pos.y;
    if (this.entering) {
      this.pos.z += (-44 - this.pos.z) * Math.min(1, dt * 1.0);
      this.pos.y += (6 - this.pos.y) * Math.min(1, dt * (this.aquatic ? 0.7 : 1.1));
      if (this.pos.z > -46) {
        this.entering = false;
        this.active = true;
        ctx.sfx.roar(2);
      }
    } else {
      this.pos.x = Math.sin(this.t * 0.45 * sp) * 7;
      this.pos.y = 6 + Math.sin(this.t * 0.9 * sp) * 1.8;
      this.pos.z = -44 + Math.sin(this.t * 0.3) * 3;
    }
    if (this.aquatic && (prevY < 0) !== (this.pos.y < 0)) splash(ctx, this.pos.x, this.pos.z, 3);

    // Body: coils weave across the screen behind the head (so the whole beast
    // reads from the rail camera), held at fixed spacing like a rope. The
    // leviathan's coils loop in and out of the sea.
    const head = this.pos;
    const k = Math.min(1, dt * 3);
    for (let i = 0; i < BOSS_SEGMENTS; i++) {
      const prev = i === 0 ? head : this.segs[i - 1];
      const cur = this.segs[i];
      const n = i + 1;
      _p.set(
        head.x + Math.sin(this.t * 0.9 - n * 0.5) * (1.5 + n * 0.85),
        this.aquatic ? head.y - 2 - n * 0.25 + Math.sin(this.t * 1.3 - n * 0.55) * 4.5 : head.y + Math.cos(this.t * 0.7 - n * 0.42) * (0.8 + n * 0.3) - n * 0.12,
        head.z - n * 1.1,
      );
      cur.lerp(_p, k);
      _d.subVectors(cur, prev);
      const len = _d.length();
      const s = this.spacing[i];
      if (len > 1e-4) cur.copy(prev).addScaledVector(_d, s / len);
    }

    const m = this.model;
    m.head.root.position.copy(head);
    const p = ctx.player.pos;
    this.look.set(head.x * 0.5 + p.x * 0.5, p.y + 1, p.z + 10);
    m.head.root.lookAt(this.look);
    m.head.jaw.rotation.x = this.open * 0.6 + 0.05;
    for (let i = 0; i < BOSS_SEGMENTS; i++) {
      const g = m.segments[i];
      g.position.copy(this.segs[i]);
      g.lookAt(i === 0 ? head : this.segs[i - 1]);
    }
    for (let w = 0; w < m.wings.length; w++) m.wings[w].rotation.z = (w === 0 ? -1 : 1) * (Math.sin(this.t * 3.2) * 0.55 + 0.15);
    for (let l = 0; l < m.legs.length; l++) m.legs[l].rotation.x = Math.sin(this.t * 7 + l * 0.9) * 0.45;
    m.head.root.updateMatrixWorld();
    m.head.mouth.getWorldPosition(this.muzzle);
    setFlash(m.materials, this.flashLevel);
    this.think(dt, ctx);
  }

  override sweepHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): boolean {
    if (!this.active) return false;
    const h = this.pos;
    let rr = 2.6 + r;
    if (segPointDist2(ax, ay, az, bx, by, bz, h.x, h.y, h.z) < rr * rr) {
      this.lastPart = -1;
      return true;
    }
    for (let i = 0; i < BOSS_SEGMENTS; i++) {
      const c = this.segs[i];
      if (this.aquatic && c.y < -1) continue;
      rr = this.segR[i] + r;
      if (segPointDist2(ax, ay, az, bx, by, bz, c.x, c.y, c.z) < rr * rr) {
        this.lastPart = i;
        return true;
      }
    }
    return false;
  }

  override damage(amount: number, ctx: GameContext): boolean {
    return super.damage(this.lastPart >= 0 ? amount * 0.3 : amount, ctx);
  }

  protected override onDeath(ctx: GameContext): void {
    super.onDeath(ctx);
    for (let i = 0; i < BOSS_SEGMENTS; i += 2) {
      const s = this.segs[i];
      ctx.particles.explosion(s.x, s.y, s.z, 2 - i * 0.08);
    }
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.model.head.root);
    for (const g of this.model.segments) ctx.scene.remove(g);
    for (const m of this.model.materials) m.dispose();
  }
}

/**
 * The Elder Idol: a vast floating stone head. Four orbiting rune-stones fire
 * volleys and ward it (the head takes 40% damage until they are shattered);
 * it spits rings from its grinding jaw and cracks open with light as it fails.
 */
export class IdolBoss extends Boss {
  private readonly model: IdolModel;
  private readonly runeHp: number[];
  private readonly runePos: THREE.Vector3[];
  private readonly runeFlash: number[];

  constructor(ctx: GameContext, title: string) {
    super(ctx, title);
    this.model = createIdolModel(ctx.biome.marking);
    this.model.root.scale.setScalar(0.9);
    this.pos.set(0, 9, -220);
    this.runeHp = this.model.runes.map(() => this.maxHp * 0.07);
    this.runePos = this.model.runes.map(() => new THREE.Vector3());
    this.runeFlash = this.model.runes.map(() => 0);
    ctx.scene.add(this.model.root);
  }

  private get warded(): boolean {
    return this.runeHp.some((h) => h > 0);
  }

  update(dt: number, ctx: GameContext): void {
    this.t += dt;
    const sp = this.speed;
    if (this.entering) {
      this.pos.z += (-46 - this.pos.z) * Math.min(1, dt * 0.9);
      this.pos.y += (6.5 - this.pos.y) * Math.min(1, dt * 0.9);
      if (this.pos.z > -48) {
        this.entering = false;
        this.active = true;
        ctx.sfx.roar(2.2);
      }
    } else {
      this.pos.x = Math.sin(this.t * 0.4 * sp) * 6.5;
      this.pos.y = 6.5 + Math.sin(this.t * 0.75 * sp) * 1.4;
      this.pos.z = -46 + Math.sin(this.t * 0.27) * 3;
    }
    const m = this.model;
    m.root.position.copy(this.pos);
    m.root.rotation.y = -this.pos.x * 0.025 + Math.sin(this.t * 0.6) * 0.08;
    m.root.rotation.z = Math.sin(this.t * 0.5) * 0.05;
    m.orbit.rotation.z += dt * 0.55 * sp;
    m.jaw.rotation.x = this.open * 0.35;
    for (let i = 0; i < m.runes.length; i++) m.runes[i].rotation.z = -m.orbit.rotation.z;
    for (let i = 0; i < m.cracks.length; i++) m.cracks[i].visible = this.phase >= 2 + (i >= 2 ? 1 : 0);
    m.root.updateMatrixWorld();
    this.volleyFrom.length = 0;
    for (let i = 0; i < m.runes.length; i++) {
      m.runes[i].getWorldPosition(this.runePos[i]);
      if (this.runeHp[i] > 0) this.volleyFrom.push(this.runePos[i]);
      this.runeFlash[i] = Math.max(0, this.runeFlash[i] - dt * 8);
      m.runeMats[i].uniforms.uFlash.value = Math.max(this.runeFlash[i], this.flashLevel * 0.5);
    }
    m.mouth.getWorldPosition(this.muzzle);
    const fl = this.flashLevel;
    for (const mat of m.materials) mat.uniforms.uFlash.value = fl;
    m.eyes.uniforms.uFlash.value = Math.max(fl, this.open * 0.6);
    this.think(dt, ctx);
  }

  override sweepHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): boolean {
    if (!this.active) return false;
    for (let i = 0; i < this.runePos.length; i++) {
      if (this.runeHp[i] <= 0) continue;
      const c = this.runePos[i];
      const rr = 1.5 + r;
      if (segPointDist2(ax, ay, az, bx, by, bz, c.x, c.y, c.z) < rr * rr) {
        this.lastPart = i;
        return true;
      }
    }
    this.lastPart = -1;
    // The head: two stacked spheres (brow and jaw).
    for (const dy of [1.2, -1.6]) {
      const rr = 3.0 + r;
      if (segPointDist2(ax, ay, az, bx, by, bz, this.pos.x, this.pos.y + dy, this.pos.z) < rr * rr) return true;
    }
    return false;
  }

  override damage(amount: number, ctx: GameContext): boolean {
    const part = this.lastPart;
    if (part >= 0 && this.runeHp[part] > 0) {
      if (this.shieldT > 0 || this.entering) return false;
      this.runeHp[part] -= amount;
      this.runeFlash[part] = 1;
      if (this.runeHp[part] <= 0) {
        const p = this.runePos[part];
        this.model.runes[part].visible = false;
        ctx.particles.explosion(p.x, p.y, p.z, 1.6, 0.8, 0.75, 0.65);
        ctx.sfx.explosion(1.2);
      }
      return false;
    }
    return super.damage(this.warded ? amount * 0.4 : amount, ctx);
  }

  protected override onDeath(ctx: GameContext): void {
    super.onDeath(ctx);
    ctx.particles.explosion(this.pos.x, this.pos.y + 3, this.pos.z, 3, 0.85, 0.8, 0.7);
    ctx.particles.explosion(this.pos.x, this.pos.y - 3, this.pos.z, 3, 0.85, 0.8, 0.7);
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.model.root);
    for (const m of [...this.model.materials, ...this.model.runeMats]) m.dispose();
  }
}

// ===========================================================================
// Scenery: biome props that scroll with the rail and sit on the terrain.
// Props in the flight lane are solid obstacles (indestructible).
// ===========================================================================
interface PropItem {
  kind: PropMeshes;
  x: number;
  z: number;
  s: number;
  hue: number;
  hit: boolean;
  wob: number;
}

export class PropField {
  private readonly items: PropItem[] = [];
  private readonly byKind = new Map<PropKind, PropMeshes>();
  private readonly counts = new Map<PropMeshes, number>();
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(readonly kinds: PropMeshes[]) {
    for (const k of kinds) this.byKind.set(k.kind, k);
  }

  /** Tints rock-type props with the biome's rock colour. */
  setRock(color: number): void {
    for (const k of this.kinds) if (k.rockTint) (k.a.material as THREE.MeshStandardMaterial).color.set(color);
  }

  spawn(kind: PropKind, x: number, scale: number): void {
    const k = this.byKind.get(kind)!;
    if (this.items.length >= k.a.instanceMatrix.count) return;
    this.items.push({ kind: k, x, z: -190, s: scale, hue: Math.random(), hit: false, wob: 0 });
  }

  clear(): void {
    this.items.length = 0;
    for (const k of this.kinds) {
      k.a.count = k.b.count = 0;
      k.a.visible = k.b.visible = false;
    }
  }

  /** Moves props with the rail; returns damage dealt to the player this frame. */
  update(dt: number, railSpeed: number, scroll: number, px: number, py: number, pz: number, colors: readonly THREE.Color[], vulnerable: boolean): number {
    let dmg = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      const prevZ = it.z;
      it.z += railSpeed * dt;
      it.wob = Math.max(0, it.wob - dt * 1.5);
      if (it.z > 12) {
        this.items.splice(i, 1);
        continue;
      }
      const height = it.kind.hitH * it.s;
      const w = it.kind.hitW * it.s;
      if (!it.hit && vulnerable && prevZ < pz + 0.7 && it.z > pz - 0.7 && Math.abs(it.x - px) < w + 0.45 && py < height) {
        it.hit = true;
        it.wob = 1;
        dmg += 25;
      }
    }
    this.counts.clear();
    for (const it of this.items) {
      const k = it.kind;
      const n = this.counts.get(k) ?? 0;
      const y = terrainY(it.x, it.z, scroll);
      // Props don't sway; they shudder briefly when the Harrier clips one.
      const shudder = Math.sin(it.wob * 40) * it.wob * 0.04;
      const yaw = k.facing ? (it.hue - 0.5) * 0.7 - it.x * 0.015 : it.hue * Math.PI * 2;
      this.q.setFromAxisAngle(UP, yaw).premultiply(_q.setFromAxisAngle(FWD, shudder));
      this.m.compose(this.v.set(it.x, y, it.z), this.q, this.sc.setScalar(it.s));
      k.a.setMatrixAt(n, this.m);
      k.b.setMatrixAt(n, this.m);
      if (k.tintB) k.b.setColorAt(n, this.c.copy(colors[Math.floor(it.hue * colors.length) % colors.length]));
      else k.b.setColorAt(n, this.c.setRGB(0.85, 0.82, 0.76));
      this.counts.set(k, n + 1);
    }
    for (const k of this.kinds) {
      const n = this.counts.get(k) ?? 0;
      k.a.count = k.b.count = n;
      k.a.visible = k.b.visible = n > 0;
      if (n === 0) continue;
      k.a.instanceMatrix.needsUpdate = true;
      k.b.instanceMatrix.needsUpdate = true;
      if (k.b.instanceColor) k.b.instanceColor.needsUpdate = true;
    }
    return dmg;
  }
}
