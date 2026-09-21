/**
 * Enemy AI.
 *
 * One explicit state machine drives every archetype; the archetype only changes
 * the *parameters* and the attack payload. That keeps behaviour predictable,
 * debuggable and cheap to run for dozens of agents.
 *
 *   IDLE -> PATROL -> ALERT -> CHASE -> (STRAFE | TELEGRAPH) -> ATTACK -> RECOVER -> CHASE
 *
 * Design rules enforced here:
 *  - Every attack has a visible telegraph (callback `onTelegraph`).
 *  - Enemies never attack through walls (line of sight is required).
 *  - Melee enemies commit: the hit lands at the *end* of the wind-up, so the
 *    player can always dodge it.
 */

import { TAU, clamp, dist2, angleTo, rotateToward } from '../core/math.js';
import { BOSS, ENEMY_STATES, ELITE_ABILITY } from '../config/enemies.js';
import { TEAM } from '../weapons/projectile.js';

const LOS_INTERVAL = 0.14;

/**
 * @typedef {Object} AIContext
 * @property {import('../player/player.js').Player} player
 * @property {import('../world/tilemap.js').TileMap} map
 * @property {import('../world/world.js').WorldRuntime} world
 * @property {import('../core/rng.js').Rng} rng
 * @property {{damageMul:number}} difficulty
 */

export function updateEnemyAI(enemy, dt, ctx) {
  if (!enemy.alive) return;
  if (enemy.isBoss) {
    updateBossAI(enemy, dt, ctx);
    return;
  }
  const { player } = ctx;
  const distance = Math.sqrt(dist2(enemy.x, enemy.y, player.x, player.y));

  // Shared timers.
  if (enemy.staggerTimer > 0) {
    enemy.staggerTimer -= dt;
    if (enemy.staggerTimer <= 0 && enemy.state === ENEMY_STATES.STAGGER) {
      enemy.setState(ENEMY_STATES.CHASE);
    }
  }
  enemy.losTimer = (enemy.losTimer ?? 0) - dt;
  if (enemy.losTimer <= 0) {
    enemy.losTimer = LOS_INTERVAL;
    enemy.hasLos = ctx.map.hasLineOfSight(enemy.x, enemy.y, player.x, player.y);
  }
  const hasLos = enemy.hasLos !== false;

  if (enemy.spawnGrace > 0) return;

  // Awareness.
  if (!enemy.alerted) {
    if (player.alive && (enemy.canSee(player) || enemy.hitFlash > 0)) {
      enemy.alertTo(player.x, player.y);
      enemy.setState(ENEMY_STATES.ALERT);
      if (ctx.onAlert) ctx.onAlert(enemy);
    } else {
      updatePatrol(enemy, dt, ctx);
      return;
    }
  } else if (player.alive) {
    if (distance < enemy.aggroRange * 1.6 || hasLos) {
      enemy.lastKnownPlayer.x = player.x;
      enemy.lastKnownPlayer.y = player.y;
      enemy.searchTimer = 3.2;
    }
  }

  if (!player.alive) {
    enemy.setState(ENEMY_STATES.PATROL);
    enemy.alerted = false;
    return;
  }

  switch (enemy.state) {
    case ENEMY_STATES.ALERT:
      if (enemy.stateTime > 0.22) enemy.setState(ENEMY_STATES.CHASE);
      break;
    case ENEMY_STATES.STAGGER:
      enemy.vx = 0;
      enemy.vy = 0;
      break;
    case ENEMY_STATES.TELEGRAPH:
      updateTelegraph(enemy, dt, ctx, distance);
      break;
    case ENEMY_STATES.ATTACK:
      updateAttackState(enemy, dt, ctx, distance);
      break;
    case ENEMY_STATES.RECOVER:
      enemy.vx *= 0.85;
      enemy.vy *= 0.85;
      if (enemy.stateTime >= enemy.recoverTime) {
        enemy.attackCooldown = enemy.attackCooldownTime;
        enemy.setState(ENEMY_STATES.CHASE);
      }
      break;
    case ENEMY_STATES.STRAFE:
      updateStrafe(enemy, dt, ctx, distance, hasLos);
      break;
    case ENEMY_STATES.IDLE:
    case ENEMY_STATES.PATROL:
    case ENEMY_STATES.CHASE:
    default:
      updateChase(enemy, dt, ctx, distance, hasLos);
      break;
  }
}

function updatePatrol(enemy, dt, ctx) {
  enemy.setState(ENEMY_STATES.PATROL);
  enemy.idleTimer = (enemy.idleTimer ?? 0) - dt;
  if (!enemy.patrolTarget || enemy.idleTimer <= 0 || dist2(enemy.x, enemy.y, enemy.patrolTarget.x, enemy.patrolTarget.y) < 900) {
    if (!enemy.patrolHome) enemy.patrolHome = { x: enemy.x, y: enemy.y };
    const angle = ctx.rng ? ctx.rng.angle() : enemy.animTime;
    const radius = 90 + (ctx.rng ? ctx.rng.float(0, 130) : 100);
    enemy.patrolTarget = {
      x: enemy.patrolHome.x + Math.cos(angle) * radius,
      y: enemy.patrolHome.y + Math.sin(angle) * radius,
    };
    enemy.idleTimer = 1.4 + (ctx.rng ? ctx.rng.float(0, 2.2) : 1);
  }
  steerTo(enemy, dt, ctx, enemy.patrolTarget.x, enemy.patrolTarget.y, enemy.baseSpeed * 0.32);
}

function updateChase(enemy, dt, ctx, distance, hasLos) {
  const role = enemy.def.role;
  const { player } = ctx;

  if (role === 'ranged') {
    const preferred = enemy.def.preferredRange ?? enemy.attackRange * 0.7;
    if (hasLos && distance <= enemy.attackRange && enemy.attackCooldown <= 0) {
      beginTelegraph(enemy, ctx, 'ranged');
      return;
    }
    if (distance > preferred * 1.15 || !hasLos) {
      steerTo(enemy, dt, ctx, player.x, player.y, enemy.baseSpeed);
    } else if (distance < preferred * 0.7) {
      const away = angleTo(player.x, player.y, enemy.x, enemy.y);
      steerTo(enemy, dt, ctx, enemy.x + Math.cos(away) * 200, enemy.y + Math.sin(away) * 200, enemy.baseSpeed * 0.9);
    } else {
      enemy.setState(ENEMY_STATES.STRAFE);
    }
    return;
  }

  if (role === 'heavy') {
    const inRange = distance <= enemy.attackRange + player.radius;
    if (inRange && hasLos && enemy.attackCooldown <= 0) {
      beginTelegraph(enemy, ctx, 'heavy');
      return;
    }
    steerTo(enemy, dt, ctx, player.x, player.y, enemy.baseSpeed);
    return;
  }

  if (role === 'charger') {
    const inRange = distance <= enemy.def.attackRange + player.radius + 90;
    if (inRange && hasLos && enemy.attackCooldown <= 0) {
      beginTelegraph(enemy, ctx, 'charger');
      return;
    }
    steerTo(enemy, dt, ctx, player.x, player.y, enemy.baseSpeed);
    return;
  }

  // Melee default.
  const inRange = distance <= enemy.attackRange + player.radius;
  if (inRange && hasLos && enemy.attackCooldown <= 0) {
    beginTelegraph(enemy, ctx, 'melee');
    return;
  }
  if (!hasLos && distance < 500) {
    steerTo(enemy, dt, ctx, player.x, player.y, enemy.baseSpeed);
  } else if (hasLos) {
    enemy.path.length = 0;
    const dir = normalize(player.x - enemy.x, player.y - enemy.y);
    applyVelocity(enemy, dir.x * enemy.baseSpeed, dir.y * enemy.baseSpeed);
  } else {
    steerTo(enemy, dt, ctx, enemy.lastKnownPlayer.x, enemy.lastKnownPlayer.y, enemy.baseSpeed);
  }
}

function updateStrafe(enemy, dt, ctx, distance, hasLos) {
  const { player } = ctx;
  const preferred = enemy.def.preferredRange ?? 260;
  if (distance <= enemy.attackRange && hasLos && enemy.attackCooldown <= 0) {
    beginTelegraph(enemy, ctx, 'ranged');
    return;
  }
  if (enemy.strafeTimer <= 0) {
    enemy.strafeTimer = 0.8 + (ctx.rng ? ctx.rng.float(0, 0.9) : 0.5);
    if (ctx.rng && ctx.rng.bool(0.4)) enemy.strafeDir *= -1;
  }
  const toPlayer = angleTo(enemy.x, enemy.y, player.x, player.y);
  const orbit = toPlayer + (Math.PI / 2) * enemy.strafeDir;
  const radialError = (distance - preferred) * 0.006;
  const targetX = enemy.x + Math.cos(orbit) * 120 + Math.cos(toPlayer) * radialError * 120;
  const targetY = enemy.y + Math.sin(orbit) * 120 + Math.sin(toPlayer) * radialError * 120;
  steerTo(enemy, dt, ctx, targetX, targetY, enemy.baseSpeed * 0.85);
}

function beginTelegraph(enemy, ctx, kind) {
  enemy.telegraphKind = kind;
  enemy.attackWindup = enemy.telegraphTime * (kind === 'heavy' ? 1.15 : 1);
  enemy.telegraphAngle = angleTo(enemy.x, enemy.y, ctx.player.x, ctx.player.y);
  enemy.setState(ENEMY_STATES.TELEGRAPH);
  if (enemy.elite && !enemy.eliteUsed && ctx.rng && ctx.rng.bool(0.3)) {
    enemy.eliteUsed = true;
    if (enemy.elite.ability === ELITE_ABILITY.SHIELD) {
      enemy.addShield(Math.round(enemy.maxHealth * 0.35));
      if (ctx.onEliteAbility) ctx.onEliteAbility(enemy, 'shield');
    }
  }
  if (ctx.onTelegraph) ctx.onTelegraph(enemy, kind);
}

function updateTelegraph(enemy, dt, ctx, distance) {
  const { player } = ctx;
  enemy.vx *= 0.82;
  enemy.vy *= 0.82;
  enemy.attackWindup -= dt;
  // Track the player slowly so the player can still dodge by moving.
  const trackSpeed = enemy.def.role === 'heavy' ? 2.2 : enemy.def.role === 'charger' ? 4.5 : 3.2;
  enemy.telegraphAngle = rotateToward(
    enemy.telegraphAngle ?? angleTo(enemy.x, enemy.y, player.x, player.y),
    angleTo(enemy.x, enemy.y, player.x, player.y),
    trackSpeed * dt,
  );
  if (enemy.attackWindup > 0) return;

  executeAttack(enemy, ctx, distance);
  enemy.setState(ENEMY_STATES.ATTACK);
}

function updateAttackState(enemy, dt, ctx, distance) {
  void dt;
  void distance;
  // Attack recovery is handled in the RECOVER state; ATTACK is a one-frame
  // marker that also covers the lunge window for chargers.
  if (enemy.lungeTimer > 0) return;
  enemy.setState(ENEMY_STATES.RECOVER);
  void ctx;
}

function executeAttack(enemy, ctx, distance) {
  const { player } = ctx;
  switch (enemy.def.role) {
    case 'ranged': {
      const def = enemy.def;
      const count = def.projectiles ?? 1;
      const spread = def.spreadAngle ?? 0;
      const baseAngle = enemy.telegraphAngle ?? angleTo(enemy.x, enemy.y, player.x, player.y);
      const muzzleX = enemy.x + Math.cos(baseAngle) * (enemy.radius + 6);
      const muzzleY = enemy.y + Math.sin(baseAngle) * (enemy.radius + 6);
      for (let i = 0; i < count; i += 1) {
        const offset = count === 1 ? 0 : (i / (count - 1) - 0.5) * spread;
        const angle = baseAngle + offset;
        ctx.spawnProjectile({
          x: muzzleX,
          y: muzzleY,
          vx: Math.cos(angle) * enemy.projectileSpeed,
          vy: Math.sin(angle) * enemy.projectileSpeed,
          damage: enemy.baseDamage,
          radius: def.areaDamage ? 6 : 4,
          life: (enemy.attackRange * 1.6) / enemy.projectileSpeed,
          team: TEAM.HOSTILE,
          color: enemy.accent,
          width: 2.2,
          areaRadius: def.areaDamage ? 54 : 0,
          areaDamage: def.areaDamage ? enemy.baseDamage * 0.7 : 0,
          areaColor: enemy.accent,
          glow: 1.4,
        });
      }
      if (ctx.onAttack) ctx.onAttack(enemy, 'ranged', { x: muzzleX, y: muzzleY, angle: baseAngle });
      break;
    }
    case 'charger': {
      const angle = enemy.telegraphAngle ?? angleTo(enemy.x, enemy.y, player.x, player.y);
      enemy.lungeDirX = Math.cos(angle);
      enemy.lungeDirY = Math.sin(angle);
      enemy.lungeSpeed = enemy.baseSpeed * 3.6;
      enemy.lungeTimer = 0.34;
      enemy.lungeHitDone = false;
      if (ctx.onAttack) ctx.onAttack(enemy, 'charger', { x: enemy.x, y: enemy.y, angle });
      break;
    }
    case 'heavy': {
      const reach = enemy.attackRange + player.radius + 18;
      const angle = enemy.telegraphAngle ?? angleTo(enemy.x, enemy.y, player.x, player.y);
      const angleDiff = Math.abs(angleDelta(angleTo(enemy.x, enemy.y, player.x, player.y), angle));
      if (distance <= reach && angleDiff < 1.2) {
        ctx.damagePlayer(enemy.baseDamage, { source: enemy, kind: 'melee' });
        if (ctx.onAttack) ctx.onAttack(enemy, 'heavyHit', { x: player.x, y: player.y, angle });
      } else {
        if (ctx.onAttack) ctx.onAttack(enemy, 'heavyMiss', { x: enemy.x, y: enemy.y, angle });
      }
      enemy.lungeDirX = Math.cos(angle);
      enemy.lungeDirY = Math.sin(angle);
      enemy.lungeSpeed = enemy.baseSpeed * 2.4;
      enemy.lungeTimer = 0.2;
      break;
    }
    case 'melee':
    default: {
      const reach = enemy.attackRange + player.radius + 10;
      if (distance <= reach) {
        ctx.damagePlayer(enemy.baseDamage, { source: enemy, kind: 'melee' });
        if (ctx.onAttack) ctx.onAttack(enemy, 'meleeHit', { x: player.x, y: player.y });
      } else if (ctx.onAttack) {
        ctx.onAttack(enemy, 'meleeMiss', { x: enemy.x, y: enemy.y });
      }
      break;
    }
  }
}

/** Contact damage during a charger lunge. */
export function updateEnemyContact(enemy, dt, ctx) {
  if (!enemy.alive || enemy.isBoss) return;
  if (enemy.def.role !== 'charger') return;
  if (enemy.lungeTimer <= 0 || enemy.lungeHitDone) return;
  const { player } = ctx;
  const rr = enemy.radius + player.radius + 4;
  if (dist2(enemy.x, enemy.y, player.x, player.y) <= rr * rr) {
    enemy.lungeHitDone = true;
    ctx.damagePlayer(enemy.baseDamage, { source: enemy, kind: 'melee' });
    if (ctx.onAttack) ctx.onAttack(enemy, 'meleeHit', { x: player.x, y: player.y });
  }
  void dt;
}

// ---------------------------------------------------------------------------
// Boss
// ---------------------------------------------------------------------------

function updateBossAI(boss, dt, ctx) {
  const { player } = ctx;
  boss.introTimer = Math.max(0, boss.introTimer - dt);
  if (boss.introTimer > 0) {
    boss.vx = 0;
    boss.vy = 0;
    return;
  }
  boss.losTimer = (boss.losTimer ?? 0) - dt;
  if (boss.losTimer <= 0) {
    boss.losTimer = LOS_INTERVAL;
    boss.hasLos = ctx.map.hasLineOfSight(boss.x, boss.y, player.x, player.y);
  }
  const distance = Math.sqrt(dist2(boss.x, boss.y, player.x, player.y));
  const hasLos = boss.hasLos !== false;

  if (!boss.alerted) {
    boss.alerted = true;
    if (ctx.onBossAlert) ctx.onBossAlert(boss);
  }
  if (!player.alive) {
    boss.vx *= 0.9;
    boss.vy *= 0.9;
    return;
  }

  if (boss.updatePhase()) {
    if (ctx.onBossPhase) ctx.onBossPhase(boss, boss.phaseName);
    boss.attackTimer = 0.7;
  }

  switch (boss.state) {
    case ENEMY_STATES.TELEGRAPH: {
      boss.vx *= 0.8;
      boss.vy *= 0.8;
      boss.attackWindup -= dt;
      if (boss.pendingAttack && boss.pendingAttack.track !== false) {
        boss.telegraphAngle = rotateToward(
          boss.telegraphAngle ?? 0,
          angleTo(boss.x, boss.y, player.x, player.y),
          2.4 * dt,
        );
      }
      if (boss.attackWindup <= 0) {
        executeBossAttack(boss, ctx);
        boss.setState(ENEMY_STATES.RECOVER);
        boss.recoverTimer = boss.pendingAttack?.recover ?? 0.6;
      }
      break;
    }
    case ENEMY_STATES.RECOVER: {
      boss.vx *= 0.9;
      boss.vy *= 0.9;
      boss.recoverTimer -= dt;
      if (boss.recoverTimer <= 0) {
        boss.setState(ENEMY_STATES.CHASE);
        boss.attackTimer = 0.35 + (ctx.rng ? ctx.rng.float(0, 0.4) : 0.2);
      }
      break;
    }
    case ENEMY_STATES.STAGGER:
      boss.vx = 0;
      boss.vy = 0;
      break;
    default: {
      const phase = boss.currentPhase;
      const speed = boss.baseSpeed * (phase.speedMul ?? 1);
      boss.attackTimer -= dt;
      boss.summonTimer -= dt;
      if (hasLos && distance <= boss.attackRange + player.radius + 24 && boss.attackTimer <= 0) {
        beginBossAttack(boss, ctx, 'slam');
        return;
      }
      if (boss.attackTimer <= 0) {
        const options = phase.attacks.filter((a) => a !== 'summon' || boss.summonTimer <= 0);
        const choice = ctx.rng
          ? ctx.rng.pick(options.length > 0 ? options : phase.attacks)
          : options[0] ?? 'burst';
        beginBossAttack(boss, ctx, choice);
        return;
      }
      if (distance > boss.attackRange * 0.8 || !hasLos) {
        steerTo(boss, dt, ctx, player.x, player.y, speed);
      } else {
        const orbit = angleTo(boss.x, boss.y, player.x, player.y) + Math.PI / 2;
        steerTo(boss, dt, ctx, boss.x + Math.cos(orbit) * 140, boss.y + Math.sin(orbit) * 140, speed * 0.7);
      }
      boss.setState(ENEMY_STATES.CHASE);
      break;
    }
  }
}

function beginBossAttack(boss, ctx, kind) {
  const phase = boss.currentPhase;
  let spec;
  switch (kind) {
    case 'slam':
      spec = { kind, telegraph: BOSS.slam.telegraph, recover: BOSS.slam.recover, track: true };
      break;
    case 'burst':
      spec = { kind, telegraph: BOSS.burst.telegraph, recover: BOSS.burst.recover, track: true };
      break;
    case 'sweep':
      spec = { kind, telegraph: BOSS.sweep.telegraph, recover: BOSS.sweep.recover, track: true };
      break;
    case 'summon':
      spec = { kind, telegraph: BOSS.summon.telegraph, recover: BOSS.summon.recover, track: false };
      boss.summonTimer = 11;
      break;
    default:
      throw new Error(`Unknown boss attack "${kind}"`);
  }
  boss.pendingAttack = spec;
  boss.telegraphAngle = angleTo(boss.x, boss.y, ctx.player.x, ctx.player.y);
  boss.attackWindup = spec.telegraph;
  boss.setState(ENEMY_STATES.TELEGRAPH);
  void phase;
  if (ctx.onBossTelegraph) ctx.onBossTelegraph(boss, kind, spec.telegraph);
}

function executeBossAttack(boss, ctx) {
  const spec = boss.pendingAttack;
  if (!spec) {
    boss.setState(ENEMY_STATES.CHASE);
    return;
  }
  const { player } = ctx;
  const angle = boss.telegraphAngle ?? angleTo(boss.x, boss.y, player.x, player.y);

  switch (spec.kind) {
    case 'slam': {
      const radius = BOSS.slam.radius;
      if (ctx.onBossSlam) ctx.onBossSlam(boss, radius);
      if (dist2(boss.x, boss.y, player.x, player.y) <= (radius + player.radius) ** 2) {
        ctx.damagePlayer(boss.baseDamage * 1.35, { source: boss, kind: 'slam', bypassArmor: false });
      }
      boss.lungeDirX = Math.cos(angle);
      boss.lungeDirY = Math.sin(angle);
      boss.lungeSpeed = boss.baseSpeed * 3;
      boss.lungeTimer = 0.22;
      break;
    }
    case 'burst': {
      const { projectiles, speed, damage } = BOSS.burst;
      for (let i = 0; i < projectiles; i += 1) {
        const a = angle + (i / projectiles) * TAU;
        ctx.spawnProjectile({
          x: boss.x + Math.cos(a) * (boss.radius + 8),
          y: boss.y + Math.sin(a) * (boss.radius + 8),
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          damage: damage * ctx.difficulty.damageMul,
          radius: 6,
          life: 2.6,
          team: TEAM.HOSTILE,
          color: BOSS.accent,
          width: 3,
          glow: 1.6,
        });
      }
      if (ctx.onBossBurst) ctx.onBossBurst(boss, projectiles);
      break;
    }
    case 'sweep': {
      const { projectiles, speed, damage, spread } = BOSS.sweep;
      for (let i = 0; i < projectiles; i += 1) {
        const a = angle + (i / (projectiles - 1) - 0.5) * spread;
        ctx.spawnProjectile({
          x: boss.x + Math.cos(a) * (boss.radius + 8),
          y: boss.y + Math.sin(a) * (boss.radius + 8),
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed,
          damage: damage * ctx.difficulty.damageMul,
          radius: 5,
          life: 2.2,
          team: TEAM.HOSTILE,
          color: '#ffd166',
          width: 2.6,
          glow: 1.4,
        });
      }
      if (ctx.onBossBurst) ctx.onBossBurst(boss, projectiles);
      break;
    }
    case 'summon': {
      if (ctx.onBossSummon) ctx.onBossSummon(boss, BOSS.summon.types, BOSS.summon.count);
      break;
    }
    default:
      throw new Error(`Unknown boss attack "${spec.kind}"`);
  }
  boss.pendingAttack = null;
}

// ---------------------------------------------------------------------------
// Steering helpers
// ---------------------------------------------------------------------------

function steerTo(enemy, dt, ctx, targetX, targetY, speed) {
  const { map } = ctx;
  const direct = map.hasLineOfSight(enemy.x, enemy.y, targetX, targetY);
  let dirX = 0;
  let dirY = 0;
  if (direct) {
    enemy.path.length = 0;
    const n = normalize(targetX - enemy.x, targetY - enemy.y);
    dirX = n.x;
    dirY = n.y;
  } else {
    enemy.repathToward(map, targetX, targetY);
    const steer = enemy.followPath();
    dirX = steer.x;
    dirY = steer.y;
    if (steer.done) {
      const n = normalize(targetX - enemy.x, targetY - enemy.y);
      dirX = n.x;
      dirY = n.y;
    }
  }
  applyVelocity(enemy, dirX * speed, dirY * speed);
  void dt;
}

function applyVelocity(enemy, vx, vy) {
  // Instant steering with a light inertia so movement does not look robotic.
  enemy.vx = enemy.vx * 0.35 + vx * 0.65;
  enemy.vy = enemy.vy * 0.35 + vy * 0.65;
}

function normalize(x, y) {
  const len = Math.hypot(x, y);
  if (len < 1e-6) return { x: 0, y: 0 };
  return { x: x / len, y: y / len };
}

function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Separation pass so a pack of enemies does not collapse into one blob. */
export function separateEnemies(enemies, dt) {
  for (let i = 0; i < enemies.length; i += 1) {
    const a = enemies[i];
    if (!a.alive || a.isBoss) continue;
    for (let j = i + 1; j < enemies.length; j += 1) {
      const b = enemies[j];
      if (!b.alive) continue;
      const minDist = a.radius + b.radius;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > minDist * minDist || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const push = ((minDist - d) / d) * 0.5;
      const weightA = b.isBoss ? 1 : 0.5;
      const weightB = a.isBoss ? 1 : 0.5;
      a.x -= dx * push * weightA * clamp(dt * 60, 0, 1);
      a.y -= dy * push * weightA * clamp(dt * 60, 0, 1);
      b.x += dx * push * weightB * clamp(dt * 60, 0, 1);
      b.y += dy * push * weightB * clamp(dt * 60, 0, 1);
    }
  }
}

export { ENEMY_STATES };
