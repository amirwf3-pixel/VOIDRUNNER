/**
 * Enemy entity. Holds stats, state machine bookkeeping, movement integration
 * and damage intake. Behaviour lives in `ai.js` so this file stays a data +
 * physics container.
 */

import { clamp, dist2, damp } from '../core/math.js';
import { BOSS, ENEMY_STATES, ELITE_MODIFIERS, getEnemyDef } from '../config/enemies.js';

let nextEnemyId = 1;

export function resetEnemyIds() {
  nextEnemyId = 1;
}

export class Enemy {
  /**
   * @param {Object} spec
   * @param {string} spec.typeId
   * @param {number} spec.x
   * @param {number} spec.y
   * @param {string|null} [spec.elite]
   * @param {number} [spec.tier]
   * @param {{healthMul:number,damageMul:number,speedMul:number,bossHealthMul:number,xpMul:number}} [spec.difficulty]
   */
  constructor(spec) {
    const def = spec.isBoss ? { ...BOSS, role: 'boss', attackRange: BOSS.attackRange } : getEnemyDef(spec.typeId);
    this.def = def;
    this.typeId = spec.isBoss ? 'boss' : spec.typeId;
    this.isBoss = Boolean(spec.isBoss);
    this.isElite = Boolean(spec.elite) && !this.isBoss;
    this.eliteKey = this.isElite ? spec.elite : null;
    this.elite = this.isElite ? ELITE_MODIFIERS[spec.elite] ?? ELITE_MODIFIERS.elite : null;
    this.id = nextEnemyId;
    nextEnemyId += 1;

    const difficulty = spec.difficulty ?? { healthMul: 1, damageMul: 1, speedMul: 1, bossHealthMul: 1, xpMul: 1 };
    const eliteHealth = this.elite?.healthMul ?? 1;
    const eliteDamage = this.elite?.damageMul ?? 1;
    const eliteSpeed = this.elite?.speedMul ?? 1;

    this.maxHealth = Math.round(def.health * difficulty.healthMul * eliteHealth);
    this.health = this.maxHealth;
    this.shield = 0;
    this.maxShield = 0;
    this.armor = def.armor + (this.elite?.armorAdd ?? 0);
    this.baseDamage = def.damage * difficulty.damageMul * eliteDamage;
    this.baseSpeed = def.speed * difficulty.speedMul * eliteSpeed;
    this.radius = def.radius * (this.elite?.scale ?? 1);
    this.attackRange = def.attackRange;
    this.telegraphTime = def.telegraph;
    this.recoverTime = def.recover;
    this.attackCooldownTime = def.cooldown;
    this.projectileSpeed = def.projectileSpeed ?? 600;
    this.xpValue = Math.round(def.xp * difficulty.xpMul * (this.elite?.xpMul ?? 1) * (this.isBoss ? 1 : 1));
    this.scoreValue = Math.round(def.score * (this.elite?.scoreMul ?? 1));

    this.x = spec.x;
    this.y = spec.y;
    this.vx = 0;
    this.vy = 0;
    this.heading = 0;
    this.state = ENEMY_STATES.IDLE;
    this.stateTime = 0;
    this.alive = true;
    this.alerted = !spec.dormant;
    this.aggroRange = this.isBoss ? 1400 : 520;
    this.loseAggroRange = this.isBoss ? 2600 : 900;
    this.attackCooldown = 0;
    this.attackWindup = 0;
    this.recoverTimer = 0;
    this.staggerTimer = 0;
    this.hitFlash = 0;
    this.deathTimer = 0;
    this.knockbackX = 0;
    this.knockbackY = 0;
    this.path = [];
    this.pathIndex = 0;
    this.repathTimer = 0;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeTimer = 0;
    this.shieldTimer = 0;
    this.lastKnownPlayer = { x: spec.x, y: spec.y };
    this.searchTimer = 0;
    this.attackVariant = 0;
    this.animTime = Math.random() * 10;
    this.contactCooldown = 0;
    this.spawnGrace = 0.35;
    this.lungeTimer = 0;
    this.lungeDirX = 0;
    this.lungeDirY = 0;
    this.lungeSpeed = 0;
    this.summonTimer = 6;
    this.phaseIndex = 0;
    this.phaseName = this.isBoss ? BOSS.phases[0].name : null;
    this.telegraphKind = null;
    this.deathCause = null;
  }

  get healthRatio() {
    return this.maxHealth > 0 ? clamp(this.health / this.maxHealth, 0, 1) : 0;
  }

  get totalHealthRatio() {
    const total = this.maxHealth + this.maxShield;
    if (total <= 0) return 0;
    return clamp((this.health + this.shield) / total, 0, 1);
  }

  get displayName() {
    if (this.isBoss) return BOSS.name;
    const base = this.def.name;
    return this.isElite ? `${this.elite.name} ${base}` : base;
  }

  get color() {
    return this.def.color;
  }

  get accent() {
    return this.def.accent ?? '#ffffff';
  }

  /** True while the enemy is mid attack animation/telegraph. */
  get isAttacking() {
    return this.state === ENEMY_STATES.TELEGRAPH || this.state === ENEMY_STATES.ATTACK;
  }

  canSee(player) {
    const range = this.aggroRange;
    if (dist2(this.x, this.y, player.x, player.y) > range * range) return false;
    return true;
  }

  setState(state, context = null) {
    if (this.state === state) return;
    this.state = state;
    this.stateTime = 0;
    if (context && context.onStateChange) context.onStateChange(this, state);
  }

  alertTo(x, y) {
    this.alerted = true;
    this.lastKnownPlayer.x = x;
    this.lastKnownPlayer.y = y;
  }

  /** Applies damage, returns a rich result so the caller can drive feedback. */
  takeDamage(amount, { crit = false, armorPierce = 0, knockback = 0, sourceX = null, sourceY = null, bypassShield = false } = {}) {
    if (!this.alive) return { applied: 0, died: false, absorbedByArmor: 0, absorbedByShield: 0 };
    const raw = Math.max(0, amount);
    const effectiveArmor = Math.max(0, this.armor - armorPierce);
    const afterArmor = Math.max(1, raw - effectiveArmor);
    const absorbedByArmor = raw - afterArmor;
    let absorbedByShield = 0;
    let remaining = afterArmor;
    if (this.shield > 0 && !bypassShield) {
      absorbedByShield = Math.min(this.shield, remaining);
      this.shield -= absorbedByShield;
      remaining -= absorbedByShield;
    }
    this.health -= remaining;
    this.hitFlash = 1;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.deathTimer = 0;
      this.setState(ENEMY_STATES.DEAD);
      return { applied: remaining, died: true, absorbedByArmor, absorbedByShield, crit };
    }
    // Stagger on heavy single hits; elites and the boss resist it.
    const staggerThreshold = this.maxHealth * (this.isBoss ? 0.2 : this.isElite ? 0.18 : 0.1);
    if (!this.isBoss && remaining >= staggerThreshold && this.state !== ENEMY_STATES.TELEGRAPH) {
      this.staggerTimer = this.isElite ? 0.12 : 0.2;
      this.setState(ENEMY_STATES.STAGGER);
    }
    if (knockback > 0 && !this.isBoss) {
      const dx = sourceX === null ? 0 : this.x - sourceX;
      const dy = sourceY === null ? 0 : this.y - sourceY;
      const len = Math.hypot(dx, dy) || 1;
      const resist = this.isElite ? 0.55 : 1;
      this.knockbackX += (dx / len) * knockback * resist;
      this.knockbackY += (dy / len) * knockback * resist;
    }
    return { applied: remaining, died: false, absorbedByArmor, absorbedByShield, crit };
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  addShield(amount) {
    this.maxShield = Math.max(this.maxShield, amount);
    this.shield = Math.min(this.maxShield, this.shield + amount);
  }

  /** Physics + timers. AI decides velocities; this integrates them. */
  integrate(dt, map, world) {
    this.stateTime += dt;
    this.animTime += dt;
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt * 5);
    if (this.attackCooldown > 0) this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    if (this.contactCooldown > 0) this.contactCooldown = Math.max(0, this.contactCooldown - dt);
    if (this.spawnGrace > 0) this.spawnGrace = Math.max(0, this.spawnGrace - dt);
    if (this.repathTimer > 0) this.repathTimer = Math.max(0, this.repathTimer - dt);
    if (this.strafeTimer > 0) this.strafeTimer = Math.max(0, this.strafeTimer - dt);
    if (this.searchTimer > 0) this.searchTimer = Math.max(0, this.searchTimer - dt);

    if (!this.alive) {
      this.vx = damp(this.vx, 0, 0.0001, dt);
      this.vy = damp(this.vy, 0, 0.0001, dt);
      return;
    }

    if (this.lungeTimer > 0) {
      this.lungeTimer -= dt;
      this.x += this.lungeDirX * this.lungeSpeed * dt;
      this.y += this.lungeDirY * this.lungeSpeed * dt;
    }

    // Knockback decays fast and is applied on top of steering.
    this.knockbackX = damp(this.knockbackX, 0, 0.0004, dt);
    this.knockbackY = damp(this.knockbackY, 0, 0.0004, dt);

    this.x += (this.vx + this.knockbackX) * dt;
    this.y += (this.vy + this.knockbackY) * dt;

    map.resolveCircle(this);
    if (world) world.resolveProps(this);

    if (this.vx !== 0 || this.vy !== 0) {
      const target = Math.atan2(this.vy, this.vx);
      this.heading = target;
    }
  }

  /** Repath toward a world point, respecting hostile path budget. */
  repathToward(map, x, y, { force = false } = {}) {
    if (!force && this.repathTimer > 0) return;
    this.repathTimer = this.isBoss ? 0.5 : 0.55 + Math.random() * 0.25;
    this.path = map.findPath(this.x, this.y, x, y, { maxNodes: this.isBoss ? 2500 : 1600 });
    this.pathIndex = 0;
  }

  /** Follows the current path; returns a normalised steering direction. */
  followPath() {
    if (this.path.length === 0) return { x: 0, y: 0, done: true };
    const node = this.path[this.pathIndex];
    if (!node) return { x: 0, y: 0, done: true };
    const dx = node.x - this.x;
    const dy = node.y - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 18) {
      this.pathIndex += 1;
      if (this.pathIndex >= this.path.length) {
        this.path = [];
        this.pathIndex = 0;
        return { x: 0, y: 0, done: true };
      }
      return this.followPath();
    }
    return { x: dx / dist, y: dy / dist, done: false };
  }

  serialize() {
    return {
      typeId: this.typeId,
      elite: this.eliteKey,
      x: Math.round(this.x),
      y: Math.round(this.y),
      health: Math.round(this.health),
      state: this.state,
      alerted: this.alerted,
    };
  }
}

/** Boss subclass: adds phases, a shield window and telegraphed area attacks. */
export class BossEnemy extends Enemy {
  constructor(spec) {
    super({ ...spec, isBoss: true, typeId: 'boss' });
    const difficulty = spec.difficulty ?? { bossHealthMul: 1 };
    this.maxHealth = Math.round(BOSS.health * (difficulty.bossHealthMul ?? 1));
    this.health = this.maxHealth;
    this.xpValue = Math.round(BOSS.xp * (difficulty.xpMul ?? 1));
    this.scoreValue = BOSS.score;
    this.aggroRange = 2000;
    this.phaseIndex = 0;
    this.phaseName = BOSS.phases[0].name;
    this.attackTimer = 1.5;
    this.pendingAttack = null;
    this.summonTimer = 9;
    this.arenaCenter = { x: spec.x, y: spec.y };
    this.arenaRadius = spec.arenaRadius ?? 420;
    this.introTimer = 2.2;
    this.pendingPhaseChange = false;
  }

  get currentPhase() {
    const ratio = this.healthRatio;
    let phase = BOSS.phases[0];
    for (const candidate of BOSS.phases) {
      if (ratio <= candidate.at) phase = candidate;
    }
    return phase;
  }

  updatePhase() {
    const phase = this.currentPhase;
    const index = BOSS.phases.indexOf(phase);
    if (index > this.phaseIndex) {
      this.phaseIndex = index;
      this.phaseName = phase.name;
      this.pendingPhaseChange = true;
      return true;
    }
    return false;
  }
}

export { ENEMY_STATES };
