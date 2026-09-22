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
import { WEAPON_STATE } from '../weapons/weapon.js';
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
import { MAX_SECTOR, OBJECTIVE_TYPES, OBJECTIVE_XP_BASE, PLAYER_BASE } from '../config/balance.js';
import { AMBIENT_STATES, MUSIC_STATES, SFX } from '../audio/audio.js';
import { sectorTint } from '../config/palette.js';
import { BOSS, ELITE_ABILITY } from '../config/enemies.js';

export const RUN_STATE = {
  ACTIVE: 'active',
  EXTRACTED: 'extracted',
  DEAD: 'dead',
  ABANDONED: 'abandoned',
};

/** In-run level ceiling. Exported so the save validator bounds the same range. */
export const MAX_RUN_LEVEL = 20;

/**
 * In-run level perks. Deterministic, repeatable, and clearly communicated.
 * Exported because the save validator bounds `perkIndex` by the live table.
 */
export const RUN_PERKS = [
  { level: 2, text: '+15 MAX HEALTH', apply: (p) => { p.maxHealth += 15; p.heal(15); } },
  { level: 3, text: '+8% DAMAGE', apply: (p) => { p.damageMul += 0.08; } },
  { level: 4, text: '+15 MAX ENERGY', apply: (p) => { p.maxEnergy += 15; p.addEnergy(15); } },
  { level: 5, text: '+10% RELOAD SPEED', apply: (p) => { p.reloadMul *= 0.9; } },
  { level: 6, text: '+15 ARMOR', apply: (p) => { p.maxArmor += 15; p.addArmor(15); } },
  { level: 7, text: '+6% MOVE SPEED', apply: (p) => { p.baseMoveSpeed *= 1.06; } },
  { level: 8, text: '+10% DAMAGE', apply: (p) => { p.damageMul += 0.1; } },
  { level: 9, text: '+25 MAX HEALTH', apply: (p) => { p.maxHealth += 25; p.heal(25); } },
  // The table used to stop here while the level ceiling kept climbing, so every
  // kill past level 9 was worth nothing in the run. These carry the same axes
  // further: a full six-sector clear lands around level 12-13, and the tail
  // keeps the "one level, one perk" rule true all the way to MAX_RUN_LEVEL.
  { level: 10, text: '+10% DAMAGE', apply: (p) => { p.damageMul += 0.1; } },
  { level: 11, text: '+20 MAX HEALTH', apply: (p) => { p.maxHealth += 20; p.heal(20); } },
  { level: 12, text: '+8% RELOAD SPEED', apply: (p) => { p.reloadMul *= 0.92; } },
  { level: 13, text: '+10 ARMOR', apply: (p) => { p.maxArmor += 10; p.addArmor(10); } },
  { level: 14, text: '+5% MOVE SPEED', apply: (p) => { p.baseMoveSpeed *= 1.05; } },
  { level: 15, text: '+10% DAMAGE', apply: (p) => { p.damageMul += 0.1; } },
  { level: 16, text: '+25 MAX HEALTH', apply: (p) => { p.maxHealth += 25; p.heal(25); } },
  { level: 17, text: '+8% RELOAD SPEED', apply: (p) => { p.reloadMul *= 0.92; } },
  { level: 18, text: '+20 MAX ENERGY', apply: (p) => { p.maxEnergy += 20; p.addEnergy(20); } },
  { level: 19, text: '+12 ARMOR', apply: (p) => { p.maxArmor += 12; p.addArmor(12); } },
  { level: 20, text: '+15% DAMAGE', apply: (p) => { p.damageMul += 0.15; } },
];

/**
 * How each elite ability announces itself: one cue, one colour, one word. The
 * mapping is data so an ability added to `ELITE_ABILITY` shows up in the same
 * place as the rest instead of growing another branch in the AI callback.
 *
 * `fxTime` is how long the sigil stays on the body; the burst sigil also draws
 * the fan it just fired, which is the only warning the player gets for it.
 */
export const ELITE_ABILITY_FEEDBACK = {
  [ELITE_ABILITY.SHIELD]: { sfx: SFX.ELITE_SHIELD, color: '#9fe8ff', label: 'SHIELD UP', ring: 2.4, sparks: 8, fxTime: 0.5 },
  [ELITE_ABILITY.SUMMON]: { sfx: SFX.ELITE_SUMMON, color: '#ffb03a', label: 'REINFORCEMENTS', ring: 2.8, sparks: 10, fxTime: 0.7 },
  [ELITE_ABILITY.BURST]: { sfx: SFX.ELITE_BURST, color: '#ff7ac8', label: 'SPREAD FIRE', ring: 2.2, sparks: 12, fxTime: 0.45 },
};

export function runXpForLevel(level) {
  return Math.round(90 * Math.pow(1.34, Math.max(0, level - 1)));
}

/**
 * Counters are whole numbers: anything non-finite, negative or unparseable
 * becomes zero so a malformed snapshot can never produce NaN in the run result.
 */
function statCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
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
   * @param {() => void} [config.onCheckpoint] notified when the run reaches a
   *   state worth persisting (sector change); storage itself lives with the owner
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
    // Map generation input for this run. A resumed run keeps the parameters it
    // was generated with, so `seed + tier` alone cannot silently regenerate a
    // different sector; fresh runs use the caller's parameters.
    this.genParams = config.resume?.genParams ?? config.genParams ?? {};
    this.onCheckpoint = config.onCheckpoint ?? null;

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
      // Kills are reported with the enemy so a targeted objective (the sector
      // commander) can check whether *that* hostile just died.
      this.objectives.onEnemyKilled(enemy);
      if (enemy.isElite) this.stats.elitesKilled += 1;
      // Spawned enemies (never summons) are remembered by their stable spawn
      // index so a resumed sector does not hand them back for a second reward.
      if (enemy.spawnIndex >= 0) this.defeatedSpawnIds.add(enemy.spawnIndex);
    });
    this.events.on('boss:defeated', () => {
      this.stats.bossKills += 1;
      this.objectives.onBossKilled();
    });
    this.events.on('objective:propDestroyed', ({ objectiveId }) => {
      this.objectives.onPropDestroyed(objectiveId);
    });
    // Death must settle the run in the same tick it happens; waiting for the
    // next update() would leave a corpse-driven run "active" (and in tests,
    // unobservable) if no frame follows the killing blow.
    this.events.on('player:died', () => {
      if (!this.finished) this.finish(false, RUN_STATE.DEAD);
    });
  }

  /** Regenerates the world for a sector; reused on descend and on restart. */
  _buildSector(tier, resume) {
    this.tier = tier;
    // Defeated spawn indices are sector-scoped: they are positions in this
    // sector's deterministic spawn list, so every sector starts fresh and the
    // resume hook below only restores them for a matching tier.
    this.defeatedSpawnIds = new Set();
    this.zone = generateZone({ seed: this.seed, tier, genParams: this.genParams });
    this.tint = sectorTint(tier);
    this.world = new WorldRuntime(this.zone);
    // Destroyed objective props must not come back to life. Applied the moment
    // the world exists — before loot, objectives or gameplay can touch a prop —
    // and only for the matching sector. This restores world state only: progress
    // is owned by `objectiveState` and is never re-reported here, so a resumed
    // save cannot double-count a destruction.
    if (resume && resume.destroyedProps && resume.destroyedProps.tier === tier) {
      this.world.restoreDestroyedProps(resume.destroyedProps.ids);
    }
    this.loot = new LootSystem({ zone: this.zone, progression: this.progression, runSeed: this.seed });
    this.loot.onPickup = (drop, result) => {
      if (drop.objectiveId) this.objectives.onMarkerCollected(drop.objectiveId, drop.id);
      this.notifyPickup(drop, result);
    };
    this.objectives = new ObjectiveRuntime(this.zone);
    this._wireObjectiveCallbacks();
    this.objectives.spawnMarkers(this.loot);
    if (resume) {
      // Objective progress is sector-scoped like the consumed-content sets
      // below: it is only applied when it belongs to the tier being built.
      this.objectives.restore(resume.objectiveState ?? null, tier);
      // Loot collected before the snapshot must not respawn. This runs after the
      // deterministic population exists (zone loot + objective shards) and only
      // ever hides those drops; drops spawned later from kills or props keep
      // their own ids and are never filtered by this set.
      if (resume.collectedDrops && resume.collectedDrops.tier === this.tier) {
        this.loot.restoreCollected(resume.collectedDrops.ids);
      }
    }

    this.spawner = new EnemySpawner(this.zone, new Rng(`${this.seed}:spawn:${tier}`), {
      onSpawn: (enemy) => this._onEnemySpawned(enemy),
    });
    // Enemies defeated before the snapshot must not come back to life, or a
    // reload would re-award their XP, drops and kill credit. Mirrors
    // `collectedDrops` and `destroyedProps` one line up: a resumed sector keeps
    // the content the player already consumed.
    if (resume && resume.defeatedSpawns && resume.defeatedSpawns.tier === tier) {
      const defeated = resume.defeatedSpawns.ids;
      this.spawner.restoreDefeated(defeated);
      // Recorded on the run as well: the spawner only marks the specs, and a
      // second checkpoint has to re-persist the whole set (mirrors how collected
      // drop ids are kept even when they match no freshly seeded drop).
      for (const id of defeated) this.defeatedSpawnIds.add(id);
    }

    const spawn = this.zone.spawnPoint;
    if (resume) {
      // In-run progression is restored before the player exists: the perks the
      // snapshot already earned raise the player's caps, and `Player.restore`
      // clamps the saved health/armor against those caps (see the hook below).
      this._restoreProgression(resume);
      // Weapon entries carry `{id, tier, ammo}`; legacy id-only entries are
      // still accepted by `WeaponInstance.deserialize`.
      this.player = Player.restore(
        {
          weapons: resume.weapons,
          weaponIndex: resume.weaponIndex,
          loot: resume.loot,
          reserve: resume.reserve,
          consumables: resume.consumables,
          health: resume.health,
          armor: resume.armor,
          // Counters the player owns but the run result reports (shots, dashes).
          stats: resume.playerStats,
        },
        spawn,
        this.bonuses,
        // Perks are replayed first so a save taken above the level-1 maximum is
        // not shaved down to the pre-perk cap.
        (player) => this._replayPerks(player),
      );
    } else if (this.player) {
      // Descending keeps the loadout but restores the player to the new spawn.
      // The perks this run already earned are replayed on the rebuilt player for
      // the same reason as on resume: the cursor is carried in `perkIndex`, so
      // without the replay those bonuses would be gone for the rest of the run
      // and could never be earned again. Health carries over exactly as before,
      // free to sit above the level-1 cap, and the 45% floor below now measures
      // against the perk-raised maximum.
      const carried = this.player.serialize();
      this.player = Player.restore(carried, spawn, this.bonuses, (player) => this._replayPerks(player));
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
    // Presentation memos are per-sector like the camera and the particle pool:
    // a rebuilt player must not inherit last sector's dash count as a "new
    // dash", and a fresh sector should start quiet.
    this._dashMemo = undefined;
    this._lowHealthTimer = 0;
    this._descendBlocked = false;
    this._pendingSwapReady = null;
    // The opening sector gets its own sting. Descending already has one, so the
    // two transitions are not the same event twice.
    if (tier === 1 && !resume) {
      this.audio.play(SFX.SECTOR_START, { volume: 0.6 });
      this.flash = Math.max(this.flash, 0.35);
    }
    this.bossIntroPlayed = false;
    this.bossWavesTriggered = false;
    this.spawner.bossWavesTriggered = false;
    this.pendingExplosions.length = 0;
    // Carried run statistics are re-applied last: the resets above are
    // sector-scoped, while the run's totals and elapsed time continue across a
    // resumed sector. Player-owned counters were already restored with the
    // rebuilt player (`Player.restore`).
    // The boss arena's intro wave is consumed content too: it is summoned once,
    // and letting a reload summon it again would re-award its kills and XP. The
    // reset above clears the flag for every freshly built sector, so a matching
    // record is applied here — after that reset — exactly like the tier-scoped
    // sets restored with the world and the spawner.
    if (resume && resume.bossWaves && resume.bossWaves.tier === tier && resume.bossWaves.triggered === true) {
      this.bossWavesTriggered = true;
      this.spawner.bossWavesTriggered = true;
    }
    if (resume) this._restoreStats(resume);
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
      // The bounty pays for the loop's mandatory step. Kills were the only XP
      // source, so completing the objective - the thing every sector asks for -
      // was worth nothing, and the incentive was to farm instead. Scaled by the
      // sector's xp multiplier so it stays relevant at depth, and announced
      // with the completion so its size is never a mystery.
      const bounty = Math.round(OBJECTIVE_XP_BASE * (this.zone.difficulty?.xpMul ?? 1));
      const levelsGained = this.grantXpFromKill(bounty);
      if (levelsGained > 0) this.events.emit('run:levelGained', { count: levelsGained });
      this.floatingText.push(this.player.x, this.player.y - 56, 'OBJECTIVE COMPLETE', {
        color: '#6fe3c4',
        size: 15,
        life: 2,
      });
      if (bounty > 0) {
        this.floatingText.push(this.player.x, this.player.y - 40, `+${bounty} XP`, {
          color: '#c084fc',
          size: 12,
          life: 1.4,
        });
      }
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
      // The arena names itself on entry: same boss, different protocol, so the
      // player knows the phase ladder they are about to face is not the one
      // they already learned in the earlier arena.
      const arena = enemy.arena ?? null;
      this.floatingText.push(enemy.x, enemy.y - 60, BOSS.name, { color: '#ff5c33', size: 22, life: 2.4 });
      this.floatingText.push(enemy.x, enemy.y - 40, arena?.title ?? BOSS.title, { color: '#ffb03a', size: 13, life: 2.4 });
      if (arena?.cycle) {
        this.floatingText.push(enemy.x, enemy.y - 24, arena.cycle, { color: '#ff6b5c', size: 11, life: 2.4 });
      }
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
        if (player.nextWeapon()) this._onWeaponSwap(player.weapon, 1);
        else this.audio.play(SFX.SWAP_FAIL, { volume: 0.7 });
      }
      for (let i = 0; i < 4; i += 1) {
        if (input.wasPressed(`slot${i + 1}`)) {
          // Quick-select is the deliberate version of the same action, so it
          // gets the same bracket at a slightly harder pitch: the two bindings
          // stay tellable apart without being two different systems.
          if (player.switchWeapon(i)) this._onWeaponSwap(player.weapon, 1.08);
          else if (i < player.weapons.length) this.audio.play(SFX.SWAP_FAIL, { volume: 0.5 });
        }
      }
      this._updateSwapReady(player);
      this._updateDashFeedback(player);
      this._updateLowHealthFeedback(player, dt);
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
      // The AI raises elite abilities itself; this is the announcement, so the
      // player learns why the target suddenly stopped taking damage.
      // Elite abilities fire at the moment the elite commits, so the cue has to
      // land on that frame: a bell, a ring in the ability's own colour and a
      // sigil on the body. Shield and summon used to borrow the plate cue and
      // the boss cue, and burst had no feedback at all - a five-shot fan with
      // nothing but the normal attack telegraph under it.
      onEliteAbility: (enemy, ability) => {
        const sigil = ELITE_ABILITY_FEEDBACK[ability];
        if (!sigil) return;
        enemy.abilityFx = { kind: ability, t: sigil.fxTime, color: sigil.color };
        this.audio.play(sigil.sfx, { volume: 0.7, rate: enemy.isBoss ? 0.8 : 1 });
        this.particles.spawnRing(enemy.x, enemy.y, enemy.radius * sigil.ring, sigil.color, { life: 0.5, alpha: 0.6 });
        this.particles.spawnBurst('spark', enemy.x, enemy.y, sigil.sparks, {
          speed: 170,
          life: 0.4,
          color: sigil.color,
          size: 2.2,
          rng: () => this.rng.next(),
        });
        this.floatingText.push(enemy.x, enemy.y - enemy.radius - 12, sigil.label, { color: sigil.color, size: 12, life: 1 });
      },
      // Elite summon ability: adds arrive as summons, so they carry no spawn
      // index and can never be re-paid by a resume.
      summon: (enemy, typeId, count) => this.spawner.summon(typeId, enemy.x, enemy.y, count),
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

  // -------------------------------------------------------------------------
  // Tactile feedback helpers
  // -------------------------------------------------------------------------

  /**
   * Weapon swap. The swap itself is one frame of state change; what the player
   * needs is the two mechanical beats around it — the weapon going away and the
   * next one coming up — plus a visual on the body so the swap is visible when
   * the mix is busy. Feedback only: `raiseDuration` still governs when the
   * weapon can fire.
   */
  _onWeaponSwap(weapon, rate = 1) {
    const player = this.player;
    const color = weapon?.def?.color ?? this.tint?.accent ?? '#9fb3c8';
    this.audio.play(SFX.SWAP, { rate: rate * 0.98 });
    // The second half of the swap is not a scheduled sound: it fires when the
    // weapon actually finishes raising, so a rapid double-swap cannot leave a
    // stale "ready" tick behind describing a weapon that is already stowed.
    this._pendingSwapReady = { rate, color };
    this.particles.spawnRing(player.x, player.y, player.radius * 2.6, color, { life: 0.3, alpha: 0.55 });
    this.particles.spawnBurst('muzzle', player.x, player.y, 5, {
      speed: 90,
      life: 0.22,
      color,
      size: 2.2,
      rng: () => this.rng.next(),
    });
    this.floatingText.push(player.x, player.y - 38, (weapon?.def?.short ?? weapon?.def?.name ?? 'WEAPON').toUpperCase(), {
      color,
      size: 11,
      life: 0.6,
    });
  }

  /**
   * Fires the "weapon up" tick the frame the raise finishes. Watches the state
   * the weapon already exposes, so nothing about when a weapon may fire changes.
   */
  _updateSwapReady(player) {
    const pending = this._pendingSwapReady;
    if (!pending) return;
    if (player.weapon?.state === WEAPON_STATE.RAISING) return;
    this._pendingSwapReady = null;
    this.audio.play(SFX.SWAP_READY, { rate: pending.rate, volume: 0.85 });
    const color = pending.color ?? player.weapon?.def?.color ?? '#9fb3c8';
    this.particles.spawnRing(player.x, player.y, player.radius * 1.8, color, { life: 0.22, alpha: 0.4 });
  }

  /**
   * Dash. The dash has had a recipe since the audio system was written and no
   * caller: the only thing that played was a footstep, which is also what
   * walking plays. Detected by watching the counter the player already owns, so
   * no gameplay code has to know about presentation.
   */
  _updateDashFeedback(player) {
    const dashes = player.stats.dashes;
    if (this._dashMemo === undefined) {
      this._dashMemo = dashes;
      return;
    }
    if (dashes === this._dashMemo) return;
    this._dashMemo = dashes;
    this.audio.play(SFX.PLAYER_DASH, { volume: 0.6, rate: 0.95 + this.rng.next() * 0.1 });
    this.camera.addShake(0.06);
    this.particles.spawnRing(player.x, player.y, player.radius * 2.2, this.tint?.accent ?? '#7fe6ff', { life: 0.28, alpha: 0.5 });
    // Afterimage: a short streak behind the dash so the i-frame window is
    // visible, not just felt.
    this.particles.spawnBurst('muzzle', player.x - player.dashDirX * 10, player.y - player.dashDirY * 10, 6, {
      angle: Math.atan2(-player.dashDirY, -player.dashDirX),
      spread: 0.5,
      speed: 120,
      life: 0.24,
      color: this.tint?.accent ?? '#7fe6ff',
      size: 2.4,
      rng: () => this.rng.next(),
    });
  }

  /**
   * Low health. The vignette is the steady channel; this is the one that
   * reaches a player who is staring at the far side of the screen. Throttled by
   * the run (and by the recipe) so it warns instead of nagging.
   */
  _updateLowHealthFeedback(player, dt) {
    this._lowHealthTimer = Math.max(0, (this._lowHealthTimer ?? 0) - dt);
    const ratio = player.maxHealth > 0 ? player.health / player.maxHealth : 1;
    if (!player.alive || ratio > 0.3 || ratio <= 0) {
      this._lowHealthTimer = 0;
      return;
    }
    if (this._lowHealthTimer > 0) return;
    this._lowHealthTimer = 1.6;
    this.audio.play(SFX.PLAYER_LOW_HEALTH, { volume: 0.5 });
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
      // The payoff for the whole sector. The results music starts a moment
      // later, so this is the sting the player remembers, not the menu.
      this.audio.play(SFX.EXTRACTION_SUCCESS);
      this.flash = 1;
      this.particles.spawnRing(this.extractionZone.x, this.extractionZone.y, this.extractionZone.radius * 1.5, '#6fe3c4', { life: 0.7, alpha: 0.7 });
      this.finish(true, RUN_STATE.EXTRACTED);
      return;
    }

    if (this.descendZone) {
      const descendGate = objectivesDone && this._sectorAllowsDescend() ? true : objectivesDone ? 'SECTOR LOCKED' : 'OBJECTIVE INCOMPLETE';
      const descendResult = this.descendZone.update(dt, player, descendGate);
      if (descendResult.started) this.audio.play(SFX.DESCEND_START);
      // Standing on a locked descent pad used to be silent: the reason existed
      // in the channel state and never reached the player's ears. The zone
      // reports `blocked` for the whole sector while the gate is shut, so this
      // is keyed on the player actually being at the pad - one cue per entry,
      // not one per frame and not one the moment the sector loads.
      const atPad = this.descendZone.contains(player.x, player.y);
      if (descendResult.state === 'blocked' && atPad) {
        if (!this._descendBlocked) {
          this._descendBlocked = true;
          this.audio.play(SFX.OBJECTIVE_FAIL, { volume: 0.45 });
          this.floatingText.push(player.x, player.y - 46, descendResult.reason ?? 'LOCKED', { color: '#ff6b5c', size: 12, life: 1.1 });
        }
      } else if (this._descendBlocked) {
        this._descendBlocked = false;
      }
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
          // Support waves used to arrive out of nowhere. Announce the mechanic
          // once, when the arena locks in, with the same hierarchy as a boss
          // phase: audio + shake + banner, no new UI.
          this.audio.play(SFX.BOSS_WAVE);
          this.camera.addShake(0.6);
          this.flash = Math.max(this.flash, 0.25);
          this.events.emit('boss:waves', { tier: this.tier });
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
    // The new sector is fully built, so this is the first moment at which the
    // carried loadout describes a consistent run.
    this._checkpoint();
    this.flash = 0.6;
  }

  /**
   * Tells the owner the run reached a persistable state. `Run` deliberately
   * knows nothing about storage; the owner decides what a checkpoint means.
   */
  _checkpoint() {
    if (this.onCheckpoint) this.onCheckpoint(this);
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

  /**
   * Applies every run perk the current level has reached, in table order.
   * `perkIndex` is the cursor into RUN_PERKS: each perk is granted exactly
   * once, which also holds when a single kill crosses several thresholds.
   * Levels past the end of the table simply grant nothing.
   */
  _applyPerk(level) {
    while (this.perkIndex < RUN_PERKS.length && RUN_PERKS[this.perkIndex].level <= level) {
      const perk = RUN_PERKS[this.perkIndex];
      this.perkIndex += 1;
      perk.apply(this.player);
    }
  }

  /**
   * Replays the perks a snapshot already earned onto a freshly restored player.
   *
   * `perkIndex` counts the perks granted so far, so replaying exactly that many
   * rebuilds every perk-derived stat (max health/armor/energy, damage, reload,
   * move speed) while leaving the cursor untouched: the restored run still
   * grants each perk once, and the levels already paid for are not paid again.
   */
  _replayPerks(player) {
    for (let i = 0; i < this.perkIndex && i < RUN_PERKS.length; i += 1) RUN_PERKS[i].apply(player);
  }

  /**
   * Restores in-run progression from a resumable snapshot.
   *
   * The save validator clamps these too; they are re-clamped here because a Run
   * can also be built from an in-memory snapshot that never went through it.
   * Restoring `perkIndex` is what makes the replay above exact - it represents
   * perks that were already applied, never perks to grant.
   */
  _restoreProgression(resume) {
    this.level = Math.round(clamp(Number(resume.level) || 1, 1, MAX_RUN_LEVEL));
    this.xp = clamp(Number(resume.xp) || 0, 0, 1e9);
    this.xpEarnedTotal = clamp(Number(resume.xpEarnedTotal) || 0, 0, 1e9);
    this.perkIndex = Math.round(clamp(Number(resume.perkIndex) || 0, 0, RUN_PERKS.length));
  }

  /**
   * Restores the run's accumulated statistics and elapsed time.
   *
   * These are the numbers `finish()`, `settleRun()` and the results screen
   * report, so a resumed run has to continue them instead of starting over: the
   * account records built from them (`totalPlaytimeSeconds`, `totalKills`,
   * `totalBossKills`, `highestDamageRun`) would otherwise count only what
   * happened after the resume, and `fastestExtraction` would be recorded from
   * post-resume-only time.
   *
   * Only the counters that reach the result are restored - simulation state
   * (enemies, projectiles, timers) is rebuilt by the sector build and stays
   * transient, as do the write-only counters nothing reports.
   */
  _restoreStats(resume) {
    // Re-clamped here as well as in the save validator: a Run can also be built
    // from an in-memory snapshot that never went through it.
    this.elapsed = clamp(Number(resume.elapsed) || 0, 0, 1e6);
    this.stats.kills = statCount(resume.kills);
    this.stats.objectivesCompleted = statCount(resume.objectivesCompleted);
    const stats = resume.stats && typeof resume.stats === 'object' ? resume.stats : {};
    this.stats.damageDealt = statCount(stats.damageDealt);
    this.stats.damageTaken = statCount(stats.damageTaken);
    this.stats.elitesKilled = statCount(stats.elitesKilled);
    this.stats.bossKills = statCount(stats.bossKills);
    this.stats.sectorsCleared = statCount(stats.sectorsCleared);
    this.stats.lootCollected = statCount(stats.lootCollected);
  }

  /** In-run XP. Every point is banked to the account at settlement too. */
  grantXpFromKill(amount, levelUpCallback) {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    this.xpEarnedTotal += amount;
    this.xp += amount;
    let gained = 0;
    while (this.level < MAX_RUN_LEVEL && this.xp >= runXpForLevel(this.level)) {
      this.xp -= runXpForLevel(this.level);
      this.level += 1;
      gained += 1;
      this._applyPerk(this.level);
      if (levelUpCallback) levelUpCallback(this.level);
    }
    // One funnel for every XP source, so a level never lands silently: the
    // HUD banner names the perk, this plays the cue and puts a ring on the
    // player. Several levels at once still get one moment, not a queue.
    if (gained > 0) this._onLevelGained(gained);
    return gained;
  }

  /**
   * Level-up feedback. Presentation only — the perk itself was applied above.
   */
  _onLevelGained(count) {
    const player = this.player;
    const color = '#c084fc';
    this.audio.play(SFX.LEVEL_UP, { volume: count > 1 ? 0.7 : 0.55 });
    this.flash = Math.max(this.flash, 0.18);
    this.particles.spawnRing(player.x, player.y, player.radius * 3.4, color, { life: 0.6, alpha: 0.6 });
    this.particles.spawnBurst('spark', player.x, player.y, 10, {
      speed: 150,
      life: 0.5,
      color,
      size: 2.4,
      rng: () => this.rng.next(),
    });
    this.floatingText.push(player.x, player.y - 46, count > 1 ? `LEVEL ${this.level}  (+${count})` : `LEVEL ${this.level}`, {
      color,
      size: 15,
      life: 1.4,
    });
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
    // An upgrade chip carries a payload the loot system cannot bank itself: the
    // run owns XP, levels and perks. The amount was computed and then dropped on
    // the floor, so the rarest drop in the table paid only its scrap value.
    if (result.type === 'chip') {
      const gained = this.grantXpFromKill(result.xp ?? 0);
      if (gained > 0) this.events.emit('run:levelGained', { count: gained });
    }
    const rare = drop.rarity === 'rare' || drop.rarity === 'epic' || drop.rarity === 'legendary';
    // "Permanent gain" is its own category: a chip or a weapon-tier upgrade
    // changes the kit, and it must not sound like another rare pile of scrap.
    const upgrade = result.type === 'chip' || (result.type === 'weapon' && result.upgraded);
    if (upgrade) this.audio.play(SFX.LOOT_UPGRADE, { volume: 0.6 });
    else this.audio.play(rare ? SFX.LOOT_RARE : SFX.LOOT_PICKUP, { volume: rare ? 0.6 : 0.5 });
    // Pickups used to vanish into the HUD ticker with nothing happening where
    // the drop was. A small burst keeps the reward on screen, scaled by how
    // much the drop was worth.
    const burst = upgrade ? 14 : rare ? 9 : 5;
    this.particles.spawnBurst('spark', drop.x, drop.y, burst, {
      speed: upgrade ? 190 : 140,
      life: 0.45,
      color: drop.color,
      size: upgrade ? 2.8 : 2.2,
      rng: () => this.rng.next(),
    });
    this.particles.spawnRing(drop.x, drop.y, upgrade ? 34 : rare ? 24 : 14, drop.color, { life: upgrade ? 0.5 : 0.35, alpha: 0.55 });
    if (upgrade) this.flash = Math.max(this.flash, 0.12);
    this.pickupLog.push({
      text: result.label,
      detail: result.type === 'chip' ? `+${result.xp} XP`
        : result.type === 'resource' || result.type === 'ammo' ? `+${result.amount}` : '',
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

  /** Snapshot persisted as the resumable run (`profile.run`) and rebuilt into a new Run on resume. */
  serializeForResume() {
    const player = this.player;
    return {
      seed: this.seed,
      tier: this.tier,
      elapsed: this.elapsed,
      // `sectorTime` and `startedAt` used to travel here. Neither had a reader
      // (the resume card shows `tier`/`elapsed`/`seed`, and the result reports
      // its own fields), so they are no longer written; `validateResumableRun`
      // still accepts and drops them from payloads an older build persisted.
      loot: { ...player.loot },
      weapons: player.weapons.map((w) => w.serialize()),
      weaponIndex: player.weaponIndex,
      reserve: player.ammo.serialize(),
      consumables: { ...player.consumables },
      health: player.health,
      armor: player.armor,
      kills: this.stats.kills,
      objectivesCompleted: this.stats.objectivesCompleted,
      // Run statistics that feed the result, settlement and account records.
      // Without these a resumed run would report only what happened after the
      // resume, and the records derived from them would be under-counted.
      stats: {
        damageDealt: this.stats.damageDealt,
        damageTaken: this.stats.damageTaken,
        elitesKilled: this.stats.elitesKilled,
        bossKills: this.stats.bossKills,
        sectorsCleared: this.stats.sectorsCleared,
        lootCollected: this.stats.lootCollected,
      },
      // Player-owned counters reported by the same result.
      playerStats: player.serializeStats(),
      // Map generation input. `seed` and `tier` alone only reproduce the sector
      // while these stay at the defaults. The *input* is persisted, never the
      // derived values: `zone.genParams` holds the relaxed parameters of the
      // attempt that validated, and re-feeding those would relax twice.
      genParams: { ...this.genParams },
      // In-run progression. Only the level, XP and perk cursor travel: every
      // perk-derived stat is rebuilt on resume by replaying those perks.
      level: this.level,
      xp: this.xp,
      xpEarnedTotal: this.xpEarnedTotal,
      perkIndex: this.perkIndex,
      objectiveState: { tier: this.tier, ...this.objectives.serialize() },
      // Ground drops already taken in this sector. Ids are only meaningful for
      // the tier they were collected in (each sector restarts at 1).
      collectedDrops: { tier: this.tier, ids: this.loot.collectedIdList() },
      // Objective props destroyed in this sector; prop ids are per-sector
      // positions, so they are tier-scoped for the same reason.
      destroyedProps: { tier: this.tier, ids: this.world.destroyedPropIdList() },
      // Enemy spawn indices defeated in this sector. Same reasoning again: an
      // index is a position in the generator's deterministic spawn list, so it
      // only identifies the same enemy within its own tier.
      defeatedSpawns: { tier: this.tier, ids: Array.from(this.defeatedSpawnIds).sort((a, b) => a - b) },
      // Boss arena intro wave. It is summoned once per sector and awarding its
      // kills/XP again on every reload would be a farmable reward, so the
      // trigger travels with the run and is re-applied for its own tier only.
      bossWaves: { tier: this.tier, triggered: this.bossWavesTriggered },
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
