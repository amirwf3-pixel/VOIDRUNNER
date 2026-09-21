/**
 * Weapon runtime: fire cadence, magazine, reload, bloom and per-tier scaling.
 *
 * The instance never touches the world directly - it returns shot descriptors
 * and the combat system turns them into projectiles. That keeps the weapon
 * purely about timing and stat math, which makes it fully deterministic and
 * trivially testable.
 */

import { clamp } from '../core/math.js';
import { getWeaponDef, roundsPerSecond, tierDamageMul, tierMagazineBonus } from '../config/weapons.js';

export const WEAPON_STATE = {
  READY: 'ready',
  FIRING: 'firing',
  RELOADING: 'reloading',
  EMPTY: 'empty',
  RAISING: 'raising',
};

export class WeaponInstance {
  /**
   * @param {string} weaponId
   * @param {number} [tier] 1..3
   */
  constructor(weaponId, tier = 1) {
    this.def = getWeaponDef(weaponId);
    this.id = this.def.id;
    this.tier = clamp(Math.round(tier), 1, 3);
    this.magazineSize = this.def.magazine + tierMagazineBonus(this.tier);
    this.ammo = this.magazineSize;
    this.state = WEAPON_STATE.READY;
    this.cooldown = 0;
    this.reloadTimer = 0;
    this.reloadDuration = this.def.reloadTime;
    this.bloom = 0;
    this.shotsFired = 0;
    this.raiseTimer = 0;
    this.raiseDuration = 0.16;
    this.lastShotAt = -999;
    this.totalShots = 0;
    this.dryFireCooldown = 0;
    /** Set when the magazine empties so the HUD can flash. */
    this.justEmptied = false;
    this.justReloaded = false;
    /** True once the reload timer elapsed and the magazine is awaiting ammo. */
    this.reloadReady = false;
  }

  get isReloading() {
    return this.state === WEAPON_STATE.RELOADING;
  }

  get isEmpty() {
    return this.ammo <= 0;
  }

  get displayName() {
    return this.def.name;
  }

  /** Effective seconds between shots after handling bonuses. */
  shotInterval(rateMul = 1) {
    return 1 / (roundsPerSecond(this.def) * rateMul);
  }

  effectiveReloadTime(reloadMul = 1) {
    return this.def.reloadTime * reloadMul;
  }

  effectiveSpread() {
    return this.def.spread + this.bloom;
  }

  /** Damage for one pellet before crit and falloff. */
  damagePerPellet(damageMul = 1) {
    return this.def.damage * tierDamageMul(this.tier) * damageMul;
  }

  /**
   * @param {number} dt
   * @param {Object} [modifiers]
   * @param {number} [modifiers.rateMul]
   * @param {number} [modifiers.reloadMul]
   */
  update(dt, modifiers = {}) {
    const rateMul = modifiers.rateMul ?? 1;
    const reloadMul = modifiers.reloadMul ?? 1;
    this.justReloaded = false;
    this.justEmptied = false;
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.dryFireCooldown > 0) this.dryFireCooldown = Math.max(0, this.dryFireCooldown - dt);

    if (this.state === WEAPON_STATE.RAISING) {
      this.raiseTimer -= dt;
      if (this.raiseTimer <= 0) {
        this.state = this.ammo > 0 ? WEAPON_STATE.READY : WEAPON_STATE.EMPTY;
      }
    }

    if (this.state === WEAPON_STATE.RELOADING) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        // The weapon never refills itself: it flags readiness and the owner
        // supplies the reserve, so ammo can never be created from nothing.
        this.reloadReady = true;
        this.reloadTimer = 0;
      }
    }

    // Bloom recovers toward zero; the decay is defined per second.
    const decay = this.def.bloomDecay * (modifiers.bloomDecayMul ?? 1);
    this.bloom = Math.max(0, this.bloom - decay * dt);
    void rateMul;
    void reloadMul;
  }

  /** True when a trigger pull would produce a shot right now. */
  canFire() {
    return (
      (this.state === WEAPON_STATE.READY || this.state === WEAPON_STATE.FIRING || this.state === WEAPON_STATE.EMPTY) &&
      this.cooldown <= 0 &&
      this.ammo > 0
    );
  }

  /**
   * Attempt a shot.
   * @returns {null | {pellets:number, spread:number, damage:number, critical:boolean, def:Object, tier:number}}
   */
  tryFire(modifiers = {}) {
    if (this.state === WEAPON_STATE.RELOADING || this.state === WEAPON_STATE.RAISING) return null;
    if (this.ammo <= 0) {
      if (this.dryFireCooldown <= 0) {
        this.dryFireCooldown = 0.35;
        this.state = WEAPON_STATE.EMPTY;
        return { dry: true, pellets: 0, spread: 0, damage: 0, critical: false, def: this.def, tier: this.tier };
      }
      return null;
    }
    if (this.cooldown > 0) return null;

    const rateMul = modifiers.rateMul ?? 1;
    this.ammo -= 1;
    this.shotsFired += 1;
    this.totalShots += 1;
    this.cooldown = this.shotInterval(rateMul);
    this.state = this.ammo > 0 ? WEAPON_STATE.FIRING : WEAPON_STATE.EMPTY;
    if (this.ammo === 0) this.justEmptied = true;

    const spread = clamp(this.effectiveSpread() * (modifiers.spreadMul ?? 1), 0, 0.75);
    const critChance = clamp(
      (this.def.critChance ?? 0.05) + (modifiers.critChanceAdd ?? 0),
      0,
      0.9,
    );
    const lastShotAt = this.lastShotAt;
    this.lastShotAt = 0;
    void lastShotAt;

    const shot = {
      dry: false,
      pellets: this.def.pellets,
      spread,
      damage: this.damagePerPellet(modifiers.damageMul ?? 1),
      critical: (modifiers.random ?? Math.random)() < critChance,
      def: this.def,
      tier: this.tier,
    };

    this.bloom = clamp(this.bloom + this.def.bloomPerShot * (modifiers.bloomMul ?? 1), 0, this.def.bloomMax);
    return shot;
  }

  /**
   * Start a reload.
   * @param {number} reserve available reserve ammo for this weapon's ammo type
   * @returns {boolean} whether the reload actually started
   */
  beginReload(reserve, modifiers = {}) {
    if (this.state === WEAPON_STATE.RELOADING) return false;
    if (this.ammo >= this.magazineSize) return false;
    if (reserve <= 0) return false;
    this.state = WEAPON_STATE.RELOADING;
    this.reloadReady = false;
    this.reloadDuration = this.effectiveReloadTime(modifiers.reloadMul ?? 1);
    this.reloadTimer = this.reloadDuration;
    return true;
  }

  /** True when the reload animation finished and ammo still needs transferring. */
  get needsFinish() {
    return this.state === WEAPON_STATE.RELOADING && this.reloadTimer <= 0;
  }

  /**
   * Complete a reload, drawing from the reserve.
   * @param {number} reserve
   * @returns {number} rounds actually loaded
   */
  finishReload(reserve = Infinity) {
    if (this.state !== WEAPON_STATE.RELOADING) return 0;
    const needed = this.magazineSize - this.ammo;
    const loaded = Number.isFinite(reserve) ? Math.min(needed, Math.max(0, Math.floor(reserve))) : needed;
    this.ammo += loaded;
    this.state = this.ammo > 0 ? WEAPON_STATE.READY : WEAPON_STATE.EMPTY;
    this.reloadTimer = 0;
    this.reloadReady = false;
    this.justReloaded = true;
    this.bloom = 0;
    return loaded;
  }

  cancelReload() {
    if (this.state !== WEAPON_STATE.RELOADING) return;
    this.state = this.ammo > 0 ? WEAPON_STATE.READY : WEAPON_STATE.EMPTY;
    this.reloadTimer = 0;
    this.reloadReady = false;
  }

  /** Called when the weapon becomes the active one. */
  raise() {
    this.state = WEAPON_STATE.RAISING;
    this.raiseTimer = this.raiseDuration;
    this.cancelReload();
  }

  refill() {
    this.ammo = this.magazineSize;
    if (this.state === WEAPON_STATE.EMPTY) this.state = WEAPON_STATE.READY;
  }

  /** 0..1 progress for the reload bar. */
  reloadProgress() {
    if (this.state !== WEAPON_STATE.RELOADING) return 1;
    return clamp(1 - this.reloadTimer / this.reloadDuration, 0, 1);
  }

  serialize() {
    return { id: this.id, tier: this.tier, ammo: this.ammo };
  }

  static deserialize(data) {
    if (!data || typeof data.id !== 'string') return null;
    try {
      const instance = new WeaponInstance(data.id, clamp(Math.round(data.tier ?? 1), 1, 3));
      instance.ammo = clamp(Math.round(data.ammo ?? instance.magazineSize), 0, instance.magazineSize);
      instance.state = instance.ammo > 0 ? WEAPON_STATE.READY : WEAPON_STATE.EMPTY;
      return instance;
    } catch (error) {
      console.warn('[Weapon] failed to deserialize', data, error);
      return null;
    }
  }
}

/**
 * Ammo reserve pools keyed by ammo type. Shared by every weapon using that type.
 */
export class AmmoPool {
  constructor(initial = {}) {
    this.pools = { ...initial };
  }

  get(type) {
    return this.pools[type] ?? 0;
  }

  add(type, amount) {
    if (!type) throw new TypeError('AmmoPool.add requires an ammo type');
    const next = Math.max(0, (this.pools[type] ?? 0) + Math.round(amount));
    this.pools[type] = next;
    return next;
  }

  take(type, amount) {
    const available = this.pools[type] ?? 0;
    const taken = Math.min(available, Math.max(0, Math.round(amount)));
    this.pools[type] = available - taken;
    return taken;
  }

  has(type) {
    return (this.pools[type] ?? 0) > 0;
  }

  total() {
    return Object.values(this.pools).reduce((a, b) => a + b, 0);
  }

  serialize() {
    return { ...this.pools };
  }

  static deserialize(data) {
    const pool = new AmmoPool();
    if (data && typeof data === 'object') {
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          pool.pools[key] = Math.floor(value);
        }
      }
    }
    return pool;
  }
}

/**
 * Which ammo types each weapon consumes, used for the HUD reserve display and
 * starting-loadout tuning.
 */
export const STARTING_RESERVE = {
  light: 96,
  shell: 20,
  rifle: 84,
  heavy: 120,
  cell: 40,
};
