/**
 * Enemy archetypes, elite modifiers and boss definition.
 *
 * Behaviour is a small explicit state machine per archetype (see
 * `src/enemies/ai.js`); this file only holds numbers and presentation data.
 */

export const ENEMY_STATES = {
  IDLE: 'idle',
  PATROL: 'patrol',
  ALERT: 'alert',
  CHASE: 'chase',
  STRAFE: 'strafe',
  TELEGRAPH: 'telegraph',
  ATTACK: 'attack',
  RECOVER: 'recover',
  STAGGER: 'stagger',
  DEAD: 'dead',
};

/**
 * @typedef {Object} EnemyDef
 * @property {string} id
 * @property {string} name
 * @property {'melee'|'ranged'|'charger'|'heavy'|'boss'} role
 * @property {number} health
 * @property {number} armor        flat damage reduction per hit
 * @property {number} speed        world units/second
 * @property {number} radius
 * @property {number} damage
 * @property {number} attackRange
 * @property {number} telegraph    seconds of wind-up before the hit lands
 * @property {number} recover      seconds of recovery after the attack
 * @property {number} cooldown     seconds between attack cycles
 * @property {number} xp
 * @property {number} score
 * @property {string} color
 * @property {string} accent
 * @property {string} lore
 */

/** @type {Record<string, EnemyDef>} */
export const ENEMIES = {
  husk: {
    id: 'husk',
    name: 'Husk',
    role: 'melee',
    health: 44,
    armor: 0,
    speed: 96,
    radius: 13,
    damage: 9,
    attackRange: 30,
    telegraph: 0.38,
    recover: 0.35,
    cooldown: 0.85,
    xp: 8,
    score: 10,
    color: '#8f6f5a',
    accent: '#ff8a5c',
    lore: 'Reanimated maintenance crew. Slow, numerous, and always hungry.',
  },
  dart: {
    id: 'dart',
    name: 'Dart',
    role: 'charger',
    health: 20,
    armor: 0,
    speed: 186,
    radius: 10,
    damage: 6,
    attackRange: 34,
    telegraph: 0.2,
    recover: 0.3,
    cooldown: 0.55,
    xp: 10,
    score: 12,
    color: '#7a5c8f',
    accent: '#d29cff',
    lore: 'Sprinters grown for corridor ambushes. Fragile but relentless.',
  },
  marksman: {
    id: 'marksman',
    name: 'Marksman',
    role: 'ranged',
    health: 36,
    armor: 2,
    speed: 68,
    radius: 13,
    damage: 9,
    attackRange: 470,
    preferredRange: 300,
    telegraph: 0.62,
    recover: 0.4,
    cooldown: 1.6,
    projectileSpeed: 620,
    xp: 14,
    score: 16,
    color: '#5f7f8f',
    accent: '#7fe6ff',
    lore: 'Rusted targeting servos still track heat signatures perfectly.',
  },
  brute: {
    id: 'brute',
    name: 'Brute',
    role: 'heavy',
    health: 150,
    armor: 6,
    speed: 56,
    radius: 21,
    damage: 24,
    attackRange: 42,
    telegraph: 0.8,
    recover: 0.55,
    cooldown: 1.4,
    knockback: 190,
    xp: 28,
    score: 32,
    color: '#8f5340',
    accent: '#ff6a3d',
    lore: 'Exo-frame loader fused with its pilot. Hits like a falling girder.',
  },
  spitter: {
    id: 'spitter',
    name: 'Spitter',
    role: 'ranged',
    health: 62,
    armor: 1,
    speed: 74,
    radius: 16,
    damage: 12,
    attackRange: 380,
    preferredRange: 230,
    telegraph: 0.55,
    recover: 0.5,
    cooldown: 2.1,
    projectileSpeed: 480,
    projectiles: 3,
    spreadAngle: 0.22,
    areaDamage: true,
    xp: 22,
    score: 24,
    color: '#6f8f4a',
    accent: '#b6ff5c',
    lore: 'Bursts corrosive canisters in wide arcs. Never fight one in a corner.',
  },
};

/** Elites are the same archetypes with combat modifiers and an ability. */
export const ELITE_MODIFIERS = {
  elite: {
    key: 'elite',
    name: 'Elite',
    healthMul: 2.3,
    damageMul: 1.35,
    speedMul: 1.12,
    armorAdd: 4,
    xpMul: 2.6,
    scoreMul: 3,
    scale: 1.22,
    healthBar: true,
  },
  champion: {
    key: 'champion',
    name: 'Champion',
    healthMul: 2.9,
    damageMul: 1.55,
    speedMul: 1.05,
    armorAdd: 7,
    xpMul: 3.4,
    scoreMul: 4.2,
    scale: 1.32,
    healthBar: true,
    ability: 'shield',
  },
};

export const ELITE_ABILITY = {
  SHIELD: 'shield',
  SUMMON: 'summon',
  BURST: 'burst',
};

/**
 * Boss: THE FOREMAN. Multi-phase encounter with clearly telegraphed attacks.
 * Phases are selected by health percentage thresholds.
 */
export const BOSS = {
  id: 'foreman',
  name: 'THE FOREMAN',
  title: 'Foundry Overseer',
  health: 1400,
  armor: 10,
  speed: 62,
  radius: 34,
  damage: 26,
  attackRange: 58,
  telegraph: 0.85,
  recover: 0.6,
  cooldown: 1.6,
  xp: 260,
  score: 500,
  color: '#6b3a2e',
  accent: '#ffb03a',
  knockback: 220,
  phases: [
    {
      at: 1.0,
      name: 'STOKE',
      attacks: ['slam', 'burst'],
      attackInterval: 2.0,
      speedMul: 1.0,
    },
    {
      at: 0.66,
      name: 'STOKE II',
      attacks: ['slam', 'sweep', 'summon'],
      attackInterval: 1.7,
      speedMul: 1.14,
    },
    {
      at: 0.33,
      name: 'MELTDOWN',
      attacks: ['slam', 'sweep', 'burst', 'summon'],
      attackInterval: 1.35,
      speedMul: 1.3,
    },
  ],
  burst: { projectiles: 12, speed: 420, damage: 14, telegraph: 0.75, recover: 0.55 },
  sweep: { projectiles: 5, speed: 520, damage: 16, spread: 0.6, telegraph: 0.7, recover: 0.5 },
  summon: { count: 3, telegraph: 0.9, recover: 0.8, types: ['husk', 'dart'] },
  slam: { radius: 120, telegraph: 0.9, recover: 0.7 },
};

export const ENEMY_IDS = Object.keys(ENEMIES);

export function getEnemyDef(id) {
  const def = ENEMIES[id];
  if (!def) throw new Error(`Unknown enemy id: ${id}`);
  return def;
}

/**
 * Difficulty scaling. `tier` is the zone depth (1 based). Every value is a
 * multiplier applied on top of the archetype base so archetypes keep identity.
 */
export function difficultyAt(tier) {
  const t = Math.max(1, tier);
  return {
    tier: t,
    healthMul: 1 + (t - 1) * 0.29,
    damageMul: 1 + (t - 1) * 0.17,
    speedMul: 1 + Math.min(0.45, (t - 1) * 0.06),
    countMul: 1 + (t - 1) * 0.3,
    eliteChance: Math.min(0.42, 0.05 + (t - 1) * 0.055),
    bossHealthMul: 1 + (t - 1) * 0.5,
    lootMul: 1 + (t - 1) * 0.35,
    xpMul: 1 + (t - 1) * 0.22,
    threatBudget: Math.round(26 + (t - 1) * 16),
  };
}

export const ZONE_NAMES = [
  'RUSTFALL FOUNDRY',
  'STILLWATER REACTOR',
  'ASHGATE DEPOT',
  'COLDSPIRE ARRAY',
  'BLACKSILT CISTERN',
  'HOLLOW IRON YARD',
  'NINTH VAULT',
  'CINDER CONDUIT',
];
