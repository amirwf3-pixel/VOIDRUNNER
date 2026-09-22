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
    mass: 'light',
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
    mass: 'light',
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
    mass: 'medium',
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
    mass: 'heavy',
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
    mass: 'medium',
    lore: 'Bursts corrosive canisters in wide arcs. Never fight one in a corner.',
  },
};

/**
 * How a body of each mass reads in combat: cue pitch, cue volume, camera
 * weight, debris scale and how far a stagger throws the silhouette. Everything
 * here is presentation only — no damage, speed, health, knockback or timing
 * reads from this table, so a husk and a brute can sound and look different
 * without playing differently.
 *
 * `deathCue` names the sound family; `src/game/combat.js` maps it to an SFX id
 * so this config stays free of audio imports.
 */
export const MASS_FEEDBACK = {
  light: { deathCue: 'light', hitRate: 1.12, hitVolume: 0.85, hitShake: 0.55, debris: 0.8, staggerLean: 0.8 },
  medium: { deathCue: 'standard', hitRate: 1.0, hitVolume: 1.0, hitShake: 1.0, debris: 1.0, staggerLean: 1.0 },
  heavy: { deathCue: 'heavy', hitRate: 0.86, hitVolume: 1.15, hitShake: 1.5, debris: 1.4, staggerLean: 1.35 },
};

/** Feedback profile for an archetype, with the medium default for safety. */
export function massFeedback(def) {
  return MASS_FEEDBACK[def?.mass] ?? MASS_FEEDBACK.medium;
}

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

/**
 * Sector threat profiles. Each sector rolls one, and it drives both the mix of
 * archetypes and how they are grouped: a GUNLINE holds angles with ranged
 * units, a SWARM floods corridors, an ARMORED garrison is built around heavies.
 *
 * Weights are relative within a sector, so two sectors at the same depth can
 * field very different fights while the total threat budget (and therefore the
 * overall difficulty) stays where `difficultyAt` puts it. `squad` is the size
 * of one encounter group, `elites` names the archetypes that may carry an
 * elite, and `guard` scales the garrison standing on a vault or an objective.
 *
 *   `spread`      how far squad members stand from their hotspot. Tight packs
 *                 collapse under one burst; a loose line has to be picked apart
 *                 in order, which is what turns a GUNLINE into a firing line.
 *   `markerGuard` garrison size for each data shard / reactor, so the places
 *                 the objective sends the player are fights, not pickups.
 *   `minTier`     the sector depth the profile unlocks at. Late sectors draw
 *                 from a wider pool instead of fielding the same soup with
 *                 bigger numbers.
 *
 * Tier 1 keeps its curated opener (`PATROL`) so the first sector stays a
 * readable introduction; the variety starts where the run does.
 */
export const THREAT_PROFILES = [
  {
    id: 'patrol',
    name: 'PATROL',
    minTier: 1,
    weights: { husk: 4, dart: 2, marksman: 2 },
    squad: [2, 3],
    spread: [24, 86],
    elites: ['dart', 'marksman'],
    guard: 2,
    markerGuard: 1,
  },
  {
    id: 'swarm',
    name: 'SWARM',
    weights: { husk: 6, dart: 4, marksman: 1, brute: 1, spitter: 1 },
    squad: [3, 4],
    spread: [20, 62],
    elites: ['husk', 'dart'],
    guard: 2,
    markerGuard: 2,
  },
  {
    id: 'gunline',
    name: 'GUNLINE',
    weights: { husk: 1, dart: 2, marksman: 4, brute: 1, spitter: 3 },
    squad: [2, 3],
    spread: [70, 168],
    elites: ['marksman', 'spitter'],
    guard: 2,
    markerGuard: 1,
  },
  {
    id: 'armored',
    name: 'ARMORED',
    weights: { husk: 3, dart: 1, marksman: 1, brute: 4, spitter: 1 },
    squad: [2, 3],
    spread: [30, 92],
    elites: ['brute', 'husk'],
    guard: 2,
    markerGuard: 2,
  },
  {
    id: 'skirmish',
    name: 'SKIRMISH',
    weights: { husk: 2, dart: 3, marksman: 3, brute: 2, spitter: 2 },
    squad: [2, 3],
    spread: [44, 124],
    elites: ['dart', 'marksman', 'spitter', 'brute'],
    guard: 2,
    markerGuard: 1,
  },
  {
    id: 'hunters',
    name: 'HUNTERS',
    minTier: 3,
    weights: { husk: 1, dart: 4, marksman: 4, spitter: 2, brute: 1 },
    squad: [2, 4],
    spread: [86, 190],
    elites: ['dart', 'marksman'],
    guard: 2,
    markerGuard: 2,
  },
  {
    id: 'vanguard',
    name: 'VANGUARD',
    minTier: 4,
    weights: { husk: 2, dart: 1, marksman: 3, brute: 3, spitter: 2 },
    squad: [2, 3],
    spread: [40, 112],
    elites: ['brute', 'marksman', 'spitter'],
    guard: 3,
    markerGuard: 2,
  },
];

/** Per-archetype elite ability. An elite should read as a different problem,
 *  not just a bigger health bar: heavies shield, ranged units burst, melee
 *  leaders call in help. `ELITE_MODIFIERS.champion.ability` overrides this. */
export const ELITE_ARCHETYPE_ABILITY = {
  husk: 'summon',
  dart: 'burst',
  marksman: 'burst',
  spitter: 'burst',
  brute: 'shield',
};

export const ELITE_ABILITY = {
  SHIELD: 'shield',
  SUMMON: 'summon',
  BURST: 'burst',
};

/**
 * Boss arenas. Every third sector is a boss sector, and the arena decides how
 * THE FOREMAN actually fights: which phase ladder it runs, which attacks exist
 * inside those phases, how hard it presses and what it calls in.
 *
 * The first arena is the readable cycle that teaches the moveset, so it keeps
 * the base kit untouched. The second is the endgame cycle: a longer phase
 * ladder, aimed fast lances for a player who tries to kite the arena from the
 * far wall, a cage ring with a single escape lane, and lingering slag pods that
 * deny ground instead of chasing. Attacks are additive over `BOSS`, so an arena
 * only declares what it changes, and `waves`/`summon` are what that arena
 * fields when it locks in and when it casts its own summon.
 */
export const BOSS_ARENAS = {
  1: {
    id: 'stoke',
    cycle: 'STOKE CYCLE',
    title: 'Foundry Overseer',
    waves: ['husk', 'dart'],
    summon: { types: ['husk', 'dart'], count: 3 },
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
    attacks: {},
  },
  2: {
    id: 'meltdown',
    cycle: 'MELTDOWN CYCLE',
    title: 'Crucible Overseer',
    waves: ['dart', 'marksman', 'husk'],
    summon: { types: ['dart', 'marksman'], count: 3 },
    phases: [
      {
        at: 1.0,
        name: 'FIRING',
        attacks: ['slam', 'burst', 'lance'],
        attackInterval: 1.8,
        speedMul: 1.05,
      },
      {
        at: 0.72,
        name: 'OVERPRESSURE',
        attacks: ['slam', 'lance', 'sweep', 'pods'],
        attackInterval: 1.55,
        speedMul: 1.15,
      },
      {
        at: 0.45,
        name: 'CASCADE',
        attacks: ['lance', 'sweep', 'cage', 'pods'],
        attackInterval: 1.35,
        speedMul: 1.25,
      },
      {
        at: 0.2,
        name: 'CRUCIBLE',
        attacks: ['slam', 'cage', 'lance', 'summon'],
        attackInterval: 1.2,
        speedMul: 1.35,
      },
    ],
    attacks: {
      lance: { projectiles: 3, spread: 0.16, speed: 780, damage: 15, telegraph: 0.7, recover: 0.4 },
      cage: { projectiles: 22, gap: 1.0, speed: 300, damage: 13, telegraph: 0.75, recover: 0.45 },
      pods: {
        count: 5, minRadius: 120, maxRadius: 300, damage: 12, life: 6.5, radius: 13, telegraph: 0.7, recover: 0.45,
      },
    },
  },
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
  // The first arena owns the ladder; `BOSS` is the shared stat block.
  phases: BOSS_ARENAS[1].phases,
  burst: { projectiles: 12, speed: 420, damage: 14, telegraph: 0.75, recover: 0.55 },
  sweep: { projectiles: 5, speed: 520, damage: 16, spread: 0.6, telegraph: 0.7, recover: 0.5 },
  summon: { count: 3, telegraph: 0.9, recover: 0.8, types: ['husk', 'dart'] },
  slam: { radius: 120, telegraph: 0.9, recover: 0.7 },
};

/** Arena index from the sector tier: sectors 3 and 6 are the two arenas. */
export function bossArenaFor(tier) {
  const keys = Object.keys(BOSS_ARENAS);
  const index = Math.max(1, Math.round((Number.isFinite(tier) ? tier : 1) / 3));
  return BOSS_ARENAS[Math.min(index, keys.length)] ?? BOSS_ARENAS[1];
}

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
