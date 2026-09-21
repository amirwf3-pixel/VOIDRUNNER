/**
 * Weapon definitions.
 *
 * All tuning lives here so that the weapon runtime (`src/weapons/weapon.js`)
 * stays a pure simulation. Values are expressed in world units per second and
 * seconds, tuned so each weapon occupies a distinct role:
 *
 *  - pistol     : reliable, precise, cheap, slow to kill groups
 *  - smg        : high rate, low damage, wide bloom, huge sustain
 *  - shotgun    : burst delete at close range, terrible past 400 units
 *  - rifle      : the all-rounder, controlled bursts
 *  - railpiercer: slow, long range, pierces, punishes misses
 *  - breaker    : belt-fed suppression, heavy movement penalty
 *  - arc caster : energy projectile that chains between targets
 */

export const AMMO_TYPES = {
  LIGHT: 'light',
  SHELL: 'shell',
  RIFLE: 'rifle',
  HEAVY: 'heavy',
  CELL: 'cell',
};

export const AMMO_LABELS = {
  [AMMO_TYPES.LIGHT]: 'Light',
  [AMMO_TYPES.SHELL]: 'Shells',
  [AMMO_TYPES.RIFLE]: 'Rifle',
  [AMMO_TYPES.HEAVY]: 'Heavy',
  [AMMO_TYPES.CELL]: 'Cells',
};

/**
 * @typedef {Object} WeaponDef
 * @property {string} id
 * @property {string} name
 * @property {string} ammo
 * @property {number} damage        damage per projectile
 * @property {number} pellets       projectiles per trigger pull
 * @property {number} rpm           rounds per minute (converted to rate)
 * @property {number} magazine
 * @property {number} reloadTime    seconds
 * @property {number} range         world units before damage falloff ends
 * @property {number} falloffStart  world units where falloff begins
 * @property {number} minDamageMul  damage multiplier at max range
 * @property {number} spread        base inaccuracy in radians
 * @property {number} bloomPerShot  added spread per shot
 * @property {number} bloomMax      spread ceiling
 * @property {number} bloomDecay    radians recovered per second
 * @property {number} recoil        camera kick per shot (world units)
 * @property {number} bulletSpeed   world units per second
 * @property {number} moveMul       movement multiplier while equipped
 * @property {boolean} automatic
 * @property {number} pierce        extra targets a projectile can pass through
 * @property {number} knockback
 */

/** @type {Record<string, WeaponDef>} */
export const WEAPONS = {
  pistol: {
    id: 'pistol',
    name: 'MK-3 Sidearm',
    short: 'PISTOL',
    ammo: AMMO_TYPES.LIGHT,
    damage: 16,
    pellets: 1,
    rpm: 300,
    magazine: 12,
    reloadTime: 1.05,
    range: 720,
    falloffStart: 380,
    minDamageMul: 0.55,
    spread: 0.018,
    bloomPerShot: 0.026,
    bloomMax: 0.11,
    bloomDecay: 0.34,
    recoil: 2.6,
    bulletSpeed: 1450,
    moveMul: 1.0,
    automatic: false,
    pierce: 0,
    knockback: 26,
    critChance: 0.08,
    critMul: 1.8,
    color: '#cfe4ff',
    tracerWidth: 1.6,
  },
  smg: {
    id: 'smg',
    name: 'VK-9 Scattergun SMG',
    short: 'SMG',
    ammo: AMMO_TYPES.LIGHT,
    damage: 8,
    pellets: 1,
    rpm: 780,
    magazine: 34,
    reloadTime: 1.5,
    range: 560,
    falloffStart: 240,
    minDamageMul: 0.45,
    spread: 0.055,
    bloomPerShot: 0.021,
    bloomMax: 0.2,
    bloomDecay: 0.75,
    recoil: 1.5,
    bulletSpeed: 1250,
    moveMul: 0.97,
    automatic: true,
    pierce: 0,
    knockback: 12,
    critChance: 0.05,
    critMul: 1.6,
    color: '#ffe6a8',
    tracerWidth: 1.2,
  },
  shotgun: {
    id: 'shotgun',
    name: 'Breakwater 12',
    short: 'SHOTGUN',
    ammo: AMMO_TYPES.SHELL,
    damage: 11,
    pellets: 9,
    rpm: 78,
    magazine: 6,
    reloadTime: 2.15,
    range: 460,
    falloffStart: 120,
    minDamageMul: 0.18,
    spread: 0.19,
    bloomPerShot: 0.02,
    bloomMax: 0.26,
    bloomDecay: 0.5,
    recoil: 9,
    bulletSpeed: 1000,
    moveMul: 0.92,
    automatic: false,
    pierce: 0,
    knockback: 72,
    critChance: 0.04,
    critMul: 2.0,
    color: '#ffb27a',
    tracerWidth: 1.8,
  },
  rifle: {
    id: 'rifle',
    name: 'AR-40 Lancer',
    short: 'RIFLE',
    ammo: AMMO_TYPES.RIFLE,
    damage: 14,
    pellets: 1,
    rpm: 560,
    magazine: 28,
    reloadTime: 1.85,
    range: 900,
    falloffStart: 460,
    minDamageMul: 0.62,
    spread: 0.028,
    bloomPerShot: 0.019,
    bloomMax: 0.15,
    bloomDecay: 0.62,
    recoil: 3.2,
    bulletSpeed: 1650,
    moveMul: 0.95,
    automatic: true,
    pierce: 0,
    knockback: 22,
    critChance: 0.1,
    critMul: 1.9,
    color: '#b9ffd8',
    tracerWidth: 1.6,
  },
  railpiercer: {
    id: 'railpiercer',
    name: 'Railpiercer DMR',
    short: 'DMR',
    ammo: AMMO_TYPES.RIFLE,
    damage: 46,
    pellets: 1,
    rpm: 96,
    magazine: 6,
    reloadTime: 2.3,
    range: 1500,
    falloffStart: 900,
    minDamageMul: 0.85,
    spread: 0.006,
    bloomPerShot: 0.05,
    bloomMax: 0.14,
    bloomDecay: 0.4,
    recoil: 7,
    bulletSpeed: 2600,
    moveMul: 0.88,
    automatic: false,
    pierce: 2,
    knockback: 40,
    critChance: 0.2,
    critMul: 2.4,
    color: '#9fd8ff',
    tracerWidth: 2.6,
  },
  breaker: {
    id: 'breaker',
    name: 'Breaker LMG',
    short: 'LMG',
    ammo: AMMO_TYPES.HEAVY,
    damage: 13,
    pellets: 1,
    rpm: 700,
    magazine: 90,
    reloadTime: 3.6,
    range: 780,
    falloffStart: 380,
    minDamageMul: 0.5,
    spread: 0.06,
    bloomPerShot: 0.014,
    bloomMax: 0.17,
    bloomDecay: 0.55,
    recoil: 2.2,
    bulletSpeed: 1500,
    moveMul: 0.8,
    automatic: true,
    pierce: 1,
    knockback: 26,
    critChance: 0.06,
    critMul: 1.7,
    color: '#ffd0f0',
    tracerWidth: 1.8,
  },
  arcCaster: {
    id: 'arcCaster',
    name: 'Arc Caster',
    short: 'ARC',
    ammo: AMMO_TYPES.CELL,
    damage: 22,
    pellets: 1,
    rpm: 150,
    magazine: 10,
    reloadTime: 1.9,
    range: 700,
    falloffStart: 400,
    minDamageMul: 0.7,
    spread: 0.02,
    bloomPerShot: 0.03,
    bloomMax: 0.12,
    bloomDecay: 0.5,
    recoil: 4,
    bulletSpeed: 900,
    moveMul: 0.94,
    automatic: false,
    pierce: 0,
    knockback: 18,
    chain: 2,
    chainRange: 220,
    chainDamageMul: 0.6,
    critChance: 0.12,
    critMul: 2.0,
    color: '#a6f0ff',
    tracerWidth: 2.2,
  },
};

export const STARTING_WEAPON = 'pistol';

/** Weapons that can be found as loot during a run (ordered by rarity weight). */
export const LOOTABLE_WEAPONS = ['smg', 'shotgun', 'rifle', 'railpiercer', 'breaker', 'arcCaster'];

export const WEAPON_IDS = Object.keys(WEAPONS);

export function getWeaponDef(id) {
  const def = WEAPONS[id];
  if (!def) throw new Error(`Unknown weapon id: ${id}`);
  return def;
}

export function roundsPerSecond(def) {
  return def.rpm / 60;
}

/** Human readable DPS estimate used by inventory tooltips and tests. */
export function estimateDps(def, tier = 1) {
  const reloads = def.magazine;
  const fireTime = reloads / roundsPerSecond(def);
  const cycle = fireTime + def.reloadTime;
  const damagePerMag = def.damage * def.pellets * reloads * tierDamageMul(tier);
  return damagePerMag / cycle;
}

export function tierDamageMul(tier = 1) {
  return 1 + (Math.max(1, tier) - 1) * 0.18;
}

export function tierMagazineBonus(tier = 1) {
  return (Math.max(1, tier) - 1) * Math.round(4 * (Math.max(1, tier) - 1));
}

export const WEAPON_TIER_NAMES = ['', 'Standard', 'Refined', 'Prototype'];
export const WEAPON_TIER_COLORS = ['', '#9fb3c8', '#6fe3c4', '#ffd166'];
