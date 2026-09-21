/**
 * Combat resolution: the single place where damage is computed and applied.
 *
 * Every projectile hit, melee swing, explosion and hazard routes through here,
 * which guarantees consistent crit/falloff/armor math, consistent feedback
 * (particles, numbers, shake, audio) and consistent reward (XP, loot, score).
 */

import { TAU, clamp, dist2, lerp } from '../core/math.js';
import { gaussian } from '../core/math.js';
import { TEAM, queryRadius } from '../weapons/projectile.js';
import { WEAPON_TIER_COLORS } from '../config/weapons.js';
import { SFX } from '../audio/audio.js';
import { RARITY_COLORS } from '../config/balance.js';
import { PLAYER_BASE } from '../config/balance.js';

export class CombatSystem {
  /**
   * @param {Object} ctx run context (see `src/game/run.js`)
   */
  constructor(ctx) {
    this.ctx = ctx;
  }

  get run() {
    return this.ctx;
  }

  // -------------------------------------------------------------------------
  // Player offence
  // -------------------------------------------------------------------------

  /**
   * Attempts to fire the active weapon.
   * @param {boolean} triggerHeld
   * @param {boolean} triggerPressed
   */
  updatePlayerWeapon(triggerHeld, triggerPressed) {
    const run = this.ctx;
    const player = run.player;
    const weapon = player.weapon;
    if (!weapon || !player.alive) return;

    const wantsFire = weapon.def.automatic ? triggerHeld : triggerPressed;
    if (wantsFire) {
      const shot = weapon.tryFire({
        damageMul: player.damageMultiplier,
        reloadMul: player.reloadMul,
        random: () => run.rng.next(),
      });
      if (shot && shot.dry) {
        run.audio.play(SFX.DRYFIRE);
        run.floatingText.push(player.x, player.y - 26, 'EMPTY', { color: '#ff6b5c', size: 12 });
      } else if (shot) {
        this.fireShot(shot);
      }
    }

    // Auto-reload when the magazine empties and reserve exists.
    const autoReload = run.settings.gameplay.autoReload;
    if (
      autoReload &&
      weapon.isEmpty &&
      !weapon.isReloading &&
      player.ammo.get(weapon.def.ammo) > 0 &&
      weapon.dryFireCooldown <= 0.2
    ) {
      this.startReload();
    }
  }

  startReload() {
    const run = this.ctx;
    const player = run.player;
    const weapon = player.weapon;
    if (!weapon) return false;
    const started = weapon.beginReload(player.ammo.get(weapon.def.ammo), { reloadMul: player.reloadMul });
    if (started) {
      run.audio.play(SFX.RELOAD_START);
      run.events.emit('weapon:reloadStart', { weaponId: weapon.id });
    }
    return started;
  }

  completeReload() {
    const run = this.ctx;
    const player = run.player;
    const weapon = player.weapon;
    if (!weapon || !weapon.needsFinish) return;
    const type = weapon.def.ammo;
    const loaded = weapon.finishReload(player.ammo.get(type));
    if (loaded > 0) {
      player.ammo.take(type, loaded);
      player.stats.reloads += 1;
      run.audio.play(SFX.RELOAD_FINISH);
      run.floatingText.push(player.x, player.y - 30, `RELOADED`, { color: '#9fb3c8', size: 11 });
    } else {
      // Nothing left in reserve: surface it instead of silently doing nothing.
      run.audio.play(SFX.DRYFIRE);
      run.floatingText.push(player.x, player.y - 30, 'NO RESERVE AMMO', { color: '#ff6b5c', size: 11, life: 1 });
    }
  }

  /** Turns a shot descriptor into projectiles with spread and recoil. */
  fireShot(shot) {
    const run = this.ctx;
    const player = run.player;
    const def = shot.def;
    const rng = run.rng;

    const muzzleDistance = player.radius + 12;
    const baseAngle = player.aimAngle;
    const muzzleX = player.x + Math.cos(baseAngle) * muzzleDistance;
    const muzzleY = player.y + Math.sin(baseAngle) * muzzleDistance;

    for (let i = 0; i < shot.pellets; i += 1) {
      const spreadSample = shot.pellets > 1
        ? (rng.next() - 0.5) * shot.spread
        : gaussian(() => rng.next()) * shot.spread * 0.5;
      const angle = baseAngle + spreadSample;
      const speedJitter = 1 + (rng.next() - 0.5) * 0.06;
      run.projectiles.spawn({
        x: muzzleX,
        y: muzzleY,
        vx: Math.cos(angle) * def.bulletSpeed * speedJitter,
        vy: Math.sin(angle) * def.bulletSpeed * speedJitter,
        damage: shot.damage,
        radius: def.pellets > 4 ? 2.4 : 3,
        life: (def.range * 1.25) / def.bulletSpeed,
        team: TEAM.PLAYER,
        weaponId: def.id,
        color: def.color,
        pierce: def.pierce ?? 0,
        critical: shot.critical,
        width: def.tracerWidth,
        knockback: def.knockback ?? 0,
        chain: def.chain ?? 0,
        chainRange: def.chainRange ?? 0,
        chainDamageMul: def.chainDamageMul ?? 0.6,
        glow: 1.2,
      });
    }

    player.stats.shotsFired += 1;
    if (shot.critical) player.stats.shotsFired += 0;
    // Recoil: camera kick scaled by weapon and handling upgrades.
    const kick = def.recoil * player.recoilMul;
    run.camera.addKick(-Math.cos(baseAngle) * kick, -Math.sin(baseAngle) * kick);
    run.camera.addShake(def.recoil * 0.016 * player.recoilMul);

    // Muzzle flash.
    run.particles.spawnBurst('muzzle', muzzleX, muzzleY, def.pellets > 4 ? 8 : 4, {
      angle: baseAngle,
      spread: 0.7,
      speed: 210,
      life: 0.16,
      color: def.color,
      size: def.pellets > 4 ? 4 : 2.8,
      rng: () => rng.next(),
    });
    run.particles.spawn('smoke', muzzleX, muzzleY, {
      vx: Math.cos(baseAngle) * 30,
      vy: Math.sin(baseAngle) * 30,
      life: 0.5,
      size: 7,
      color: 'rgba(120,130,150,0.35)',
      additive: false,
      drag: 1.4,
    });

    run.audio.play(SFX_BY_WEAPON[def.id] ?? SFX.PISTOL, { rate: 0.95 + rng.next() * 0.1 });
    run.spawner.alertRadius(player.x, player.y, def.pellets > 4 ? 620 : 480);
    run.events.emit('weapon:fire', { weaponId: def.id, critical: shot.critical });
  }

  // -------------------------------------------------------------------------
  // Hit resolution
  // -------------------------------------------------------------------------

  /** Called by the projectile system for every entity hit. */
  onProjectileHit(hit) {
    const run = this.ctx;
    const { projectile } = hit;
    if (projectile.team === TEAM.PLAYER && hit.enemy) {
      this.damageEnemy(hit.enemy, projectile.damage, {
        crit: projectile.critical,
        weaponId: projectile.weaponId,
        sourceX: projectile.px,
        sourceY: projectile.py,
        knockback: projectile.knockback,
        hitX: projectile.x,
        hitY: projectile.y,
      });
      run.player.stats.shotsHit += 1;
    } else if (projectile.team === TEAM.HOSTILE && hit.player) {
      this.damagePlayer(projectile.damage, {
        source: projectile.sourceTag,
        kind: 'projectile',
        hitX: projectile.x,
        hitY: projectile.y,
      });
    }
  }

  onWallHit(hit) {    const run = this.ctx;
    const { projectile } = hit;
    run.particles.spawnBurst('spark', hit.x, hit.y, 4, {
      angle: Math.atan2(hit.ny, hit.nx),
      spread: 1.4,
      speed: 130,
      life: 0.28,
      color: projectile.color,
      size: 1.7,
      rng: () => run.rng.next(),
    });
    run.particles.spawn('smoke', hit.x, hit.y, {
      life: 0.35,
      size: 4,
      color: 'rgba(140,150,170,0.3)',
      additive: false,
    });
  }

  onPropHit(projectile, prop) {
    const run = this.ctx;
    if (!prop.destructible) {
      run.particles.spawnBurst('spark', projectile.x, projectile.y, 5, {
        angle: Math.atan2(projectile.vy, projectile.vx) + Math.PI,
        spread: 1.6,
        speed: 150,
        life: 0.3,
        color: '#cfe4ff',
        size: 1.8,
        rng: () => run.rng.next(),
      });
      return;
    }
    const result = run.world.damageProp(prop, projectile.damage);
    if (!result) return;
    if (result.destroyed) {
      this.onPropDestroyed(prop);
    } else {
      run.particles.spawnBurst('debris', prop.x, prop.y, 4, {
        speed: 120,
        life: 0.5,
        color: '#6b5a45',
        size: 2.2,
        rng: () => run.rng.next(),
      });
    }
  }

  onPropDestroyed(prop) {
    const run = this.ctx;
    run.particles.spawnBurst('debris', prop.x, prop.y, 14, {
      speed: 190,
      life: 0.7,
      color: '#7a6a52',
      size: 2.6,
      rng: () => run.rng.next(),
    });
    run.camera.addShake(0.12);
    run.audio.play(SFX.EXPLOSION, { volume: 0.35, rate: 1.4 });

    if (prop.explosive) {
      this.applyExplosion({
        x: prop.x,
        y: prop.y,
        radius: prop.blastRadius,
        damage: prop.blastDamage,
        team: TEAM.PLAYER,
        color: '#ffb03a',
        weaponId: 'barrel',
      });
    }
    if (prop.kind === 'crate' || prop.kind === 'console') {
      const count = run.rng.int(1, 3);
      for (let i = 0; i < count; i += 1) {
        const angle = run.rng.angle();
        run.loot.spawnDrop({
          kind: 'resource',
          key: run.rng.bool(0.55) ? 'scrap' : 'cells',
          amount: run.rng.int(2, 6),
          rarity: 'common',
          x: prop.x + Math.cos(angle) * 18,
          y: prop.y + Math.sin(angle) * 18,
          vx: Math.cos(angle) * 70,
          vy: Math.sin(angle) * 70,
          radius: 11,
        });
      }
    }
    if (prop.objectiveId) {
      run.events.emit('objective:propDestroyed', { objectiveId: prop.objectiveId, prop });
    }
  }

  onExplosion(spec) {
    this.applyExplosion({
      x: spec.x,
      y: spec.y,
      radius: spec.radius,
      damage: spec.damage,
      team: spec.team,
      color: spec.color,
      weaponId: spec.weaponId,
    });
  }

  /** Area damage + full visual treatment. Used by barrels, boss slams, AoE. */
  applyExplosion({ x, y, radius, damage, team, color = '#ffb03a', weaponId = null }) {
    const run = this.ctx;
    run.particles.spawnRing(x, y, radius, color, { life: 0.45 });
    run.particles.spawnBurst('ember', x, y, 22, {
      speed: radius * 2.2,
      life: 0.5,
      color,
      size: 2.4,
      rng: () => run.rng.next(),
    });
    run.particles.spawnBurst('smoke', x, y, 10, {
      speed: radius * 0.9,
      life: 0.8,
      color: 'rgba(70,70,80,0.5)',
      additive: false,
      size: 10,
      rng: () => run.rng.next(),
    });
    run.camera.addShake(0.35);
    run.audio.play(SFX.EXPLOSION, { volume: 0.6, rate: 0.9 + run.rng.next() * 0.2 });
    run.flash = Math.max(run.flash, 0.35);

    if (team === TEAM.PLAYER) {
      const hits = queryRadius(run.spawner.enemies, x, y, radius, (e) => e.alive);
      for (const enemy of hits) {
        const falloff = clamp(1 - Math.sqrt(dist2(x, y, enemy.x, enemy.y)) / radius, 0.25, 1);
        this.damageEnemy(enemy, damage * falloff, {
          crit: false,
          weaponId,
          sourceX: x,
          sourceY: y,
          knockback: 120 * falloff,
          hitX: enemy.x,
          hitY: enemy.y,
          explosive: true,
        });
      }
      // Barrels chain-react. Deferred into the run's explosion queue so the
      // simulation stays inside the fixed update order (no timers involved).
      for (const prop of run.world.props) {
        if (!prop.alive || !prop.explosive) continue;
        if (prop.x === x && prop.y === y) continue;
        if (dist2(prop.x, prop.y, x, y) <= radius * radius) {
          if (!prop.chainScheduled) {
            prop.chainScheduled = true;
            run.pendingExplosions.push({ prop, delay: 0.08 });
          }
        }
      }
    }

    const player = run.player;
    if (player.alive) {
      const d = Math.sqrt(dist2(x, y, player.x, player.y));
      const friendlyFire = team === TEAM.HOSTILE;
      if (friendlyFire && d <= radius + player.radius) {
        const falloff = clamp(1 - d / (radius + player.radius), 0.3, 1);
        this.damagePlayer(damage * falloff * 0.8, { kind: 'explosion', hitX: player.x, hitY: player.y });
      }
    }
  }

  onChain({ enemy, damage, color }) {
    this.damageEnemy(enemy, damage, { crit: false, weaponId: 'arcCaster', chain: true, hitX: enemy.x, hitY: enemy.y });
    const run = this.ctx;
    run.particles.spawnBurst('spark', enemy.x, enemy.y, 6, {
      speed: 160,
      life: 0.3,
      color,
      size: 1.8,
      rng: () => run.rng.next(),
    });
  }

  // -------------------------------------------------------------------------
  // Enemy damage / death
  // -------------------------------------------------------------------------

  /**
   * @param {import('../enemies/enemy.js').Enemy} enemy
   * @param {number} amount
   * @param {Object} [opts]
   */
  damageEnemy(enemy, amount, opts = {}) {
    const run = this.ctx;
    if (!enemy || !enemy.alive) return null;
    const {
      crit = false,
      weaponId = null,
      sourceX = null,
      sourceY = null,
      knockback = 0,
      hitX = enemy.x,
      hitY = enemy.y,
      explosive = false,
      chain = false,
      armorPierce = 0,
    } = opts;

    const result = enemy.takeDamage(amount, { crit, knockback, sourceX, sourceY, armorPierce });
    const applied = Math.round(result.applied);
    run.stats.damageDealt += applied;
    run.player.stats.damageDealt += applied;

    if (run.settings.video.damageNumbers && applied > 0) {
      const color = crit ? '#ffd166' : explosive ? '#ffb03a' : '#ffffff';
      const size = crit ? 17 : 13;
      run.floatingText.push(hitX, hitY - enemy.radius, `${applied}`, { color, size, critical: crit });
      if (result.absorbedByArmor > 1) {
        run.floatingText.push(hitX + 14, hitY - enemy.radius - 12, `-${Math.round(result.absorbedByArmor)} AR`, {
          color: '#5aa9ff',
          size: 10,
          life: 0.6,
        });
      }
    }

    // Feedback.
    if (result.absorbedByArmor > result.applied * 0.5) {
      run.audio.play(SFX.HIT_ARMOR, { rate: 0.9 + run.rng.next() * 0.2 });
      run.particles.spawnBurst('spark', hitX, hitY, 4, { speed: 150, life: 0.25, color: '#bcd4ff', size: 1.6, rng: () => run.rng.next() });
    } else {
      run.audio.play(crit ? SFX.HIT_CRIT : SFX.HIT_FLESH, { rate: 0.92 + run.rng.next() * 0.16 });
      run.particles.spawnBurst('blood', hitX, hitY, crit ? 8 : 5, {
        angle: sourceX === null ? undefined : Math.atan2(hitY - sourceY, hitX - sourceX),
        spread: 1.2,
        speed: 150,
        life: 0.45,
        color: enemy.accent,
        size: 2.2,
        rng: () => run.rng.next(),
      });
    }
    if (crit) run.camera.addShake(0.08);

    run.events.emit('enemy:damaged', { enemy, applied, crit });
    if (result.died) this.onEnemyDeath(enemy, weaponId);
    return result;
  }

  onEnemyDeath(enemy, weaponId) {
    const run = this.ctx;
    run.particles.spawnBurst('debris', enemy.x, enemy.y, enemy.isElite || enemy.isBoss ? 26 : 12, {
      speed: enemy.isBoss ? 320 : 190,
      life: 0.8,
      color: enemy.accent,
      size: enemy.isBoss ? 3.4 : 2.4,
      rng: () => run.rng.next(),
    });
    run.particles.spawnRing(enemy.x, enemy.y, enemy.radius * (enemy.isBoss ? 6 : 2.4), enemy.accent, {
      life: enemy.isBoss ? 0.9 : 0.35,
    });
    run.camera.addShake(enemy.isBoss ? 1.6 : enemy.isElite ? 0.28 : 0.1);
    run.audio.play(SFX.HIT_KILL, { rate: 0.9 + run.rng.next() * 0.3, volume: enemy.isElite ? 0.7 : 0.5 });
    run.spawner.killed += 1;
    run.player.stats.kills += 1;
    run.stats.kills += 1;

    // Rewards. In-run levels grant deterministic perks; the same XP is also
    // banked to the account when the run settles.
    const xp = enemy.xpValue;
    const gained = run.grantXpFromKill(xp);
    run.floatingText.push(enemy.x, enemy.y - enemy.radius - 8, `+${xp} XP`, { color: '#c084fc', size: 11, life: 0.7 });
    if (gained > 0) this.ctx.events.emit('run:levelGained', { count: gained });
    run.flash = Math.max(run.flash, enemy.isBoss ? 0.6 : 0.06);
    run.loot.dropFromEnemy(enemy);
    run.events.emit('enemy:killed', { enemy, weaponId });

    if (enemy.isBoss) {
      run.audio.play(SFX.BOSS_DEATH);
      run.flash = 1;
      run.camera.addShake(2.2);
      run.events.emit('boss:defeated', { enemy });
    }
  }

  // -------------------------------------------------------------------------
  // Player damage
  // -------------------------------------------------------------------------

  /**
   * @param {number} amount
   * @param {Object} [opts]
   * @param {import('../enemies/enemy.js').Enemy} [opts.source]
   * @param {string} [opts.kind]
   */
  damagePlayer(amount, opts = {}) {
    const run = this.ctx;
    const player = run.player;
    if (!player.alive) return null;
    const { bypassArmor = false, kind = 'generic', hitX = player.x, hitY = player.y } = opts;

    // Stim grants a small damage resistance as well as offence.
    const stimResist = player.stimTimer > 0 ? 0.8 : 1;
    const result = player.takeDamage(amount * stimResist, { bypassArmor });
    if (result.applied <= 0 && !result.died) return result;

    run.stats.damageTaken += result.applied;
    run.camera.addShake(kind === 'slam' ? 1.0 : 0.3);
    run.shake_onDamage = true;
    run.hitStop.trigger(kind === 'slam' ? 0.09 : PLAYER_BASE.hitStopOnDamage);
    run.hitDirection = { x: player.x - hitX, y: player.y - hitY };
    run.damageVignette = 1;
    run.audio.play(SFX.PLAYER_DAMAGE, { rate: 0.9 + run.rng.next() * 0.2 });

    run.particles.spawnBurst('blood', player.x, player.y, 10, {
      speed: 170,
      life: 0.5,
      color: '#ff4d6d',
      size: 2.4,
      rng: () => run.rng.next(),
    });
    if (run.settings.video.damageNumbers) {
      run.floatingText.push(player.x, player.y - 30, `-${Math.round(result.applied)}`, { color: '#ff4d6d', size: 16 });
    }

    // Taking a hit interrupts an extraction channel: real extractions cost.
    if (run.extractionZone && run.extractionZone.active) {
      run.extractionZone.interrupt();
      run.audio.play(SFX.EXTRACTION_ABORT, { volume: 0.5 });
      run.floatingText.push(player.x, player.y - 48, 'EXTRACTION INTERRUPTED', { color: '#ff6b5c', size: 13, life: 1.2 });
      run.events.emit('extraction:interrupted', {});
    }

    run.events.emit('player:damaged', { applied: result.applied, kind, source: opts.source });
    if (result.died) {
      run.audio.play(SFX.PLAYER_DEATH);
      run.camera.addShake(1.8);
      run.events.emit('player:died', { killer: opts.source ?? null, kind });
    }
    return result;
  }

  /** Environmental hazard tick (steam vents). */
  applyHazard(prop, radius) {
    const run = this.ctx;
    const player = run.player;
    if (!player.alive) return;
    if (dist2(player.x, player.y, prop.x, prop.y) > radius * radius) return;
    this.damagePlayer(4, { kind: 'hazard', bypassArmor: true, hitX: prop.x, hitY: prop.y });
  }

  // -------------------------------------------------------------------------
  // Melee / enemy attack feedback hooks
  // -------------------------------------------------------------------------

  onEnemyTelegraph(enemy, kind) {
    const run = this.ctx;
    run.audio.play(SFX.MELEE, { volume: kind === 'heavy' ? 0.5 : 0.3, rate: 1.5 });
    run.particles.spawnRing(enemy.x, enemy.y, enemy.radius + (kind === 'heavy' ? 34 : 18), enemy.accent, { life: 0.35 });
  }

  onEnemyAttack(enemy, kind, data) {
    const run = this.ctx;
    const color = enemy.accent;
    switch (kind) {
      case 'meleeHit':
      case 'heavyHit':
        run.particles.spawnBurst('spark', data.x, data.y, 12, {
          speed: 220,
          life: 0.32,
          color,
          size: 2.2,
          rng: () => run.rng.next(),
        });
        run.camera.addShake(kind === 'heavyHit' ? 0.5 : 0.2);
        break;
      case 'meleeMiss':
      case 'heavyMiss':
        run.particles.spawnBurst('spark', data.x, data.y, 5, { speed: 120, life: 0.22, color, size: 1.6, rng: () => run.rng.next() });
        break;
      case 'ranged':
        run.particles.spawnBurst('muzzle', data.x, data.y, 4, {
          angle: data.angle,
          spread: 0.5,
          speed: 130,
          life: 0.18,
          color,
          size: 2.4,
          rng: () => run.rng.next(),
        });
        break;
      case 'charger':
        run.particles.spawnBurst('smoke', enemy.x, enemy.y, 6, {
          speed: 90,
          life: 0.4,
          color: 'rgba(120,90,150,0.45)',
          additive: false,
          size: 6,
          rng: () => run.rng.next(),
        });
        break;
      default:
        break;
    }
  }

  onBossSlam(boss, radius) {
    const run = this.ctx;
    run.particles.spawnRing(boss.x, boss.y, radius, '#ffb03a', { life: 0.6, fade: 2.4 });
    run.particles.spawnBurst('debris', boss.x, boss.y, 26, {
      speed: 300,
      life: 0.8,
      color: '#8f6f5a',
      size: 3,
      rng: () => run.rng.next(),
    });
    run.particles.spawnBurst('ember', boss.x, boss.y, 18, { speed: 260, life: 0.6, color: '#ffb03a', size: 2.6, rng: () => run.rng.next() });
    run.camera.addShake(1.1);
    run.audio.play(SFX.EXPLOSION, { volume: 0.6, rate: 0.7 });
    run.flash = Math.max(run.flash, 0.4);
  }

  onBossBurst(boss, count) {
    const run = this.ctx;
    run.particles.spawnRing(boss.x, boss.y, boss.radius * 2.4, '#ffb03a', { life: 0.4 });
    run.camera.addShake(0.4);
    void count;
  }

  onBossSummon(boss, types, count) {
    const run = this.ctx;
    const created = run.spawner.summon(types[run.rng.int(0, types.length - 1)], boss.x, boss.y, count);
    for (const enemy of created) {
      run.particles.spawnRing(enemy.x, enemy.y, 44, '#ff6b5c', { life: 0.5 });
    }
    run.audio.play(SFX.BOSS_PHASE, { volume: 0.6 });
  }

  /** Destroys an objective prop and reports progress. */
  destroyObjectiveProp(prop) {
    const run = this.ctx;
    const result = run.world.damageProp(prop, 99999);
    if (result && result.destroyed) this.onPropDestroyed(prop);
  }

  /** Weapon tier badge color used by the pickup popup. */
  tierColor(tier) {
    return WEAPON_TIER_COLORS[tier] ?? '#9fb3c8';
  }

  rarityColor(rarity) {
    return RARITY_COLORS[rarity] ?? '#9fb3c8';
  }

  /** Blends the extraction channel progress color for the HUD. */
  progressColor(ratio) {
    return `rgb(${Math.round(lerp(255, 111, ratio))}, ${Math.round(lerp(77, 227, ratio))}, ${Math.round(lerp(109, 196, ratio))})`;
  }
}

const SFX_BY_WEAPON = {
  pistol: SFX.PISTOL,
  smg: SFX.SMG,
  shotgun: SFX.SHOTGUN,
  rifle: SFX.RIFLE,
  railpiercer: SFX.RAIL,
  breaker: SFX.BREAKER,
  arcCaster: SFX.ARC,
};

export { TEAM, TAU };
