import type { GradeSettings } from './Shaders';

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SECTOR_COUNT = 5;
export const SECTOR_DURATION = 90;

/**
 * Difficulty scalar:  D(t, S) = S^1.4 · (1 + t/60) + Σ Ω_k
 */
export function difficulty(t: number, sector: number, omegaSum: number): number {
  return Math.pow(sector, 1.4) * (1 + t / 60) + omegaSum;
}

/** Director points each beast costs. */
export const ENEMY_COST = { flock: 1, leaper: 1, stalk: 3, serpent: 5, mammoth: 8 } as const;
export type BeastKind = keyof typeof ENEMY_COST;

// ---------------------------------------------------------------------------
// Elite modifiers (Ω) and sector nodes
// ---------------------------------------------------------------------------
export type ModifierId = 'ARMORED' | 'VOLATILE' | 'OVERCLOCKED' | 'SWARMING' | 'SHROUDED';

export interface EliteModifier {
  id: ModifierId;
  name: string;
  omega: number;
  desc: string;
}

export const ELITE_MODIFIERS: Record<ModifierId, EliteModifier> = {
  ARMORED: { id: 'ARMORED', name: 'Thick-Hided', omega: 1.5, desc: 'Beast health ×1.5' },
  VOLATILE: { id: 'VOLATILE', name: 'Venomous', omega: 2.0, desc: 'Slain beasts burst into venom spines' },
  OVERCLOCKED: { id: 'OVERCLOCKED', name: 'Frenzied', omega: 1.2, desc: 'Hostile fire +30% speed, +20% rate' },
  SWARMING: { id: 'SWARMING', name: 'Swarming', omega: 1.0, desc: 'Flocks +2' },
  SHROUDED: { id: 'SHROUDED', name: 'Fogbound', omega: 0.8, desc: 'Visibility reduced' },
};

export interface ModifierEffects {
  hpMul: number;
  bulletSpeedMul: number;
  fireRateMul: number;
  volatile: boolean;
  swarmBonus: number;
  fogMul: number;
}

export function resolveModifiers(mods: readonly ModifierId[]): ModifierEffects {
  const e: ModifierEffects = { hpMul: 1, bulletSpeedMul: 1, fireRateMul: 1, volatile: false, swarmBonus: 0, fogMul: 1 };
  for (const m of mods) {
    if (m === 'ARMORED') e.hpMul *= 1.5;
    if (m === 'VOLATILE') e.volatile = true;
    if (m === 'OVERCLOCKED') {
      e.bulletSpeedMul *= 1.3;
      e.fireRateMul *= 1.2;
    }
    if (m === 'SWARMING') e.swarmBonus += 2;
    if (m === 'SHROUDED') e.fogMul *= 0.55;
  }
  return e;
}

export interface SectorPalette {
  name: string;
  /** Node swatch colour. */
  a: number;
  /** Secondary accent. */
  b: number;
  /** Sky zenith. */
  skyTop: number;
  /** Sky band just above the haze. */
  horizon: number;
  /** Horizon haze, used for fog. */
  haze: number;
  sun: number;
  /** Direction toward the sun disc in the sky; the light sits a little higher. */
  sunDir: [number, number, number];
  sunSize: number;
  sunGlow: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  /** Cloud coverage 0..1. */
  clouds: number;
  cloudLit: number;
  cloudShade: number;
  ridgeFar: number;
  ridgeNear: number;
  stars: number;
  exposure: number;
  fogNear: number;
  fogFar: number;
  bloom: number;
  grade: GradeSettings;
}

/** Five times of day and weather: lighting is independent of the biome underneath. */
export const PALETTES: SectorPalette[] = [
  {
    name: 'Golden Hour',
    a: 0xc9372c,
    b: 0xe8742c,
    skyTop: 0x47689a,
    horizon: 0xf0b483,
    haze: 0xe2b38a,
    sun: 0xffd6a0,
    sunDir: [0.42, 0.075, -1],
    sunSize: 0.0009,
    sunGlow: 1,
    sunIntensity: 3.6,
    hemiSky: 0xa7bad6,
    hemiGround: 0x6a5038,
    hemiIntensity: 0.85,
    clouds: 0.5,
    cloudLit: 0xffe4c4,
    cloudShade: 0x8b7f92,
    ridgeFar: 0xc8957c,
    ridgeNear: 0x8b6a5e,
    stars: 0,
    exposure: 0.95,
    fogNear: 45,
    fogFar: 235,
    bloom: 0.32,
    grade: { lift: [0.035, 0.03, 0.045], gain: [1.04, 1.0, 0.95], shadowTint: [-0.01, 0, 0.025], highTint: [0.03, 0.015, -0.01], saturation: 0.96, contrast: 1.07 },
  },
  {
    name: 'Noon Haze',
    a: 0xd8462a,
    b: 0x2f6fb0,
    skyTop: 0x3b78c0,
    horizon: 0xc9d6de,
    haze: 0xd6d6cc,
    sun: 0xfff3e0,
    sunDir: [-0.3, 0.55, -1],
    sunSize: 0.0007,
    sunGlow: 0.7,
    sunIntensity: 3.2,
    hemiSky: 0xbcd2ea,
    hemiGround: 0x8a7458,
    hemiIntensity: 1.0,
    clouds: 0.32,
    cloudLit: 0xffffff,
    cloudShade: 0xa9b4c2,
    ridgeFar: 0xb9bcbc,
    ridgeNear: 0x9a9286,
    stars: 0,
    exposure: 0.9,
    fogNear: 50,
    fogFar: 240,
    bloom: 0.22,
    grade: { lift: [0.03, 0.03, 0.035], gain: [1.02, 1.0, 0.97], shadowTint: [-0.01, 0, 0.02], highTint: [0.02, 0.01, 0], saturation: 0.92, contrast: 1.08 },
  },
  {
    name: 'Storm Front',
    a: 0xffa22e,
    b: 0xd8dde3,
    skyTop: 0x353e4c,
    horizon: 0x7c838c,
    haze: 0x868c90,
    sun: 0xcfd8e4,
    sunDir: [0.1, 0.35, -1],
    sunSize: 0,
    sunGlow: 0.5,
    sunIntensity: 1.6,
    hemiSky: 0x9aa4b2,
    hemiGround: 0x4a4640,
    hemiIntensity: 1.25,
    clouds: 0.85,
    cloudLit: 0x9ea6b0,
    cloudShade: 0x3c424c,
    ridgeFar: 0x6c7278,
    ridgeNear: 0x4c5056,
    stars: 0,
    exposure: 1.05,
    fogNear: 30,
    fogFar: 185,
    bloom: 0.4,
    grade: { lift: [0.03, 0.035, 0.045], gain: [0.98, 1.0, 1.03], shadowTint: [0, 0.005, 0.02], highTint: [0, 0, 0.01], saturation: 0.8, contrast: 1.12 },
  },
  {
    name: 'Ember Dusk',
    a: 0x2fb4c8,
    b: 0xffb35a,
    skyTop: 0x2a2f55,
    horizon: 0xe0704a,
    haze: 0xc46a52,
    sun: 0xff9a5a,
    sunDir: [-0.38, 0.045, -1],
    sunSize: 0.0012,
    sunGlow: 1.3,
    sunIntensity: 3.0,
    hemiSky: 0x7a6aa8,
    hemiGround: 0x5a3428,
    hemiIntensity: 0.8,
    clouds: 0.45,
    cloudLit: 0xffa47a,
    cloudShade: 0x5a4a6e,
    ridgeFar: 0xa85a52,
    ridgeNear: 0x6a3a3c,
    stars: 0.4,
    exposure: 1.0,
    fogNear: 42,
    fogFar: 225,
    bloom: 0.4,
    grade: { lift: [0.04, 0.025, 0.05], gain: [1.05, 0.98, 0.95], shadowTint: [0, -0.005, 0.03], highTint: [0.03, 0.01, -0.01], saturation: 1.0, contrast: 1.08 },
  },
  {
    name: 'Blue Hour',
    a: 0xff4a3a,
    b: 0x8fd0ff,
    skyTop: 0x0f1830,
    horizon: 0x4a5a7c,
    haze: 0x3e4a66,
    sun: 0xbcd4ff,
    sunDir: [0.3, 0.22, -1],
    sunSize: 0.0006,
    sunGlow: 0.6,
    sunIntensity: 1.5,
    hemiSky: 0x5a6a9a,
    hemiGround: 0x2a2c34,
    hemiIntensity: 1.0,
    clouds: 0.3,
    cloudLit: 0x6a7aa0,
    cloudShade: 0x252c44,
    ridgeFar: 0x34405a,
    ridgeNear: 0x232a3c,
    stars: 1.2,
    exposure: 1.25,
    fogNear: 40,
    fogFar: 215,
    bloom: 0.55,
    grade: { lift: [0.02, 0.025, 0.05], gain: [0.98, 1.0, 1.05], shadowTint: [0, 0.005, 0.03], highTint: [0.01, 0.01, 0.02], saturation: 0.95, contrast: 1.06 },
  },
];

// ---------------------------------------------------------------------------
// Biomes: what the ground, scenery and wildlife look like. The run starts
// over open sea, makes landfall on the main island, then pushes inland
// through a branching choice of island biomes to the volcanic caldera.
// ---------------------------------------------------------------------------
export type BiomeId = 'ocean' | 'jungle' | 'mushroom' | 'ruins' | 'canyon' | 'caldera';
export type PropKind = 'spire' | 'stack' | 'palm' | 'shroom' | 'column' | 'moai' | 'basalt';
export type BossKind = 'leviathan' | 'wyvern' | 'crawler' | 'stonehead' | 'serpent' | 'firedrake';

export interface Biome {
  id: BiomeId;
  name: string;
  blurb: string;
  /** Flats (sand, grass, moss, flagstone, ash). */
  groundA: number;
  /** Exposed rock on slopes and rock-type props. */
  groundB: number;
  /** Per-instance tints for prop details (canopies, caps, moss). */
  foliage: number[];
  water: number;
  wall: number;
  checker: number;
  lava: number;
  /** Horizon ridgeline height. */
  ridge: number;
  /** Relative spawn weights of the scenery. */
  props: Partial<Record<PropKind, number>>;
  /** Share of scenery placed in the flight lane as obstacles. */
  laneProps: number;
  /** Relative spawn weights of the wildlife. */
  roster: Partial<Record<BeastKind, number>>;
  /** Hide and markings of the wildlife. */
  hide: number;
  marking: number;
  boss: { kind: BossKind; name: string };
  titles: string[];
}

export const BIOMES: Record<BiomeId, Biome> = {
  ocean: {
    id: 'ocean',
    name: 'Open Sea',
    blurb: 'Sea stacks and skerries on the approach to the island.',
    groundA: 0xc9b48a,
    groundB: 0x6e6660,
    foliage: [0x5c7a3a, 0x6f8a44, 0x4a6a34],
    water: 1,
    wall: 0,
    checker: 0,
    lava: 0,
    ridge: 0.3,
    props: { stack: 1 },
    laneProps: 0.3,
    roster: { flock: 1, leaper: 1.1, stalk: 0.7, serpent: 0.55 },
    hide: 0x3c5a66,
    marking: 0xe8d6a0,
    boss: { kind: 'leviathan', name: 'THE TIDEMAW LEVIATHAN' },
    titles: ['Shattered Sea', 'Gull Reach', 'Spindle Shoals', 'Brine Gate', 'Skerry Run'],
  },
  jungle: {
    id: 'jungle',
    name: 'Verdant Shore',
    blurb: 'Palm groves along the island coast.',
    groundA: 0x6a8a3c,
    groundB: 0x8a7458,
    foliage: [0x3f7a2a, 0x5a8f30, 0x2f6a2c],
    water: 0,
    wall: 0.45,
    checker: 0,
    lava: 0,
    ridge: 0.8,
    props: { palm: 1, spire: 0.15 },
    laneProps: 0.22,
    roster: { flock: 1, stalk: 0.8, serpent: 0.6, mammoth: 0.4 },
    hide: 0x4a5a2a,
    marking: 0xd8b03a,
    boss: { kind: 'wyvern', name: 'GREENSCALE WYVERN' },
    titles: ['Verdant Shore', 'Palm Run', 'Fernway', 'Coral Strand'],
  },
  mushroom: {
    id: 'mushroom',
    name: 'Sporewood',
    blurb: 'A forest of towering mushrooms.',
    groundA: 0x7a6a8a,
    groundB: 0x6a5a6a,
    foliage: [0xd8463a, 0xe08a3a, 0xb04a8a, 0x8a5ad8],
    water: 0,
    wall: 0.35,
    checker: 0,
    lava: 0,
    ridge: 0.7,
    props: { shroom: 1 },
    laneProps: 0.25,
    roster: { flock: 1.2, stalk: 1, serpent: 0.5, mammoth: 0.35 },
    hide: 0x5a3a5a,
    marking: 0x7ad8c0,
    boss: { kind: 'crawler', name: 'THE MYCELIUM CRAWLER' },
    titles: ['Sporewood', 'Cap Hollow', 'Mycel Vale', 'Puffball Glen'],
  },
  ruins: {
    id: 'ruins',
    name: 'Colonnade',
    blurb: 'Columns and stone heads on an ancient paved plain.',
    groundA: 0xb8a888,
    groundB: 0x9a8a72,
    foliage: [0x8a2f24, 0x9a3a2a, 0x7a2a20],
    water: 0,
    wall: 0.3,
    checker: 1,
    lava: 0,
    ridge: 0.6,
    props: { column: 1, moai: 0.35 },
    laneProps: 0.25,
    roster: { flock: 1, stalk: 0.7, serpent: 0.6, mammoth: 0.5 },
    hide: 0x6a5a4a,
    marking: 0x3ab0d8,
    boss: { kind: 'stonehead', name: 'THE ELDER IDOL' },
    titles: ['Colonnade', 'Hall of Heads', 'Idol Steppe', 'Marble Way'],
  },
  canyon: {
    id: 'canyon',
    name: 'Sunscorch Canyon',
    blurb: 'Eroded spires in a deep red gorge.',
    groundA: 0x8a7148,
    groundB: 0xa7835a,
    foliage: [0x8d6a52, 0x7a5c46, 0x9c7a5c],
    water: 0,
    wall: 1,
    checker: 0,
    lava: 0,
    ridge: 1,
    props: { spire: 1 },
    laneProps: 0.22,
    roster: { flock: 1, stalk: 0.8, serpent: 0.7, mammoth: 0.6 },
    hide: 0x6a4a34,
    marking: 0xe8742c,
    boss: { kind: 'serpent', name: 'THE DUNE SERPENT' },
    titles: ['Sunscorch Canyon', 'Red Gorge', 'Cinder Gate', 'Kestrel Run'],
  },
  caldera: {
    id: 'caldera',
    name: 'The Caldera',
    blurb: 'Basalt and lava at the island’s burning heart.',
    groundA: 0x3a3430,
    groundB: 0x2e2a28,
    foliage: [0x7a3a1a, 0x8a4a1a, 0x5a2a14],
    water: 0,
    wall: 1.15,
    checker: 0,
    lava: 1,
    ridge: 1.3,
    props: { basalt: 1, spire: 0.3 },
    laneProps: 0.25,
    roster: { flock: 1, stalk: 0.9, serpent: 0.8, mammoth: 0.7 },
    hide: 0x2a2220,
    marking: 0xff7a2a,
    boss: { kind: 'firedrake', name: 'THE ASHEN FIREDRAKE' },
    titles: ['The Caldera', 'Ember Throne', 'Obsidian Lace', 'Hollow Sun'],
  },
};

const INLAND: BiomeId[] = ['jungle', 'mushroom', 'ruins', 'canyon'];

export interface SectorNode {
  id: string;
  title: string;
  biome: Biome;
  palette: SectorPalette;
  modifiers: ModifierId[];
  omega: number;
  rewardMul: number;
  seed: number;
}

/**
 * Three branch choices for the next sector, seeded per run. Sector 1 is
 * always the sea crossing and the last sector the caldera; in between each
 * branch leads into a different inland biome, favouring unvisited ones.
 */
export function generateNodeChoices(sector: number, runSeed: number, visited: readonly BiomeId[] = []): SectorNode[] {
  const rng = mulberry32(runSeed * 977 + sector * 7919);
  const ids = Object.keys(ELITE_MODIFIERS) as ModifierId[];
  let biomes: BiomeId[];
  if (sector === 1) biomes = ['ocean', 'ocean', 'ocean'];
  else if (sector >= SECTOR_COUNT) biomes = ['caldera', 'caldera', 'caldera'];
  else {
    const shuffle = (a: BiomeId[]) => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    // Unvisited biomes first; revisits only fill the remaining branches.
    const fresh = shuffle(INLAND.filter((b) => !visited.includes(b)));
    const seen = shuffle(INLAND.filter((b) => visited.includes(b)));
    biomes = shuffle([...fresh, ...seen].slice(0, 3));
  }
  const nodes: SectorNode[] = [];
  const usedNames = new Set<string>();
  for (let i = 0; i < 3; i++) {
    // Risk ladder: one calm, one moderate, one hazardous route.
    const count = i === 0 ? (sector >= 4 ? 1 : 0) : i === 1 ? 1 : Math.min(3, 2 + (sector >= 3 ? 1 : 0));
    const mods: ModifierId[] = [];
    const pool = [...ids];
    for (let k = 0; k < count; k++) mods.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    const omega = mods.reduce((s, m) => s + ELITE_MODIFIERS[m].omega, 0);
    const biome = BIOMES[biomes[i]];
    let name = biome.titles[Math.floor(rng() * biome.titles.length)];
    for (let guard = 0; usedNames.has(name) && guard < 20; guard++) name = biome.titles[Math.floor(rng() * biome.titles.length)];
    usedNames.add(name);
    nodes.push({
      id: `${sector}-${i}`,
      title: name,
      biome,
      palette: PALETTES[(sector - 1 + i * 2) % PALETTES.length],
      modifiers: mods,
      omega,
      rewardMul: 1 + 0.25 * omega,
      seed: Math.floor(rng() * 1e9),
    });
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Wave director: spends difficulty points on wildlife every cycle.
// ---------------------------------------------------------------------------
export interface Spawner {
  spawnFlock(count: number, rng: () => number): void;
  spawnLeapers(count: number, rng: () => number): void;
  spawnStalk(rng: () => number): void;
  spawnSerpent(rng: () => number): void;
  spawnMammoth(rng: () => number): void;
  spawnProp(x: number, scale: number, rng: () => number): void;
  /** Sum of the costs of all live enemies. */
  aliveCost(): number;
}

export class WaveDirector {
  private budget = 0;
  private cycleTimer = 1.2;
  private propTimer = 1;
  private rng: () => number;
  /** Current D(t,S) — exposed for HUD/debug. */
  current = 0;

  constructor(
    private readonly sector: number,
    private readonly omega: number,
    private readonly effects: ModifierEffects,
    private readonly biome: Biome,
    seed: number,
  ) {
    this.rng = mulberry32(seed);
  }

  static readonly CYCLE = 2.0;

  update(dt: number, t: number, spawner: Spawner, spawning: boolean): void {
    const D = difficulty(t, this.sector, this.omega);
    this.current = D;

    this.propTimer -= dt;
    if (this.propTimer <= 0) {
      this.propTimer = 0.28 + this.rng() * 0.6;
      // Mostly flanking scenery; occasionally an obstacle in the flight lane.
      const x = this.rng() < this.biome.laneProps ? (this.rng() - 0.5) * 16 : (this.rng() < 0.5 ? -1 : 1) * (11 + this.rng() * 16);
      spawner.spawnProp(x, 0.7 + this.rng() * 0.8, this.rng);
    }

    if (!spawning) return;
    this.cycleTimer -= dt;
    if (this.cycleTimer > 0) return;
    this.cycleTimer += WaveDirector.CYCLE;

    // Accrue points; carry half of any unspent remainder to the next cycle.
    this.budget = Math.min(this.budget * 0.5 + D * 1.5, D * 3);
    const cap = 4 + D * 2.4;
    let guard = 6;
    while (guard-- > 0 && this.budget >= 1 && spawner.aliveCost() < cap) {
      const kind = this.pick(t);
      switch (kind) {
        case 'mammoth':
          spawner.spawnMammoth(this.rng);
          break;
        case 'serpent':
          spawner.spawnSerpent(this.rng);
          break;
        case 'stalk':
          spawner.spawnStalk(this.rng);
          break;
        case 'leaper':
        case 'flock': {
          const n = Math.max(1, Math.min(Math.floor(this.budget), 3 + Math.floor(this.rng() * 3)));
          if (kind === 'leaper') spawner.spawnLeapers(n + Math.floor(this.effects.swarmBonus / 2), this.rng);
          else spawner.spawnFlock(n + this.effects.swarmBonus, this.rng);
          this.budget -= n;
          continue;
        }
      }
      this.budget -= ENEMY_COST[kind];
    }
  }

  /** Weighted pick among the biome's wildlife that the budget can afford. */
  private pick(t: number): BeastKind {
    const big = this.sector >= 2 || t > 45;
    const opts: [BeastKind, number][] = [];
    for (const [k, w] of Object.entries(this.biome.roster) as [BeastKind, number][]) {
      if (ENEMY_COST[k] > this.budget) continue;
      if ((k === 'mammoth' || k === 'serpent') && !big && !(k === 'serpent' && t > 20)) continue;
      opts.push([k, w]);
    }
    if (opts.length === 0) return 'flock';
    let r = this.rng() * opts.reduce((s, o) => s + o[1], 0);
    for (const [k, w] of opts) {
      r -= w;
      if (r <= 0) return k;
    }
    return opts[opts.length - 1][0];
  }
}
