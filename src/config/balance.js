/**
 * Global balance sheet + progression data.
 *
 * Anything that affects how the game *feels* numerically lives here so the
 * runtime systems stay small and the tuning can be reasoned about in one place.
 */

export const SECTOR_TARGET_MINUTES = 4;
export const MAX_SECTOR = 6;

export const PLAYER_BASE = {
  maxHealth: 100,
  maxArmor: 0,
  maxEnergy: 100,
  moveSpeed: 220,
  acceleration: 2400,
  friction: 1900,
  energyRegen: 24,
  sprintMul: 1.0,
  dashCost: 30,
  dashSpeed: 700,
  dashTime: 0.15,
  dashCooldown: 0.5,
  invulnOnHit: 0.5,
  hitStopOnDamage: 0.05,
  pickupRadius: 44,
  radius: 14,
  reviveInvuln: 1.5,
};

export const ARMOR_REDUCTION_PER_POINT = 0.055;
export const ARMOR_REDUCTION_CAP = 0.62;

export const XP_CURVE = {
  base: 120,
  growth: 1.16,
  maxLevel: 60,
};

/**
 * Run XP granted for finishing a sector objective, scaled by the sector's own
 * xp multiplier. Kills used to be the only XP source, so the one step of the
 * loop that is always required - reach the objective and complete it - paid
 * nothing, and play was pushed toward farming kills instead. Measured effect is
 * deliberately modest: about 15% of a tier-1 sector's XP and 8% of a tier-6
 * one, worth roughly one extra level over a six-sector run.
 */
export const OBJECTIVE_XP_BASE = 50;

export function xpForLevel(level) {
  return Math.round(XP_CURVE.base * Math.pow(XP_CURVE.growth, Math.max(0, level - 1)));
}

export function totalXpForLevel(level) {
  let total = 0;
  for (let i = 1; i < level; i += 1) total += xpForLevel(i);
  return total;
}

export function levelFromXp(totalXp) {
  let level = 1;
  let remaining = totalXp;
  while (level < XP_CURVE.maxLevel && remaining >= xpForLevel(level)) {
    remaining -= xpForLevel(level);
    level += 1;
  }
  return { level, remaining, next: level < XP_CURVE.maxLevel ? xpForLevel(level) : 0 };
}

/** Passive, automatic bonuses granted by account level. */
export function accountLevelBonus(level) {
  const l = Math.max(0, level - 1);
  return {
    damageMul: 1 + l * 0.01,
    healthAdd: Math.floor(l * 0.8),
    lootMul: 1 + l * 0.01,
    energyAdd: Math.floor(l * 0.5),
  };
}

/**
 * Permanent upgrade tracks bought with CORES between runs.
 * `cost(level)` returns the price of the NEXT level (level = current owned).
 */
export const META_UPGRADES = [
  {
    id: 'vitality',
    name: 'Vitality Matrix',
    description: '+12 maximum health per rank.',
    maxRank: 8,
    baseCost: 60,
    costGrowth: 1.55,
    effect: (rank) => ({ healthAdd: rank * 12 }),
    format: (rank) => `+${rank * 12} HP`,
  },
  {
    id: 'plating',
    name: 'Composite Plating',
    description: '+5 maximum armor per rank. Armor reduces incoming damage.',
    maxRank: 8,
    baseCost: 70,
    costGrowth: 1.55,
    effect: (rank) => ({ armorAdd: rank * 5 }),
    format: (rank) => `+${rank * 5} AR`,
  },
  {
    id: 'capacitor',
    name: 'Capacitor Bank',
    description: '+10 maximum energy per rank, letting you dash more often.',
    maxRank: 6,
    baseCost: 55,
    costGrowth: 1.5,
    effect: (rank) => ({ energyAdd: rank * 10 }),
    format: (rank) => `+${rank * 10} EN`,
  },
  {
    id: 'servos',
    name: 'Servo Legs',
    description: '+4% movement speed per rank.',
    maxRank: 6,
    baseCost: 80,
    costGrowth: 1.6,
    effect: (rank) => ({ moveMul: 1 + rank * 0.04 }),
    format: (rank) => `+${rank * 4}% SPD`,
  },
  {
    id: 'handling',
    name: 'Weapon Handling',
    description: '-6% reload time and -12% recoil per rank.',
    maxRank: 5,
    baseCost: 90,
    costGrowth: 1.6,
    effect: (rank) => ({ reloadMul: 1 - rank * 0.06, recoilMul: 1 - rank * 0.12 }),
    format: (rank) => `-${rank * 6}% RELOAD`,
  },
  {
    id: 'gunsmith',
    name: 'Gunsmithing',
    description: '+5% weapon damage per rank.',
    maxRank: 6,
    baseCost: 100,
    costGrowth: 1.62,
    effect: (rank) => ({ damageMul: 1 + rank * 0.05 }),
    format: (rank) => `+${rank * 5}% DMG`,
  },
  {
    id: 'munitions',
    name: 'Munitions Reserve',
    description: '+15% starting reserve ammunition and +2 magazines found per rank.',
    maxRank: 5,
    baseCost: 65,
    costGrowth: 1.5,
    effect: (rank) => ({ ammoMul: 1 + rank * 0.15, magBonus: rank * 2 }),
    format: (rank) => `+${rank * 15}% AMMO`,
  },
  {
    id: 'scavenger',
    name: 'Scavenger Protocol',
    description: '+8% loot quantity and +6% CORES extracted per rank.',
    maxRank: 6,
    baseCost: 85,
    costGrowth: 1.58,
    effect: (rank) => ({ lootMul: 1 + rank * 0.08, coreMul: 1 + rank * 0.06 }),
    format: (rank) => `+${rank * 8}% LOOT`,
  },
  {
    id: 'medbay',
    name: 'Field Medbay',
    description: 'Start each run with an extra repair kit per rank.',
    maxRank: 3,
    baseCost: 120,
    costGrowth: 1.7,
    effect: (rank) => ({ medkitsAdd: rank }),
    format: (rank) => `+${rank} KIT`,
  },
  {
    id: 'salvage',
    name: 'Salvage Rights',
    description: 'Recover +6% of your CORES when you die (base 25%).',
    maxRank: 5,
    baseCost: 75,
    costGrowth: 1.55,
    effect: (rank) => ({ salvageAdd: rank * 0.06 }),
    format: (rank) => `+${rank * 6}% SALVAGE`,
  },
];

export const DEATH_SALVAGE_BASE = 0.25;

export function upgradeCost(upgrade, currentRank) {
  return Math.round(upgrade.baseCost * Math.pow(upgrade.costGrowth, currentRank));
}

export function upgradeById(id) {
  const found = META_UPGRADES.find((u) => u.id === id);
  if (!found) throw new Error(`Unknown meta upgrade: ${id}`);
  return found;
}

/** Aggregate every effect from a `{ upgradeId: rank }` map. */
export function aggregateUpgrades(ranks) {
  const totals = {
    healthAdd: 0,
    armorAdd: 0,
    energyAdd: 0,
    moveMul: 1,
    reloadMul: 1,
    recoilMul: 1,
    damageMul: 1,
    ammoMul: 1,
    magBonus: 0,
    lootMul: 1,
    coreMul: 1,
    medkitsAdd: 0,
    salvageAdd: 0,
  };
  for (const upgrade of META_UPGRADES) {
    const rank = ranks?.[upgrade.id] ?? 0;
    if (rank <= 0) continue;
    const effect = upgrade.effect(Math.min(rank, upgrade.maxRank));
    for (const [key, value] of Object.entries(effect)) {
      if (key.endsWith('Mul')) totals[key] *= value;
      else totals[key] += value;
    }
  }
  return totals;
}

/** Total CORES invested so far, used by the save-screen summary. */
export function totalInvested(ranks) {
  let total = 0;
  for (const upgrade of META_UPGRADES) {
    const rank = Math.min(ranks?.[upgrade.id] ?? 0, upgrade.maxRank);
    for (let i = 0; i < rank; i += 1) total += upgradeCost(upgrade, i);
  }
  return total;
}

export const RESOURCE_DEFS = {
  scrap: { id: 'scrap', name: 'Scrap', color: '#9aa7b4', value: 1, icon: 's', stackable: true },
  cores: { id: 'cores', name: 'Cores', color: '#ffd166', value: 1, icon: 'c', stackable: true },
  cells: { id: 'cells', name: 'Cells', color: '#7fe6ff', value: 1, icon: 'e', stackable: true },
  datashard: { id: 'datashard', name: 'Data Shard', color: '#c084fc', value: 1, icon: 'd', stackable: true },
  intel: { id: 'intel', name: 'Intel', color: '#6fe3c4', value: 1, icon: 'i', stackable: true },
};

/**
 * Loot table. `weight` is used for weighted picks, `qty` for stack amounts.
 * `minTier` gates entries behind sector depth so deep runs feel rewarding.
 */
export const LOOT_TABLE = [
  { id: 'scrap', weight: 26, qty: [3, 9], rarity: 'common' },
  { id: 'cells', weight: 12, qty: [1, 3], rarity: 'common' },
  { id: 'cores', weight: 14, qty: [1, 3], rarity: 'uncommon' },
  { id: 'ammo_light', weight: 30, qty: [12, 26], rarity: 'common' },
  { id: 'ammo_rifle', weight: 22, qty: [10, 22], rarity: 'common' },
  { id: 'ammo_shell', weight: 16, qty: [4, 10], rarity: 'common' },
  { id: 'ammo_heavy', weight: 10, qty: [16, 34], rarity: 'uncommon', minTier: 2 },
  { id: 'ammo_cell', weight: 10, qty: [6, 14], rarity: 'uncommon', minTier: 2 },
  { id: 'medkit', weight: 16, qty: [1, 1], rarity: 'uncommon' },
  { id: 'armorplate', weight: 12, qty: [1, 1], rarity: 'uncommon' },
  { id: 'stim', weight: 10, qty: [1, 1], rarity: 'uncommon' },
  { id: 'datashard', weight: 9, qty: [1, 1], rarity: 'rare', minTier: 2 },
  { id: 'intel', weight: 6, qty: [1, 1], rarity: 'rare', minTier: 3 },
  { id: 'weapon', weight: 11, qty: [1, 1], rarity: 'rare', minTier: 1 },
  { id: 'upgrade_chip', weight: 4, qty: [1, 1], rarity: 'epic', minTier: 3 },
];

/**
 * Weapon-drop tier odds by sector depth. Weapon tier is the game's in-run
 * refinement axis (damage and magazine size), so a fixed roll meant late
 * sectors kept handing back tier-1 duplicates — rewards that resolve to six
 * scrap. Depth shifts the odds instead of adding more drops.
 */
export const LOOT_WEAPON_TIER_WEIGHTS = {
  1: [{ tier: 1, weight: 62 }, { tier: 2, weight: 28 }, { tier: 3, weight: 10 }],
  2: [{ tier: 1, weight: 50 }, { tier: 2, weight: 34 }, { tier: 3, weight: 16 }],
  3: [{ tier: 1, weight: 38 }, { tier: 2, weight: 38 }, { tier: 3, weight: 24 }],
  4: [{ tier: 1, weight: 26 }, { tier: 2, weight: 40 }, { tier: 3, weight: 34 }],
  5: [{ tier: 1, weight: 18 }, { tier: 2, weight: 38 }, { tier: 3, weight: 44 }],
  6: [{ tier: 1, weight: 12 }, { tier: 2, weight: 34 }, { tier: 3, weight: 54 }],
};

/**
 * Prize-room loot. A vault is the sector's richest room and the only one the
 * generator garrisons on purpose, so its drops are worth more per drop
 * (`quality` scales stack sizes) and roll rarer more often. Ordinary rooms keep
 * the old odds.
 */
export const VAULT_LOOT_QUALITY_MUL = 1.35;
export const VAULT_RARITY_BOOST_CHANCE = 0.3;
export const ROOM_RARITY_BOOST_CHANCE = 0.12;

/** Odds for a sector, clamped to the deepest defined tier. */
export function weaponTierWeights(sectorTier = 1) {
  const tier = Math.min(6, Math.max(1, Math.round(sectorTier) || 1));
  return LOOT_WEAPON_TIER_WEIGHTS[tier];
}

export const RARITY_COLORS = {
  common: '#9fb3c8',
  uncommon: '#6fe3c4',
  rare: '#5aa9ff',
  epic: '#c084fc',
  legendary: '#ffb03a',
};

export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export const CONSUMABLES = {
  medkit: { id: 'medkit', name: 'Repair Kit', heal: 45, description: 'Restores 45 health.' },
  armorplate: { id: 'armorplate', name: 'Armor Plate', armor: 30, description: 'Restores 30 armor.' },
  stim: { id: 'stim', name: 'Combat Stim', description: '+30% damage and +15% speed for 12s.', duration: 12 },
};

export const OBJECTIVE_TYPES = {
  ELIMINATE: 'eliminate',
  RECOVER: 'recover',
  DESTROY: 'destroy',
  HUNT: 'hunt',
  BOSS: 'boss',
};

export const EXTRACTION = {
  channelTime: 6.5,
  radius: 70,
  descendChannelTime: 4.0,
  descendRadius: 62,
};

export const MAP_GEN_DEFAULTS = {
  width: 2800,
  height: 2800,
  roomAttempts: 170,
  minRoomSize: 170,
  maxRoomSize: 420,
  largeRoomChance: 0.18,
  corridorWidth: 96,
  wallThickness: 32,
  obstacleDensity: 0.34,
};

export const AUDIO_DEFAULTS = {
  master: 0.85,
  music: 0.55,
  sfx: 0.8,
  ambient: 0.5,
};

export const VIDEO_DEFAULTS = {
  screenShake: 1.0,
  damageNumbers: true,
  particles: 1.0,
  bloom: true,
  showMinimap: true,
  showFps: false,
  showCrosshair: true,
};

export const GAMEPLAY_DEFAULTS = {
  autoReload: true,
  holdToExtract: true,
  cursorLock: false,
  aimAssist: 1.0,
};
