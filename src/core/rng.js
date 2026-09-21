/**
 * Deterministic pseudo random number generation.
 *
 * Every system that needs randomness takes an `Rng` instance so that a seed
 * fully reproduces a run (map layout, loot rolls, enemy spawns, particle jitter).
 */

import { TAU } from './math.js';

/** Mulberry32: tiny, fast and good enough for gameplay randomness. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** xmur3 string hash, used to turn human readable seeds into integers. */
export function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function finish() {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

export class Rng {
  constructor(seed = 1) {
    this.seed = typeof seed === 'string' ? hashString(seed)() : seed >>> 0;
    this.state = this.seed >>> 0;
    this.calls = 0;
  }

  /** Fork a child generator with a derived but stable seed. */
  fork(label) {
    const mixed = hashString(`${this.seed}:${label}:${this.calls}`)();
    return new Rng(mixed);
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  float(min = 0, max = 1) {
    return min + this.next() * (max - min);
  }

  int(min, max) {
    return Math.floor(this.float(min, max + 1 - 1e-9));
  }

  bool(chance = 0.5) {
    return this.next() < chance;
  }

  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }

  angle() {
    return this.next() * TAU;
  }

  pick(array) {
    if (!array || array.length === 0) return undefined;
    return array[Math.floor(this.next() * array.length) % array.length];
  }

  weighted(entries) {
    let total = 0;
    for (const entry of entries) total += Math.max(0, entry.weight ?? 1);
    if (total <= 0) return entries[0];
    let roll = this.next() * total;
    for (const entry of entries) {
      roll -= Math.max(0, entry.weight ?? 1);
      if (roll <= 0) return entry;
    }
    return entries[entries.length - 1];
  }

  shuffle(array) {
    const out = array.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  /** Snapshot / restore so sub-systems cannot desync a shared stream. */
  snapshot() {
    return { seed: this.seed, state: this.state, calls: this.calls };
  }

  restore(snapshot) {
    this.seed = snapshot.seed >>> 0;
    this.state = snapshot.state >>> 0;
    this.calls = snapshot.calls ?? 0;
  }
}

export function createRng(seed) {
  return new Rng(seed);
}

const WORDS_A = [
  'NULL', 'ASH', 'VOID', 'IRON', 'DUST', 'HEX', 'GLOOM', 'RUST', 'ECHO', 'ZERO',
  'STATIC', 'CINDER', 'HALO', 'ONYX', 'FLUX', 'GRAVE', 'NEON', 'PALE', 'SHARD', 'TITAN',
];
const WORDS_B = [
  'FOUNDRY', 'REACTOR', 'DEPOT', 'SPIRE', 'TERMINAL', 'CISTERN', 'YARD', 'VAULT', 'CONDUIT', 'FURNACE',
  'SILO', 'RIG', 'BUNKER', 'ARRAY', 'WORKS', 'HANGAR', 'CANAL', 'BASIN', 'TOWER', 'GATE',
];

/** Human readable deterministic seed codes, e.g. "IRON-FOUNDRY-4F2A". */
export function generateSeedCode(rng = new Rng(Date.now() & 0xffffffff)) {
  const a = rng.pick(WORDS_A);
  const b = rng.pick(WORDS_B);
  const hex = (rng.int(0, 0xffff)).toString(16).toUpperCase().padStart(4, '0');
  return `${a}-${b}-${hex}`;
}

export function isValidSeedCode(code) {
  return typeof code === 'string' && code.trim().length >= 1 && code.trim().length <= 40;
}
