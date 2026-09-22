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
import { ENEMY_STATES, massFeedback } from '../config/enemies.js';
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
      // Reload pitch follows the class too, so the mag-out/mag-in pair belongs
      // to the weapon and not to "guns in general".
      run.audio.play(SFX.RELOAD_START, { rate: (FIRE_PROFILE[weapon.def.id] ?? FIRE_PROFILE.default).reloadPitch });
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
      run.audio.play(SFX.RELOAD_FINISH, { rate: (FIRE_PROFILE[player.weapon?.def?.id] ?? FIRE_PROFILE.default).reloadPitch });
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
    const dirX = Math.cos(baseAngle);
    const dirY = Math.sin(baseAngle);
    // Point blank. The muzzle sits `player.radius + 12` ahead of the player, so
    // a hostile that is already in contact sits *behind* the spawn point and the
    // shot passes straight through it (measured before this clamp: 0% hits
    // inside 13u, 100% from 20u). Starting the projectile inside the nearest
    // body on the firing line keeps the shot where the player aimed it; the
    // muzzle flash and tracer origin move with it, so a contact shot reads as a
    // contact shot instead of a whiff.
    let startDistance = muzzleDistance;
    for (const enemy of run.spawner.enemies) {
      if (!enemy.alive) continue;
      const ex = enemy.x - player.x;
      const ey = enemy.y - player.y;
      const along = ex * dirX + ey * dirY;
      const body = enemy.radius + 1;
      if (along < 0 || along > muzzleDistance + body) continue;
      const perp = Math.abs(ex * dirY - ey * dirX);
      if (perp > body) continue;
      const near = along - Math.sqrt(Math.max(0, body * body - perp * perp));
      startDistance = Math.min(startDistance, Math.max(0, near + 1));
    }
    const muzzleX = player.x + dirX * startDistance;
    const muzzleY = player.y + dirY * startDistance;

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
    run.camera.addKick(-dirX * kick, -dirY * kick);
    run.camera.addShake(def.recoil * 0.016 * player.recoilMul);

    // Muzzle flash. The shape and the report tail are per weapon class, not per
    // archetype of "gun": without this a pistol, a rifle and a breaker read as
    // the same weapon with different numbers, which is what the class spread
    // ended up looking and sounding like.
    const fx = FIRE_PROFILE[def.id] ?? FIRE_PROFILE.default;
    run.particles.spawnBurst('muzzle', muzzleX, muzzleY, Math.round(fx.muzzle * (def.pellets > 4 ? 1.6 : 1)), {
      angle: baseAngle,
      spread: fx.spread,
      speed: fx.muzzleSpeed,
      life: 0.16,
      color: def.color,
      size: fx.muzzleSize * (def.pellets > 4 ? 1.3 : 1),
      rng: () => rng.next(),
    });
    if (fx.trail > 0) {
      // A short hot streak behind the flash: reads as a long barrel, not a
      // bigger bang.
      run.particles.spawn('muzzle', muzzleX, muzzleY, {
        vx: dirX * -70,
        vy: dirY * -70,
        life: 0.1,
        size: fx.trail,
        color: def.color,
        additive: true,
        glow: 1.6,
      });
    }
    run.particles.spawn('smoke', muzzleX, muzzleY, {
      vx: Math.cos(baseAngle) * 30,
      vy: Math.sin(baseAngle) * 30,
      life: fx.smokeLife,
      size: fx.smokeSize,
      color: 'rgba(120,130,150,0.35)',
      additive: false,
      drag: 1.4,
    });

    run.audio.play(SFX_BY_WEAPON[def.id] ?? SFX.PISTOL, { rate: (0.95 + rng.next() * 0.1) * fx.pitch, volume: fx.volume });
    // Heavy classes get a low-end body under the report so weight survives the
    // mix even when several weapons are firing at once.
    if (fx.tail) run.audio.play(SFX.WEAPON_TAIL, { rate: fx.tail, volume: 0.55 });
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

    // A hit can be swallowed whole by a shield, so the guard cannot be "did any
    // damage land": the player still needs to see what the shot spent itself on.
    if (run.settings.video.damageNumbers && (applied > 0 || result.absorbedByShield > 1)) {
      const color = crit ? '#ffd166' : explosive ? '#ffb03a' : '#ffffff';
      const size = crit ? 17 : 13;
      if (applied > 0) run.floatingText.push(hitX, hitY - enemy.radius, `${applied}`, { color, size, critical: crit });
      if (result.absorbedByShield > 1) {
        run.floatingText.push(hitX + 14, hitY - enemy.radius - 12, `-${Math.round(result.absorbedByShield)} SH`, {
          color: '#9fe8ff',
          size: 10,
          life: 0.6,
        });
      }
      if (result.absorbedByArmor > 1) {
        run.floatingText.push(hitX + 14, hitY - enemy.radius - 12, `-${Math.round(result.absorbedByArmor)} AR`, {
          color: '#5aa9ff',
          size: 10,
          life: 0.6,
        });
      }
    }

    // Feedback. A shielded elite is the one case where "nothing seems to
    // happen": the shield eats the shot, so playing the body-hit cue made the
    // target read as invulnerable rather than protected. Shields, plates and
    // flesh are three different materials and now sound like three different
    // materials — a shield used to borrow the plate cue, which made a protected
    // elite and an armoured one indistinguishable by ear.
    const mass = massFeedback(enemy.def);
    const shieldBefore = enemy.shield + result.absorbedByShield;
    if (result.absorbedByShield > result.applied * 0.5 && result.absorbedByShield > 0) {
      run.audio.play(SFX.SHIELD_HIT, { rate: 1.05 + run.rng.next() * 0.2, volume: 0.75 });
      run.particles.spawnBurst('spark', hitX, hitY, 5, { speed: 170, life: 0.28, color: '#9fe8ff', size: 1.8, rng: () => run.rng.next() });
      run.particles.spawnRing(hitX, hitY, enemy.radius + 6, '#9fe8ff', { life: 0.22, alpha: 0.4 });
    } else if (result.absorbedByArmor > result.applied * 0.5) {
      run.audio.play(SFX.HIT_ARMOR, { rate: 0.9 + run.rng.next() * 0.2, volume: 0.95 });
      run.particles.spawnBurst('spark', hitX, hitY, 4, { speed: 150, life: 0.25, color: '#bcd4ff', size: 1.6, rng: () => run.rng.next() });
    } else {
      run.audio.play(crit ? SFX.HIT_CRIT : SFX.HIT_FLESH, {
        rate: (0.92 + run.rng.next() * 0.16) * mass.hitRate,
        volume: mass.hitVolume,
      });
      run.particles.spawnBurst('blood', hitX, hitY, Math.max(2, Math.round((crit ? 8 : 5) * mass.debris)), {
        angle: sourceX === null ? undefined : Math.atan2(hitY - sourceY, hitX - sourceX),
        spread: 1.2,
        speed: 150,
        life: 0.45,
        color: enemy.accent,
        size: 2.2 * (0.9 + mass.debris * 0.1),
        rng: () => run.rng.next(),
      });
    }
    // A shield that ran out gets its own cue: "the shots are working now" is a
    // state change the player has to be able to notice mid-fight.
    if (shieldBefore > 0 && enemy.shield <= 0 && enemy.alive) {
      run.audio.play(SFX.SHIELD_BREAK, { volume: enemy.isBoss ? 0.9 : 0.7 });
      run.particles.spawnRing(hitX, hitY, enemy.radius * 3.2, '#9fe8ff', { life: 0.45, alpha: 0.6 });
      if (enemy.isElite || enemy.isBoss) {
        run.floatingText.push(enemy.x, enemy.y - enemy.radius - 14, 'SHIELD DOWN', { color: '#9fe8ff', size: 12, life: 0.9 });
      }
    }
    // Stagger is a real opening, and it used to exist only inside the AI: a
    // heavy hit that cancelled a telegraphed attack looked like every other hit,
    // which is exactly the moment a squad fight needs to advertise.
    if (enemy.state === ENEMY_STATES.STAGGER && enemy.stateTime === 0 && result.applied > 0) {
      run.audio.play(SFX.ENEMY_STAGGER, { rate: (0.96 + run.rng.next() * 0.12) * mass.hitRate, volume: 0.7 * mass.hitVolume });
      run.particles.spawnRing(enemy.x, enemy.y, enemy.radius * (1.9 + mass.staggerLean * 0.5), '#ffffff', { life: 0.26, alpha: 0.5 });
    }
    if (crit) run.camera.addShake(0.08);
    else if (mass.hitShake > 1.2 && result.applied > 0) run.camera.addShake(0.1 * mass.hitShake);

    run.events.emit('enemy:damaged', { enemy, applied, crit });
    if (result.died) this.onEnemyDeath(enemy, weaponId);
    return result;
  }

  onEnemyDeath(enemy, weaponId) {
    const run = this.ctx;
    const mass = massFeedback(enemy.def);
    const elite = enemy.isElite || enemy.isBoss;
    run.particles.spawnBurst('debris', enemy.x, enemy.y, Math.round((elite ? 26 : 12) * mass.debris), {
      speed: enemy.isBoss ? 320 : 190,
      life: 0.8,
      color: enemy.accent,
      size: enemy.isBoss ? 3.4 : 2.4 * (0.9 + mass.debris * 0.1),
      rng: () => run.rng.next(),
    });
    run.particles.spawnRing(enemy.x, enemy.y, enemy.radius * (enemy.isBoss ? 6 : 2.4), enemy.accent, {
      life: enemy.isBoss ? 0.9 : 0.35,
    });
    run.camera.addShake((enemy.isBoss ? 1.6 : enemy.isElite ? 0.28 : 0.1) * (elite ? 1 : mass.hitShake));
    // Kills are the most repeated sound in a run, so the cue carries the body
    // mass: popping a dart and dropping a brute must not be the same event.
    // Elites keep the signature kill cue, bosses have their own.
    if (enemy.isBoss) run.audio.play(SFX.HIT_KILL, { rate: 0.72, volume: 0.6 });
    else if (enemy.isElite) run.audio.play(SFX.HIT_KILL, { rate: 0.9 + run.rng.next() * 0.2, volume: 0.7 });
    else if (mass.deathCue === 'heavy') run.audio.play(SFX.DEATH_HEAVY, { rate: 0.94 + run.rng.next() * 0.12, volume: 0.8 });
    else if (mass.deathCue === 'light') run.audio.play(SFX.DEATH_LIGHT, { rate: 0.96 + run.rng.next() * 0.14, volume: 0.7 });
    else run.audio.play(SFX.HIT_KILL, { rate: 0.96 + run.rng.next() * 0.14, volume: 0.5 });
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
    // Plating that eats most of a hit is worth hearing: without this the only
    // cue was the same damage sting as a clean hit, and the number on screen
    // did not say where the rest of the damage went. The armour reduction caps
    // out below 100% by design, so this is about "mostly stopped", not "fully
    // stopped" - which is how a plate hit actually reads.
    const absorbedMost = !bypassArmor && result.absorbed > result.applied;
    if (absorbedMost) {
      run.audio.play(SFX.HIT_ARMOR, { rate: 0.82 + run.rng.next() * 0.12, volume: 0.5 });
      run.particles.spawnBurst('spark', hitX, hitY, 5, {
        speed: 150,
        life: 0.28,
        color: '#bcd4ff',
        size: 1.7,
        rng: () => run.rng.next(),
      });
    }

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
      if (absorbedMost) {
        run.floatingText.push(player.x + 14, player.y - 46, `-${Math.round(result.absorbed)} AR`, { color: '#5aa9ff', size: 11, life: 0.8 });
      }
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

/**
 * Per-class fire presentation. Purely cosmetic: muzzle burst counts/sizes, the
 * hot trail behind the flash, smoke, and where the report sits in pitch and
 * volume. Recoil, spread, damage and cadence come from `src/config/weapons.js`
 * and are untouched.
 *
 * Before this table the seven classes shared one muzzle shape and one smoke
 * puff, so pistol/rifle/breaker differed only by colour — the closest class
 * pairs scored 0.06-0.13 apart on a normalised fire-signature distance where 0
 * is identical.
 */
const FIRE_PROFILE = {
  default: { muzzle: 4, muzzleSize: 2.8, spread: 0.7, muzzleSpeed: 210, smokeSize: 7, smokeLife: 0.5, trail: 0, pitch: 1, volume: 1, tail: 0, reloadPitch: 1.0 },
  // Service pistol: clean, small flash, minimal smoke.
  pistol: { muzzle: 3, muzzleSize: 2.4, spread: 0.55, muzzleSpeed: 190, smokeSize: 5, smokeLife: 0.34, trail: 0, pitch: 1.04, volume: 0.95, tail: 0, reloadPitch: 1.05 },
  // SMG: fast, thin, snappy — small flash but a hard short bark.
  smg: { muzzle: 3, muzzleSize: 2.1, spread: 0.85, muzzleSpeed: 240, smokeSize: 4, smokeLife: 0.26, trail: 0, pitch: 1.18, volume: 0.85, tail: 0, reloadPitch: 1.15 },
  // Shotgun: wide wall of flash and a long smoke plume.
  shotgun: { muzzle: 10, muzzleSize: 4.6, spread: 1.15, muzzleSpeed: 260, smokeSize: 12, smokeLife: 0.8, trail: 0, pitch: 0.95, volume: 1, tail: 0.8, reloadPitch: 0.92 },
  // Rifle: longer flash with a streak, a real report.
  rifle: { muzzle: 5, muzzleSize: 3.2, spread: 0.5, muzzleSpeed: 230, smokeSize: 6, smokeLife: 0.42, trail: 3.2, pitch: 0.9, volume: 1, tail: 0.9, reloadPitch: 0.86 },
  // Rail: a lance of light, almost no smoke, deepest pitch.
  railpiercer: { muzzle: 4, muzzleSize: 3.6, spread: 0.2, muzzleSpeed: 320, smokeSize: 3, smokeLife: 0.3, trail: 6, pitch: 0.82, volume: 1, tail: 0.62, reloadPitch: 0.78 },
  // Breaker: blunt, smoky, short.
  breaker: { muzzle: 6, muzzleSize: 3.4, spread: 0.95, muzzleSpeed: 200, smokeSize: 9, smokeLife: 0.5, trail: 0, pitch: 0.88, volume: 1, tail: 0.74, reloadPitch: 0.94 },
  // Arc caster: no muzzle bloom at all — a crackling halo instead.
  arcCaster: { muzzle: 8, muzzleSize: 2.2, spread: 3.14, muzzleSpeed: 150, smokeSize: 2, smokeLife: 0.2, trail: 4, pitch: 1.1, volume: 0.9, tail: 0, reloadPitch: 1.1 },
};

export { TEAM, TAU };
