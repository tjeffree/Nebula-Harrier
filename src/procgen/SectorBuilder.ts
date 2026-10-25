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

export const ENEMY_COST = { wyrm: 1, sentinel: 3, titan: 8 } as const;

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
  ARMORED: { id: 'ARMORED', name: 'Armored', omega: 1.5, desc: 'Enemy hull ×1.5' },
  VOLATILE: { id: 'VOLATILE', name: 'Volatile', omega: 2.0, desc: 'Kills burst into shrapnel' },
  OVERCLOCKED: { id: 'OVERCLOCKED', name: 'Overclocked', omega: 1.2, desc: 'Hostile fire +30% speed, +20% rate' },
  SWARMING: { id: 'SWARMING', name: 'Swarming', omega: 1.0, desc: 'Wyrm packs +2' },
  SHROUDED: { id: 'SHROUDED', name: 'Shrouded', omega: 0.8, desc: 'Visibility reduced' },
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
  /** Primary accent: swarm enemy panels, boss core, node swatch. */
  a: number;
  /** Secondary accent: boss trim and pods. */
  b: number;
  /** Sky zenith. */
  skyTop: number;
  /** Sky band just above the haze. */
  horizon: number;
  /** Horizon haze, used for fog. */
  haze: number;
  /** Sand on the flats. */
  groundA: number;
  /** Exposed rock on slopes and spires. */
  groundB: number;
  /** Boulder tints at the foot of each spire. */
  foliage: number[];
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

/** Five times of day and weather: the sector look comes from light, not paint. */
export const PALETTES: SectorPalette[] = [
  {
    name: 'Golden Hour',
    a: 0xc9372c,
    b: 0xe8742c,
    skyTop: 0x47689a,
    horizon: 0xf0b483,
    haze: 0xe2b38a,
    groundA: 0x8a7148,
    groundB: 0xa7835a,
    foliage: [0x8d6a52, 0x7a5c46, 0x9c7a5c],
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
    groundA: 0xb39a72,
    groundB: 0x9c7c5e,
    foliage: [0x8a7458, 0xa08a6a, 0x766450],
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
    groundA: 0x5f5a52,
    groundB: 0x6f665c,
    foliage: [0x4c4842, 0x5a544c, 0x3f3c38],
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
    groundA: 0x6b4a3c,
    groundB: 0x8a5a44,
    foliage: [0x5c3e32, 0x6e4a3a, 0x4a3328],
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
    groundA: 0x464852,
    groundB: 0x56545e,
    foliage: [0x3a3c46, 0x44424c, 0x30323a],
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

export interface SectorNode {
  id: string;
  title: string;
  palette: SectorPalette;
  modifiers: ModifierId[];
  omega: number;
  rewardMul: number;
  seed: number;
}

const NODE_NAMES = [
  'Cinder Gate', 'Halcyon Drift', 'Shardfall', 'Vesper Line', 'Nadir Coil', 'Prism Wake', 'Iris Fold',
  'Kestrel Run', 'Obsidian Lace', 'Corona Shelf', 'Lumen Trench', 'Auric Veil', 'Static Reef', 'Hollow Sun',
];

/** Three branch choices for the next sector, seeded per run. */
export function generateNodeChoices(sector: number, runSeed: number): SectorNode[] {
  const rng = mulberry32(runSeed * 977 + sector * 7919);
  const ids = Object.keys(ELITE_MODIFIERS) as ModifierId[];
  const nodes: SectorNode[] = [];
  const usedNames = new Set<string>();
  for (let i = 0; i < 3; i++) {
    // Risk ladder: one calm, one moderate, one hazardous route.
    const count = i === 0 ? (sector >= 4 ? 1 : 0) : i === 1 ? 1 : Math.min(3, 2 + (sector >= 3 ? 1 : 0));
    const mods: ModifierId[] = [];
    const pool = [...ids];
    for (let k = 0; k < count; k++) mods.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    const omega = mods.reduce((s, m) => s + ELITE_MODIFIERS[m].omega, 0);
    let name = NODE_NAMES[Math.floor(rng() * NODE_NAMES.length)];
    while (usedNames.has(name)) name = NODE_NAMES[Math.floor(rng() * NODE_NAMES.length)];
    usedNames.add(name);
    nodes.push({
      id: `${sector}-${i}`,
      title: name,
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
// Wave director: spends difficulty points on enemy spawns every cycle.
// ---------------------------------------------------------------------------
export interface Spawner {
  spawnWyrmGroup(count: number, rng: () => number): void;
  spawnSentinel(rng: () => number): void;
  spawnTitan(rng: () => number): void;
  spawnSpire(x: number, scale: number): void;
  /** Sum of the costs of all live enemies. */
  aliveCost(): number;
}

export class WaveDirector {
  private budget = 0;
  private cycleTimer = 1.2;
  private spireTimer = 1;
  private rng: () => number;
  /** Current D(t,S) — exposed for HUD/debug. */
  current = 0;

  constructor(
    private readonly sector: number,
    private readonly omega: number,
    private readonly effects: ModifierEffects,
    seed: number,
  ) {
    this.rng = mulberry32(seed);
  }

  static readonly CYCLE = 2.0;

  update(dt: number, t: number, spawner: Spawner, spawning: boolean): void {
    const D = difficulty(t, this.sector, this.omega);
    this.current = D;

    this.spireTimer -= dt;
    if (this.spireTimer <= 0) {
      this.spireTimer = 0.5 + this.rng() * 1.1;
      const lane = this.rng();
      // Mostly flanking scenery; occasionally an obstacle in the flight lane.
      const x = lane < 0.22 ? (this.rng() - 0.5) * 16 : (this.rng() < 0.5 ? -1 : 1) * (11 + this.rng() * 16);
      spawner.spawnSpire(x, 0.7 + this.rng() * 0.8);
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
      const r = this.rng();
      if (this.budget >= ENEMY_COST.titan && (this.sector >= 2 || t > 45) && r < 0.3) {
        spawner.spawnTitan(this.rng);
        this.budget -= ENEMY_COST.titan;
      } else if (this.budget >= ENEMY_COST.sentinel && r < 0.55) {
        spawner.spawnSentinel(this.rng);
        this.budget -= ENEMY_COST.sentinel;
      } else {
        const n = Math.max(1, Math.min(Math.floor(this.budget), 3 + Math.floor(this.rng() * 3))) + this.effects.swarmBonus;
        spawner.spawnWyrmGroup(n, this.rng);
        this.budget -= n - this.effects.swarmBonus;
      }
    }
  }
}

export const BOSS_NAMES = ['SERAPH PRISMARCH', 'EMBER LEVIATHAN', 'VIRIDIAN COLOSSUS', 'UMBRAL HIEROPHANT', 'THE SOLAR HARBINGER'];
