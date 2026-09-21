/**
 * Loot: generation from the table, ground drops, pickup resolution and the
 * consumable effects.
 *
 * Loot rolls use a dedicated `Rng` stream derived from the zone seed, so the
 * same seed produces the same drops at the same containers.
 */

import { Rng } from '../core/rng.js';
import { clamp, dist2, TAU } from '../core/math.js';
import {
  AMMO_TYPES,
  LOOTABLE_WEAPONS,
  WEAPON_TIER_NAMES,
} from '../config/weapons.js';
import { CONSUMABLES, LOOT_TABLE, RARITY_COLORS, RARITY_ORDER, RESOURCE_DEFS } from '../config/balance.js';

const AMMO_TO_TYPE = {
  ammo_light: AMMO_TYPES.LIGHT,
  ammo_shell: AMMO_TYPES.SHELL,
  ammo_rifle: AMMO_TYPES.RIFLE,
  ammo_heavy: AMMO_TYPES.HEAVY,
  ammo_cell: AMMO_TYPES.CELL,
};

export const DROP_KIND = {
  RESOURCE: 'resource',
  AMMO: 'ammo',
  CONSUMABLE: 'consumable',
  WEAPON: 'weapon',
  CHIP: 'chip',
  OBJECTIVE: 'objective',
};

export class Drop {
  constructor(spec) {
    this.id = spec.id ?? 0;
    this.kind = spec.kind;
    this.key = spec.key;
    this.amount = spec.amount ?? 1;
    this.rarity = spec.rarity ?? 'common';
    this.x = spec.x;
    this.y = spec.y;
    this.vx = spec.vx ?? 0;
    this.vy = spec.vy ?? 0;
    this.radius = spec.radius ?? 12;
    this.tier = spec.tier ?? 1;
    this.active = true;
    this.age = 0;
    this.bob = Math.random() * TAU;
    this.magnetized = false;
    this.objectiveId = spec.objectiveId ?? null;
    this.sourceRoomId = spec.sourceRoomId ?? -1;
  }

  get color() {
    if (this.kind === DROP_KIND.RESOURCE) return RESOURCE_DEFS[this.key]?.color ?? '#9fb3c8';
    if (this.kind === DROP_KIND.AMMO) return '#b9c6d4';
    if (this.kind === DROP_KIND.CONSUMABLE) return this.key === 'medkit' ? '#ff4d6d' : this.key === 'armorplate' ? '#5aa9ff' : '#ffd166';
    if (this.kind === DROP_KIND.WEAPON) return RARITY_COLORS[this.rarity] ?? '#9fb3c8';
    if (this.kind === DROP_KIND.CHIP) return RARITY_COLORS.epic;
    return '#ffd166';
  }

  get label() {
    switch (this.kind) {
      case DROP_KIND.RESOURCE:
        return RESOURCE_DEFS[this.key]?.name ?? this.key;
      case DROP_KIND.AMMO:
        return `${this.amount} Ammo`;
      case DROP_KIND.CONSUMABLE:
        return CONSUMABLES[this.key]?.name ?? this.key;
      case DROP_KIND.WEAPON:
        return `${WEAPON_TIER_NAMES[this.tier]} Weapon`;
      case DROP_KIND.CHIP:
        return 'Upgrade Chip';
      default:
        return this.key;
    }
  }
}

/**
 * Rolls a single loot entry from the table.
 * @param {Rng} rng
 * @param {{tier:number, quality:number, rarityBoost:number}} ctx
 */
export function rollLoot(rng, ctx) {
  const tier = Math.max(1, ctx.tier ?? 1);
  const candidates = LOOT_TABLE.filter((entry) => (entry.minTier ?? 1) <= tier);
  const boost = ctx.rarityBoost ?? 0;
  const weighted = candidates.map((entry) => {
    let weight = entry.weight;
    // Rarity boost pushes rare entries up and common entries down.
    if (entry.rarity === 'rare') weight *= 1 + boost * 0.6;
    if (entry.rarity === 'epic') weight *= 1 + boost * 1.1;
    if (entry.rarity === 'common') weight *= Math.max(0.35, 1 - boost * 0.18);
    return { ...entry, weight };
  });
  const picked = rng.weighted(weighted);
  const quality = ctx.quality ?? 1;
  const qtyRange = picked.qty ?? [1, 1];
  let amount = rng.int(qtyRange[0], qtyRange[1]);
  if (picked.rarity !== 'epic' && picked.id !== 'weapon') {
    amount = Math.max(1, Math.round(amount * clamp(quality, 0.5, 4)));
  }
  return { entry: picked, amount };
}

/** Converts a rolled entry into a Drop instance. */
export function entryToDrop(entry, amount, x, y, rng, spec = {}) {
  if (entry.id in AMMO_TO_TYPE) {
    return new Drop({
      kind: DROP_KIND.AMMO,
      key: AMMO_TO_TYPE[entry.id],
      amount,
      rarity: entry.rarity,
      x,
      y,
      ...spec,
    });
  }
  if (entry.id === 'weapon') {
    const weaponId = spec.weaponId ?? rng.pick(LOOTABLE_WEAPONS);
    const tier = spec.weaponTier
      ?? rng.weighted([
        { tier: 1, weight: 62 },
        { tier: 2, weight: 28 },
        { tier: 3, weight: 10 },
      ]).tier;
    const rarity = tier === 3 ? 'legendary' : tier === 2 ? 'epic' : 'rare';
    return new Drop({
      kind: DROP_KIND.WEAPON,
      key: weaponId,
      tier,
      amount: 1,
      rarity,
      x,
      y,
      radius: 15,
      ...spec,
    });
  }
  if (entry.id === 'upgrade_chip') {
    return new Drop({ kind: DROP_KIND.CHIP, key: 'upgrade_chip', amount, rarity: 'epic', x, y, radius: 15, ...spec });
  }
  if (entry.id in CONSUMABLES) {
    return new Drop({ kind: DROP_KIND.CONSUMABLE, key: entry.id, amount, rarity: entry.rarity, x, y, ...spec });
  }
  return new Drop({ kind: DROP_KIND.RESOURCE, key: entry.id, amount, rarity: entry.rarity, x, y, ...spec });
}

/**
 * LootSystem: owns ground drops, magnet pickups and pickup dispatch.
 */
export class LootSystem {
  /**
   * @param {Object} ctx
   * @param {ReturnType<import('../generation/zone.js').generateZone>} ctx.zone
   * @param {import('../progression/progression.js').Progression} ctx.progression
   * @param {number} ctx.runSeed
   */
  constructor({ zone, progression, runSeed, rng = null }) {
    this.zone = zone;
    this.progression = progression;
    this.rng = rng ?? new Rng(`${runSeed}:loot:${zone.tier}`);
    this.drops = [];
    this.nextId = 1;
    this.totalPicked = 0;
    this.onPickup = null;
    this.onError = null;
    this._seedZoneLoot();
  }

  _seedZoneLoot() {
    for (const spawn of this.zone.lootSpawns) {
      const rollCount = spawn.guaranteed ? 2 : this.rng.bool(0.75) ? 2 : 1;
      for (let i = 0; i < rollCount; i += 1) {
        const roll = rollLoot(this.rng, {
          tier: spawn.tier ?? this.zone.tier,
          quality: spawn.quality ?? 1,
          rarityBoost: spawn.rarityBoost ?? 0,
        });
        const jitterAngle = this.rng.angle();
        const jitterRadius = this.rng.float(0, 34);
        const drop = entryToDrop(
          roll.entry,
          roll.amount,
          spawn.x + Math.cos(jitterAngle) * jitterRadius,
          spawn.y + Math.sin(jitterAngle) * jitterRadius,
          this.rng,
          { id: this.nextId++, sourceRoomId: spawn.roomId },
        );
        this.drops.push(drop);
      }
    }
  }

  /** Enemy death drops. Elites and the boss drop meaningfully more. */
  dropFromEnemy(enemy) {
    const created = [];
    const isBoss = enemy.isBoss;
    const isElite = enemy.isElite;
    const count = isBoss ? 7 : isElite ? 3 : this.rng.bool(0.42) ? 1 : 0;
    const boost = isBoss ? 3 : isElite ? 1.6 : 0;
    for (let i = 0; i < count; i += 1) {
      const roll = rollLoot(this.rng, {
        tier: this.zone.tier,
        quality: 1 + (isBoss ? 1.2 : isElite ? 0.5 : 0),
        rarityBoost: boost,
      });
      const angle = this.rng.angle();
      const radius = this.rng.float(6, 26);
      const drop = entryToDrop(roll.entry, roll.amount, enemy.x + Math.cos(angle) * radius, enemy.y + Math.sin(angle) * radius, this.rng, {
        id: this.nextId++,
        vx: Math.cos(angle) * 60,
        vy: Math.sin(angle) * 60,
        sourceRoomId: -1,
      });
      this.drops.push(drop);
      created.push(drop);
    }
    // Boss always guarantees a tier-3 weapon to reward the fight.
    if (isBoss) {
      const drop = entryToDrop(
        { id: 'weapon', rarity: 'legendary' },
        1,
        enemy.x,
        enemy.y + 30,
        this.rng,
        { id: this.nextId++, sourceRoomId: -1, weaponTier: 3 },
      );
      this.drops.push(drop);
      created.push(drop);
    }
    return created;
  }

  /** Spawns a specific drop (used by destructible props and objectives). */
  spawnDrop(spec) {
    const drop = new Drop({ ...spec, id: this.nextId++ });
    this.drops.push(drop);
    return drop;
  }

  /**
   * @param {number} dt
   * @param {Object} ctx
   * @param {import('../player/player.js').Player} ctx.player
   * @param {import('../world/world.js').WorldRuntime} ctx.world
   * @param {boolean} ctx.canPickup
   */
  update(dt, ctx) {
    const { player, world } = ctx;
    const pickupRadius = ctx.pickupRadius ?? 46;
    for (const drop of this.drops) {
      if (!drop.active) continue;
      drop.age += dt;
      drop.bob += dt * 2.4;
      // Drop physics (short hop on spawn).
      const drag = Math.exp(-6 * dt);
      drop.vx *= drag;
      drop.vy *= drag;
      drop.x += drop.vx * dt;
      drop.y += drop.vy * dt;
      if (world) world.resolveProps(drop);

      if (!ctx.canPickup || !player.alive) continue;
      const d2 = dist2(drop.x, drop.y, player.x, player.y);
      const magnet = drop.kind === DROP_KIND.WEAPON || drop.kind === DROP_KIND.CHIP ? pickupRadius * 0.8 : pickupRadius;
      if (d2 <= magnet * magnet) {
        this.pickup(drop, player);
      } else if (d2 <= (magnet * 3.1) ** 2) {
        // Gentle attraction so loot feels responsive without teleporting.
        const d = Math.sqrt(d2) || 1;
        const pull = 190 * dt;
        drop.x += ((player.x - drop.x) / d) * pull;
        drop.y += ((player.y - drop.y) / d) * pull;
      }
    }
    const before = this.drops.length;
    this.drops = this.drops.filter((d) => d.active);
    return before !== this.drops.length;
  }

  /** @returns {boolean} whether the drop was consumed */
  pickup(drop, player) {
    if (!drop.active) return false;
    const result = this.applyPickup(drop, player);
    if (!result) return false;
    drop.active = false;
    this.totalPicked += 1;
    if (this.onPickup) this.onPickup(drop, result);
    return true;
  }

  /** Pure-ish resolution of a pickup, returns a descriptor or null when blocked. */
  applyPickup(drop, player) {
    switch (drop.kind) {
      case DROP_KIND.RESOURCE: {
        const gained = player.addLoot(drop.key, drop.amount);
        return { type: 'resource', key: drop.key, amount: gained, rarity: drop.rarity, label: drop.label };
      }
      case DROP_KIND.AMMO: {
        player.ammo.add(drop.key, drop.amount);
        return { type: 'ammo', key: drop.key, amount: drop.amount, rarity: drop.rarity, label: `${drop.amount} ${drop.key.toUpperCase()}` };
      }
      case DROP_KIND.CONSUMABLE: {
        player.consumables[drop.key] = (player.consumables[drop.key] ?? 0) + drop.amount;
        if (drop.key === 'medkit') player.medkits += drop.amount;
        return { type: 'consumable', key: drop.key, amount: drop.amount, rarity: drop.rarity, label: drop.label };
      }
      case DROP_KIND.WEAPON: {
        const outcome = player.addWeapon(drop.key, drop.tier);
        return {
          type: 'weapon',
          key: drop.key,
          tier: drop.tier,
          added: outcome.added,
          upgraded: outcome.upgraded,
          rarity: drop.rarity,
          label: outcome.added ? 'New weapon acquired' : outcome.upgraded ? 'Weapon upgraded' : 'Duplicate weapon scrapped',
          scrapValue: outcome.added || outcome.upgraded ? 0 : 6,
          onDuplicate: () => {
            player.addLoot('scrap', 6);
          },
        };
      }
      case DROP_KIND.CHIP: {
        // Upgrade chips are banked XP immediately - they are too valuable to
        // risk carrying, which makes them a real decision point.
        const xp = 45 * this.zone.tier;
        player.addLoot('cells', drop.amount * 2);
        return { type: 'chip', key: 'upgrade_chip', amount: drop.amount, xp, rarity: 'epic', label: 'Upgrade chip (+XP on extraction)' };
      }
      default:
        return null;
    }
  }

  /** Uses a consumable, returning the effect descriptor or null when unavailable. */
  useConsumable(player, key) {
    const available = player.consumables[key] ?? 0;
    if (available <= 0) return null;
    if (key === 'medkit') {
      if (player.health >= player.maxHealth) return null;
      const healed = player.heal(CONSUMABLES.medkit.heal);
      player.consumables.medkit -= 1;
      player.medkits -= 1;
      return { key, healed, label: `+${Math.round(healed)} HP` };
    }
    if (key === 'armorplate') {
      const gained = player.addArmor(CONSUMABLES.armorplate.armor);
      if (gained <= 0) return null;
      player.consumables.armorplate -= 1;
      return { key, armor: gained, label: `+${Math.round(gained)} ARMOR` };
    }
    if (key === 'stim') {
      player.consumables.stim -= 1;
      player.stimTimer = CONSUMABLES.stim.duration;
      return { key, duration: CONSUMABLES.stim.duration, label: 'STIM ACTIVE' };
    }
    throw new Error(`Unknown consumable "${key}"`);
  }

  /** Chips are converted to XP at extraction; blocked drops are auto-collected. */
  collectAll(player) {
    let collected = 0;
    for (const drop of this.drops) {
      if (!drop.active) continue;
      if (drop.kind === DROP_KIND.WEAPON || drop.kind === DROP_KIND.CHIP) continue;
      if (this.pickup(drop, player)) collected += 1;
    }
    return collected;
  }

  countByRarity() {
    const counts = {};
    for (const drop of this.drops) {
      if (!drop.active) continue;
      counts[drop.rarity] = (counts[drop.rarity] ?? 0) + 1;
    }
    return counts;
  }

  reset() {
    this.drops = [];
  }
}

export { RARITY_ORDER };
