import * as THREE from 'three';
import { bus } from '../core/EventBus';
import { ATLAS, createBossModel, createSentinelModel, createTitanModel, type BossModel, type SentinelModel, type TitanModel } from '../procgen/ModelFactory';
import { ENEMY_COST } from '../procgen/SectorBuilder';
import { terrainY } from '../procgen/Shaders';
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

// ===========================================================================
// Drone Wyrm (1 pt): straight fly-in, single shot, spiral retreat.
// Segments are rope-constrained instances with lateral sinusoidal motion:
//   ΔX_i = A · sin(ωt + i·φ)
// ===========================================================================
export class DroneWyrm extends Enemy {
  static readonly SEGS = 7;
  static readonly SPACING = 1.15;
  static readonly A = 0.45;
  static readonly OMEGA = 7.0;
  static readonly PHI = 0.85;

  private readonly segs: THREE.Vector3[] = [];
  /** Render-space segment positions (rope + sinusoid), reused for hit tests. */
  private readonly drawn: THREE.Vector3[] = [];
  private phase: 'wait' | 'in' | 'attack' | 'retreat' = 'wait';
  private phaseT = 0;
  private fired = false;
  private readonly start: THREE.Vector3;
  private readonly anchor: THREE.Vector3;
  private spinR = 0;
  private spinA = 0;

  constructor(
    ctx: GameContext,
    start: THREE.Vector3,
    anchor: THREE.Vector3,
    private delay: number,
    private readonly spinDir: number,
  ) {
    super('wyrm', 3 * ctx.fx.hpMul, 1.2, 100, ENEMY_COST.wyrm);
    this.start = start.clone();
    this.anchor = anchor.clone();
    this.pos.copy(start);
    for (let i = 0; i < DroneWyrm.SEGS; i++) {
      this.segs.push(new THREE.Vector3(start.x, start.y, start.z - i * DroneWyrm.SPACING));
      this.drawn.push(this.segs[i].clone());
    }
    this.active = false;
  }

  update(dt: number, ctx: GameContext): void {
    this.phaseT += dt;
    switch (this.phase) {
      case 'wait':
        if (this.phaseT >= this.delay) {
          this.phase = 'in';
          this.phaseT = 0;
          this.active = true;
        }
        return;
      case 'in': {
        const dur = 2.3;
        const t = Math.min(1, this.phaseT / dur);
        hermite(this.start, this.anchor, _p.set(0, 0, 90), _d.set(0, 0, 8), t, this.pos);
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
          if (ctx.player.alive) this.fireAt(ctx, this.pos, 30, 0.7);
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

    // Rope constraint: each segment trails its predecessor at fixed spacing.
    this.segs[0].copy(this.pos);
    for (let i = 1; i < DroneWyrm.SEGS; i++) {
      const prev = this.segs[i - 1];
      const cur = this.segs[i];
      _d.subVectors(cur, prev);
      const len = _d.length();
      if (len > DroneWyrm.SPACING) cur.copy(prev).addScaledVector(_d, DroneWyrm.SPACING / len);
    }

    // Render.
    if (this.pos.z < LOD_Z) {
      const c = ctx.accentColor;
      ctx.batch.push(this.pos.x, this.pos.y, this.pos.z, ATLAS.WYRM_LOD, 4.5, 4.5, 0, c.r, c.g, c.b, 1);
      for (let i = 0; i < DroneWyrm.SEGS; i++) this.drawn[i].copy(this.segs[i]);
      return;
    }
    const t = ctx.time;
    const ec = ctx.accentColor;
    const fl = this.flash;
    for (let i = 0; i < DroneWyrm.SEGS; i++) {
      const s = this.segs[i];
      const dx = i === 0 ? 0 : DroneWyrm.A * Math.sin(DroneWyrm.OMEGA * t + i * DroneWyrm.PHI);
      const dp = this.drawn[i].set(s.x + dx, s.y + dx * 0.35, s.z);
      // Orient along the chain.
      if (i > 0) _d.subVectors(this.drawn[i - 1], dp).normalize();
      else _d.subVectors(this.segs[0], this.segs[1]).normalize();
      if (_d.lengthSq() < 1e-6) _d.copy(FWD);
      _q.setFromUnitVectors(FWD, _d);
      const sc = i === 0 ? 1.25 : 1.0 - i * 0.075;
      _s.setScalar(sc);
      // Alternate body / belly bands; hit flash blends toward white.
      const band = i % 2 === 0 ? 1 : 0.82;
      ctx.wyrmWriter.write(dp, _q, _s, ec.r * band + (1 - ec.r * band) * fl, ec.g * band + (1 - ec.g * band) * fl, ec.b * band + (1 - ec.b * band) * fl);
    }
  }

  override sweepHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): boolean {
    if (!this.active) return false;
    for (let i = 0; i < DroneWyrm.SEGS; i++) {
      const c = this.drawn[i];
      const rr = (i === 0 ? 1.25 : 0.85) + r;
      if (segPointDist2(ax, ay, az, bx, by, bz, c.x, c.y, c.z) < rr * rr) return true;
    }
    return false;
  }

  protected override onDeath(ctx: GameContext): void {
    super.onDeath(ctx);
    const c = ctx.accentColor;
    for (let i = 1; i < DroneWyrm.SEGS; i++) {
      const s = this.drawn[i];
      ctx.particles.burst(s.x, s.y, s.z, 3, 8, c.r, c.g, c.b, 0.5);
    }
  }

  dispose(): void {}
}

// ===========================================================================
// Pylon Sentinel (3 pts): ground-anchored, sweeping predictive lasers.
// ===========================================================================
export class PylonSentinel extends Enemy {
  private readonly model: SentinelModel;
  private state: 'approach' | 'charge' | 'sweep' | 'cool' | 'release' = 'approach';
  private stateT = 0;
  private cycles = 0;
  private readonly anchorZ: number;
  private sweepBase = new THREE.Vector3();
  private emitAcc = 0;
  private readonly headPos = new THREE.Vector3();

  constructor(ctx: GameContext, x: number, anchorZ: number) {
    super('sentinel', 14 * ctx.fx.hpMul, 1.3, 350, ENEMY_COST.sentinel);
    this.model = createSentinelModel();
    this.pos.set(x, 0, -175);
    this.anchorZ = anchorZ;
    this.model.root.position.copy(this.pos);
    ctx.scene.add(this.model.root);
  }

  update(dt: number, ctx: GameContext): void {
    this.stateT += dt;
    const rate = ctx.fx.fireRateMul;
    switch (this.state) {
      case 'approach':
        this.pos.z += ctx.railSpeed * 0.9 * dt;
        if (this.pos.z >= this.anchorZ) this.next('charge');
        break;
      case 'charge': {
        // Telegraph: particles converge on the emitter.
        if (Math.random() < 0.6) {
          const a = Math.random() * Math.PI * 2;
          ctx.particles.emit(
            this.headPos.x + Math.cos(a) * 2,
            this.headPos.y + Math.sin(a) * 2,
            this.headPos.z + 0.8,
            -Math.cos(a) * 6,
            -Math.sin(a) * 6,
            0,
            0.3,
            0.5,
            0.1,
            2,
            0.4,
            0.8,
          );
        }
        if (this.stateT > 0.75 / rate) {
          // Lock on the player's predicted position at sweep start.
          const p = ctx.player.pos;
          const lead = this.headPos.distanceTo(p) / 38;
          this.sweepBase.set(p.x + ctx.player.vel.x * lead, p.y + 0.9 + ctx.player.vel.y * lead * 0.5, p.z);
          this.emitAcc = 0;
          this.next('sweep');
        }
        break;
      }
      case 'sweep': {
        const dur = 1.1;
        const t = Math.min(1, this.stateT / dur);
        this.emitAcc += dt;
        const step = 0.05 / rate;
        while (this.emitAcc >= step) {
          this.emitAcc -= step;
          const off = (t - 0.5) * 0.7 * (this.cycles % 2 === 0 ? 1 : -1);
          _d.subVectors(this.sweepBase, this.headPos).normalize().applyAxisAngle(UP, off).multiplyScalar(38);
          ctx.projectiles.spawnEnemy(this.headPos.x, this.headPos.y, this.headPos.z + 0.9, _d.x, _d.y, _d.z, {
            needle: true,
            color: 0x5cff9d,
            dmg: 10,
          });
        }
        if (t >= 1) {
          this.cycles++;
          this.next(this.cycles >= 3 ? 'release' : 'cool');
        }
        break;
      }
      case 'cool':
        if (this.stateT > 1.1 / rate) this.next('charge');
        break;
      case 'release':
        this.pos.z += ctx.railSpeed * dt;
        if (this.pos.z > 10) this.despawn();
        break;
    }

    this.model.root.position.copy(this.pos);
    this.model.head.getWorldPosition(this.headPos);
    if (ctx.player.alive) this.model.head.lookAt(ctx.player.pos.x, ctx.player.pos.y + 0.9, ctx.player.pos.z);
    const charging = this.state === 'charge' ? 0.5 + 0.5 * Math.sin(this.stateT * 40) : 0;
    const [shell, eye, white] = this.model.materials;
    shell.uniforms.uFlash.value = this.flash;
    white.uniforms.uFlash.value = this.flash;
    eye.uniforms.uFlash.value = Math.max(this.flash, charging);
  }

  private next(s: PylonSentinel['state']): void {
    this.state = s;
    this.stateT = 0;
  }

  override sweepHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): boolean {
    // Head sphere + three spheres down the column.
    const px = this.pos.x;
    const pz = this.pos.z;
    const spheres = [
      [4.0, 1.35],
      [2.6, 0.75],
      [1.3, 0.85],
      [0.3, 1.4],
    ];
    for (const [y, rad] of spheres) {
      const rr = rad + r;
      if (segPointDist2(ax, ay, az, bx, by, bz, px, y, pz) < rr * rr) return true;
    }
    return false;
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.model.root);
    for (const m of this.model.materials) m.dispose();
  }
}

// ===========================================================================
// Nebula Titan (8 pts): multi-stage armour, tracking projectile spreads.
// ===========================================================================
export class NebulaTitan extends Enemy {
  private readonly model: TitanModel;
  private readonly plateHp: number[];
  private readonly platePos: THREE.Vector3[];
  private readonly plateFlash: number[];
  private readonly from: THREE.Vector3;
  private readonly anchor: THREE.Vector3;
  private fireT = 1.5;
  private leaving = false;

  constructor(ctx: GameContext, x: number, y: number) {
    super('titan', 30 * ctx.fx.hpMul, 1.7, 1000, ENEMY_COST.titan);
    this.model = createTitanModel();
    this.from = new THREE.Vector3(x * 0.5, 10, -180);
    this.anchor = new THREE.Vector3(x, y, -62);
    this.pos.copy(this.from);
    this.plateHp = this.model.plates.map(() => 5 * ctx.fx.hpMul);
    this.platePos = this.model.plates.map(() => new THREE.Vector3());
    this.plateFlash = this.model.plates.map(() => 0);
    this.contactDamage = 30;
    ctx.scene.add(this.model.root);
  }

  private get exposed(): boolean {
    return this.plateHp.every((h) => h <= 0);
  }

  update(dt: number, ctx: GameContext): void {
    const enter = 3.2;
    if (this.age < enter) {
      const t = this.age / enter;
      const e = 1 - Math.pow(1 - t, 3);
      this.pos.lerpVectors(this.from, this.anchor, e);
    } else if (!this.leaving) {
      const t = this.age - enter;
      this.pos.set(this.anchor.x + Math.sin(t * 0.6) * 5, this.anchor.y + Math.sin(t * 0.9) * 1.2, this.anchor.z + Math.sin(t * 0.4) * 4);
      if (this.age > 30) this.leaving = true;
      this.fireT -= dt * ctx.fx.fireRateMul;
      if (this.fireT <= 0 && ctx.player.alive) {
        const stage2 = this.exposed;
        this.fireT = stage2 ? 1.5 : 2.3;
        const ways = stage2 ? 7 : 5;
        const spread = stage2 ? 0.55 : 0.42;
        for (let i = 0; i < ways; i++) {
          const yaw = (i / (ways - 1) - 0.5) * spread;
          this.fireAt(ctx, this.pos, 24, 0.3, { homing: stage2 ? 1.6 : 1.1, color: 0xffb347, size: 1.15 }, yaw);
        }
        ctx.sfx.enemyShot(0.7);
      }
    } else {
      this.pos.z -= dt * 40;
      this.pos.y += dt * 4;
      if (this.pos.z < DESPAWN_FAR) this.despawn();
    }

    const m = this.model;
    m.root.position.copy(this.pos);
    m.armor.rotation.z += dt * (this.exposed ? 0 : 0.9);
    m.core.rotation.x += dt * 0.7;
    m.core.rotation.y += dt * 1.1;
    m.root.updateMatrixWorld();
    for (let i = 0; i < m.plates.length; i++) {
      m.plates[i].getWorldPosition(this.platePos[i]);
      this.plateFlash[i] = Math.max(0, this.plateFlash[i] - dt * 8);
      m.plateMats[i].uniforms.uFlash.value = this.plateFlash[i];
    }
    m.coreMat.uniforms.uFlash.value = this.flash;
    if (this.exposed) {
      const pulse = 0.5 + 0.5 * Math.sin(ctx.time * 10);
      (m.coreMat.uniforms.uEdge.value as THREE.Color).setRGB(1, 0.3 + pulse * 0.4, 0.2);
    }
  }

  override sweepHit(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number): boolean {
    if (!this.active) return false;
    for (let i = 0; i < this.platePos.length; i++) {
      if (this.plateHp[i] <= 0) continue;
      const c = this.platePos[i];
      const rr = 1.1 + r;
      if (segPointDist2(ax, ay, az, bx, by, bz, c.x, c.y, c.z) < rr * rr) {
        this.lastPart = i;
        return true;
      }
    }
    const rr = this.radius + r;
    this.lastPart = -1;
    return segPointDist2(ax, ay, az, bx, by, bz, this.pos.x, this.pos.y, this.pos.z) < rr * rr;
  }

  override damage(amount: number, ctx: GameContext): boolean {
    const part = this.lastPart;
    if (part >= 0 && this.plateHp[part] > 0) {
      this.plateHp[part] -= amount;
      this.plateFlash[part] = 1;
      if (this.plateHp[part] <= 0) {
        const p = this.platePos[part];
        this.model.plates[part].visible = false;
        ctx.particles.explosion(p.x, p.y, p.z, 0.9, 1, 0.55, 0.15);
        ctx.sfx.explosion(0.5);
      }
      return false;
    }
    // Armour absorbs 75% of core damage until stripped.
    return super.damage(this.exposed ? amount : amount * 0.25, ctx);
  }

  protected override onDeath(ctx: GameContext): void {
    ctx.particles.explosion(this.pos.x, this.pos.y, this.pos.z, 2.6, 0.75, 0.45, 1);
  }

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.model.root);
    this.model.coreMat.dispose();
    for (const m of [...this.model.plateMats, ...this.model.extraMats]) m.dispose();
  }
}

// ===========================================================================
// Sector boss: three-phase bullet-pattern construct.
// ===========================================================================
export class SectorBoss extends Enemy {
  private readonly model: BossModel;
  phase = 1;
  private shieldT = 0;
  private t = 0;
  private ringT = 1.5;
  private aimT = 1;
  private spiralT = 0;
  private spiralA = 0;
  private sweepT = 3;
  private sweepActive = 0;
  private summonT = 6;
  private readonly podPos: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private entering = true;
  onSummon: (count: number) => void = () => {};

  constructor(
    ctx: GameContext,
    readonly title: string,
    edge: number,
    accent: number,
  ) {
    const hp = 220 * Math.pow(ctx.sector, 1.15) * ctx.fx.hpMul;
    super('boss', hp, 4.2, 5000 * ctx.sector, 0);
    this.isBoss = true;
    this.contactDamage = 40;
    this.model = createBossModel(edge, accent);
    this.model.root.scale.setScalar(1.25);
    this.pos.set(0, 8, -220);
    this.model.root.position.copy(this.pos);
    ctx.scene.add(this.model.root);
    this.active = false;
    bus.emit('boss:spawn', { name: title, maxHp: hp });
  }

  get hpFrac(): number {
    return Math.max(0, this.hp / this.maxHp);
  }

  update(dt: number, ctx: GameContext): void {
    const m = this.model;
    const speed = this.phase === 3 ? 1.35 : this.phase === 2 ? 1.15 : 1;
    m.ringA.rotation.z += dt * 0.6 * speed;
    m.ringB.rotation.y += dt * 0.9 * speed;
    m.core.rotation.y += dt * 0.4;
    m.core.rotation.x += dt * 0.25;

    if (this.entering) {
      this.pos.z += (-42 - this.pos.z) * Math.min(1, dt * 1.1);
      this.pos.y += (5.5 - this.pos.y) * Math.min(1, dt * 1.1);
      if (this.pos.z > -44) {
        this.entering = false;
        this.active = true;
      }
    } else {
      this.t += dt;
      this.pos.x = Math.sin(this.t * 0.45 * speed) * 7;
      this.pos.y = 5.5 + Math.sin(this.t * 0.9 * speed) * 1.6;
      this.pos.z = -42 + Math.sin(this.t * 0.3) * 3;
    }
    m.root.position.copy(this.pos);
    m.root.updateMatrixWorld();
    for (let i = 0; i < 4; i++) m.pods[i].getWorldPosition(this.podPos[i]);

    // Phase transitions at 66% / 33%.
    const frac = this.hpFrac;
    const want = frac < 0.33 ? 3 : frac < 0.66 ? 2 : 1;
    if (want > this.phase) {
      this.phase = want;
      this.shieldT = 1.2;
      ctx.projectiles.clearEnemyBullets(ctx.particles);
      ctx.particles.explosion(this.pos.x, this.pos.y, this.pos.z, 3, 1, 0.4, 0.75);
      bus.emit('boss:phase', { phase: want });
    }
    if (this.shieldT > 0) this.shieldT -= dt;

    const flash = Math.max(this.flash, this.shieldT > 0 ? 0.5 + 0.5 * Math.sin(ctx.time * 30) : 0);
    for (const mat of m.materials) mat.uniforms.uFlash.value = flash;

    if (this.entering || this.shieldT > 0 || !ctx.player.alive) return;
    this.runPatterns(dt * ctx.fx.fireRateMul, ctx);
  }

  private runPatterns(dt: number, ctx: GameContext): void {
    const P = this.phase;
    const pos = this.pos;
    const col = P === 1 ? 0xff4fa0 : P === 2 ? 0xffb347 : 0xff3d5a;

    // Radial rings expanding toward the player.
    this.ringT -= dt;
    if (this.ringT <= 0) {
      this.ringT = P === 1 ? 1.6 : P === 2 ? 2.2 : 1.3;
      const n = P === 3 ? 22 : 16;
      const off = Math.random() * Math.PI;
      for (let i = 0; i < n; i++) {
        const a = off + (i / n) * Math.PI * 2;
        ctx.projectiles.spawnEnemy(pos.x, pos.y, pos.z + 2, Math.cos(a) * 6.5, Math.sin(a) * 6.5, 17, { color: col });
      }
      ctx.sfx.enemyShot(1);
    }

    // Aimed pod volleys.
    this.aimT -= dt;
    if (this.aimT <= 0) {
      this.aimT = P === 1 ? 0.9 : 2.0;
      if (P === 1) {
        for (const pp of this.podPos) if (pp.y > pos.y - 1) this.fireAt(ctx, pp, 28, 0.6, { color: 0x29f0ff });
      } else {
        for (let i = 0; i < 7; i++) {
          this.fireAt(ctx, pos, 24, 0.4, { color: 0x29f0ff, homing: 0.6, size: 1.1 }, (i / 6 - 0.5) * 0.7);
        }
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
          ctx.projectiles.spawnEnemy(pos.x, pos.y, pos.z + 2, Math.cos(a) * 8, Math.sin(a) * 8, 19, { color: col, size: 0.9 });
        }
      }
    }

    // Phase 3: needle sweeps from pods + summons.
    if (P === 3) {
      this.sweepT -= dt;
      if (this.sweepT <= 0) {
        this.sweepT = 3.5;
        this.sweepActive = 1.0;
      }
      if (this.sweepActive > 0) {
        this.sweepActive -= dt;
        const s = 1 - this.sweepActive;
        for (let i = 0; i < 4; i += 2) {
          const pp = this.podPos[i];
          _d.set((s - 0.5) * 2 * (i === 0 ? 1 : -1) * 14 - pp.x, ctx.player.pos.y + 0.9 - pp.y, -pp.z).normalize().multiplyScalar(40);
          if (Math.random() < 0.6) ctx.projectiles.spawnEnemy(pp.x, pp.y, pp.z, _d.x, _d.y, _d.z, { needle: true, color: 0xff3d5a });
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

  dispose(ctx: GameContext): void {
    ctx.scene.remove(this.model.root);
    for (const m of this.model.materials) m.dispose();
  }
}

// ===========================================================================
// Tree field: puffy trees that scroll with the rail and sit on the terrain.
// Trees in the flight lane are solid obstacles (indestructible).
// ===========================================================================
export class TreeField {
  private readonly items: { x: number; z: number; s: number; hue: number; hit: boolean; wob: number }[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(
    readonly trunks: THREE.InstancedMesh,
    readonly canopies: THREE.InstancedMesh,
  ) {}

  spawn(x: number, scale: number): void {
    if (this.items.length >= this.canopies.instanceMatrix.count) return;
    this.items.push({ x, z: -190, s: scale, hue: Math.random(), hit: false, wob: 0 });
  }

  clear(): void {
    this.items.length = 0;
    this.trunks.count = 0;
    this.canopies.count = 0;
  }

  /** Moves trees with the rail; returns damage dealt to the player this frame. */
  update(
    dt: number,
    railSpeed: number,
    scroll: number,
    px: number,
    py: number,
    pz: number,
    colors: readonly THREE.Color[],
    vulnerable: boolean,
  ): number {
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
      const height = 6.3 * it.s;
      const w = 1.0 * it.s;
      if (!it.hit && vulnerable && prevZ < pz + 0.7 && it.z > pz - 0.7 && Math.abs(it.x - px) < w + 0.45 && py < height) {
        it.hit = true;
        it.wob = 1;
        dmg += 25;
      }
    }
    let n = 0;
    for (const it of this.items) {
      const y = terrainY(it.x, it.z, scroll);
      // Gentle sway, plus a springy wobble when the Harrier clips a tree.
      const sway = Math.sin(it.z * 0.15 + it.hue * 6) * 0.03 + Math.sin(it.wob * 18) * it.wob * 0.25;
      this.q.setFromAxisAngle(FWD, sway);
      this.m.compose(this.v.set(it.x, y, it.z), this.q, this.sc.setScalar(it.s));
      this.trunks.setMatrixAt(n, this.m);
      this.canopies.setMatrixAt(n, this.m);
      this.canopies.setColorAt(n, this.c.copy(colors[Math.floor(it.hue * colors.length) % colors.length]));
      n++;
    }
    this.trunks.count = n;
    this.canopies.count = n;
    this.trunks.instanceMatrix.needsUpdate = true;
    this.canopies.instanceMatrix.needsUpdate = true;
    if (this.canopies.instanceColor) this.canopies.instanceColor.needsUpdate = true;
    return dmg;
  }
}
