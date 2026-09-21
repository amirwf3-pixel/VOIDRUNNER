/**
 * The run: a complete play session across one or more sectors.
 *
 * This is the composition root for gameplay - it owns the player, the zone,
 * every subsystem and the fixed update order. Nothing else in the codebase
 * knows how the systems fit together, which keeps the dependency graph acyclic
 * and makes the whole game loop inspectable in one place.
 *
 * Update order per frame (deliberate and stable):
 *   1. timers / hit-stop         6. projectiles
 *   2. player intent + movement  7. loot magnets
 *   3. weapon + reload           8. world props / hazards
 *   4. enemy activation + AI     9. objectives
 *   5. enemy physics + contact  10. extraction / descent
 *                               11. effects, camera, audio state, death
 */

import { Rng } from '../core/rng.js';
import { clamp, dist2, TAU } from '../core/math.js';
import { generateZone } from '../generation/zone.js';
import { Player } from '../player/player.js';
import { EnemySpawner } from '../enemies/spawner.js';
import { updateEnemyAI, updateEnemyContact, separateEnemies } from '../enemies/ai.js';
import { ProjectileSystem, TEAM } from '../weapons/projectile.js';
import { Camera } from '../effects/camera.js';
import { FloatingTextSystem, HitStop, ParticleSystem } from '../effects/particles.js';
import { WorldRuntime, ChannelZone } from '../world/world.js';
import { LootSystem, DROP_KIND } from '../loot/loot.js';
import { CombatSystem } from './combat.js';
import { ObjectiveRuntime } from './objectives.js';
import { MAX_SECTOR, OBJECTIVE_TYPES, PLAYER_BASE } from '../config/balance.js';
import { AMBIENT_STATES, MUSIC_STATES, SFX } from '../audio/audio.js';
import { sectorTint } from '../config/palette.js';
import { BOSS } from '../config/enemies.js';

export const RUN_STATE = {
  ACTIVE: 'active',
  EXTRACTED: 'extracted',
  DEAD: 'dead',
  ABANDONED: 'abandoned',
};

/** In-run level perks. Deterministic, repeatable, and clearly communicated. */
const RUN_PERKS = [
  { level: 2, text: '+15 MAX HEALTH', apply: (p) => { p.maxHealth += 15; p.heal(15); } },
  { level: 3, text: '+8% DAMAGE', apply: (p) => { p.damageMul += 0.08; } },
  { level: 4, text: '+15 MAX ENERGY', apply: (p) => { p.maxEnergy += 15; p.addEnergy(15); } },
  { level: 5, text: '+10% RELOAD SPEED', apply: (p) => { p.reloadMul *= 0.9; } },
  { level: 6, text: '+15 ARMOR', apply: (p) => { p.maxArmor += 15; p.addArmor(15); } },
  { level: 7, text: '+6% MOVE SPEED', apply: (p) => { p.baseMoveSpeed *= 1.06; } },
  { level: 8, text: '+10% DAMAGE', apply: (p) => { p.damageMul += 0.1; } },
  { level: 9, text: '+25 MAX HEALTH', apply: (p) => { p.maxHealth += 25; p.heal(25); } },
];

export function runXpForLevel(level) {
  return Math.round(90 * Math.pow(1.34, Math.max(0, level - 1)));
}

export class Run {
  /**
   * @param {Object} config
   * @param {string} config.seed
   * @param {number} [config.startTier]
   * @param {Object} config.profile
   * @param {import('../progression/progression.js').Progression} config.progression
   * @param {import('../audio/audio.js').AudioEngine} config.audio
   * @param {import('../core/events.js').EventBus} config.events
   * @param {Object|null} [config.resume] validated resumable run
   */
  constructor(config) {
    if (!config || typeof config.seed !== 'string') throw new TypeError('Run requires a seed string');
    this.seed = config.seed;
    this.profile = config.profile;
    this.progression = config.progression;
    this.audio = config.audio;
    this.events = config.events;
    this.settings = config.profile.settings;
    this.bonuses = config.progression.computeRunBonuses();
    this.genParams = config.genParams ?? {};

    this.tier = config.resume?.tier ?? config.startTier ?? 1;
    this.state = RUN_STATE.ACTIVE;
    this.finished = false;
    this.result = null;

    // Deterministic simulation stream, forked per sector so advancing sectors
    // cannot retroactively change what happened in earlier ones.
    this.rng = new Rng(`${this.seed}:sim:${this.tier}`);

    this.camera = new Camera({ width: 1280, height: 720 });
    this.particles = new ParticleSystem();
    this.particles.density = this.settings.video.particles;
    this.floatingText = new FloatingTextSystem();
    this.floatingText.enabled = this.settings.video.damageNumbers;
    this.hitStop = new HitStop();
    this.projectiles = new ProjectileSystem();
    this.combat = new CombatSystem(this);

    this.elapsed = 0;
    this.sectorTime = 0;
    this.flash = 0;
    this.damageVignette = 0;
    this.hitDirection = { x: 0, y: 0 };
    this.pendingExplosions = [];
    this.extractionStats = null;
    this.threatLevel = 0;
    this.musicState = null;
    this.ambientState = null;
    this.pickupLog = [];
    this.level = 1;
    this.xp = 0;
    this.xpEarnedTotal = 0;
    this.perkIndex = 0;
    this.stats = {
      kills: 0,
      damageDealt: 0,
      damageTaken: 0,
      elitesKilled: 0,
      bossKills: 0,
      objectivesCompleted: 0,
      sectorsCleared: 0,
      uselessShots: 0,
      lootCollected: 0,
    };
    this.bossIntroPlayed = false;
    this.bossWavesTriggered = false;

    this._wireEvents();
    this._buildSector(this.tier, config.resume ?? null);
  }

  /** Gameplay events are routed here so objective/stat bookkeeping is central. */
  _wireEvents() {
    this.events.on('enemy:killed', ({ enemy }) => {
      this.objectives.onEnemyKilled();
      if (enemy.isElite) this.stats.elitesKilled += 1;
    });
    this.events.on('boss:defeated', () => {
      this.stats.bossKills += 1;
      this.objectives.onBossKilled();
    });
    this.events.on('objective:propDestroyed', ({ objectiveId }) => {
      this.objectives.onPropDestroyed(objectiveId);
    });
  }

  /** Regenerates the world for a sector; reused on descend and on restart. */
  _buildSector(tier, resume) {
    this.tier = tier;
    this.zone = generateZone({ seed: this.seed, tier, genParams: this.genParams });
    this.tint = sectorTint(tier);
    this.world = new WorldRuntime(this.zone);
    this.loot = new LootSystem({ zone: this.zone, progression: this.progression, runSeed: this.seed });
    this.loot.onPickup = (drop, result) => {
      if (drop.objectiveId) this.objectives.onMarkerCollected(drop.objectiveId, drop.id);
      this.notifyPickup(drop, result);
    };
    this.objectives = new ObjectiveRuntime(this.zone);
    this._wireObjectiveCallbacks();
    this.objectives.spawnMarkers(this.loot);
    if (resume) this.objectives.restore(resume.objectiveState ?? null);

    this.spawner = new EnemySpawner(this.zone, new Rng(`${this.seed}:spawn:${tier}`), {
      onSpawn: (enemy) => this._onEnemySpawned(enemy),
    });

    const spawn = this.zone.spawnPoint;
    if (resume) {
      this.player = Player.restore(
        {
          weapons: resume.weapons.map((id) => ({ id, tier: 1, ammo: undefined })),
          loot: resume.loot,
          reserve: resume.reserve,
          health: resume.health,
          armor: resume.armor,
        },
        spawn,
        this.bonuses,
      );
    } else if (this.player) {
      // Descending keeps the loadout but restores the player to the new spawn.
      const carried = this.player.serialize();
      this.player = Player.restore(carried, spawn, this.bonuses);
      this.player.health = Math.max(Math.round(this.player.maxHealth * 0.45), this.player.health);
    } else {
      this.player = new Player(spawn, this.bonuses);
      this.player.setLoadout(['pistol'], {
        ammoMul: this.bonuses.ammoMul,
        medkitsAdd: this.bonuses.medkitsAdd,
      });
    }

    this.extractionZone = new ChannelZone(this.zone.extraction, 'extract');
    this.descendZone = this.zone.descend ? new ChannelZone(this.zone.descend, 'descend') : null;
    this.camera.setBounds(this.zone.bounds);
    this.camera.snapTo(spawn.x, spawn.y);
    this.projectiles.reset();
    this.particles.reset();
    this.sectorTime = 0;
    this.bossIntroPlayed = false;
    this.bossWavesTriggered = false;
    this.spawner.bossWavesTriggered = false;
    this.pendingExplosions.length = 0;
  }

  _wireObjectiveCallbacks() {
    this.objectives.onProgress = (objective) => {
      this.audio.play(SFX.OBJECTIVE_PROGRESS);
      const info = this.objectives.describe(objective);
      this.floatingText.push(this.player.x, this.player.y - 46, `${info.title} ${objective.progress}/${objective.target}`, {
        color: '#ffd166',
        size: 13,
        life: 1.2,
      });
      this.events.emit('objective:progress', { objective });
    };
    this.objectives.onComplete = (objective) => {
      this.stats.objectivesCompleted += 1;
      this.audio.play(SFX.OBJECTIVE_COMPLETE);
      this.floatingText.push(this.player.x, this.player.y - 56, 'OBJECTIVE COMPLETE', {
        color: '#6fe3c4',
        size: 15,
        life: 2,
      });
      this.flash = Math.max(this.flash, 0.3);
      this.events.emit('objective:complete', { objective });
    };
    this.objectives.onAllComplete = () => {
      this.audio.play(SFX.EXTRACTION_START);
      this.events.emit('objective:allComplete', {});
    };
  }

  _onEnemySpawned(enemy) {
    if (enemy.isBoss && !this.bossIntroPlayed) {
      this.bossIntroPlayed = true;
      this.audio.play(SFX.BOSS_SPAWN);
      this.camera.addShake(1.2);
      this.floatingText.push(enemy.x, enemy.y - 60, BOSS.name, { color: '#ff5c33', size: 22, life: 2.4 });
      this.floatingText.push(enemy.x, enemy.y - 40, BOSS.title, { color: '#ffb03a', size: 13, life: 2.4 });
      this.events.emit('boss:spawn', { enemy });
    }
  }

  // -------------------------------------------------------------------------
  // Main update
  // -------------------------------------------------------------------------

  /**
   * @param {number} rawDt seconds
   * @param {import('../core/input.js').Input} input
   */
  update(rawDt, input) {
    if (this.finished) return;
    const dt = clamp(rawDt, 0, 1 / 20);
    const simDt = this.hitStop.consume(dt);

    this.elapsed += dt;
    this.sectorTime += dt;
    this.threatLevel = Math.max(0, this.threatLevel - dt * 0.6);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 2.4);
    if (this.damageVignette > 0) this.damageVignette = Math.max(0, this.damageVignette - dt * 1.6);

    const player = this.player;
    const aimWorld = this.camera.screenToWorld(input.pointer.x, input.pointer.y);

    // 1) Player intent + movement.
    if (player.alive) {
      player.update(simDt, {
        move: input.axis(),
        aimWorld,
        dashPressed: input.wasPressed('dash'),
        dashHeld: input.keyDown('ShiftLeft'),
      }, this.zone.map, this.world);
    } else {
      player.update(simDt, { move: { x: 0, y: 0 }, aimWorld, dashPressed: false, dashHeld: false }, this.zone.map, this.world);
    }

    // 2) Weapon handling.
    for (const weapon of player.weapons) {
      weapon.update(simDt, { reloadMul: player.reloadMul });
    }
    if (player.alive) {
      this.combat.completeReload();
      this.combat.updatePlayerWeapon(input.pointerDown(0), input.pointerClicked(0));
      if (input.wasPressed('reload') && !player.weapon.isReloading) this.startReloadWithFeedback();
      if (input.wasPressed('swapWeapon')) {
        if (player.nextWeapon()) this.audio.play(SFX.SWAP);
      }
      for (let i = 0; i < 4; i += 1) {
        if (input.wasPressed(`slot${i + 1}`)) {
          if (player.switchWeapon(i)) this.audio.play(SFX.SWAP);
        }
      }
      this._updateConsumables(input);
      this.audio.updateSteps(simDt, Math.hypot(player.vx, player.vy) > 24, Math.hypot(player.vx, player.vy) / 220);
    }

    // 3) Enemy activation and AI.
    this.spawner.updateActivation(simDt, player, player.alive);
    const aiCtx = {
      player,
      map: this.zone.map,
      world: this.world,
      rng: this.rng,
      difficulty: this.zone.difficulty,
      spawnProjectile: (spec) => this.projectiles.spawn({ ...spec, sourceTag: null }),
      damagePlayer: (amount, opts) => this.combat.damagePlayer(amount, opts),
      onTelegraph: (enemy, kind) => this.combat.onEnemyTelegraph(enemy, kind),
      onAttack: (enemy, kind, data) => this.combat.onEnemyAttack(enemy, kind, data),
      onAlert: () => { this.threatLevel = Math.min(1, this.threatLevel + 0.25); },
      onBossAlert: () => { this.threatLevel = 1; },
      onBossPhase: (boss, name) => {
        this.audio.play(SFX.BOSS_PHASE);
        this.camera.addShake(0.8);
        this.floatingText.push(boss.x, boss.y - 70, `PHASE: ${name}`, { color: '#ffb03a', size: 18, life: 1.6 });
        this.events.emit('boss:phase', { name });
      },
      onBossTelegraph: (boss, kind) => this.combat.onEnemyTelegraph(boss, kind),
      onBossSlam: (boss, radius) => this.combat.onBossSlam(boss, radius),
      onBossBurst: (boss, count) => this.combat.onBossBurst(boss, count),
      onBossSummon: (boss, types, count) => this.combat.onBossSummon(boss, types, count),
    };

    for (const enemy of this.spawner.enemies) {
      if (!enemy.alive) continue;
      if (!this.spawner.shouldSimulate(enemy, player)) continue;
      updateEnemyAI(enemy, simDt, aiCtx);
      enemy.integrate(simDt, this.zone.map, this.world);
      updateEnemyContact(enemy, simDt, aiCtx);
    }
    separateEnemies(this.spawner.enemies, simDt);

    // 4) Projectiles.
    this.projectiles.update(simDt, {
      map: this.zone.map,
      enemies: this.spawner.enemies,
      player,
      world: this.world,
      onHit: (hit) => this.combat.onProjectileHit(hit),
      onWall: (hit) => this.combat.onWallHit(hit),
      onPropHit: (projectile, prop) => this.combat.onPropHit(projectile, prop),
      onExplosion: (spec) => this.combat.onExplosion(spec),
      onChain: (spec) => this.combat.onChain(spec),
    });

    // 5) Loot.
    this.loot.update(simDt, {
      player,
      world: this.world,
      canPickup: player.alive,
      pickupRadius: PLAYER_BASE.pickupRadius + (player.weapon?.def.id === 'breaker' ? -8 : 0),
    });

    // 6) World props and hazards.
    this.world.update(simDt, {
      onHazard: (prop, radius) => this.combat.applyHazard(prop, radius),
    });
    this.world.postUpdate();
    this._updatePendingExplosions(simDt);

    // 7) Objectives.
    this.objectives.update(simDt, { elapsed: this.elapsed, onObjectiveComplete: () => {} });

    // 8) Extraction / descent.
    this._updateZones(simDt);

    // 9) Effects, camera, audio.
    this.particles.update(simDt);
    this.floatingText.update(simDt);
    this.camera.update(dt, player, { x: player.aimDir.x, y: player.aimDir.y }, this.settings.video.screenShake);
    this._updateAudioState();
    this.spawner.reap(simDt);

    // 10) Pickup logging decay (HUD ticker).
    for (let i = this.pickupLog.length - 1; i >= 0; i -= 1) {
      this.pickupLog[i].life -= dt;
      if (this.pickupLog[i].life <= 0) this.pickupLog.splice(i, 1);
    }

    if (!player.alive && !this.finished) {
      this.finish(false, RUN_STATE.DEAD);
    }
  }

  startReloadWithFeedback() {
    const started = this.combat.startReload();
    if (!started) {
      const player = this.player;
      const weapon = player.weapon;
      if (weapon && weapon.ammo >= weapon.magazineSize) {
        this.floatingText.push(player.x, player.y - 28, 'MAG FULL', { color: '#7d8ea3', size: 11, life: 0.6 });
      } else {
        this.audio.play(SFX.DRYFIRE);
        this.floatingText.push(player.x, player.y - 28, 'NO AMMO', { color: '#ff6b5c', size: 11, life: 0.7 });
      }
    }
  }

  _updateConsumables(input) {
    const player = this.player;
    const tryUse = (key) => {
      const result = this.loot.useConsumable(player, key);
      if (!result) {
        this.audio.play(SFX.UI_ERROR, { volume: 0.4 });
        return null;
      }
      if (key === 'medkit') this.audio.play(SFX.PLAYER_HEAL);
      else if (key === 'armorplate') this.audio.play(SFX.UI_CONFIRM, { volume: 0.5 });
      else this.audio.play(SFX.LEVEL_UP, { volume: 0.5 });
      this.floatingText.push(player.x, player.y - 36, result.label, { color: '#6fe3c4', size: 14, life: 1.1 });
      this.events.emit('player:consumable', { key, result });
      return result;
    };
    if (input.wasPressed('useMedkit')) tryUse('medkit');
    if (input.codePressed('KeyG')) tryUse('armorplate');
    if (input.codePressed('KeyT')) tryUse('stim');
  }

  _updatePendingExplosions(dt) {
    for (let i = this.pendingExplosions.length - 1; i >= 0; i -= 1) {
      const entry = this.pendingExplosions[i];
      entry.delay -= dt;
      if (entry.delay > 0) continue;
      this.pendingExplosions.splice(i, 1);
      const prop = entry.prop;
      if (!prop.alive) continue;
      prop.alive = false;
      this.combat.onPropDestroyed(prop);
    }
  }

  _updateZones(dt) {
    const player = this.player;
    const objectivesDone = this.objectives.allComplete;
    const gate = objectivesDone ? true : 'OBJECTIVE INCOMPLETE';

    const extractResult = this.extractionZone.update(dt, player, gate);
    if (extractResult.started) {
      this.audio.play(SFX.EXTRACTION_START);
      this.events.emit('extraction:start', {});
    }
    if (extractResult.state === 'channelling') {
      this.extractionStats = extractResult;
      if (Math.floor(this.extractionZone.progress * 2) !== Math.floor((this.extractionZone.progress - dt) * 2)) {
        this.audio.play(SFX.EXTRACTION_CHANNEL);
      }
      this.particles.spawnRing(this.extractionZone.x, this.extractionZone.y, this.extractionZone.radius * (0.85 + extractResult.progress * 0.3), '#6fe3c4', {
        life: 0.4,
        alpha: 0.4,
      });
    }
    if (extractResult.state === 'complete') {
      this.finish(true, RUN_STATE.EXTRACTED);
      return;
    }

    if (this.descendZone) {
      const descendGate = objectivesDone && this._sectorAllowsDescend() ? true : objectivesDone ? 'SECTOR LOCKED' : 'OBJECTIVE INCOMPLETE';
      const descendResult = this.descendZone.update(dt, player, descendGate);
      if (descendResult.started) this.audio.play(SFX.DESCEND_START);
      if (descendResult.state === 'channelling') {
        this.particles.spawnRing(this.descendZone.x, this.descendZone.y, this.descendZone.radius * (0.85 + descendResult.progress * 0.3), '#c084fc', {
          life: 0.4,
          alpha: 0.4,
        });
      }
      if (descendResult.state === 'complete') {
        this._advanceSector();
      }
    }

    // Boss arena trigger.
    const boss = this.spawner.boss;
    if (boss && boss.alive && !this.bossWavesTriggered) {
      const room = this.zone.rooms.find((r) => r.id === boss.roomId || r.type === 'boss');
      if (room) {
        const inRoom = player.x > room.rect.x - 60 && player.x < room.rect.x + room.rect.w + 60
          && player.y > room.rect.y - 60 && player.y < room.rect.y + room.rect.h + 60;
        if (inRoom) {
          this.bossWavesTriggered = true;
          this.spawner.triggerBossWaves();
        }
      }
    }
  }

  _sectorAllowsDescend() {
    return this.tier < MAX_SECTOR;
  }

  _advanceSector() {
    if (this.tier >= MAX_SECTOR) {
      this.finish(true, RUN_STATE.EXTRACTED);
      return;
    }
    this.stats.sectorsCleared += 1;
    this.audio.play(SFX.DESCEND_COMPLETE);
    this.flash = 0.8;
    this.events.emit('sector:descend', { from: this.tier, to: this.tier + 1 });
    const carriedObjectiveState = null;
    this.rng = new Rng(`${this.seed}:sim:${this.tier + 1}`);
    this._buildSector(this.tier + 1, carriedObjectiveState);
    this.flash = 0.6;
  }

  _updateAudioState() {
    const bossAlive = this.spawner.bossAlive && this.spawner.boss && this.spawner.boss.alerted;
    const inCombat = this.threatLevel > 0.2 || this.spawner.enemies.some(
      (e) => e.alive && e.alerted && dist2(e.x, e.y, this.player.x, this.player.y) < 620 * 620,
    );
    let music = MUSIC_STATES.EXPLORE;
    if (bossAlive) music = MUSIC_STATES.BOSS;
    else if (this.extractionZone.active) music = MUSIC_STATES.EXTRACTION;
    else if (inCombat) music = MUSIC_STATES.COMBAT;
    if (music !== this.musicState) {
      this.musicState = music;
      this.audio.startMusic(music);
    }

    const ambient = this.tier % 3 === 0
      ? AMBIENT_STATES.REACTOR
      : this.tier % 3 === 1
        ? AMBIENT_STATES.FOUNDRY
        : AMBIENT_STATES.DEPOT;
    if (ambient !== this.ambientState) {
      this.ambientState = ambient;
      this.audio.startAmbient(ambient);
    }
  }

  // -------------------------------------------------------------------------
  // XP / levels
  // -------------------------------------------------------------------------

  /** In-run XP. Every point is banked to the account at settlement too. */
  grantXpFromKill(amount, levelUpCallback) {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    this.xpEarnedTotal += amount;
    this.xp += amount;
    let gained = 0;
    while (this.level < 20 && this.xp >= runXpForLevel(this.level)) {
      this.xp -= runXpForLevel(this.level);
      this.level += 1;
      gained += 1;
      this._applyPerk(this.level);
      if (levelUpCallback) levelUpCallback(this.level);
    }
    return gained;
  }

  xpProgress() {
    const needed = runXpForLevel(this.level);
    return { level: this.level, current: this.xp, needed, ratio: needed > 0 ? clamp(this.xp / needed, 0, 1) : 1 };
  }

  // -------------------------------------------------------------------------
  // Loot notifications
  // -------------------------------------------------------------------------

  notifyPickup(drop, result) {
    this.stats.lootCollected += 1;
    if (result.type === 'weapon' && result.onDuplicate) result.onDuplicate();
    const rare = drop.rarity === 'rare' || drop.rarity === 'epic' || drop.rarity === 'legendary';
    this.audio.play(rare ? SFX.LOOT_RARE : SFX.LOOT_PICKUP, { volume: rare ? 0.6 : 0.5 });
    this.pickupLog.push({
      text: result.label,
      detail: result.type === 'resource' || result.type === 'ammo' ? `+${result.amount}` : '',
      color: drop.color,
      life: 2.6,
    });
    while (this.pickupLog.length > 5) this.pickupLog.shift();
    this.events.emit('loot:pickup', { drop, result });
  }

  // -------------------------------------------------------------------------
  // End of run
  // -------------------------------------------------------------------------

  /** @param {boolean} extracted @param {string} state */
  finish(extracted, state) {
    if (this.finished) return;
    this.finished = true;
    this.state = state;
    const player = this.player;
    this.result = {
      seed: this.seed,
      extracted,
      sector: this.tier,
      sectorsCleared: this.stats.sectorsCleared,
      elapsed: this.elapsed,
      kills: this.stats.kills,
      elitesKilled: this.stats.elitesKilled,
      bossKills: this.stats.bossKills,
      xp: Math.round(this.xpEarnedTotal),
      damageDealt: Math.round(this.stats.damageDealt),
      damageTaken: Math.round(this.stats.damageTaken),
      objectivesCompleted: this.stats.objectivesCompleted,
      loot: { ...player.loot },
      lootValue: player.lootValue(),
      cores: player.loot.cores ?? 0,
      accuracy: player.stats.shotsFired > 0 ? player.stats.shotsHit / player.stats.shotsFired : 0,
      shotsFired: player.stats.shotsFired,
      shotsHit: player.stats.shotsHit,
      dashes: player.stats.dashes,
      lootCollected: this.stats.lootCollected,
      level: this.level,
      state,
    };
    this.audio.stopAmbient();
    this.audio.startMusic(MUSIC_STATES.RESULTS);
    this.musicState = MUSIC_STATES.RESULTS;
    this.events.emit('run:finished', this.result);
  }

  abandon() {
    if (this.finished) return;
    this.finish(false, RUN_STATE.ABANDONED);
  }

  /** Snapshot used to persist a resumable run and to write the death summary. */
  serializeForResume() {
    const player = this.player;
    return {
      seed: this.seed,
      tier: this.tier,
      elapsed: this.elapsed,
      sectorTime: this.sectorTime,
      loot: { ...player.loot },
      weapons: player.weapons.map((w) => w.id),
      reserve: player.ammo.serialize(),
      health: player.health,
      armor: player.armor,
      kills: this.stats.kills,
      objectivesCompleted: this.stats.objectivesCompleted,
      startedAt: Date.now() - Math.round(this.elapsed * 1000),
      objectiveState: this.objectives.serialize(),
    };
  }

  /** Compact world-state snapshot for tests and debugging. */
  debugSnapshot() {
    return {
      seed: this.seed,
      tier: this.tier,
      elapsed: Math.round(this.elapsed * 100) / 100,
      player: {
        x: Math.round(this.player.x),
        y: Math.round(this.player.y),
        health: Math.round(this.player.health),
        armor: Math.round(this.player.armor),
        energy: Math.round(this.player.energy),
        weapon: this.player.weapon?.id ?? null,
        ammo: this.player.weapon?.ammo ?? 0,
        loot: { ...this.player.loot },
      },
      enemies: this.spawner.enemies.filter((e) => e.alive).length,
      lootDrops: this.loot.drops.filter((d) => d.active).length,
      objectives: this.objectives.objectives.map((o) => ({ id: o.id, progress: o.progress, target: o.target, complete: o.complete })),
      extractionReady: this.objectives.allComplete,
    };
  }

  dispose() {
    this.audio.stopAmbient();
    this.particles.reset();
    this.projectiles.reset();
  }
}

export { TEAM, DROP_KIND, OBJECTIVE_TYPES, TAU };
