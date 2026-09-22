/**
 * Enemy spawning and lifetime management for a single sector.
 *
 * Spawns are precomputed by the generator (deterministic positions), but they
 * are *activated* by proximity so the player never fights the whole map at
 * once. Boss sectors additionally gate enemy waves behind the arena entrance.
 */

import { dist2 } from '../core/math.js';
import { BossEnemy, Enemy, resetEnemyIds } from './enemy.js';
import { ENEMY_IDS, bossArenaFor } from '../config/enemies.js';

const ACTIVATION_RADIUS = 760;
const ACTIVATION_RADIUS_BOSS = 1500;
const SLEEP_RADIUS = 1700;
const MAX_ACTIVE = 46;

export class EnemySpawner {
  /**
   * @param {ReturnType<import('../generation/zone.js').generateZone>} zone
   * @param {import('../core/rng.js').Rng} rng
   * @param {Object} [handlers]
   */
  constructor(zone, rng, handlers = {}) {
    this.zone = zone;
    this.rng = rng;
    this.handlers = handlers;
    this.enemies = [];
    this.pending = zone.enemySpawns.map((spec, index) => ({ ...spec, index, spawned: false }));
    this.bossSpawned = false;
    this.boss = null;
    this.activeCap = MAX_ACTIVE;
    this.totalSpawned = 0;
    this.killed = 0;
    this.pendingSummons = [];
  }

  get aliveCount() {
    let count = 0;
    for (const e of this.enemies) if (e.alive) count += 1;
    return count;
  }

  get bossAlive() {
    return Boolean(this.boss && this.boss.alive);
  }

  /** Creates the enemy object from a spawn spec. */
  _materialize(spec) {
    const difficulty = this.zone.difficulty;
    if (spec.isBoss) {
      const room = this.zone.rooms.find((r) => r.id === spec.roomId);
      const arenaRadius = room ? Math.max(room.rect.w, room.rect.h) * 0.6 : 420;
      const boss = new BossEnemy({ ...spec, difficulty, arenaRadius });
      boss.patrolHome = { x: spec.x, y: spec.y };
      this.bossSpawned = true;
      this.boss = boss;
      return boss;
    }
    const enemy = new Enemy({ ...spec, difficulty });
    enemy.patrolHome = { x: spec.x, y: spec.y };
    return enemy;
  }

  addEnemy(spec, { immediate = true } = {}) {
    const enemy = this._materialize(spec);
    // Stable identity for the resume hook below: pending specs carry their
    // index in the generator's deterministic spawn list, summoned adds do not.
    enemy.spawnIndex = Number.isInteger(spec.index) ? spec.index : -1;
    if (!immediate) enemy.spawnGrace = Math.max(enemy.spawnGrace, 0.6);
    this.enemies.push(enemy);
    this.totalSpawned += 1;
    if (this.handlers.onSpawn) this.handlers.onSpawn(enemy);
    return enemy;
  }

  /**
   * Summoned adds (boss / elite abilities). A single blocked position used to
   * drop the add silently — an elite in a corridor would "summon" nothing while
   * its one-shot ability was already spent — so each add searches a few rings
   * around the caller before giving up.
   */
  summon(typeId, x, y, count = 1) {
    const created = [];
    const safeType = ENEMY_IDS.includes(typeId) ? typeId : 'husk';
    for (let i = 0; i < count; i += 1) {
      let placed = null;
      for (let attempt = 0; attempt < 5 && !placed; attempt += 1) {
        const angle = this.rng.angle();
        // Corridors are only ~96 units wide, so the first ring has to fit inside
        // one: tight rings first, widening with each retry.
        const radius = 30 + this.rng.float(0, 60) + attempt * 22;
        const sx = x + Math.cos(angle) * radius;
        const sy = y + Math.sin(angle) * radius;
        if (!this.zone.map.circleCollides(sx, sy, 14)) placed = { sx, sy };
      }
      if (!placed) continue;
      const { sx, sy } = placed;
      const enemy = this.addEnemy(
        {
          x: sx,
          y: sy,
          typeId: safeType,
          elite: null,
          roomId: -1,
          dormant: false,
        },
        { immediate: true },
      );
      enemy.alerted = true;
      enemy.spawnGrace = 0.5;
      created.push(enemy);
    }
    return created;
  }

  /**
   * @param {number} dt
   * @param {{x:number,y:number}} playerPos
   * @param {boolean} playerAlive
   */
  updateActivation(dt, playerPos, playerAlive) {
    void dt;
    if (!playerAlive) return;
    for (const spec of this.pending) {
      if (spec.spawned) continue;
      const radius = spec.isBoss ? ACTIVATION_RADIUS_BOSS : ACTIVATION_RADIUS;
      if (dist2(spec.x, spec.y, playerPos.x, playerPos.y) > radius * radius) continue;
      if (this.enemies.length >= this.activeCap && !spec.isBoss) continue;
      spec.spawned = true;
      this.addEnemy(spec, { immediate: false });
    }
  }

  /** Removes dead enemies from the active list (after their death animation). */
  reap(dt) {
    let changed = false;
    for (const enemy of this.enemies) {
      if (!enemy.alive) enemy.deathTimer += dt;
    }
    const before = this.enemies.length;
    this.enemies = this.enemies.filter((e) => e.alive || e.deathTimer < 1.6);
    if (this.enemies.length !== before) changed = true;
    return changed;
  }

  /** Distance-based sleep keeps far-away AI cheap without despawning it. */
  shouldSimulate(enemy, playerPos) {
    if (enemy.isBoss) return true;
    if (!enemy.alive) return false;
    if (enemy.alerted) return true;
    return dist2(enemy.x, enemy.y, playerPos.x, playerPos.y) <= SLEEP_RADIUS * SLEEP_RADIUS;
  }

  /** Alerts every spawned enemy within a radius (used by noisy weapons). */
  alertRadius(x, y, radius) {
    const r2 = radius * radius;
    let count = 0;
    for (const enemy of this.enemies) {
      if (!enemy.alive || enemy.alerted) continue;
      if (dist2(enemy.x, enemy.y, x, y) <= r2) {
        enemy.alertTo(x, y);
        count += 1;
      }
    }
    return count;
  }

  /**
   * Pre-marks spawns that were already defeated before the snapshot so a
   * resumed sector does not regenerate them — and with them their XP, drops and
   * kill credit. Mirrors `LootSystem.restoreCollected` and
   * `WorldRuntime.restoreDestroyedProps`: spawn indices are positions in the
   * generator's deterministic spawn list, so the same index always refers to
   * the same enemy for the same seed/tier. The restored spawns count as
   * spawned/killed because that is what happened before the checkpoint.
   * @param {number[]} indices
   * @returns {number} how many spawns were suppressed
   */
  restoreDefeated(indices) {
    if (!Array.isArray(indices) || indices.length === 0) return 0;
    const wanted = new Set(indices);
    let restored = 0;
    for (const spec of this.pending) {
      if (spec.spawned || !wanted.has(spec.index)) continue;
      spec.spawned = true;
      restored += 1;
    }
    this.totalSpawned += restored;
    this.killed += restored;
    return restored;
  }

  percentCleared() {
    const total = this.pending.length;
    if (total === 0) return 1;
    const spawned = this.pending.filter((p) => p.spawned).length;
    return spawned / total;
  }

  /**
   * Boss arena wave: called when the player enters the boss room. The wave
   * belongs to the arena the boss is running (see BOSS_ARENAS), so the second
   * arena opens on its own escort instead of the first one again with more
   * health.
   */
  triggerBossWaves() {
    if (!this.boss) return [];
    if (this.bossWavesTriggered) return [];
    this.bossWavesTriggered = true;
    const arena = this.boss.arena ?? bossArenaFor(this.zone.tier);
    const types = arena.waves;
    const perType = types.length > 2 ? 3 : 4;
    const summoned = [];
    for (const typeId of types) {
      summoned.push(...this.summon(typeId, this.boss.x, this.boss.y, perType));
    }
    return summoned;
  }

  getStatistics() {
    return {
      totalSpawned: this.totalSpawned,
      alive: this.aliveCount,
      killed: this.killed,
      bossDefeated: this.bossSpawned && this.boss && !this.boss.alive,
    };
  }
}

export { resetEnemyIds };
