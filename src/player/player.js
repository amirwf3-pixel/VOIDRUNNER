/**
 * Player entity: movement, dash, health/armor/energy, weapon loadout and
 * inventory of temporary run loot.
 *
 * The player never resolves hits itself; it exposes stats and takes damage
 * through explicit methods so combat rules stay in one place.
 */

import { clamp, damp, dist2, rotateToward, TAU } from '../core/math.js';
import { ARMOR_REDUCTION_CAP, ARMOR_REDUCTION_PER_POINT, CONSUMABLES, PLAYER_BASE, RESOURCE_DEFS } from '../config/balance.js';
import { AmmoPool, WeaponInstance, STARTING_RESERVE } from '../weapons/weapon.js';
import { getWeaponDef } from '../config/weapons.js';

/** Upper bound for a saved consumable stack; well above any reachable in-run value. */
const CONSUMABLE_STOCK_CAP = 999;

/**
 * Counters the run result reports are whole numbers: anything non-finite,
 * negative or unparseable becomes zero, so a malformed snapshot cannot put NaN
 * into the results screen or the account records derived from them.
 */
function statCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Normalises a saved consumable stock against the live `CONSUMABLES` table.
 *
 * Unknown keys are dropped, and counts are floored to whole units and clamped
 * to [0, CONSUMABLE_STOCK_CAP] so a malformed save cannot create negative,
 * fractional or non-finite stock. Missing/invalid entries inside a payload that
 * does contain consumable data become 0 (the player simply carries none).
 *
 * @returns {{medkit:number, armorplate:number, stim:number}|null} `null` when
 *   the payload holds no recognisable consumable data at all, which lets
 *   callers fall back to the pre-consumable-save behaviour.
 */
function normalizeConsumables(state) {
  if (!state || typeof state !== 'object') return null;
  const out = {};
  let recognised = 0;
  for (const key of Object.keys(CONSUMABLES)) {
    const value = state[key];
    if (Number.isFinite(value)) recognised += 1;
    out[key] = Number.isFinite(value) ? clamp(Math.floor(value), 0, CONSUMABLE_STOCK_CAP) : 0;
  }
  return recognised > 0 ? out : null;
}

/**
 * Upper bound for a saved loot stack; mirrors `MAX_LOOT_STACK` in the save
 * validator. Well above any amount reachable in a run.
 */
const LOOT_STACK_CAP = 1e6;

/**
 * Normalises a saved loot bag against the live `RESOURCE_DEFS` table.
 *
 * `SaveSystem` already sanitises this, but `Run` can also be built from an
 * in-memory snapshot that never went through validation, and the bag feeds
 * `lootValue()` -> `result.lootValue`/`result.cores` -> the settled account. So
 * the same rule is re-applied here: known resources only, finite numbers only,
 * rounded and clamped to 0..`LOOT_STACK_CAP`. Unusable values contribute
 * nothing, and valid loot is kept exactly as saved.
 */
function normalizeLoot(state) {
  const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const out = {};
  for (const key of Object.keys(RESOURCE_DEFS)) {
    const value = Number.isFinite(source[key]) ? clamp(Math.round(source[key]), 0, LOOT_STACK_CAP) : 0;
    out[key] = value;
  }
  return out;
}

export const PLAYER_STATE = {
  ACTIVE: 'active',
  DEAD: 'dead',
};

export class Player {
  /**
   * @param {{x:number,y:number}} spawn
   * @param {Object} bonuses result of Progression.computeRunBonuses()
   */
  constructor(spawn, bonuses) {
    this.x = spawn.x;
    this.y = spawn.y;
    this.vx = 0;
    this.vy = 0;
    this.radius = PLAYER_BASE.radius;
    this.aimAngle = 0;
    this.aimDir = { x: 1, y: 0 };
    this.facing = 1;

    this.maxHealth = PLAYER_BASE.maxHealth + (bonuses?.maxHealthAdd ?? 0);
    this.health = this.maxHealth;
    this.maxArmor = PLAYER_BASE.maxArmor + (bonuses?.maxArmorAdd ?? 0);
    this.armor = this.maxArmor;
    this.maxEnergy = PLAYER_BASE.maxEnergy + (bonuses?.maxEnergyAdd ?? 0);
    this.energy = this.maxEnergy;

    this.baseMoveSpeed = PLAYER_BASE.moveSpeed * (bonuses?.moveMul ?? 1);
    this.damageMul = bonuses?.damageMul ?? 1;
    this.reloadMul = bonuses?.reloadMul ?? 1;
    this.recoilMul = bonuses?.recoilMul ?? 1;

    this.state = PLAYER_STATE.ACTIVE;
    this.alive = true;
    this.invulnTimer = 0;
    this.hitFlash = 0;
    this.dashTimer = 0;
    this.dashCooldown = 0;
    this.dashDirX = 0;
    this.dashDirY = 0;
    this.isDashing = false;
    this.isSprinting = false;
    this.walkCycle = 0;
    this.lastDamageAt = -999;
    this.timeSinceDamage = 999;

    /** Permanent-ish run loadout. */
    this.weapons = [];
    this.weaponIndex = 0;
    this.ammo = new AmmoPool();
    this.consumables = { medkit: 0, armorplate: 0, stim: 0 };
    /** Temporary run loot (lost or partially lost on death). */
    this.loot = { scrap: 0, cores: 0, cells: 0, datashard: 0, intel: 0 };
    this.medkits = 0;

    this.stimTimer = 0;
    this.stats = {
      kills: 0,
      damageDealt: 0,
      damageTaken: 0,
      shotsFired: 0,
      shotsHit: 0,
      lootValue: 0,
      distanceTravelled: 0,
      dashes: 0,
      reloads: 0,
    };

    this.pickupFlash = 0;
  }

  /** @param {Object} bonuses */
  applyBonuses(bonuses) {
    this.maxHealth = PLAYER_BASE.maxHealth + (bonuses.maxHealthAdd ?? 0);
    this.health = this.maxHealth;
    this.maxArmor = PLAYER_BASE.maxArmor + (bonuses.maxArmorAdd ?? 0);
    this.armor = this.maxArmor;
    this.maxEnergy = PLAYER_BASE.maxEnergy + (bonuses.maxEnergyAdd ?? 0);
    this.energy = this.maxEnergy;
    this.baseMoveSpeed = PLAYER_BASE.moveSpeed * (bonuses.moveMul ?? 1);
    this.damageMul = bonuses.damageMul ?? 1;
    this.reloadMul = bonuses.reloadMul ?? 1;
    this.recoilMul = bonuses.recoilMul ?? 1;
    this.magBonus = bonuses.magBonus ?? 0;
    this.ammoMul = bonuses.ammoMul ?? 1;
  }

  /**
   * Build the starting loadout.
   * @param {string[]} weaponIds
   * @param {{medkitsAdd?:number, ammoMul?:number}} bonuses
   */
  setLoadout(weaponIds, bonuses = {}) {
    this.weapons = [];
    for (const id of weaponIds) {
      try {
        const instance = new WeaponInstance(id, 1);
        this.weapons.push(instance);
      } catch (error) {
        console.warn(`[Player] skipping unknown starting weapon "${id}"`, error);
      }
    }
    if (this.weapons.length === 0) this.weapons.push(new WeaponInstance('pistol', 1));
    this.weaponIndex = 0;
    this.weapons[0].raise();

    // Reserve ammo covers every ammo type the loadout can consume.
    const ammoMul = bonuses.ammoMul ?? 1;
    this.ammo = new AmmoPool();
    for (const weapon of this.weapons) {
      const type = weapon.def.ammo;
      const base = STARTING_RESERVE[type] ?? 60;
      this.ammo.add(type, Math.round(base * ammoMul));
    }
    this.medkits = 1 + (bonuses.medkitsAdd ?? 0);
    this.consumables.medkit = this.medkits;
    this.consumables.armorplate = 1;
    this.consumables.stim = 1;
  }

  get weapon() {
    return this.weapons[this.weaponIndex] ?? null;
  }

  get isReloading() {
    return this.weapon ? this.weapon.isReloading : false;
  }

  get speedMultiplier() {
    const moveMul = this.weapon ? this.weapon.def.moveMul : 1;
    const stimMul = this.stimTimer > 0 ? 1.15 : 1;
    return moveMul * stimMul * (this.isSprinting ? 1.0 : 1.0);
  }

  get damageMultiplier() {
    return this.damageMul * (this.stimTimer > 0 ? 1.3 : 1);
  }

  get armorReduction() {
    return Math.min(ARMOR_REDUCTION_CAP, this.armor * ARMOR_REDUCTION_PER_POINT);
  }

  switchWeapon(index) {
    if (index < 0 || index >= this.weapons.length) return false;
    if (index === this.weaponIndex) return false;
    this.weaponIndex = index;
    this.weapons[index].raise();
    return true;
  }

  nextWeapon() {
    if (this.weapons.length <= 1) return false;
    return this.switchWeapon((this.weaponIndex + 1) % this.weapons.length);
  }

  addWeapon(weaponId, tier = 1) {
    const existing = this.weapons.find((w) => w.id === weaponId);
    if (existing) {
      if (tier > existing.tier) {
        existing.tier = clamp(tier, 1, 3);
        existing.magazineSize = getWeaponDef(weaponId).magazine;
        existing.refill();
        return { added: false, upgraded: true, weapon: existing };
      }
      return { added: false, upgraded: false, weapon: existing };
    }
    const instance = new WeaponInstance(weaponId, tier);
    this.weapons.push(instance);
    const type = instance.def.ammo;
    if (!this.ammo.has(type)) {
      this.ammo.add(type, Math.round((STARTING_RESERVE[type] ?? 60) * 0.6 * (this.ammoMul ?? 1)));
    }
    return { added: true, upgraded: false, weapon: instance };
  }

  /**
   * @param {number} dt
   * @param {Object} input
   * @param {{x:number,y:number}} input.move
   * @param {{x:number,y:number}} input.aimWorld
   * @param {boolean} input.dashPressed
   * @param {boolean} input.dashHeld
   * @param {import('../world/tilemap.js').TileMap} map
   * @param {import('../world/world.js').WorldRuntime} world
   */
  update(dt, input, map, world) {
    if (!this.alive) {
      this.vx = damp(this.vx, 0, 0.0001, dt);
      this.vy = damp(this.vy, 0, 0.0001, dt);
      this.x += this.vx * dt;
      this.y += this.vy * dt;
      return;
    }
    this.timeSinceDamage += dt;
    if (this.invulnTimer > 0) this.invulnTimer = Math.max(0, this.invulnTimer - dt);
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt * 4);
    if (this.pickupFlash > 0) this.pickupFlash = Math.max(0, this.pickupFlash - dt * 3);
    if (this.dashCooldown > 0) this.dashCooldown = Math.max(0, this.dashCooldown - dt);
    if (this.stimTimer > 0) this.stimTimer = Math.max(0, this.stimTimer - dt);

    // Aim: the renderer supplies the world-space cursor position.
    if (input.aimWorld) {
      const angle = Math.atan2(input.aimWorld.y - this.y, input.aimWorld.x - this.x);
      this.aimAngle = angle;
      this.aimDir = { x: Math.cos(angle), y: Math.sin(angle) };
      if (Math.abs(Math.cos(angle)) > 0.1) this.facing = Math.cos(angle) >= 0 ? 1 : -1;
    }

    // Dash.
    if (this.isDashing) {
      this.dashTimer -= dt;
      const speed = PLAYER_BASE.dashSpeed;
      this.x += this.dashDirX * speed * dt;
      this.y += this.dashDirY * speed * dt;
      if (this.dashTimer <= 0) {
        this.isDashing = false;
        this.vx = this.dashDirX * speed * 0.28;
        this.vy = this.dashDirY * speed * 0.28;
      }
    } else {
      const move = input.move ?? { x: 0, y: 0 };
      const wantsMove = move.x !== 0 || move.y !== 0;
      this.isSprinting = Boolean(input.dashHeld) && wantsMove && this.energy > 5;
      const staminaMul = this.isSprinting ? 1.22 : 1;
      const targetSpeed = this.baseMoveSpeed * this.speedMultiplier * staminaMul;
      const accel = PLAYER_BASE.acceleration;
      const desiredVx = move.x * targetSpeed;
      const desiredVy = move.y * targetSpeed;
      if (wantsMove) {
        this.vx = approach(this.vx, desiredVx, accel * dt);
        this.vy = approach(this.vy, desiredVy, accel * dt);
      } else {
        this.vx = approach(this.vx, 0, PLAYER_BASE.friction * dt);
        this.vy = approach(this.vy, 0, PLAYER_BASE.friction * dt);
      }
      if (this.isSprinting) {
        this.energy = Math.max(0, this.energy - 14 * dt);
        if (this.energy <= 0) this.isSprinting = false;
      }
      this.x += this.vx * dt;
      this.y += this.vy * dt;

      if (input.dashPressed && this.dashCooldown <= 0 && this.energy >= PLAYER_BASE.dashCost) {
        let dx = move.x;
        let dy = move.y;
        if (dx === 0 && dy === 0) {
          dx = this.aimDir.x;
          dy = this.aimDir.y;
        }
        const len = Math.hypot(dx, dy) || 1;
        this.dashDirX = dx / len;
        this.dashDirY = dy / len;
        this.isDashing = true;
        this.dashTimer = PLAYER_BASE.dashTime;
        this.dashCooldown = PLAYER_BASE.dashCooldown;
        this.energy -= PLAYER_BASE.dashCost;
        this.invulnTimer = Math.max(this.invulnTimer, PLAYER_BASE.dashTime * 0.9);
        this.stats.dashes += 1;
      }
    }

    // Energy regeneration (paused while sprinting).
    if (!this.isSprinting) {
      this.energy = Math.min(this.maxEnergy, this.energy + PLAYER_BASE.energyRegen * dt);
    }

    // Collision: tiles then props, twice, so corners settle.
    for (let i = 0; i < 2; i += 1) {
      map.resolveCircle(this);
      world.resolveProps(this);
    }

    const travelled = Math.hypot(this.vx, this.vy) * dt;
    this.stats.distanceTravelled += travelled;
    if (travelled > 1) this.walkCycle += travelled * 0.045;
  }

  /**
   * Applies damage after armor. `bypassArmor` is used by hazards and the boss
   * slam so armor never becomes a hard wall.
   * @returns {{applied:number, absorbed:number, died:boolean}}
   */
  takeDamage(amount, { bypassArmor = false, ignoreInvuln = false } = {}) {
    if (!this.alive) return { applied: 0, absorbed: 0, died: false };
    if (this.invulnTimer > 0 && !ignoreInvuln) return { applied: 0, absorbed: 0, died: false };
    const raw = Math.max(0, amount);
    let absorbed = 0;
    let remaining = raw;
    if (!bypassArmor && this.armor > 0) {
      const reduction = this.armorReduction;
      absorbed = raw * reduction;
      remaining = raw - absorbed;
      // Armor degrades as it soaks damage.
      this.armor = Math.max(0, this.armor - Math.max(1, raw * 0.18));
    }
    const applied = Math.max(0, remaining);
    this.health -= applied;
    this.stats.damageTaken += applied;
    this.invulnTimer = PLAYER_BASE.invulnOnHit;
    this.hitFlash = 1;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.state = PLAYER_STATE.DEAD;
      return { applied, absorbed, died: true };
    }
    return { applied, absorbed, died: false };
  }

  heal(amount) {
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    return this.health - before;
  }

  addArmor(amount) {
    const before = this.armor;
    this.armor = Math.min(Math.max(this.maxArmor, 50), this.armor + amount);
    return this.armor - before;
  }

  addEnergy(amount) {
    const before = this.energy;
    this.energy = Math.min(this.maxEnergy, this.energy + amount);
    return this.energy - before;
  }

  /**
   * Adds loot to the temporary run inventory.
   * @returns {number} actual amount added
   */
  addLoot(resourceId, amount) {
    if (!(resourceId in this.loot)) {
      this.loot[resourceId] = 0;
    }
    const add = Math.max(0, Math.round(amount));
    this.loot[resourceId] += add;
    this.pickupFlash = 1;
    return add;
  }

  /** Cores + scrap value used for the "loot value" run statistic. */
  lootValue() {
    return (this.loot.scrap ?? 0) + (this.loot.cores ?? 0) * 8 + (this.loot.cells ?? 0) * 3
      + (this.loot.datashard ?? 0) * 12 + (this.loot.intel ?? 0) * 18;
  }

  /** Part of the loot that survives a death - the rest is lost. */
  forfeitLoot(rate) {
    const lost = {};
    for (const key of Object.keys(this.loot)) {
      const value = this.loot[key] ?? 0;
      const keep = Math.floor(value * rate);
      lost[key] = value - keep;
      this.loot[key] = keep;
    }
    return lost;
  }

  nearestEnemyDistance(enemies) {
    let best = Infinity;
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      const d = dist2(this.x, this.y, enemy.x, enemy.y);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  /** Called by the renderer to keep the aim reticle rotation smooth. */
  rotateAimToward(targetAngle, maxStep) {
    this.aimAngle = rotateToward(this.aimAngle, targetAngle, maxStep);
  }

  /**
   * Counters the run result reports (shots, dashes). They live on the player,
   * but they are run totals, so they are carried through every rebuild of the
   * player instead of restarting at zero.
   */
  serializeStats() {
    return {
      shotsFired: this.stats.shotsFired,
      shotsHit: this.stats.shotsHit,
      dashes: this.stats.dashes,
    };
  }

  serialize() {
    return {
      loot: { ...this.loot },
      weapons: this.weapons.map((w) => w.serialize()),
      weaponIndex: this.weaponIndex,
      reserve: this.ammo.serialize(),
      consumables: { ...this.consumables },
      health: this.health,
      armor: this.armor,
      stats: this.serializeStats(),
    };
  }

  /**
   * @param {Object} data serialized player payload
   * @param {{x:number,y:number}} spawn
   * @param {Object} bonuses result of Progression.computeRunBonuses()
   * @param {(player: Player) => void} [beforeVitals] run-level hook invoked once
   *   the player exists but before the saved health/armor are applied, so the
   *   caps those values are clamped against already include earned run perks
   */
  static restore(data, spawn, bonuses, beforeVitals = null) {
    const player = new Player(spawn, bonuses);
    if (!data) return player;
    const weapons = Array.isArray(data.weapons)
      ? data.weapons.map((w) => WeaponInstance.deserialize(w)).filter(Boolean)
      : [];
    if (weapons.length > 0) {
      player.weapons = weapons;
      // Clamped here as well as in the save validator: `Run` can be built from
      // an in-memory snapshot that never went through validation.
      player.weaponIndex = clamp(Math.round(data.weaponIndex ?? 0), 0, weapons.length - 1);
      player.weapons[player.weaponIndex].raise();
    } else {
      player.setLoadout(['pistol'], bonuses);
    }
    const pool = AmmoPool.deserialize(data.reserve);
    if (Object.keys(pool.pools).length === 0) {
      for (const weapon of player.weapons) {
        pool.add(weapon.def.ammo, Math.round((STARTING_RESERVE[weapon.def.ammo] ?? 60) * (bonuses.ammoMul ?? 1)));
      }
    }
    player.ammo = pool;
    player.loot = normalizeLoot(data.loot);

    // Perks that raise `maxHealth`/`maxArmor` are replayed before the saved
    // vitals are clamped, otherwise a legitimately saved value would be shaved
    // down to the pre-perk cap.
    if (beforeVitals) beforeVitals(player);

    player.health = clamp(data.health ?? player.maxHealth, 1, player.maxHealth);
    player.armor = clamp(data.armor ?? player.maxArmor, 0, Math.max(player.maxArmor, 50));

    // Run totals the player owns (see `serializeStats`). Older snapshots carry
    // none of them, which simply resumes with zeroed counters.
    const stats = data.stats && typeof data.stats === 'object' ? data.stats : {};
    player.stats.shotsFired = statCount(stats.shotsFired);
    player.stats.shotsHit = statCount(stats.shotsHit);
    player.stats.dashes = statCount(stats.dashes);

    // Consumable stock is carried state: restore the exact saved counts. Only
    // saves predating consumable persistence fall back to the older resume
    // default (one bonus-adjusted medkit, no plates or stims).
    const consumables = normalizeConsumables(data.consumables);
    if (consumables) {
      player.consumables = consumables;
      player.medkits = consumables.medkit;
    } else {
      player.medkits = 1 + (bonuses.medkitsAdd ?? 0);
      player.consumables.medkit = player.medkits;
    }
    return player;
  }
}

function approach(current, target, delta) {
  if (current < target) return Math.min(current + delta, target);
  return Math.max(current - delta, target);
}

/** Utility used by AI and effects to reason about the player's hitbox. */
export function playerCircle(player) {
  return { x: player.x, y: player.y, radius: player.radius };
}

export const PLAYER_ANGLE_TOLERANCE = TAU / 64;
