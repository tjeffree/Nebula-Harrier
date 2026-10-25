/** Fully-resolved, run-level weapon/movement/score modifiers. */
export interface RunStats {
  damage: number;
  fireInterval: number;
  projSpeed: number;
  jitter: number;
  /** Multiplies secondary-weapon cooldown and damage. */
  secondaryCdMul: number;
  secondaryDmgMul: number;
  chainTargets: number;
  chainRange: number;
  chainDamageMul: number;
  spreadWays: number;
  spreadDamageMul: number;
  dashCooldown: number;
  dashInvuln: number;
  dashMines: number;
  railSpeedMul: number;
  scoreMul: number;
  maxHp: number;
  shieldInterval: number;
}

export type ArchetypeId = 'STRIKER' | 'TEMPEST' | 'PHANTOM';

export interface Archetype {
  id: ArchetypeId;
  name: string;
  blurb: string;
  unlockCost: number;
  accent: number;
  trim: number;
  /** Colour of this frame's energy bolts. */
  bolt: number;
  base: Pick<RunStats, 'damage' | 'fireInterval' | 'projSpeed' | 'jitter' | 'dashCooldown' | 'dashInvuln'>;
}

export const ARCHETYPES: Record<ArchetypeId, Archetype> = {
  STRIKER: {
    id: 'STRIKER',
    name: 'Striker',
    blurb: 'Heavy single lance. High damage per bolt, steady cadence.',
    unlockCost: 0,
    accent: 0xe8742c,
    trim: 0xffb35a,
    bolt: 0xffd27a,
    base: { damage: 1.6, fireInterval: 0.13, projSpeed: 120, jitter: 0, dashCooldown: 0.85, dashInvuln: 0.14 },
  },
  TEMPEST: {
    id: 'TEMPEST',
    name: 'Tempest',
    blurb: 'Rapid scatter-fire. Lower damage, relentless volume.',
    unlockCost: 400,
    accent: 0xd9b23a,
    trim: 0xffe08a,
    bolt: 0xffa040,
    base: { damage: 0.95, fireInterval: 0.07, projSpeed: 130, jitter: 0.03, dashCooldown: 0.85, dashInvuln: 0.14 },
  },
  PHANTOM: {
    id: 'PHANTOM',
    name: 'Phantom',
    blurb: 'Phase-shift frame. Short dash cooldown, long invulnerability.',
    unlockCost: 900,
    accent: 0x4a8fc9,
    trim: 0x9fd8ff,
    bolt: 0x8fdcff,
    base: { damage: 1.25, fireInterval: 0.11, projSpeed: 125, jitter: 0, dashCooldown: 0.45, dashInvuln: 0.3 },
  },
};

export interface MetaBonuses {
  hullTier: number;
  ordnanceTier: number;
  fluxTier: number;
}

export type BoonId =
  | 'overcharge_coil'
  | 'temporal_dash'
  | 'prism_splitter'
  | 'superluminal_engine'
  | 'fractal_rounds'
  | 'ordnance_link'
  | 'nanite_weave'
  | 'aegis_lattice';

export interface BoonDef {
  id: BoonId;
  name: string;
  glyph: string;
  maxStacks: number;
  desc: (stack: number) => string;
  apply: (s: RunStats, stack: number) => void;
}

export const BOONS: Record<BoonId, BoonDef> = {
  overcharge_coil: {
    id: 'overcharge_coil',
    name: 'Overcharge Coil',
    glyph: 'ϟ',
    maxStacks: 2,
    desc: (n) =>
      n === 1
        ? 'Projectile velocity +25%. Bolts arc chain-lightning to the nearest 2 targets within 5 units.'
        : 'Chain-lightning arcs to 2 additional targets.',
    apply: (s, n) => {
      s.projSpeed *= 1.25;
      s.chainTargets += 2 * n;
      s.chainRange = 5;
    },
  },
  temporal_dash: {
    id: 'temporal_dash',
    name: 'Temporal Dash',
    glyph: '⧗',
    maxStacks: 1,
    desc: () => 'Evade grants a 0.4s invulnerability window and drops a cluster of 3 stationary antimatter mines.',
    apply: (s) => {
      s.dashInvuln = Math.max(s.dashInvuln, 0.4);
      s.dashMines = 3;
    },
  },
  prism_splitter: {
    id: 'prism_splitter',
    name: 'Prism Splitter',
    glyph: '⟁',
    maxStacks: 2,
    desc: (n) =>
      n === 1
        ? 'Primary cannon splits into a wide 3-way spread at 70% damage per projectile.'
        : 'Spread widens to 5-way.',
    apply: (s, n) => {
      s.spreadWays = n === 1 ? 3 : 5;
      s.spreadDamageMul = 0.7;
    },
  },
  superluminal_engine: {
    id: 'superluminal_engine',
    name: 'Superluminal Engine',
    glyph: '≫',
    maxStacks: 2,
    desc: () => 'Forward rail speed +15%. Score multiplier ×1.5.',
    apply: (s, n) => {
      s.railSpeedMul *= Math.pow(1.15, n);
      s.scoreMul *= Math.pow(1.5, n);
    },
  },
  fractal_rounds: {
    id: 'fractal_rounds',
    name: 'Fractal Rounds',
    glyph: '◈',
    maxStacks: 3,
    desc: () => 'Projectile damage +30%.',
    apply: (s, n) => {
      s.damage *= Math.pow(1.3, n);
    },
  },
  ordnance_link: {
    id: 'ordnance_link',
    name: 'Ordnance Link',
    glyph: '✸',
    maxStacks: 2,
    desc: () => 'Secondary weapon cooldown −25%, fire rate +12%.',
    apply: (s, n) => {
      s.secondaryCdMul *= Math.pow(0.75, n);
      s.fireInterval /= Math.pow(1.12, n);
    },
  },
  nanite_weave: {
    id: 'nanite_weave',
    name: 'Nanite Weave',
    glyph: '✚',
    maxStacks: 3,
    desc: () => 'Max hull +25. Immediately repairs 40% of hull.',
    apply: (s, n) => {
      s.maxHp += 25 * n;
    },
  },
  aegis_lattice: {
    id: 'aegis_lattice',
    name: 'Aegis Lattice',
    glyph: '⬡',
    maxStacks: 2,
    desc: (n) => (n === 1 ? 'A shield absorbs one hit; recharges every 9s.' : 'Shield recharge 5s.'),
    apply: (s, n) => {
      s.shieldInterval = n === 1 ? 9 : 5;
    },
  },
};

export interface SynergyDef {
  id: string;
  name: string;
  requires: BoonId[];
  desc: string;
  apply: (s: RunStats) => void;
}

export const SYNERGIES: SynergyDef[] = [
  {
    id: 'storm_lattice',
    name: 'Storm Lattice',
    requires: ['overcharge_coil', 'prism_splitter'],
    desc: 'Every spread bolt chains; arc damage ×1.5, +1 arc target.',
    apply: (s) => {
      s.chainDamageMul *= 1.5;
      s.chainTargets += 1;
    },
  },
  {
    id: 'event_horizon',
    name: 'Event Horizon',
    requires: ['temporal_dash', 'superluminal_engine'],
    desc: 'Dash cooldown halved.',
    apply: (s) => {
      s.dashCooldown *= 0.5;
    },
  },
  {
    id: 'cluster_payload',
    name: 'Cluster Payload',
    requires: ['ordnance_link', 'fractal_rounds'],
    desc: 'Secondary weapon damage ×1.6.',
    apply: (s) => {
      s.secondaryDmgMul *= 1.6;
    },
  },
];

/** Run-scoped boon inventory with stat resolution and draft generation. */
export class BoonRegistry {
  readonly owned = new Map<BoonId, number>();

  reset(): void {
    this.owned.clear();
  }

  stack(id: BoonId): number {
    return this.owned.get(id) ?? 0;
  }

  /** Adds a boon; returns any synergies newly completed by it. */
  add(id: BoonId): SynergyDef[] {
    const before = new Set(this.activeSynergies().map((s) => s.id));
    this.owned.set(id, Math.min(BOONS[id].maxStacks, this.stack(id) + 1));
    return this.activeSynergies().filter((s) => !before.has(s.id));
  }

  /** Synergies that taking `id` would newly complete. */
  wouldComplete(id: BoonId): SynergyDef[] {
    return SYNERGIES.filter(
      (s) =>
        s.requires.includes(id) &&
        !s.requires.every((r) => this.owned.has(r)) &&
        s.requires.every((r) => r === id || this.owned.has(r)),
    );
  }

  activeSynergies(): SynergyDef[] {
    return SYNERGIES.filter((s) => s.requires.every((r) => this.owned.has(r)));
  }

  /** Draws up to three distinct, non-maxed boons. */
  draft(rng: () => number): BoonId[] {
    const pool = (Object.keys(BOONS) as BoonId[]).filter((id) => this.stack(id) < BOONS[id].maxStacks);
    const out: BoonId[] = [];
    while (out.length < 3 && pool.length > 0) {
      // Favour boons that would complete a synergy.
      const weights = pool.map((id) =>
        SYNERGIES.some((s) => s.requires.includes(id) && s.requires.some((r) => r !== id && this.owned.has(r))) ? 2.2 : 1,
      );
      const total = weights.reduce((a, b) => a + b, 0);
      let r = rng() * total;
      let pick = 0;
      for (; pick < pool.length - 1; pick++) {
        r -= weights[pick];
        if (r <= 0) break;
      }
      out.push(pool[pick]);
      pool.splice(pick, 1);
    }
    return out;
  }

  computeStats(arch: Archetype, meta: MetaBonuses): RunStats {
    const s: RunStats = {
      ...arch.base,
      secondaryCdMul: 1,
      secondaryDmgMul: 1,
      chainTargets: 0,
      chainRange: 0,
      chainDamageMul: 0.5,
      spreadWays: 1,
      spreadDamageMul: 1,
      dashMines: 0,
      railSpeedMul: 1,
      scoreMul: 1,
      maxHp: 100,
      shieldInterval: 0,
    };
    // Meta-tree permanent upgrades.
    s.maxHp += 20 * meta.hullTier;
    s.secondaryCdMul *= 1 - 0.1 * meta.ordnanceTier;
    s.damage *= 1 + 0.2 * meta.fluxTier;
    // Boons, then synergies.
    for (const [id, n] of this.owned) BOONS[id].apply(s, n);
    for (const syn of this.activeSynergies()) syn.apply(s);
    return s;
  }
}
