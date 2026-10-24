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
  a: number;
  b: number;
  fog: number;
}

export const PALETTES: SectorPalette[] = [
  { name: 'Magenta Drift', a: 0x29f0ff, b: 0xff2bd6, fog: 0x1a0630 },
  { name: 'Ember Reach', a: 0xffb347, b: 0xff3d5a, fog: 0x2a0812 },
  { name: 'Viridian Shoal', a: 0x5cff9d, b: 0x2b8cff, fog: 0x041a24 },
  { name: 'Ultraviolet Rift', a: 0xb48cff, b: 0xff2bd6, fog: 0x14052e },
  { name: 'Solar Abyss', a: 0xfff07a, b: 0xff5b2b, fog: 0x260a04 },
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
