/**
 * Save system.
 *
 * The profile (meta progression, settings, records, resumable run) is stored in
 * `localStorage` under a versioned key. Loading is defensive: unknown versions
 * are migrated, malformed fields fall back to defaults, and a corrupt payload
 * is quarantined rather than silently discarded.
 *
 * `SaveSystem` is storage-agnostic - the storage backend is injected, which
 * makes the whole thing testable in Node with a memory stub.
 */

import { AUDIO_DEFAULTS, GAMEPLAY_DEFAULTS, MAP_GEN_DEFAULTS, RESOURCE_DEFS, VIDEO_DEFAULTS } from '../config/balance.js';
// Progression bounds are owned by the run so the validator can never drift from
// the level ceiling or the perk table it is sanitising against.
import { MAX_RUN_LEVEL, RUN_PERKS } from '../game/run.js';

export const SAVE_KEY = 'voidrunner.profile.v1';
export const SAVE_VERSION = 3;

export function defaultProfile() {
  return {
    version: SAVE_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    account: {
      level: 1,
      xp: 0,
      cores: 0,
      totalRuns: 0,
      successfulExtractions: 0,
      deaths: 0,
      bestSector: 0,
      totalKills: 0,
      totalBossKills: 0,
      fastestExtraction: 0,
      totalPlaytimeSeconds: 0,
      highestDamageRun: 0,
      bestLootRun: 0,
    },
    upgrades: {},
    unlocks: { weapons: ['pistol'], consumables: ['medkit'] },
    settings: {
      audio: { ...AUDIO_DEFAULTS },
      video: { ...VIDEO_DEFAULTS },
      gameplay: { ...GAMEPLAY_DEFAULTS },
    },
    run: null,
    stats: {
      runsBySeed: {},
      lastRunSummary: null,
    },
  };
}

/** In-memory storage used by tests and as a fallback when localStorage throws. */
export class MemoryStorage {
  constructor() {
    this.data = new Map();
  }

  getItem(key) {
    return this.data.has(key) ? this.data.get(key) : null;
  }

  setItem(key, value) {
    this.data.set(key, String(value));
  }

  removeItem(key) {
    this.data.delete(key);
  }
}

export class SaveSystem {
  constructor({ storage = null, key = SAVE_KEY, onError = null } = {}) {
    this.key = key;
    this.onError = onError;
    this.storage = storage ?? pickStorage(onError);
    /** Set when the previous load had to repair or quarantine data. */
    this.lastLoadWarning = null;
  }

  _report(error, context) {
    if (this.onError) this.onError(error, context);
    else console.error(`[Save] ${context}:`, error);
  }

  hasSave() {
    try {
      return this.storage.getItem(this.key) !== null;
    } catch (error) {
      this._report(error, 'hasSave');
      return false;
    }
  }

  load() {
    this.lastLoadWarning = null;
    let raw = null;
    try {
      raw = this.storage.getItem(this.key);
    } catch (error) {
      this._report(error, 'load read');
      return defaultProfile();
    }
    if (!raw) return defaultProfile();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this._report(error, 'load parse');
      this.lastLoadWarning = 'Save file was corrupt and has been reset.';
      try {
        this.storage.setItem(`${this.key}.corrupt`, raw);
        this.storage.removeItem(this.key);
      } catch (innerError) {
        this._report(innerError, 'quarantine corrupt save');
      }
      return defaultProfile();
    }
    const { profile, warnings } = sanitizeProfile(parsed);
    if (warnings.length > 0) {
      this.lastLoadWarning = warnings.join(' ');
    }
    return profile;
  }

  save(profile) {
    if (!profile || typeof profile !== 'object') {
      throw new TypeError('SaveSystem.save requires a profile object');
    }
    const payload = { ...profile, version: SAVE_VERSION, updatedAt: Date.now() };
    try {
      this.storage.setItem(this.key, JSON.stringify(payload));
      return true;
    } catch (error) {
      this._report(error, 'save write');
      return false;
    }
  }

  /** Wipes every profile key including quarantine copies. */
  clear() {
    try {
      this.storage.removeItem(this.key);
      this.storage.removeItem(`${this.key}.corrupt`);
      return true;
    } catch (error) {
      this._report(error, 'clear');
      return false;
    }
  }
}

function pickStorage(onError) {
  try {
    if (typeof localStorage !== 'undefined') {
      const probe = '__voidrunner_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch (error) {
    if (onError) onError(error, 'localStorage unavailable, using memory storage');
  }
  return new MemoryStorage();
}

function num(value, fallback, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/**
 * Like `num`, but tolerant of numeric strings. Used for resumable-run fields:
 * older builds stored `tier`/`elapsed` as strings, and a run that cannot be
 * resumed costs the player the whole sector. Anything non-numeric still falls
 * back, so garbage is never accepted.
 */
function numLoose(value, fallback, min = -Infinity, max = Infinity) {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(min, Math.min(max, parsed));
  }
  return num(value, fallback, min, max);
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Coerce arbitrary parsed JSON into a valid profile. Returns the repaired
 * profile plus a list of human readable warnings.
 */
export function sanitizeProfile(input) {
  const base = defaultProfile();
  const warnings = [];
  if (!input || typeof input !== 'object') {
    return { profile: base, warnings: ['Save data was not an object; defaults applied.'] };
  }
  if (input.version !== SAVE_VERSION) {
    warnings.push(`Migrated save from version ${input.version ?? 'unknown'} to ${SAVE_VERSION}.`);
  }

  const account = input.account && typeof input.account === 'object' ? input.account : {};
  base.account.level = Math.round(num(account.level, 1, 1, 999));
  base.account.xp = Math.round(num(account.xp, 0, 0, 1e12));
  base.account.cores = Math.round(num(account.cores, 0, 0, 1e12));
  base.account.totalRuns = Math.round(num(account.totalRuns, 0, 0, 1e9));
  base.account.successfulExtractions = Math.round(num(account.successfulExtractions, 0, 0, 1e9));
  base.account.deaths = Math.round(num(account.deaths, 0, 0, 1e9));
  base.account.bestSector = Math.round(num(account.bestSector, 0, 0, 999));
  base.account.totalKills = Math.round(num(account.totalKills, 0, 0, 1e9));
  base.account.totalBossKills = Math.round(num(account.totalBossKills, 0, 0, 1e9));
  base.account.fastestExtraction = num(account.fastestExtraction, 0, 0, 1e9);
  base.account.totalPlaytimeSeconds = num(account.totalPlaytimeSeconds, 0, 0, 1e9);
  base.account.highestDamageRun = Math.round(num(account.highestDamageRun, 0, 0, 1e12));
  base.account.bestLootRun = Math.round(num(account.bestLootRun, 0, 0, 1e12));
  base.createdAt = num(input.createdAt, Date.now(), 0, 1e15);
  base.updatedAt = num(input.updatedAt, Date.now(), 0, 1e15);

  if (input.upgrades && typeof input.upgrades === 'object') {
    for (const [key, value] of Object.entries(input.upgrades)) {
      const rank = Math.round(num(value, 0, 0, 999));
      if (rank > 0) base.upgrades[key] = rank;
    }
  }

  if (input.unlocks && typeof input.unlocks === 'object') {
    base.unlocks.weapons = Array.isArray(input.unlocks.weapons)
      ? input.unlocks.weapons.filter((w) => typeof w === 'string')
      : base.unlocks.weapons;
    base.unlocks.consumables = Array.isArray(input.unlocks.consumables)
      ? input.unlocks.consumables.filter((c) => typeof c === 'string')
      : base.unlocks.consumables;
  }
  if (!base.unlocks.weapons.includes('pistol')) base.unlocks.weapons.unshift('pistol');

  const settings = input.settings && typeof input.settings === 'object' ? input.settings : {};
  const audio = settings.audio && typeof settings.audio === 'object' ? settings.audio : {};
  base.settings.audio.master = num(audio.master, AUDIO_DEFAULTS.master, 0, 1);
  base.settings.audio.music = num(audio.music, AUDIO_DEFAULTS.music, 0, 1);
  base.settings.audio.sfx = num(audio.sfx, AUDIO_DEFAULTS.sfx, 0, 1);
  base.settings.audio.ambient = num(audio.ambient, AUDIO_DEFAULTS.ambient, 0, 1);

  const video = settings.video && typeof settings.video === 'object' ? settings.video : {};
  base.settings.video.screenShake = num(video.screenShake, VIDEO_DEFAULTS.screenShake, 0, 2);
  base.settings.video.damageNumbers = bool(video.damageNumbers, VIDEO_DEFAULTS.damageNumbers);
  base.settings.video.particles = num(video.particles, VIDEO_DEFAULTS.particles, 0, 2);
  base.settings.video.bloom = bool(video.bloom, VIDEO_DEFAULTS.bloom);
  base.settings.video.showMinimap = bool(video.showMinimap, VIDEO_DEFAULTS.showMinimap);
  base.settings.video.showFps = bool(video.showFps, VIDEO_DEFAULTS.showFps);
  base.settings.video.showCrosshair = bool(video.showCrosshair, VIDEO_DEFAULTS.showCrosshair);

  const gameplay = settings.gameplay && typeof settings.gameplay === 'object' ? settings.gameplay : {};
  base.settings.gameplay.autoReload = bool(gameplay.autoReload, GAMEPLAY_DEFAULTS.autoReload);
  base.settings.gameplay.holdToExtract = bool(gameplay.holdToExtract, GAMEPLAY_DEFAULTS.holdToExtract);
  base.settings.gameplay.cursorLock = bool(gameplay.cursorLock, GAMEPLAY_DEFAULTS.cursorLock);
  base.settings.gameplay.aimAssist = num(gameplay.aimAssist, GAMEPLAY_DEFAULTS.aimAssist, 0, 1);

  // A stored run is resumable only when it is a real payload. `null` (what
  // `defaultProfile` writes and what settlement leaves behind) and a missing
  // field (profiles written before runs were persisted) are the legitimate
  // "no run in progress" states and stay silent. Every other unusable value is
  // corrupted data, reported through the existing load warning exactly like
  // object-shaped garbage always was - a stored run is never dropped quietly.
  if (input.run !== null && input.run !== undefined) {
    const validated = validateResumableRun(input.run);
    if (validated) base.run = validated;
    else warnings.push('Stored run could not be resumed and was discarded.');
  }

  if (input.stats && typeof input.stats === 'object') {
    base.stats.runsBySeed = input.stats.runsBySeed && typeof input.stats.runsBySeed === 'object'
      ? input.stats.runsBySeed
      : {};
    base.stats.lastRunSummary = input.stats.lastRunSummary ?? null;
  }
  return { profile: base, warnings };
}

/** Upper bound on persisted collected-drop ids; far above one sector's drop count. */
const MAX_COLLECTED_DROP_IDS = 2000;
/** Upper bound on persisted destroyed-prop ids; a sector only has a handful. */
const MAX_DESTROYED_PROP_IDS = 512;
/** Upper bound on persisted defeated-spawn ids; a sector has well under 100. */
const MAX_DEFEATED_SPAWN_IDS = 512;

/**
 * Shared validation for sector-scoped id sets (collected drops, destroyed
 * objective props). Ids only make sense inside the sector that produced them,
 * so the tier is stored alongside them and a payload without a usable tier is
 * discarded entirely. Malformed entries are dropped, duplicates collapsed and
 * the list capped, so a hostile or corrupt payload can never grow without bound
 * or hand generation a value it cannot use.
 * @returns {{tier:number, ids:number[]}|undefined}
 */
function sanitizeTierScopedIds(state, cap) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.ids)) return undefined;
  const tier = Math.round(numLoose(state.tier, 0, 0, 99));
  if (tier <= 0) return undefined;
  const seen = new Set();
  const ids = [];
  for (const raw of state.ids) {
    if (!Number.isFinite(raw)) continue;
    const id = Math.trunc(raw);
    if (id < 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= cap) break;
  }
  return { tier, ids };
}

/**
 * Ids of ground drops already collected in the current sector (every sector
 * restarts the drop id sequence at 1).
 * @returns {{tier:number, ids:number[]}|undefined}
 */
function sanitizeCollectedDrops(state) {
  return sanitizeTierScopedIds(state, MAX_COLLECTED_DROP_IDS);
}

/**
 * Ids of objective props destroyed in the current sector. Prop ids are array
 * positions, so every sector numbers its props from zero and the tier scoping
 * matters just as much here: an id from sector 1 must never knock out a prop in
 * sector 2. Restoration additionally re-checks that a prop both matches the id
 * and participates in an objective.
 * @returns {{tier:number, ids:number[]}|undefined}
 */
function sanitizeDestroyedProps(state) {
  return sanitizeTierScopedIds(state, MAX_DESTROYED_PROP_IDS);
}

/**
 * Spawn indices of enemies defeated in the current sector. Spawn indices are
 * positions in the generator's deterministic spawn list, so they carry the same
 * tier scoping as drop and prop ids: an index from sector 1 must never suppress
 * an enemy in sector 2. Restoration re-checks the tier before applying them.
 * @returns {{tier:number, ids:number[]}|undefined}
 */
function sanitizeDefeatedSpawns(state) {
  return sanitizeTierScopedIds(state, MAX_DEFEATED_SPAWN_IDS);
}

/**
 * Boss arena intro wave. The wave is summoned once per sector, so its trigger
 * is sector-scoped consumed content like `defeatedSpawns`: an untriggered (or
 * missing) record simply leaves the arena as a fresh sector would.
 * @returns {{tier:number, triggered:boolean}|undefined}
 */
function sanitizeBossWaves(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined;
  const tier = Math.round(numLoose(state.tier, 0, 0, 99));
  if (tier <= 0) return undefined;
  return { tier, triggered: bool(state.triggered, false) };
}

/**
 * Objective progress is part of a resumable run: completing the zone's
 * objectives is what unlocks extraction, so dropping it on load would send the
 * player back to an un-extractable sector. Only the shape the runtime
 * understands is kept, so a malformed save cannot inject arbitrary state.
 * The state is tagged with the sector it was recorded in (objective ids are
 * shared by every tier), and untiered states from older builds stay accepted.
 * @returns {{tier?:number, objectives: Array<{id:string, progress:number, complete:boolean}>}|null}
 */
function sanitizeObjectiveState(state) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.objectives)) return null;
  const objectives = [];
  for (const entry of state.objectives) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.id !== 'string' || entry.id.length === 0) continue;
    objectives.push({
      id: entry.id.slice(0, 64),
      progress: Math.round(numLoose(entry.progress, 0, 0, 1e9)),
      complete: bool(entry.complete, false),
    });
  }
  if (objectives.length === 0) return null;
  // Sector-tagged states are only applied to the tier they name
  // (`ObjectiveRuntime.restore`); legacy states carry no tier and stay accepted.
  if (!Number.isFinite(state.tier)) return { objectives };
  return { tier: Math.round(numLoose(state.tier, 1, 1, 99)), objectives };
}

/**
 * Normalises saved weapons. Entries accept both the legacy bare-id form
 * (`'smg'`) and the current object form (`{id, tier, ammo}`); both come back as
 * `{id}` plus `tier`/`ammo` only when those are finite numbers. A missing or
 * malformed `ammo` is therefore left out and the deserializer falls back to a
 * full magazine — exactly how runs saved before these fields existed behave.
 * Duplicate ids are collapsed because the live game never holds two instances
 * of the same weapon.
 * @returns {Array<{id:string, tier?:number, ammo?:number}>} never empty
 */
function sanitizeWeapons(list) {
  if (!Array.isArray(list)) return [{ id: 'pistol' }];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const spec = typeof entry === 'string' ? { id: entry } : entry;
    if (!spec || typeof spec !== 'object') continue;
    const id = typeof spec.id === 'string' ? spec.id.slice(0, 64) : '';
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const weapon = { id };
    if (Number.isFinite(spec.tier)) weapon.tier = Math.round(clampNumber(spec.tier, 1, 3));
    if (Number.isFinite(spec.ammo)) weapon.ammo = Math.round(clampNumber(spec.ammo, 0, 1e6));
    out.push(weapon);
  }
  return out.length > 0 ? out : [{ id: 'pistol' }];
}

/**
 * Run statistics are counters: whole numbers, never negative, never non-finite.
 * Anything else - strings, NaN, Infinity, negative noise - becomes 0, which is
 * the same default a save written before the counter existed resumes with.
 */
function statCount(value) {
  return Math.round(numLoose(value, 0, 0, 1e12));
}

/** Run-owned statistics reported by the run result. */
function sanitizeRunStats(state) {
  const stats = state && typeof state === 'object' ? state : {};
  return {
    damageDealt: statCount(stats.damageDealt),
    damageTaken: statCount(stats.damageTaken),
    elitesKilled: statCount(stats.elitesKilled),
    bossKills: statCount(stats.bossKills),
    sectorsCleared: statCount(stats.sectorsCleared),
    lootCollected: statCount(stats.lootCollected),
  };
}

/** Player-owned counters reported by the same result. */
function sanitizePlayerStats(state) {
  const stats = state && typeof state === 'object' ? state : {};
  return {
    shotsFired: statCount(stats.shotsFired),
    shotsHit: statCount(stats.shotsHit),
    dashes: statCount(stats.dashes),
  };
}

/**
 * Ranges for the generation parameters a resumable run may carry.
 *
 * The generator reads exactly the `MAP_GEN_DEFAULTS` keys, so only those are
 * kept; these ranges are the values it can use meaningfully (world dimensions
 * are clamped to 2200..5200px internally, `roomAttempts` has a floor of 40
 * during relaxation, and the rest are probabilities or tile-scale pixel sizes).
 * Keys without an entry here are simply not persisted.
 */
const GEN_PARAM_BOUNDS = {
  width: [1200, 6000],
  height: [1200, 6000],
  roomAttempts: [40, 400],
  minRoomSize: [64, 320],
  maxRoomSize: [120, 640],
  largeRoomChance: [0, 1],
  corridorWidth: [32, 256],
  wallThickness: [8, 64],
  obstacleDensity: [0, 1],
};

/**
 * Sanitises the generation input carried by a resumable run.
 *
 * Unknown keys are dropped, values must already be finite numbers (numeric
 * strings, NaN, Infinity, arrays and nested objects are ignored), and each
 * value is clamped to `GEN_PARAM_BOUNDS`. A missing or malformed payload
 * becomes `{}`, which regenerates from `MAP_GEN_DEFAULTS` - exactly how runs
 * saved before this field existed behave.
 */
function sanitizeGenParams(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {};
  const out = {};
  for (const key of Object.keys(MAP_GEN_DEFAULTS)) {
    const bounds = GEN_PARAM_BOUNDS[key];
    if (!bounds) continue;
    const value = num(state[key], null, bounds[0], bounds[1]);
    if (value !== null) out[key] = value;
  }
  return out;
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Hard ceiling for a single carried resource stack. Run loot enters the bag in
 * single or double digit amounts, so a stack anywhere near this can only come
 * from a tampered payload.
 */
const MAX_LOOT_STACK = 1e6;

/**
 * Sanitises the carried loot bag.
 *
 * Only resources declared in `RESOURCE_DEFS` are kept and values must already
 * be finite numbers: strings, booleans, arrays, objects, NaN and Infinity are
 * dropped. Quantities are rounded (matching `Player.addLoot`, which is the only
 * way loot enters the bag during play) and clamped to 0..`MAX_LOOT_STACK`, so a
 * negative stack becomes 0 instead of banking a negative balance. A missing or
 * malformed bag becomes `{}`, which resumes exactly like a run saved before
 * loot was persisted.
 *
 * This is the load-bearing guard for the account: `lootValue()` feeds
 * `result.lootValue`/`result.cores`, and `result.cores` is added straight to
 * `account.cores`, so a non-finite value used to erase the banked balance on
 * the next load. `Player.restore` re-applies the same rule for snapshots that
 * never went through this validator.
 */
function sanitizeLoot(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {};
  const out = {};
  for (const key of Object.keys(RESOURCE_DEFS)) {
    const value = num(state[key], null, 0, MAX_LOOT_STACK);
    if (value !== null) out[key] = Math.round(value);
  }
  return out;
}

/**
 * A resumable run only needs the seed, sector, elapsed time and carried loot -
 * the zone itself is regenerated deterministically from the seed, which keeps
 * saves tiny and guarantees no map drift.
 */
export function validateResumableRun(run) {
  if (!run || typeof run !== 'object') return null;
  if (typeof run.seed !== 'string' || run.seed.length === 0) return null;
  const tier = Math.round(numLoose(run.tier, 1, 1, 99));
  const elapsed = numLoose(run.elapsed, 0, 0, 1e6);
  const loot = sanitizeLoot(run.loot);
  const weapons = sanitizeWeapons(run.weapons);
  const weaponIndex = Math.round(num(run.weaponIndex, 0, 0, weapons.length - 1));
  const reserve = run.reserve && typeof run.reserve === 'object' ? { ...run.reserve } : {};
  // Kept as a plain copy for the same reason as `reserve`: the owning module
  // (`Player`) normalises counts against the live CONSUMABLES table on restore.
  const consumables = run.consumables && typeof run.consumables === 'object' ? { ...run.consumables } : undefined;
  // In-run progression. Missing fields fall back to a fresh level-1 run, which
  // is exactly how saves written before progression was persisted behave.
  const level = Math.round(numLoose(run.level, 1, 1, MAX_RUN_LEVEL));
  const xp = numLoose(run.xp, 0, 0, 1e9);
  const xpEarnedTotal = numLoose(run.xpEarnedTotal, 0, 0, 1e9);
  const perkIndex = Math.round(numLoose(run.perkIndex, 0, 0, RUN_PERKS.length));
  return {
    seed: run.seed.slice(0, 40),
    tier,
    elapsed,
    loot,
    weapons,
    weaponIndex,
    reserve,
    consumables,
    health: numLoose(run.health, 100, 1, 1e6),
    armor: numLoose(run.armor, 0, 0, 1e6),
    // `sectorTime` and `startedAt` are deliberately absent: every build up to
    // v3 wrote them, yet nothing (menu, results, settlement) ever read them
    // back. This function returns a whitelist, so legacy payloads that still
    // carry them are accepted, ignored and dropped on the next save.
    kills: Math.round(numLoose(run.kills, 0, 0, 1e9)),
    objectivesCompleted: Math.round(numLoose(run.objectivesCompleted, 0, 0, 1e9)),
    // Run statistics. Missing bags (saves written before they were persisted)
    // resume as zeroed counters, exactly like a fresh run.
    stats: sanitizeRunStats(run.stats),
    playerStats: sanitizePlayerStats(run.playerStats),
    // Generation input. Absent in saves written before it was persisted, which
    // sanitises to `{}` and regenerates exactly like those builds did.
    genParams: sanitizeGenParams(run.genParams),
    level,
    xp,
    xpEarnedTotal,
    perkIndex,
    objectiveState: sanitizeObjectiveState(run.objectiveState),
    collectedDrops: sanitizeCollectedDrops(run.collectedDrops),
    destroyedProps: sanitizeDestroyedProps(run.destroyedProps),
    defeatedSpawns: sanitizeDefeatedSpawns(run.defeatedSpawns),
    bossWaves: sanitizeBossWaves(run.bossWaves),
  };
}
