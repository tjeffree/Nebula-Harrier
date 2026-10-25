import type { ArchetypeId } from './BoonRegistry';

export type UpgradeId = 'hull_plating' | 'ordnance_bay' | 'core_flux' | 'whip_emitter';

export interface UpgradeEntry {
  tier: number;
  max: number;
  base_cost: number;
  scalar: number;
}

export interface MetaProfile {
  chronocores: number;
  upgrades: Record<UpgradeId, UpgradeEntry>;
  unlocked_archetypes: ArchetypeId[];
  selected_archetype: ArchetypeId;
  best_score: number;
  runs: number;
  settings: { music: number; sfx: number; crt: boolean };
}

export const UPGRADE_INFO: Record<UpgradeId, { name: string; desc: string }> = {
  hull_plating: { name: 'Flight Armour', desc: '+20 max health per tier' },
  ordnance_bay: { name: 'Ordnance Bay', desc: 'Launch with a Nova Bomb · −10% secondary cooldown per tier' },
  core_flux: { name: 'Core Flux', desc: '+20% blaster damage per tier' },
  whip_emitter: { name: 'Hard-Light Emitter', desc: '+25% whip damage and +8% reach per tier' },
};

const KEY = 'nh.meta.v1';
const CIPHER = 'NEBULA-HARRIER::chrono';
const MAGIC = 'NH1';

function defaults(): MetaProfile {
  return {
    chronocores: 0,
    upgrades: {
      hull_plating: { tier: 0, max: 5, base_cost: 100, scalar: 1.7 },
      ordnance_bay: { tier: 0, max: 5, base_cost: 150, scalar: 2.0 },
      core_flux: { tier: 0, max: 3, base_cost: 500, scalar: 2.5 },
      whip_emitter: { tier: 0, max: 4, base_cost: 200, scalar: 1.9 },
    },
    unlocked_archetypes: ['STRIKER'],
    selected_archetype: 'STRIKER',
    best_score: 0,
    runs: 0,
    settings: { music: 0.6, sfx: 0.8, crt: true },
  };
}

/** FNV-1a 32-bit, used as a tamper checksum. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function xorCipher(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const k = CIPHER.charCodeAt(i % CIPHER.length) ^ ((i * 131) & 255);
    out[i] = bytes[i] ^ k;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encode(profile: MetaProfile): string {
  const json = JSON.stringify(profile);
  const payload = toBase64(xorCipher(new TextEncoder().encode(json)));
  return `${MAGIC}.${fnv1a(payload)}.${payload}`;
}

export function decode(raw: string): MetaProfile | null {
  const [magic, sum, payload] = raw.split('.');
  if (magic !== MAGIC || !payload || fnv1a(payload) !== sum) return null;
  try {
    return JSON.parse(new TextDecoder().decode(xorCipher(fromBase64(payload)))) as MetaProfile;
  } catch {
    return null;
  }
}

/** Obfuscated, checksummed localStorage wrapper for the persistent meta-tree. */
export class MetaStore {
  profile: MetaProfile;

  constructor() {
    this.profile = this.load();
  }

  private load(): MetaProfile {
    const d = defaults();
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch {
      return d;
    }
    const p = raw ? decode(raw) : null;
    if (!p) return d;
    // Merge so new fields added in later versions get defaults.
    const merged: MetaProfile = { ...d, ...p, settings: { ...d.settings, ...p.settings }, upgrades: { ...d.upgrades } };
    for (const id of Object.keys(d.upgrades) as UpgradeId[]) {
      // Ordnance Bay replaced Thermal Heatsink; carry over tiers already paid for.
      const legacy = id === 'ordnance_bay' ? (p.upgrades as Record<string, UpgradeEntry> | undefined)?.thermal_heatsink?.tier : undefined;
      const tier = p.upgrades?.[id]?.tier ?? legacy ?? 0;
      merged.upgrades[id] = { ...d.upgrades[id], tier: Math.max(0, Math.min(d.upgrades[id].max, tier | 0)) };
    }
    if (!merged.unlocked_archetypes.includes('STRIKER')) merged.unlocked_archetypes.unshift('STRIKER');
    if (!merged.unlocked_archetypes.includes(merged.selected_archetype)) merged.selected_archetype = 'STRIKER';
    merged.chronocores = Math.max(0, Math.floor(merged.chronocores || 0));
    return merged;
  }

  save(): void {
    try {
      localStorage.setItem(KEY, encode(this.profile));
    } catch {
      /* storage unavailable (private mode) – progression stays in memory */
    }
  }

  cost(id: UpgradeId): number {
    const u = this.profile.upgrades[id];
    return Math.round(u.base_cost * Math.pow(u.scalar, u.tier));
  }

  canBuy(id: UpgradeId): boolean {
    const u = this.profile.upgrades[id];
    return u.tier < u.max && this.profile.chronocores >= this.cost(id);
  }

  buy(id: UpgradeId): boolean {
    if (!this.canBuy(id)) return false;
    this.profile.chronocores -= this.cost(id);
    this.profile.upgrades[id].tier++;
    this.save();
    return true;
  }

  unlockArchetype(id: ArchetypeId, cost: number): boolean {
    if (this.profile.unlocked_archetypes.includes(id) || this.profile.chronocores < cost) return false;
    this.profile.chronocores -= cost;
    this.profile.unlocked_archetypes.push(id);
    this.save();
    return true;
  }

  addCores(n: number): void {
    this.profile.chronocores += Math.max(0, Math.floor(n));
    this.save();
  }

  tier(id: UpgradeId): number {
    return this.profile.upgrades[id].tier;
  }
}
