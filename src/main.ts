import * as THREE from 'three';
import { Engine, CAMERA_POS, CAMERA_TARGET } from './core/Engine';
import { InputManager } from './core/InputManager';
import { bus } from './core/EventBus';
import { SoundSynth } from './audio/SoundSynth';
import { MusicTrackGen } from './audio/MusicTrackGen';
import { Player } from './entities/Player';
import { Ordnance, SECONDARIES } from './entities/Ordnance';
import { ArcRenderer, ParticleSystem, ProjectileSystem, SpriteBatch, type Hittable } from './entities/ProjectileSystem';
import { Enemy, EnemyManager, InstanceWriter, type GameContext } from './entities/EnemyBase';
import { BeastBoss, Boss, HydraStalk, IdolBoss, Leaper, Mammoth, PropField, Razorwing, Serpent } from './entities/EnemyVariants';
import { HardLightWhip } from './entities/Whip';
import { ATLAS, createBlobShadow, createGround, createSky, loadAtlas } from './procgen/ModelFactory';
import { createSwarmMeshes, type SwarmMeshes } from './procgen/BeastModels';
import { createPropMeshes } from './procgen/PropModels';
import { globalUniforms } from './procgen/Shaders';
import {
  BIOMES,
  ELITE_MODIFIERS,
  PALETTES,
  SECTOR_COUNT,
  SECTOR_DURATION,
  WaveDirector,
  generateNodeChoices,
  mulberry32,
  resolveModifiers,
  type Biome,
  type BiomeId,
  type PropKind,
  type SectorNode,
  type SectorPalette,
  type Spawner,
} from './procgen/SectorBuilder';
import { ARCHETYPES, BOONS, BoonRegistry, type ArchetypeId, type BoonId, type RunStats } from './roguelite/BoonRegistry';
import { MetaStore, UPGRADE_INFO, type UpgradeId } from './roguelite/MetaStore';

type State = 'title' | 'map' | 'sector' | 'bossIntro' | 'boss' | 'clear' | 'draft' | 'warp' | 'dying' | 'over' | 'victory' | 'shop';
const PLAY_STATES: ReadonlySet<State> = new Set(['sector', 'bossIntro', 'boss', 'clear', 'warp', 'dying']);

const params = new URLSearchParams(location.search);
const QUICK = params.has('quick');
const GOD = params.has('god');
const AUTOSTART = params.has('autostart');
const START_SECTOR = Math.max(1, Math.min(SECTOR_COUNT, Number(params.get('sector')) || 1));
const FORCE_BIOME = BIOMES[params.get('biome') as BiomeId] as Biome | undefined;
const SKIP_TO_BOSS = params.has('boss');
const BASE_RAIL_SPEED = 38;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

interface Mine {
  x: number;
  y: number;
  z: number;
  life: number;
}

class Game {
  private readonly engine: Engine;
  private readonly input: InputManager;
  private readonly sfx = new SoundSynth();
  private readonly music: MusicTrackGen;
  private readonly meta = new MetaStore();
  private readonly boons = new BoonRegistry();
  private readonly player: Player;
  private readonly projectiles = new ProjectileSystem();
  private readonly particles = new ParticleSystem(4096);
  private readonly batch: SpriteBatch;
  private readonly arcs = new ArcRenderer();
  private readonly ordnance = new Ordnance();
  private readonly launchAt = new THREE.Vector3();
  private readonly enemies = new EnemyManager();
  private readonly props: PropField;
  private readonly swarmMeshes: SwarmMeshes;
  private readonly whip = new HardLightWhip();
  private readonly whipAt = new THREE.Vector3();
  private readonly foliage: THREE.Color[] = [];
  private biome: Biome = BIOMES.ocean;
  private visited: BiomeId[] = [];
  private readonly shadow: THREE.Mesh;
  private readonly sky: THREE.Mesh;
  private readonly sunDir = new THREE.Vector3();
  private readonly ctx: GameContext;
  private readonly spawner: Spawner;

  private state: State = 'title';
  private paused = false;
  private stateT = 0;
  private stats!: RunStats;
  private runSeed = 1;
  private sector = 1;
  private node: SectorNode | null = null;
  private director: WaveDirector | null = null;
  private boss: Boss | null = null;
  private sectorTime = 0;
  private score = 0;
  private kills = 0;
  private coresBonus = 0;
  private sectorsCleared = 0;
  private mines: Mine[] = [];
  private shake = 0;
  private damageFlash = 0;
  private railBoost = 1;
  private readonly chainBuf: Enemy[] = [];
  private readonly camLook = new THREE.Vector3();
  private readonly aimPoint = new THREE.Vector3();
  private lastHud = { score: -1, time: -1, mult: '', hp: -1, sec: '' };
  private menuReturn: (() => void) | null = null;

  // DOM.
  private readonly screens = $('#screens');
  private readonly hud = $('#hud');
  private readonly banner = $('#banner');
  private readonly pauseBtn = $<HTMLButtonElement>('#pause-btn');

  constructor() {
    const container = $('#game');
    this.engine = new Engine(container);
    this.input = new InputManager(this.engine.renderer.domElement);
    this.music = new MusicTrackGen(this.sfx);
    const scene = this.engine.scene;

    this.sky = createSky();
    scene.add(this.sky);
    scene.fog = new THREE.Fog(0xe2b38a, 45, 235);
    scene.add(createGround());
    const propMeshes = createPropMeshes(64);
    for (const k of propMeshes) scene.add(k.a, k.b);
    this.props = new PropField(propMeshes);
    this.shadow = createBlobShadow();
    scene.add(this.shadow);
    this.swarmMeshes = createSwarmMeshes();
    const sw = this.swarmMeshes;
    scene.add(sw.flockBody, sw.wingL, sw.wingR, sw.leaper, sw.segment);
    this.batch = new SpriteBatch(8192, loadAtlas());
    scene.add(this.batch.mesh);
    scene.add(this.arcs.lines);
    scene.add(this.whip.group);

    this.player = new Player(scene);
    this.player.setArchetype(ARCHETYPES[this.meta.profile.selected_archetype]);
    this.stats = this.boons.computeStats(ARCHETYPES[this.meta.profile.selected_archetype], this.metaBonuses());
    this.player.reset(this.stats);

    this.ctx = {
      scene,
      time: 0,
      railSpeed: BASE_RAIL_SPEED,
      sector: 1,
      player: this.player,
      projectiles: this.projectiles,
      particles: this.particles,
      batch: this.batch,
      sfx: this.sfx,
      fx: resolveModifiers([]),
      enemies: this.enemies,
      swarm: {
        flockBody: new InstanceWriter(sw.flockBody),
        wingL: new InstanceWriter(sw.wingL),
        wingR: new InstanceWriter(sw.wingR),
        leaper: new InstanceWriter(sw.leaper),
        segment: new InstanceWriter(sw.segment),
      },
      biome: BIOMES.ocean,
      accentColor: new THREE.Color(BIOMES.ocean.marking),
    };

    this.spawner = {
      spawnFlock: (n, rng) => this.spawnFlock(n, rng),
      spawnLeapers: (n, rng) => {
        const side = rng() < 0.5 ? -1 : 1;
        const z = -26 - rng() * 18;
        for (let i = 0; i < n; i++) this.enemies.add(new Leaper(this.ctx, side, z - i * 2.5, 4.5 + rng() * 3, i * 0.3, 2.3 + rng() * 0.5));
      },
      spawnStalk: (rng) => {
        const x = (rng() < 0.5 ? -1 : 1) * (2.5 + rng() * 7);
        this.enemies.add(new HydraStalk(this.ctx, x, -60 + rng() * 14));
      },
      spawnSerpent: (rng) => this.enemies.add(new Serpent(this.ctx, (rng() - 0.5) * 8, 3.5 + rng() * 2.5, this.biome.water > 0)),
      spawnMammoth: (rng) => this.enemies.add(new Mammoth(this.ctx, (rng() - 0.5) * 8)),
      spawnProp: (x, s, rng) => this.spawnProp(x, s, rng),
      aliveCost: () => this.enemies.aliveCost(),
    };

    this.projectiles.onPlayerBulletHit = (t, x, y, z, dmg) => this.onBulletHit(t, x, y, z, dmg);
    this.applyBiome(BIOMES.ocean);
    this.applyPalette(PALETTES[0]);
    this.applySettings();
    this.bindEvents();
    this.bindDom();
    this.bindFullscreen();
    this.showTitle();
    if (AUTOSTART) {
      this.startRun();
      this.onAction('node', '0');
      // Debug: simulate N seconds up front so the first rendered frame is mid-fight.
      const warm = Number(params.get('warmup')) || 0;
      for (let i = 0; i < warm * 30; i++) {
        globalUniforms.uTime.value = i / 30;
        this.update(1 / 30, i / 30);
      }
    }
    this.engine.start((dt, t) => this.update(dt, t));
    if (params.has('debug')) (window as unknown as { __nh: Game }).__nh = this;
  }

  private metaBonuses() {
    return {
      hullTier: this.meta.tier('hull_plating'),
      ordnanceTier: this.meta.tier('ordnance_bay'),
      fluxTier: this.meta.tier('core_flux'),
      whipTier: this.meta.tier('whip_emitter'),
    };
  }

  // =========================================================================
  // Event wiring
  // =========================================================================
  private bindEvents(): void {
    bus.on('enemy:killed', (e) => {
      if (e.kind !== 'boss') this.kills++;
      this.score += Math.round(e.points * this.stats.scoreMul);
      const big = e.kind === 'mammoth' ? 1.6 : e.kind === 'serpent' ? 1.3 : e.kind === 'stalk' ? 1.1 : 0.7;
      this.sfx.explosion(big);
      this.shake = Math.max(this.shake, big > 1.2 ? 0.5 : 0.15);
      if (this.state === 'sector' || this.state === 'boss') this.ordnance.maybeDrop(e.x, e.y, e.z, e.kind);
    });
    this.ordnance.onPickup = (id) => {
      this.sfx.boon();
      this.showBanner(SECONDARIES[id].name.toUpperCase(), SECONDARIES[id].blurb);
    };
    bus.on('player:hit', (e) => {
      if (e.damage === 0) {
        this.sfx.shieldBreak();
        return;
      }
      this.sfx.playerHit();
      this.damageFlash = 1;
      this.shake = Math.max(this.shake, 0.6);
    });
    bus.on('player:died', () => {
      const p = this.player.pos;
      this.particles.explosion(p.x, p.y + 1, p.z - 1, 3, 1, 0.75, 0.4);
      this.sfx.explosion(2);
      this.shake = 1.2;
      this.setState('dying');
    });
    bus.on('player:dash', (e) => {
      if (this.stats.dashReadiesWhip > 0) this.whip.ready();
      if (this.stats.dashMines <= 0) return;
      for (let i = 0; i < this.stats.dashMines; i++) {
        this.mines.push({ x: e.x + (i - 1) * 1.6, y: e.y, z: this.player.pos.z - 4 - i * 3.5, life: 6 });
      }
    });
    bus.on('boss:spawn', (e) => {
      $('#boss-name').textContent = e.name;
      $('#boss').classList.add('on');
    });
    bus.on('boss:phase', (e) => {
      this.showBanner(`PHASE ${e.phase}`, e.phase === 3 ? 'IT IS FRENZIED' : 'IT IS ENRAGED', true);
      this.sfx.explosion(1.5);
      this.shake = 0.8;
    });
    bus.on('boss:killed', (e) => {
      this.projectiles.clearEnemyBullets(this.particles);
      for (let i = 0; i < 9; i++) {
        setTimeout(() => {
          this.particles.explosion(e.x + (Math.random() - 0.5) * 8, e.y + (Math.random() - 0.5) * 6, e.z, 2 + Math.random() * 2);
          this.sfx.explosion(1.6);
          this.shake = 0.9;
        }, i * 160);
      }
      $('#boss').classList.remove('on');
      this.boss = null;
      this.setState('clear');
    });
  }

  private bindDom(): void {
    const unlock = () => {
      this.sfx.unlock();
      if (this.state === 'title') this.music.setMode('title');
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    this.screens.addEventListener('click', (ev) => {
      const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!el || (el as HTMLButtonElement).disabled) return;
      this.sfx.unlock();
      this.onAction(el.dataset.action!, el.dataset.arg ?? '');
    });
    this.pauseBtn.addEventListener('click', () => this.input.requestPause());

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (PLAY_STATES.has(this.state) && !this.paused) this.setPaused(true);
        this.sfx.suspend();
      } else {
        this.sfx.unlock();
      }
    });
  }

  // =========================================================================
  // Run flow
  // =========================================================================
  private setState(s: State): void {
    this.state = s;
    this.stateT = 0;
    const playing = PLAY_STATES.has(s);
    this.hud.classList.toggle('on', playing);
    this.pauseBtn.classList.toggle('on', playing);
    this.input.menuMode = !playing;
    this.input.setTouchVisible(playing && s !== 'dying');
    if (playing) this.hideScreen();
  }

  private startRun(): void {
    const arch = ARCHETYPES[this.meta.profile.selected_archetype];
    this.boons.reset();
    this.player.setArchetype(arch);
    this.stats = this.boons.computeStats(arch, this.metaBonuses());
    this.player.reset(this.stats);
    this.ordnance.reset(this.meta.tier('ordnance_bay') > 0 ? 'nova' : null);
    this.whip.reset();
    this.whip.setColor(arch.trim);
    this.visited = [];
    this.runSeed = (Math.random() * 1e9) | 0;
    this.sector = START_SECTOR;
    this.score = 0;
    this.kills = 0;
    this.coresBonus = 0;
    this.sectorsCleared = 0;
    this.clearField();
    this.renderBoons();
    this.requestLandscape();
    this.showMap();
  }

  private requestLandscape(): void {
    if (!this.input.isTouch || document.fullscreenElement) return;
    const el = document.documentElement;
    const orient = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    el.requestFullscreen?.({ navigationUI: 'hide' })
      .then(() => orient.lock?.('landscape'))
      .catch(() => {});
  }

  /**
   * Touch devices go fullscreen as soon as they are in landscape. Browsers only
   * allow it from a user gesture, so rotating tries straight away and, if
   * refused, the next tap anywhere completes it. Tapping the portrait "rotate"
   * overlay goes fullscreen and locks landscape in one step.
   */
  private bindFullscreen(): void {
    if (!this.input.isTouch || !document.documentElement.requestFullscreen) return;
    const landscape = window.matchMedia('(orientation: landscape)');
    const onTap = () => {
      window.removeEventListener('pointerup', onTap, true);
      if (landscape.matches) this.requestLandscape();
    };
    const arm = () => {
      if (!landscape.matches || document.fullscreenElement) return;
      this.requestLandscape();
      window.addEventListener('pointerup', onTap, true);
    };
    landscape.addEventListener('change', arm);
    $('#rotate').addEventListener('click', () => this.requestLandscape());
    arm();
  }

  private clearField(): void {
    this.enemies.clear(this.ctx);
    this.projectiles.clearAll();
    this.particles.clear();
    this.arcs.clear();
    this.props.clear();
    this.whip.reset();
    this.mines.length = 0;
    this.ordnance.clearField();
    this.boss = null;
    $('#boss').classList.remove('on');
  }

  private startSector(node: SectorNode): void {
    if (FORCE_BIOME) node = { ...node, biome: FORCE_BIOME };
    this.node = node;
    this.ctx.sector = this.sector;
    this.ctx.fx = resolveModifiers(node.modifiers);
    this.applyBiome(node.biome);
    this.applyPalette(node.palette);
    this.director = new WaveDirector(this.sector, node.omega, this.ctx.fx, node.biome, node.seed);
    this.sectorTime = SKIP_TO_BOSS ? (QUICK ? 10 : SECTOR_DURATION) : 0;
    this.music.setSeed(node.seed);
    this.music.setMode('run');
    this.sfx.startEngine();
    this.input.flush();
    this.setState('sector');
    this.showBanner(`SECTOR ${this.sector}`, `${node.title} · ${node.biome.name}`.toUpperCase());
  }

  /** Ground, scenery and wildlife for a biome (lighting comes from the palette). */
  private applyBiome(b: Biome): void {
    this.biome = b;
    this.ctx.biome = b;
    const g = globalUniforms;
    g.uGroundA.value.set(b.groundA);
    g.uGroundB.value.set(b.groundB);
    g.uWater.value = b.water;
    g.uWall.value = b.wall;
    g.uChecker.value = b.checker;
    g.uLava.value = b.lava;
    g.uRidge.value = b.ridge;
    g.uIsland.value = b.water > 0 ? 0.25 : 0;
    this.props.setRock(b.groundB);
    this.foliage.length = 0;
    for (const c of b.foliage) this.foliage.push(new THREE.Color(c));
    const sw = this.swarmMeshes;
    for (const m of [sw.flockBody, sw.wingL, sw.wingR, sw.leaper, sw.segment]) (m.material as THREE.MeshStandardMaterial).color.set(b.hide);
    this.ctx.accentColor.set(b.marking);
    this.player.overWater = b.water > 0;
  }

  private applyPalette(p: SectorPalette): void {
    const g = globalUniforms;
    g.uPalA.value.set(p.a);
    g.uPalB.value.set(p.b);
    g.uFogColor.value.set(p.haze);
    g.uSkyTop.value.set(p.skyTop);
    g.uHorizon.value.set(p.horizon);
    g.uSunColor.value.set(p.sun);
    g.uSunDir.value.set(...p.sunDir).normalize();
    g.uSunSize.value = p.sunSize;
    g.uSunGlow.value = p.sunGlow;
    g.uClouds.value = p.clouds;
    g.uCloudLit.value.set(p.cloudLit);
    g.uCloudShade.value.set(p.cloudShade);
    g.uRidgeFar.value.set(p.ridgeFar);
    g.uRidgeNear.value.set(p.ridgeNear);
    g.uStars.value = p.stars;
    const fogMul = this.ctx.fx.fogMul;
    g.uFogNear.value = p.fogNear * fogMul;
    g.uFogFar.value = p.fogFar * Math.max(0.6, fogMul);
    const fog = this.engine.scene.fog as THREE.Fog;
    fog.color.set(p.haze);
    fog.near = g.uFogNear.value;
    fog.far = g.uFogFar.value;
    this.engine.renderer.setClearColor(p.haze, 1);

    // The light sits a little above the drawn sun so shadows stay long but readable.
    const e = this.engine;
    this.sunDir.set(p.sunDir[0], Math.max(0.15, p.sunDir[1] + 0.1), p.sunDir[2]);
    e.setSunDirection(this.sunDir);
    e.sun.color.set(p.sun);
    e.sun.intensity = p.sunIntensity;
    e.hemi.color.set(p.hemiSky);
    e.hemi.groundColor.set(p.hemiGround);
    e.hemi.intensity = p.hemiIntensity;
    e.setBloom(p.bloom, 0.55, 0.88);
    e.setGrade(p.grade, p.exposure);
    e.updateEnvironment(this.sky);
  }

  private spawnProp(x: number, s: number, rng: () => number): void {
    const opts = Object.entries(this.biome.props) as [PropKind, number][];
    let r = rng() * opts.reduce((a, o) => a + o[1], 0);
    let kind = opts[0][0];
    for (const [k, w] of opts) {
      r -= w;
      if (r <= 0) {
        kind = k;
        break;
      }
    }
    this.props.spawn(kind, x, kind === 'moai' ? s * 1.25 : s);
  }

  private spawnFlock(n: number, rng: () => number): void {
    const side = rng() < 0.5 ? -1 : 1;
    const baseY = 1.5 + rng() * 4.5;
    const formation = Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const k = i - (n - 1) / 2;
      let ax = k * 2.6 + (rng() - 0.5) * 2;
      let ay = baseY;
      if (formation === 1) ay = baseY + Math.abs(k) * 0.9; // V
      if (formation === 2) ay = baseY + Math.sin(i * 1.3) * 1.5; // wave
      ax = Math.max(-9, Math.min(9, ax + side * 1.5));
      ay = Math.max(0.8, Math.min(7.2, ay));
      const anchor = new THREE.Vector3(ax, ay, -28 - rng() * 14);
      const start = new THREE.Vector3(ax * 1.4 + side * 10, ay + 3 + rng() * 4, -175);
      this.enemies.add(new Razorwing(this.ctx, start, anchor, i * 0.22, side));
    }
  }

  private spawnBoss(): void {
    const { kind, name } = this.biome.boss;
    const boss = kind === 'stonehead' ? new IdolBoss(this.ctx, name) : new BeastBoss(this.ctx, name, kind);
    boss.onSummon = (n) => this.spawnFlock(n, Math.random);
    this.boss = boss;
    this.enemies.add(boss);
  }

  private finishSector(): void {
    this.sectorsCleared++;
    this.visited.push(this.biome.id);
    this.coresBonus += 60 * this.sector * (this.node?.rewardMul ?? 1);
    bus.emit('sector:clear', { sector: this.sector });
    this.clearField();
    if (this.sector >= SECTOR_COUNT) {
      this.endRun(true);
      return;
    }
    this.showDraft();
  }

  private endRun(victory: boolean): void {
    this.sfx.setEngine(0, 0, false);
    const base = this.score / 200 + this.kills * 0.4 + this.coresBonus;
    const cores = Math.floor(base * (victory ? 1.25 : 1));
    const prof = this.meta.profile;
    const best = this.score > prof.best_score;
    prof.best_score = Math.max(prof.best_score, this.score);
    prof.runs++;
    this.meta.addCores(cores);
    this.music.setMode('title');
    this.setState(victory ? 'victory' : 'over');
    this.showRunSummary(victory, cores, best);
  }

  // =========================================================================
  // Combat glue
  // =========================================================================
  private onBulletHit(t: Hittable, x: number, y: number, z: number, dmg: number): void {
    const e = t as Enemy;
    e.damage(dmg, this.ctx);
    this.sfx.hit();
    this.particles.spark(x, y, z, 2, 1.6, 1.0);
    this.particles.spark(x, y, z, 1.6, 0.9, 0.4);
    const s = this.stats;
    if (s.chainTargets > 0) {
      const near = this.enemies.nearest(e.pos.x, e.pos.y, e.pos.z, s.chainRange, s.chainTargets, e, this.chainBuf);
      for (const n of near) {
        this.arcs.add(e.pos.x, e.pos.y, e.pos.z, n.pos.x, n.pos.y, n.pos.z);
        n.damage(dmg * s.chainDamageMul, this.ctx);
      }
      if (near.length) this.sfx.chain();
    }
  }

  /** A whip strike landing: heavy hit-sparks, a jolt of shake, optional arc lightning. */
  private onWhipHit(e: Enemy, dmg: number): void {
    const p = e.pos;
    e.damage(dmg, this.ctx);
    const c = new THREE.Color(ARCHETYPES[this.meta.profile.selected_archetype].trim);
    this.particles.burst(p.x, p.y, p.z, 14, 12, c.r * 2, c.g * 2, c.b * 2, 0.45);
    this.particles.emit(p.x, p.y, p.z, 0, 0, 0, 0.25, 1, 5, c.r * 2, c.g * 2, c.b * 2, ATLAS.RING, 0);
    this.sfx.hit();
    this.shake = Math.max(this.shake, 0.18);
    if (this.stats.whipChain > 0) {
      const near = this.enemies.nearest(p.x, p.y, p.z, 7, 3, e, this.chainBuf);
      for (const n of near) {
        this.arcs.add(p.x, p.y, p.z, n.pos.x, n.pos.y, n.pos.z);
        n.damage(dmg * 0.5, this.ctx);
      }
      if (near.length) this.sfx.chain();
    }
  }

  /**
   * Picks the enemy closest to the firing line inside a narrow window ahead,
   * so near-misses still connect (essential with touch controls).
   */
  private aimAssist(x: number, y: number, z: number): THREE.Vector3 | null {
    let best: Enemy | null = null;
    let bestD = Infinity;
    for (const e of this.enemies.list) {
      if (!e.alive || !e.active || e.pos.z > z - 8) continue;
      // Window widens slightly with distance (perspective-fair).
      const win = 1.6 + e.radius + (z - e.pos.z) * 0.02;
      const dx = e.pos.x - x;
      const dy = e.pos.y - y;
      const d = dx * dx + dy * dy;
      if (Math.abs(dx) < win && Math.abs(dy) < win && d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best ? this.aimPoint.copy(best.pos) : null;
  }

  private ordnanceCtx() {
    return { game: this.ctx, arcs: this.arcs, stats: this.stats };
  }

  private updateMines(dt: number): void {
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      m.life -= dt;
      let boom = m.life <= 0;
      if (!boom) {
        for (const e of this.enemies.list) {
          if (e.alive && e.sweepHit(m.x, m.y, m.z, m.x, m.y, m.z, 1.0)) {
            boom = true;
            break;
          }
        }
      }
      if (boom) {
        const dmg = 8 * this.stats.damage;
        for (const e of this.enemies.list) {
          if (e.alive && e.active && (e.pos.x - m.x) ** 2 + (e.pos.y - m.y) ** 2 + (e.pos.z - m.z) ** 2 < 4.5 * 4.5) e.damage(dmg, this.ctx);
        }
        this.particles.explosion(m.x, m.y, m.z, 1.6, 1, 0.7, 0.35);
        this.sfx.explosion(0.9);
        this.mines.splice(i, 1);
        continue;
      }
      const pulse = 1 + Math.sin(this.ctx.time * 10 + i) * 0.15;
      this.batch.push(m.x, m.y, m.z, ATLAS.MINE, 1.4 * pulse, 1.4 * pulse, this.ctx.time * 2, 2, 1.2, 0.5, Math.min(1, m.life));
    }
  }

  // =========================================================================
  // Frame update
  // =========================================================================
  private update(dt: number, time: number): void {
    this.input.update();
    this.handleMenuNav();

    if (this.input.consumePause() && PLAY_STATES.has(this.state) && this.state !== 'dying') {
      this.setPaused(!this.paused);
    }
    // Auto-pause when a phone is rotated to portrait mid-run.
    if (!this.paused && PLAY_STATES.has(this.state) && this.input.isTouch && window.innerHeight > window.innerWidth) {
      this.setPaused(true);
    }
    if (this.paused) return;

    this.ctx.time = time;
    this.stateT += dt;
    const playing = PLAY_STATES.has(this.state);

    // Rail speed (warp boosts it).
    const targetBoost = this.state === 'warp' ? 4 : 1;
    this.railBoost += (targetBoost - this.railBoost) * Math.min(1, dt * 1.6);
    const rail = BASE_RAIL_SPEED * (playing ? this.stats.railSpeedMul : 0.7) * this.railBoost;
    this.ctx.railSpeed = rail;
    globalUniforms.uScroll.value += rail * dt;

    this.runStateLogic(dt);

    this.batch.begin();
    const sw = this.ctx.swarm;
    sw.flockBody.begin();
    sw.wingL.begin();
    sw.wingR.begin();
    sw.leaper.begin();
    sw.segment.begin();
    // The main island looms ever larger across the sea crossing.
    if (this.biome.water > 0 && this.state !== 'title') {
      const dur = QUICK ? 10 : SECTOR_DURATION;
      const prog = this.state === 'sector' ? this.sectorTime / dur : 1;
      globalUniforms.uIsland.value = 0.25 + 0.75 * Math.min(1, prog);
    }

    const controlsEnabled = playing && this.state !== 'warp' && this.state !== 'dying';
    this.player.update(dt, {
      input: this.input,
      projectiles: this.projectiles,
      particles: this.particles,
      sfx: this.sfx,
      camera: this.engine.camera,
      railSpeed: rail,
      controlsEnabled,
      aimAssist: (x, y, z) => this.aimAssist(x, y, z),
    });
    if (this.input.consumeSecondary() && controlsEnabled && this.player.alive) {
      const at = this.player.launchPoint(this.launchAt);
      if (this.ordnance.tryFire(at.x, at.y, at.z, this.ordnanceCtx())) this.shake = Math.max(this.shake, 0.35);
      else this.sfx.deny();
    }
    if (this.input.consumeMelee() && controlsEnabled && this.player.alive) {
      if (this.whip.tryStrike(this.stats)) this.sfx.whip();
    }
    this.player.whipPose = this.whip.pose;
    this.player.whipDrawn = this.whip.swinging;
    if (this.player.alive) {
      this.whip.update(dt, this.player.whipOrigin(this.whipAt), {
        game: this.ctx,
        stats: this.stats,
        onHit: (e, dmg) => this.onWhipHit(e, dmg),
      });
    }
    if (GOD) this.player.hp = this.player.stats.maxHp;

    if (playing) {
      this.enemies.update(
        dt,
        this.ctx,
        (e) => {
          if (!this.player.vulnerable()) return;
          this.player.takeDamage(e.contactDamage);
          if (!e.isBoss) e.damage(6, this.ctx);
        },
        this.player.radius,
      );
      this.projectiles.update(dt, this.enemies.list, this.player, this.ctx.fx.bulletSpeedMul);
      this.updateMines(dt);
      this.ordnance.update(dt, this.player.x, this.player.y, this.player.z, this.ordnanceCtx());
    }
    const p = this.player.pos;
    const treeDmg = this.props.update(dt, rail, globalUniforms.uScroll.value, p.x, p.y, p.z, this.foliage, playing && this.player.vulnerable());
    if (treeDmg > 0) {
      this.player.takeDamage(treeDmg);
      this.player.vel.x *= -0.6;
    }
    if (!playing || this.state === 'warp') this.director?.update(dt, 0, this.spawner, false);

    this.particles.update(dt, rail);
    this.arcs.update(dt);
    this.projectiles.render(this.batch, time);
    this.particles.render(this.batch);
    this.player.renderSprites(this.batch, time);
    this.renderWarpStreaks(dt);
    this.batch.end();
    sw.flockBody.end();
    sw.wingL.end();
    sw.wingR.end();
    sw.leaper.end();
    sw.segment.end();

    this.updateCamera(dt);
    this.updateEffects(dt);
    if (playing) this.updateHud();
    this.sfx.setEngine(Math.hypot(this.player.vel.x, this.player.vel.y), rail, playing && this.player.alive);
  }

  private runStateLogic(dt: number): void {
    switch (this.state) {
      case 'sector': {
        this.sectorTime += dt;
        const dur = QUICK ? 10 : SECTOR_DURATION;
        this.director!.update(dt, this.sectorTime, this.spawner, true);
        if (this.sectorTime >= dur) {
          this.setState('bossIntro');
          this.showBanner('WARNING', 'APEX BEAST APPROACHING', true);
          this.sfx.alarm();
          this.music.setMode('boss');
        }
        break;
      }
      case 'bossIntro':
        this.director!.update(dt, this.sectorTime, this.spawner, false);
        if (this.stateT > 3.2) {
          this.spawnBoss();
          this.setState('boss');
        }
        break;
      case 'boss':
        this.director!.update(dt, this.sectorTime, this.spawner, false);
        break;
      case 'clear':
        if (this.stateT > 0.6 && this.stateT - dt <= 0.6) this.showBanner('SECTOR CLEAR', `+${Math.round(60 * this.sector * (this.node?.rewardMul ?? 1))} CHRONOCORES BANKED`);
        if (this.stateT > 3.0) this.finishSector();
        break;
      case 'warp':
        globalUniforms.uWarp.value = Math.sin(Math.min(1, this.stateT / 2.6) * Math.PI);
        if (this.stateT > 2.6) {
          globalUniforms.uWarp.value = 0;
          this.sector++;
          this.showMap();
        }
        break;
      case 'dying':
        this.engine.timeScale = Math.min(1, 0.35 + this.stateT * 0.4);
        if (this.stateT > 1.0) {
          this.engine.timeScale = 1;
          this.clearField();
          this.endRun(false);
        }
        break;
      default:
        break;
    }
  }

  private renderWarpStreaks(dt: number): void {
    const w = globalUniforms.uWarp.value;
    if (w < 0.05) return;
    const n = Math.floor(w * 40 * dt * 60);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 4 + Math.random() * 18;
      this.particles.emit(Math.cos(a) * r, 3 + Math.sin(a) * r * 0.6, -120, 0, 0, 260, 0.5, 0.3, 0.3, 1, 1, 1, ATLAS.SPARK, 0, 0, 12);
    }
  }

  private updateCamera(dt: number): void {
    const cam = this.engine.camera;
    // Non-linear horizontal lag: lerp(cam.x, player.x * 0.18, 0.08) per 60Hz frame.
    const k = 1 - Math.pow(1 - 0.08, dt * 60);
    const targetX = this.player.pos.x * 0.18;
    const baseX = cam.userData.baseX ?? CAMERA_POS.x;
    const nx = baseX + (targetX - baseX) * k;
    cam.userData.baseX = nx;
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const s = this.shake * this.shake * 0.35;
    cam.position.set(nx + (Math.random() - 0.5) * s, CAMERA_POS.y + (Math.random() - 0.5) * s, CAMERA_POS.z);
    this.camLook.copy(CAMERA_TARGET);
    cam.lookAt(this.camLook);
  }

  private updateEffects(dt: number): void {
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.5);
    this.engine.post.uniforms.uDamage.value = this.damageFlash;
    // Contact shadow shrinks and fades as the Harrier climbs.
    const p = this.player.pos;
    const k = Math.min(1, p.y / 7.5);
    this.shadow.visible = this.player.alive;
    this.shadow.position.set(p.x, 0.04, p.z);
    this.shadow.scale.setScalar(1.25 * (1 - k * 0.45));
    (this.shadow.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 0.22 * (1 - k * 0.8);
  }

  // =========================================================================
  // HUD
  // =========================================================================
  private updateHud(): void {
    const p = this.player;
    const s = this.stats;
    $('#hp-fill').style.transform = `scaleX(${Math.max(0, p.hp / s.maxHp)})`;
    const o = this.ordnance;
    const ready = o.readiness(s);
    $('#sec-fill').style.transform = `scaleX(${ready})`;
    const sec = o.equipped ? `${SECONDARIES[o.equipped].short}|${o.cooldownLeft > 0 ? Math.ceil(o.cooldownLeft) : ''}` : '';
    if (sec !== this.lastHud.sec) {
      this.lastHud.sec = sec;
      const [name = '', secs = ''] = sec.split('|');
      $('#sec-name').textContent = name || '—';
      $('#sec-num').textContent = secs;
      $('#sec-row').classList.toggle('empty', !name);
      $('#sec-row').classList.toggle('ready', !!name && !secs);
    }
    this.input.setSecondaryButton(ready, o.equipped ? SECONDARIES[o.equipped].short : '');
    $('#dash-fill').style.transform = `scaleX(${1 - p.dashCooldownLeft / s.dashCooldown})`;
    const whipReady = this.whip.readiness(s);
    $('#whip-fill').style.transform = `scaleX(${whipReady})`;
    $('#whip-row').classList.toggle('ready', whipReady >= 1);
    this.input.setMeleeButton(whipReady);
    const hp = Math.ceil(p.hp);
    if (hp !== this.lastHud.hp) {
      this.lastHud.hp = hp;
      $('#hp-num').textContent = String(hp);
    }
    if (this.score !== this.lastHud.score) {
      this.lastHud.score = this.score;
      $('#hud-score').textContent = this.score.toLocaleString('en-US');
    }
    const mult = `×${s.scoreMul.toFixed(2)}`;
    if (mult !== this.lastHud.mult) {
      this.lastHud.mult = mult;
      $('#hud-mult').textContent = mult;
    }
    const dur = QUICK ? 10 : SECTOR_DURATION;
    const remaining = this.state === 'sector' ? Math.ceil(dur - this.sectorTime) : 0;
    if (remaining !== this.lastHud.time) {
      this.lastHud.time = remaining;
      $('#hud-timer').textContent = this.state === 'sector' ? String(remaining) : 'BOSS';
      $('#hud-sector').textContent = `SECTOR ${this.sector} / ${SECTOR_COUNT}`;
    }
    if (this.boss) $('#boss-fill').style.transform = `scaleX(${this.boss.hpFrac})`;
  }

  private renderBoons(): void {
    const el = $('#boons');
    el.innerHTML = [...this.boons.owned]
      .map(([id, n]) => `<span title="${BOONS[id].name}">${BOONS[id].glyph}${n > 1 ? `<b>${n}</b>` : ''}</span>`)
      .join('');
  }

  private showBanner(title: string, sub: string, warn = false): void {
    const b = this.banner;
    b.querySelector('h2')!.textContent = title;
    b.querySelector('p')!.textContent = sub;
    b.classList.remove('show', 'warn');
    void b.offsetWidth; // restart animation
    b.classList.add('show');
    b.classList.toggle('warn', warn);
  }

  // =========================================================================
  // Menus
  // =========================================================================
  private showScreen(html: string): void {
    this.screens.innerHTML = `<div class="screen">${html}</div>`;
    this.screens.classList.add('on');
    this.input.menuMode = true;
    this.input.setTouchVisible(false);
    const first = this.screens.querySelector<HTMLElement>('[autofocus], .btn:not([disabled]), .card');
    first?.focus({ preventScroll: true });
  }

  private hideScreen(): void {
    this.screens.classList.remove('on');
    this.screens.innerHTML = '';
  }

  private handleMenuNav(): void {
    let nav = this.input.consumeNav();
    while (nav) {
      if (this.screens.classList.contains('on')) {
        const items = Array.from(this.screens.querySelectorAll<HTMLElement>('.btn:not([disabled]), .card'));
        const idx = items.indexOf(document.activeElement as HTMLElement);
        if (nav === 'confirm') {
          (document.activeElement as HTMLElement | null)?.click();
        } else if (nav === 'back') {
          if (this.paused) this.setPaused(false);
          else this.menuReturn?.();
        } else if (items.length) {
          const step = nav === 'up' || nav === 'left' ? -1 : 1;
          const next = items[(idx + step + items.length) % items.length];
          next.focus({ preventScroll: true });
          this.sfx.click();
        }
      }
      nav = this.input.consumeNav();
    }
  }

  private setPaused(p: boolean): void {
    this.paused = p;
    if (p) {
      this.sfx.setEngine(0, 0, false);
      this.menuReturn = () => this.setPaused(false);
      this.showScreen(`
        <h3>PAUSED</h3>
        <div class="sub">SECTOR ${this.sector} · SCORE ${this.score.toLocaleString('en-US')}</div>
        <div class="row"><button class="btn primary" data-action="resume">Resume</button></div>
        ${this.settingsRow()}
        <div class="row"><button class="btn" data-action="abandon">Abandon Run</button></div>
        ${this.helpHtml()}`);
      this.music.setMode('off');
    } else {
      this.hideScreen();
      this.input.menuMode = false;
      this.input.setTouchVisible(true);
      this.input.flush();
      this.music.setMode(this.state === 'boss' || this.state === 'bossIntro' ? 'boss' : 'run');
    }
  }

  private settingsRow(): string {
    const s = this.meta.profile.settings;
    return `<div class="row">
      <button class="btn" data-action="toggle" data-arg="music">Music ${s.music > 0 ? 'On' : 'Off'}</button>
      <button class="btn" data-action="toggle" data-arg="sfx">SFX ${s.sfx > 0 ? 'On' : 'Off'}</button>
    </div>`;
  }

  private helpHtml(): string {
    return this.input.isTouch
      ? `<div class="help">LEFT THUMB: MOVE · DOUBLE-TAP + PUSH: EVADE · FIRE: SHOOT · WHIP: HARD-LIGHT LASH · SMALL BUTTON: ORDNANCE · II: PAUSE</div>`
      : `<div class="help">WASD / ARROWS: MOVE · SPACE / LMB: FIRE · Q / F / MMB: WHIP · E / RMB: ORDNANCE · SHIFT + DIRECTION: EVADE · ESC / P: PAUSE<br/>GAMEPAD: LEFT STICK · RT / A FIRE · B / LT WHIP · RB / X ORDNANCE · LB EVADE · START PAUSE</div>`;
  }

  private applySettings(): void {
    const s = this.meta.profile.settings;
    this.sfx.setVolumes(s.music, s.sfx);
  }

  private showTitle(): void {
    this.setState('title');
    this.applyBiome(BIOMES.ocean);
    this.applyPalette(PALETTES[0]);
    this.ctx.fx = resolveModifiers([]);
    this.music.setMode('title');
    this.menuReturn = null;
    const prof = this.meta.profile;
    const archCards = (Object.keys(ARCHETYPES) as ArchetypeId[])
      .map((id) => {
        const a = ARCHETYPES[id];
        const unlocked = prof.unlocked_archetypes.includes(id);
        const sel = prof.selected_archetype === id;
        const sw = `<span class="swatch" style="background:#${a.accent.toString(16).padStart(6, '0')}"></span>`;
        return `<button class="card ${sel ? 'sel' : ''} ${unlocked ? '' : 'locked'}" data-action="arch" data-arg="${id}">
          <div class="name">${sw}${a.name}</div>
          <div class="desc">${a.blurb}</div>
          <div class="meta">${unlocked ? (sel ? '▶ SELECTED' : 'SELECT') : `UNLOCK · ${a.unlockCost} CORES`}</div>
        </button>`;
      })
      .join('');
    this.showScreen(`
      <h1 class="logo">NEBULA<br/><span>HARRIER</span></h1>
      <div class="tag">JETPACK ISLAND ADVENTURE</div>
      <div class="cores">◆ ${prof.chronocores.toLocaleString('en-US')} CHRONOCORES · BEST ${prof.best_score.toLocaleString('en-US')}</div>
      <div class="cards" style="margin-top:14px">${archCards}</div>
      <div class="row">
        <button class="btn primary" data-action="launch" autofocus>Launch</button>
        <button class="btn" data-action="shop">Meta Shop</button>
      </div>
      ${this.settingsRow()}
      ${this.helpHtml()}`);
  }

  private showMap(): void {
    this.setState('map');
    this.menuReturn = null;
    const nodes = generateNodeChoices(this.sector, this.runSeed, this.visited);
    this.pendingNodes = nodes;
    const cards = nodes
      .map((n, i) => {
        const sw = `<span class="swatch" style="background:#${n.palette.a.toString(16).padStart(6, '0')}"></span>`;
        const mods = n.modifiers.length
          ? n.modifiers.map((m) => `<span class="chip" title="${ELITE_MODIFIERS[m].desc}">${ELITE_MODIFIERS[m].name} Ω${ELITE_MODIFIERS[m].omega}</span>`).join('')
          : '<span class="chip calm">NO ELITE MODIFIERS</span>';
        const desc = n.modifiers.length ? n.modifiers.map((m) => ELITE_MODIFIERS[m].desc).join(' · ') : 'A quieter corridor. Standard threat profile.';
        return `<button class="card" data-action="node" data-arg="${i}">
          <div class="name">${sw}${n.title}</div>
          <div class="desc"><b>${n.biome.name}</b> · ${n.palette.name}<br/>${n.biome.blurb}<br/>${desc}</div>
          <div class="mods">${mods}</div>
          <div class="meta">REWARD ×${n.rewardMul.toFixed(2)}</div>
        </button>`;
      })
      .join('');
    this.showScreen(`
      <h3>SECTOR ${this.sector} / ${SECTOR_COUNT} · CHART COURSE</h3>
      <div class="sub">HEALTH ${Math.ceil(this.player.hp)} / ${this.stats.maxHp} · SCORE ${this.score.toLocaleString('en-US')}</div>
      <div class="cards">${cards}</div>`);
  }

  private pendingNodes: SectorNode[] = [];
  private pendingDraft: BoonId[] = [];

  private showDraft(): void {
    this.setState('draft');
    this.menuReturn = null;
    const rng = mulberry32(this.runSeed + this.sector * 31);
    this.pendingDraft = this.boons.draft(rng);
    if (this.pendingDraft.length === 0) {
      this.startWarp();
      return;
    }
    const cards = this.pendingDraft
      .map((id, i) => {
        const b = BOONS[id];
        const next = this.boons.stack(id) + 1;
        const completes = this.boons
          .wouldComplete(id)
          .map((syn) => `${syn.name} — ${syn.desc}`)
          .join(' / ');
        return `<button class="card" data-action="boon" data-arg="${i}">
          <div class="glyph">${b.glyph}</div>
          <div class="name">${b.name}${b.maxStacks > 1 ? ` <small>${next}/${b.maxStacks}</small>` : ''}</div>
          <div class="desc">${b.desc(next)}</div>
          ${completes ? `<div class="synergy">◆ SYNERGY: ${completes}</div>` : ''}
        </button>`;
      })
      .join('');
    this.showScreen(`
      <h3>BOON DRAFT</h3>
      <div class="sub">SELECT ONE AUGMENT · HEALTH RESTORED 25%</div>
      <div class="cards">${cards}</div>`);
  }

  private startWarp(): void {
    this.input.flush();
    this.setState('warp');
    this.sfx.warp();
    if (this.sector === 1) this.showBanner('LANDFALL', 'ONWARD TO THE ISLAND');
    else if (this.sector + 1 === SECTOR_COUNT) this.showBanner('ASCENT', 'INTO THE CALDERA');
    else this.showBanner('ONWARD', `HEADING INLAND · SECTOR ${this.sector + 1}`);
  }

  private showRunSummary(victory: boolean, cores: number, best: boolean): void {
    this.menuReturn = () => this.showTitle();
    this.showScreen(`
      <h3>${victory ? 'ISLAND LIBERATED' : 'HARRIER DOWN'}</h3>
      <div class="sub">${victory ? 'ALL FIVE SECTORS CLEARED' : `FELL IN SECTOR ${this.sector}`}${best ? ' · NEW BEST' : ''}</div>
      <div class="tally">
        SCORE <b>${this.score.toLocaleString('en-US')}</b><br/>
        KILLS <b>${this.kills}</b><br/>
        SECTORS CLEARED <b>${this.sectorsCleared}</b><br/>
        ${victory ? 'VICTORY BONUS <b>×1.25</b><br/>' : ''}
        CHRONOCORES EARNED <b>+${cores}</b>
      </div>
      <div class="row">
        <button class="btn primary" data-action="shop" autofocus>Meta Shop</button>
        <button class="btn" data-action="title">Title</button>
      </div>`);
  }

  private showShop(): void {
    this.setState('shop');
    this.menuReturn = () => this.showTitle();
    const prof = this.meta.profile;
    const items = (Object.keys(prof.upgrades) as UpgradeId[])
      .map((id) => {
        const u = prof.upgrades[id];
        const maxed = u.tier >= u.max;
        const cost = this.meta.cost(id);
        const pips = Array.from({ length: u.max }, (_, i) => `<i class="${i < u.tier ? 'on' : ''}"></i>`).join('');
        return `<div class="item">
          <div class="name">${UPGRADE_INFO[id].name}</div>
          <div class="desc">${UPGRADE_INFO[id].desc}</div>
          <div class="pips">${pips}</div>
          <button class="btn" data-action="buy" data-arg="${id}" ${maxed || !this.meta.canBuy(id) ? 'disabled' : ''}>
            ${maxed ? 'Maxed' : `Buy · ${cost}`}
          </button>
        </div>`;
      })
      .join('');
    const archs = (Object.keys(ARCHETYPES) as ArchetypeId[])
      .filter((id) => !prof.unlocked_archetypes.includes(id))
      .map((id) => {
        const a = ARCHETYPES[id];
        return `<div class="item">
          <div class="name">Archetype: ${a.name}</div>
          <div class="desc">${a.blurb}</div>
          <div class="pips"></div>
          <button class="btn" data-action="unlock" data-arg="${id}" ${prof.chronocores < a.unlockCost ? 'disabled' : ''}>Unlock · ${a.unlockCost}</button>
        </div>`;
      })
      .join('');
    this.showScreen(`
      <h3>META SHOP</h3>
      <div class="cores">◆ ${prof.chronocores.toLocaleString('en-US')} CHRONOCORES</div>
      <div class="shop">${items}${archs}</div>
      <div class="row"><button class="btn primary" data-action="title">Done</button></div>`);
  }

  private onAction(action: string, arg: string): void {
    const prof = this.meta.profile;
    switch (action) {
      case 'launch':
        this.sfx.click(true);
        this.startRun();
        break;
      case 'arch': {
        const id = arg as ArchetypeId;
        if (!prof.unlocked_archetypes.includes(id)) {
          if (!this.meta.unlockArchetype(id, ARCHETYPES[id].unlockCost)) {
            this.sfx.deny();
            return;
          }
          this.sfx.boon();
        } else this.sfx.click();
        prof.selected_archetype = id;
        this.meta.save();
        this.player.setArchetype(ARCHETYPES[id]);
        this.showTitle();
        break;
      }
      case 'node':
        this.sfx.click(true);
        this.startSector(this.pendingNodes[Number(arg)]);
        break;
      case 'boon': {
        const id = this.pendingDraft[Number(arg)];
        const newSyn = this.boons.add(id);
        this.sfx.boon();
        this.stats = this.boons.computeStats(ARCHETYPES[prof.selected_archetype], this.metaBonuses());
        this.player.applyStats(this.stats, 0.25 + (id === 'nanite_weave' ? 0.4 : 0));
        this.renderBoons();
        this.startWarp();
        if (newSyn.length) {
          setTimeout(() => this.showBanner('SYNERGY', newSyn.map((s) => s.name.toUpperCase()).join(' · ')), 1200);
          for (const s of newSyn) bus.emit('synergy:unlocked', { name: s.name });
        }
        break;
      }
      case 'shop':
        this.sfx.click();
        this.showShop();
        break;
      case 'buy':
        if (this.meta.buy(arg as UpgradeId)) this.sfx.boon();
        this.showShop();
        break;
      case 'unlock': {
        const id = arg as ArchetypeId;
        if (this.meta.unlockArchetype(id, ARCHETYPES[id].unlockCost)) this.sfx.boon();
        this.showShop();
        break;
      }
      case 'title':
        this.sfx.click();
        this.showTitle();
        break;
      case 'resume':
        this.sfx.click();
        this.setPaused(false);
        break;
      case 'abandon':
        this.paused = false;
        this.hideScreen();
        this.clearField();
        this.endRun(false);
        break;
      case 'toggle': {
        const s = prof.settings;
        if (arg === 'music') s.music = s.music > 0 ? 0 : 0.6;
        if (arg === 'sfx') s.sfx = s.sfx > 0 ? 0 : 0.8;
        this.meta.save();
        this.applySettings();
        this.sfx.click();
        const btn = this.screens.querySelector<HTMLElement>(`[data-action="toggle"][data-arg="${arg}"]`);
        if (btn) {
          const label = arg === 'music' ? `Music ${s.music > 0 ? 'On' : 'Off'}` : `SFX ${s.sfx > 0 ? 'On' : 'Off'}`;
          btn.textContent = label;
        }
        break;
      }
    }
  }
}

new Game();
