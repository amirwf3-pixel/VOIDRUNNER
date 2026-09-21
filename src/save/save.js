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

import { AUDIO_DEFAULTS, GAMEPLAY_DEFAULTS, VIDEO_DEFAULTS } from '../config/balance.js';

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

  if (input.run && typeof input.run === 'object') {
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

/**
 * A resumable run only needs the seed, sector, elapsed time and carried loot -
 * the zone itself is regenerated deterministically from the seed, which keeps
 * saves tiny and guarantees no map drift.
 */
export function validateResumableRun(run) {
  if (!run || typeof run !== 'object') return null;
  if (typeof run.seed !== 'string' || run.seed.length === 0) return null;
  const tier = Math.round(num(run.tier, 1, 1, 99));
  const elapsed = num(run.elapsed, 0, 0, 1e6);
  const loot = run.loot && typeof run.loot === 'object' ? { ...run.loot } : {};
  const weapons = Array.isArray(run.weapons)
    ? run.weapons.filter((w) => typeof w === 'string' && w.length > 0)
    : ['pistol'];
  const reserve = run.reserve && typeof run.reserve === 'object' ? { ...run.reserve } : {};
  return {
    seed: run.seed.slice(0, 40),
    tier,
    elapsed,
    loot,
    weapons: weapons.length > 0 ? weapons : ['pistol'],
    reserve,
    health: num(run.health, 100, 1, 1e6),
    armor: num(run.armor, 0, 0, 1e6),
    sectorTime: num(run.sectorTime, 0, 0, 1e6),
    kills: Math.round(num(run.kills, 0, 0, 1e9)),
    objectivesCompleted: Math.round(num(run.objectivesCompleted, 0, 0, 1e9)),
    startedAt: num(run.startedAt, Date.now(), 0, 1e15),
  };
}
