/**
 * Audio architecture.
 *
 * Every gameplay event maps to one `Sfx` key. The engine synthesises all
 * sounds procedurally with the Web Audio API (oscillators + noise buffers +
 * filters), so the project ships with zero copyrighted assets and still makes
 * real noise. If the browser blocks or lacks Web Audio the engine degrades to
 * a silent but fully functional stub - gameplay never depends on it.
 *
 * Hooks (all implemented):
 *   weapon.fire.<weaponId>   pistol | smg | shotgun | rifle | railpiercer | breaker | arcCaster
 *   weapon.reload.start / .finish
 *   weapon.dryfire
 *   hit.flesh / hit.armor / hit.crit / hit.kill
 *   player.damage / player.death / player.dash / player.heal / player.step
 *   ui.move / ui.click / ui.confirm / ui.back / ui.error
 *   objective.progress / objective.complete / objective.fail
 *   extraction.start / extraction.channel / extraction.success / extraction.abort
 *   descend.start / descend.complete
 *   boss.spawn / boss.phase / boss.death
 *   loot.pickup / loot.rare / levelup
 *   ambient.loop.<zone>   and   music.<state>
 */

export const SFX = {
  PISTOL: 'weapon.fire.pistol',
  SMG: 'weapon.fire.smg',
  SHOTGUN: 'weapon.fire.shotgun',
  RIFLE: 'weapon.fire.rifle',
  RAIL: 'weapon.fire.railpiercer',
  BREAKER: 'weapon.fire.breaker',
  ARC: 'weapon.fire.arcCaster',
  RELOAD_START: 'weapon.reload.start',
  RELOAD_FINISH: 'weapon.reload.finish',
  DRYFIRE: 'weapon.dryfire',
  SWAP: 'weapon.swap',
  SWAP_READY: 'weapon.swap.ready',
  SWAP_FAIL: 'weapon.swap.fail',
  WEAPON_TAIL: 'weapon.tail',
  HIT_FLESH: 'hit.flesh',
  HIT_ARMOR: 'hit.armor',
  HIT_CRIT: 'hit.crit',
  HIT_KILL: 'hit.kill',
  SHIELD_HIT: 'shield.hit',
  SHIELD_BREAK: 'shield.break',
  ENEMY_STAGGER: 'enemy.stagger',
  DEATH_LIGHT: 'enemy.death.light',
  DEATH_HEAVY: 'enemy.death.heavy',
  ELITE_SHIELD: 'elite.shield',
  ELITE_SUMMON: 'elite.summon',
  ELITE_BURST: 'elite.burst',
  PLAYER_DAMAGE: 'player.damage',
  PLAYER_DEATH: 'player.death',
  PLAYER_DASH: 'player.dash',
  PLAYER_HEAL: 'player.heal',
  PLAYER_STEP: 'player.step',
  UI_MOVE: 'ui.move',
  UI_CLICK: 'ui.click',
  UI_CONFIRM: 'ui.confirm',
  UI_BACK: 'ui.back',
  UI_ERROR: 'ui.error',
  OBJECTIVE_PROGRESS: 'objective.progress',
  OBJECTIVE_COMPLETE: 'objective.complete',
  OBJECTIVE_FAIL: 'objective.fail',
  EXTRACTION_START: 'extraction.start',
  EXTRACTION_CHANNEL: 'extraction.channel',
  EXTRACTION_SUCCESS: 'extraction.success',
  EXTRACTION_ABORT: 'extraction.abort',
  DESCEND_START: 'descend.start',
  DESCEND_COMPLETE: 'descend.complete',
  BOSS_SPAWN: 'boss.spawn',
  BOSS_PHASE: 'boss.phase',
  BOSS_DEATH: 'boss.death',
  BOSS_WAVE: 'boss.wave',
  LOOT_PICKUP: 'loot.pickup',
  LOOT_RARE: 'loot.rare',
  LOOT_UPGRADE: 'loot.upgrade',
  LEVEL_UP: 'levelup',
  PLAYER_LOW_HEALTH: 'player.lowhealth',
  SECTOR_START: 'sector.start',
  EXPLOSION: 'combat.explosion',
  MELEE: 'combat.melee',
};

export const MUSIC_STATES = {
  MENU: 'music.menu',
  EXPLORE: 'music.explore',
  COMBAT: 'music.combat',
  BOSS: 'music.boss',
  EXTRACTION: 'music.extraction',
  RESULTS: 'music.results',
};

export const AMBIENT_STATES = {
  FOUNDRY: 'ambient.loop.foundry',
  REACTOR: 'ambient.loop.reactor',
  DEPOT: 'ambient.loop.depot',
};

/** Per-effect synthesis recipes. */
const RECIPES = {
  [SFX.PISTOL]: { type: 'shot', dur: 0.14, f0: 420, f1: 90, noise: 0.5, gain: 0.5, q: 1.2 },
  [SFX.SMG]: { type: 'shot', dur: 0.09, f0: 620, f1: 160, noise: 0.42, gain: 0.36, q: 1.0 },
  [SFX.SHOTGUN]: { type: 'shot', dur: 0.32, f0: 260, f1: 45, noise: 0.95, gain: 0.72, q: 0.8 },
  [SFX.RIFLE]: { type: 'shot', dur: 0.13, f0: 520, f1: 120, noise: 0.55, gain: 0.48, q: 1.1 },
  [SFX.RAIL]: { type: 'rail', dur: 0.5, f0: 1400, f1: 180, noise: 0.35, gain: 0.62 },
  [SFX.BREAKER]: { type: 'shot', dur: 0.11, f0: 380, f1: 95, noise: 0.6, gain: 0.4, q: 1.0 },
  [SFX.ARC]: { type: 'arc', dur: 0.3, f0: 900, f1: 2100, noise: 0.25, gain: 0.45 },
  [SFX.RELOAD_START]: { type: 'click', dur: 0.09, f0: 320, f1: 160, gain: 0.34 },
  [SFX.RELOAD_FINISH]: { type: 'click', dur: 0.12, f0: 210, f1: 420, gain: 0.4 },
  [SFX.DRYFIRE]: { type: 'click', dur: 0.06, f0: 900, f1: 500, gain: 0.24 },
  // A swap is two mechanical events, not one: the weapon goes away and the next
  // one comes up. `SWAP` is the heavy holster clack; `SWAP_READY` is the bolt
  // tick that lands exactly when the raise animation finishes, so the player can
  // hear when the new weapon is actually usable.
  [SFX.SWAP]: { type: 'click', dur: 0.14, f0: 300, f1: 86, gain: 0.34, minGap: 0.05 },
  [SFX.SWAP_READY]: { type: 'click', dur: 0.08, f0: 700, f1: 1280, gain: 0.3, minGap: 0.05 },
  [SFX.SWAP_FAIL]: { type: 'click', dur: 0.06, f0: 240, f1: 180, gain: 0.18, minGap: 0.12 },
  // Low-end body for the heavy weapon classes, layered under their muzzle report.
  [SFX.WEAPON_TAIL]: { type: 'tone', dur: 0.24, f0: 150, f1: 44, gain: 0.34, wave: 'triangle', minGap: 0.05 },
  [SFX.HIT_FLESH]: { type: 'noise', dur: 0.1, f0: 900, f1: 200, gain: 0.36, filter: 'lowpass' },
  [SFX.HIT_ARMOR]: { type: 'noise', dur: 0.09, f0: 2600, f1: 1400, gain: 0.34, filter: 'bandpass', q: 3 },
  [SFX.HIT_CRIT]: { type: 'tone', dur: 0.16, f0: 1250, f1: 1900, gain: 0.34, wave: 'square' },
  [SFX.HIT_KILL]: { type: 'tone', dur: 0.24, f0: 340, f1: 70, gain: 0.4, wave: 'sawtooth' },
  // Energy shields are tonal and layered, plates are noise: two absorb channels
  // that used to share `HIT_ARMOR` are now audibly different problems.
  [SFX.SHIELD_HIT]: { type: 'arc', dur: 0.22, f0: 1200, f1: 480, noise: 0.16, gain: 0.32, minGap: 0.04 },
  [SFX.SHIELD_BREAK]: { type: 'arpeggio', dur: 0.3, notes: [1400, 900], gain: 0.34 },
  [SFX.ENEMY_STAGGER]: { type: 'noise', dur: 0.17, f0: 480, f1: 150, gain: 0.26, filter: 'bandpass', q: 2, minGap: 0.07 },
  // Death mass: light bodies pop, heavy bodies land. Elites keep `HIT_KILL`.
  [SFX.DEATH_LIGHT]: { type: 'tone', dur: 0.18, f0: 520, f1: 120, gain: 0.32, wave: 'triangle' },
  [SFX.DEATH_HEAVY]: { type: 'tone', dur: 0.42, f0: 180, f1: 48, gain: 0.5, wave: 'sawtooth' },
  // Elite abilities get their own voice, one per ability, so what the elite is
  // doing can be identified without looking at it.
  [SFX.ELITE_SHIELD]: { type: 'tone', dur: 0.5, f0: 220, f1: 880, gain: 0.34, wave: 'triangle', minGap: 0.2 },
  [SFX.ELITE_SUMMON]: { type: 'arc', dur: 0.45, f0: 300, f1: 900, noise: 0.3, gain: 0.4, minGap: 0.2 },
  [SFX.ELITE_BURST]: { type: 'tone', dur: 0.3, f0: 900, f1: 180, gain: 0.42, wave: 'square', minGap: 0.15 },
  [SFX.PLAYER_DAMAGE]: { type: 'tone', dur: 0.3, f0: 190, f1: 70, gain: 0.5, wave: 'sawtooth' },
  [SFX.PLAYER_DEATH]: { type: 'tone', dur: 1.1, f0: 240, f1: 40, gain: 0.55, wave: 'sawtooth' },
  [SFX.PLAYER_DASH]: { type: 'noise', dur: 0.24, f0: 1600, f1: 320, gain: 0.3, filter: 'highpass' },
  [SFX.PLAYER_HEAL]: { type: 'tone', dur: 0.4, f0: 520, f1: 1040, gain: 0.34, wave: 'sine' },
  [SFX.PLAYER_STEP]: { type: 'noise', dur: 0.05, f0: 700, f1: 260, gain: 0.1, filter: 'lowpass' },
  [SFX.UI_MOVE]: { type: 'tone', dur: 0.05, f0: 800, f1: 900, gain: 0.16, wave: 'sine' },
  [SFX.UI_CLICK]: { type: 'tone', dur: 0.07, f0: 640, f1: 880, gain: 0.22, wave: 'square' },
  [SFX.UI_CONFIRM]: { type: 'arpeggio', dur: 0.26, notes: [523, 659, 784], gain: 0.28 },
  [SFX.UI_BACK]: { type: 'arpeggio', dur: 0.22, notes: [523, 392], gain: 0.24 },
  [SFX.UI_ERROR]: { type: 'tone', dur: 0.18, f0: 200, f1: 150, gain: 0.34, wave: 'square' },
  [SFX.OBJECTIVE_PROGRESS]: { type: 'tone', dur: 0.16, f0: 700, f1: 980, gain: 0.26, wave: 'sine' },
  [SFX.OBJECTIVE_COMPLETE]: { type: 'arpeggio', dur: 0.5, notes: [523, 659, 784, 1046], gain: 0.34 },
  [SFX.OBJECTIVE_FAIL]: { type: 'arpeggio', dur: 0.5, notes: [440, 349, 262], gain: 0.3 },
  [SFX.EXTRACTION_START]: { type: 'tone', dur: 0.5, f0: 300, f1: 600, gain: 0.34, wave: 'triangle' },
  [SFX.EXTRACTION_CHANNEL]: { type: 'tone', dur: 0.16, f0: 620, f1: 700, gain: 0.16, wave: 'sine' },
  [SFX.EXTRACTION_SUCCESS]: { type: 'arpeggio', dur: 0.9, notes: [392, 523, 659, 784, 1046], gain: 0.42 },
  [SFX.EXTRACTION_ABORT]: { type: 'tone', dur: 0.3, f0: 400, f1: 180, gain: 0.3, wave: 'triangle' },
  [SFX.DESCEND_START]: { type: 'tone', dur: 0.7, f0: 200, f1: 90, gain: 0.4, wave: 'triangle' },
  [SFX.DESCEND_COMPLETE]: { type: 'arpeggio', dur: 0.6, notes: [262, 330, 392, 523], gain: 0.36 },
  [SFX.BOSS_SPAWN]: { type: 'tone', dur: 1.4, f0: 110, f1: 55, gain: 0.6, wave: 'sawtooth' },
  [SFX.BOSS_PHASE]: { type: 'arpeggio', dur: 0.7, notes: [330, 415, 220], gain: 0.42 },
  [SFX.BOSS_DEATH]: { type: 'explosion', dur: 2.0, gain: 0.7 },
  // Boss support waves: a low swell that reads as "more is coming" without
  // borrowing the boss's own spawn/phase cues.
  [SFX.BOSS_WAVE]: { type: 'tone', dur: 0.9, f0: 90, f1: 124, gain: 0.48, wave: 'sawtooth', minGap: 0.5 },
  [SFX.LOOT_PICKUP]: { type: 'tone', dur: 0.1, f0: 800, f1: 1200, gain: 0.24, wave: 'triangle' },
  [SFX.LOOT_RARE]: { type: 'arpeggio', dur: 0.4, notes: [659, 880, 1174], gain: 0.34 },
  // Rare is "valuable"; upgrade is "your kit changed". Chips and weapon-tier
  // pickups use this so a permanent gain never sounds like salvage.
  [SFX.LOOT_UPGRADE]: { type: 'arpeggio', dur: 0.5, notes: [659, 880, 1174, 1568], gain: 0.36 },
  [SFX.LEVEL_UP]: { type: 'arpeggio', dur: 0.7, notes: [523, 659, 784, 1046, 1318], gain: 0.38 },
  // Low-health heartbeat: a quiet sub thump, throttled by the run so it warns
  // without becoming a metronome.
  [SFX.PLAYER_LOW_HEALTH]: { type: 'tone', dur: 0.5, f0: 92, f1: 62, gain: 0.3, wave: 'sine', minGap: 1.0 },
  // Sector start is the low end of the transition hierarchy: descend keeps its
  // rising arpeggio, the opening sector gets its own darker sting.
  [SFX.SECTOR_START]: { type: 'arpeggio', dur: 0.5, notes: [196, 294, 392], gain: 0.32, minGap: 0.5 },
  [SFX.EXPLOSION]: { type: 'explosion', dur: 0.7, gain: 0.6 },
  [SFX.MELEE]: { type: 'noise', dur: 0.14, f0: 1200, f1: 300, gain: 0.32, filter: 'bandpass', q: 1.5 },
};

export class AudioEngine {
  /**
   * @param {Object} [options]
   * @param {() => Record<string, number>} [options.getVolume] returns {master,music,sfx,ambient}
   */
  constructor({ getVolume = null, onError = null } = {}) {
    this.ctx = null;
    this.available = false;
    this.unlocked = false;
    this.buses = null;
    this.getVolume = getVolume ?? (() => ({ master: 0.85, music: 0.55, sfx: 0.8, ambient: 0.5 }));
    this.onError = onError;
    this.noiseBuffer = null;
    this.lastPlayed = new Map();
    this.musicTimers = [];
    this.currentMusic = null;
    this.currentAmbient = null;
    this.ambientNodes = null;
    this._stepAccumulator = 0;
  }

  /** Must be called from a user gesture on most browsers. Safe to call repeatedly. */
  init() {
    if (this.ctx) return this.available;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) {
        this.available = false;
        return false;
      }
      this.ctx = new Ctor({ latencyHint: 'interactive' });
      const master = this.ctx.createGain();
      const music = this.ctx.createGain();
      const sfx = this.ctx.createGain();
      const ambient = this.ctx.createGain();
      for (const node of [music, sfx, ambient]) node.connect(master);
      master.connect(this.ctx.destination);
      this.buses = { master, music, sfx, ambient };
      this.noiseBuffer = this._createNoiseBuffer(1.2);
      this.available = true;
      this.applyVolumes();
      return true;
    } catch (error) {
      this.available = false;
      if (this.onError) this.onError(error);
      else console.warn('[Audio] Web Audio unavailable, running silent:', error);
      return false;
    }
  }

  unlock() {
    if (!this.ctx) this.init();
    if (!this.ctx) return false;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch((error) => {
        if (this.onError) this.onError(error);
      });
    }
    this.unlocked = true;
    return true;
  }

  _createNoiseBuffer(seconds) {
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, Math.floor(rate * seconds), rate);
    const data = buffer.getChannelData(0);
    // Deterministic noise so audio does not perturb any seeded randomness.
    let seed = 0x2545f491;
    for (let i = 0; i < data.length; i += 1) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[i] = ((seed >>> 0) / 4294967296) * 2 - 1;
    }
    return buffer;
  }

  applyVolumes() {
    if (!this.buses) return;
    const v = this.getVolume();
    const master = clampVol(v.master);
    this.buses.master.gain.value = master;
    this.buses.music.gain.value = clampVol(v.music) * 0.62;
    this.buses.sfx.gain.value = clampVol(v.sfx);
    this.buses.ambient.gain.value = clampVol(v.ambient) * 0.4;
  }

  /** @param {string} key one of SFX / MUSIC_STATES / AMBIENT_STATES */
  play(key, { volume = 1, rate = 1, delay = 0 } = {}) {
    if (!this.available || !this.ctx) return false;
    const recipe = RECIPES[key];
    if (!recipe) {
      console.warn(`[Audio] no recipe registered for "${key}"`);
      return false;
    }
    // Simple voice throttling to avoid 30 identical hit sounds in one frame.
    const now = this.ctx.currentTime;
    const last = this.lastPlayed.get(key) ?? -1;
    const minGap = recipe.minGap ?? 0.012;
    if (now - last < minGap) return false;
    this.lastPlayed.set(key, now);
    try {
      const start = now + delay;
      const dest = recipe.bus === 'music' ? this.buses.music : this.buses.sfx;
      switch (recipe.type) {
        case 'shot':
          this._playShot(recipe, start, volume, rate, dest);
          break;
        case 'rail':
          this._playRail(recipe, start, volume, rate, dest);
          break;
        case 'arc':
          this._playArc(recipe, start, volume, rate, dest);
          break;
        case 'click':
          this._playClick(recipe, start, volume, rate, dest);
          break;
        case 'tone':
          this._playTone(recipe, start, volume, rate, dest);
          break;
        case 'noise':
          this._playNoise(recipe, start, volume, rate, dest);
          break;
        case 'arpeggio':
          this._playArpeggio(recipe, start, volume, dest);
          break;
        case 'explosion':
          this._playExplosion(recipe, start, volume, dest);
          break;
        default:
          throw new Error(`Unhandled audio recipe type "${recipe.type}" for "${key}"`);
      }
      return true;
    } catch (error) {
      if (this.onError) this.onError(error);
      else console.warn(`[Audio] failed to play "${key}":`, error);
      return false;
    }
  }

  _env(gainNode, start, dur, peak, attack = 0.004, release = null) {
    const g = gainNode.gain;
    const rel = release ?? dur;
    g.setValueAtTime(0.0001, start);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + attack);
    g.exponentialRampToValueAtTime(0.0001, start + Math.max(attack + 0.01, rel));
  }

  _playShot(recipe, start, volume, rate, dest) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = 'square';
    osc.frequency.setValueAtTime(recipe.f0 * rate, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, recipe.f1 * rate), start + recipe.dur);
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2400, start);
    filter.frequency.exponentialRampToValueAtTime(400, start + recipe.dur);
    filter.Q.value = recipe.q ?? 1;
    osc.connect(filter).connect(oscGain).connect(dest);
    this._env(oscGain, start, recipe.dur, recipe.gain * volume, 0.002, recipe.dur * 0.8);
    osc.start(start);
    osc.stop(start + recipe.dur + 0.05);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const noiseGain = ctx.createGain();
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.setValueAtTime(1800, start);
    noiseFilter.frequency.exponentialRampToValueAtTime(500, start + recipe.dur);
    noiseFilter.Q.value = 0.8;
    noise.connect(noiseFilter).connect(noiseGain).connect(dest);
    this._env(noiseGain, start, recipe.dur, recipe.gain * recipe.noise * volume, 0.001, recipe.dur * 0.7);
    noise.start(start);
    noise.stop(start + recipe.dur + 0.05);
  }

  _playRail(recipe, start, volume, rate, dest) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(recipe.f0 * rate, start);
    osc.frequency.exponentialRampToValueAtTime(recipe.f1, start + recipe.dur);
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(2200, start);
    filter.frequency.exponentialRampToValueAtTime(600, start + recipe.dur);
    filter.Q.value = 4;
    osc.connect(filter).connect(gain).connect(dest);
    this._env(gain, start, recipe.dur, recipe.gain * volume, 0.003, recipe.dur);
    osc.start(start);
    osc.stop(start + recipe.dur + 0.05);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const ng = ctx.createGain();
    const nf = ctx.createBiquadFilter();
    nf.type = 'highpass';
    nf.frequency.value = 900;
    noise.connect(nf).connect(ng).connect(dest);
    this._env(ng, start, 0.18, recipe.gain * recipe.noise * volume, 0.001, 0.18);
    noise.start(start);
    noise.stop(start + 0.25);
  }

  _playArc(recipe, start, volume, rate, dest) {
    const ctx = this.ctx;
    for (let i = 0; i < 3; i += 1) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      const offset = i * 0.018;
      osc.frequency.setValueAtTime(recipe.f0 * (1 + i * 0.35) * rate, start + offset);
      osc.frequency.exponentialRampToValueAtTime(recipe.f1 * (1 + i * 0.1), start + offset + recipe.dur);
      osc.connect(gain).connect(dest);
      this._env(gain, start + offset, recipe.dur * 0.7, (recipe.gain / 3) * volume, 0.002, recipe.dur * 0.7);
      osc.start(start + offset);
      osc.stop(start + offset + recipe.dur);
    }
  }

  _playClick(recipe, start, volume, rate, dest) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(recipe.f0 * rate, start);
    osc.frequency.exponentialRampToValueAtTime(recipe.f1 * rate, start + recipe.dur);
    osc.connect(gain).connect(dest);
    this._env(gain, start, recipe.dur, recipe.gain * volume, 0.001, recipe.dur);
    osc.start(start);
    osc.stop(start + recipe.dur + 0.03);
  }

  _playTone(recipe, start, volume, rate, dest) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = recipe.wave ?? 'sine';
    osc.frequency.setValueAtTime(recipe.f0 * rate, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, recipe.f1 * rate), start + recipe.dur);
    osc.connect(gain).connect(dest);
    this._env(gain, start, recipe.dur, recipe.gain * volume, 0.006, recipe.dur);
    osc.start(start);
    osc.stop(start + recipe.dur + 0.05);
  }

  _playNoise(recipe, start, volume, rate, dest) {
    const ctx = this.ctx;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.playbackRate.value = rate;
    const filter = ctx.createBiquadFilter();
    filter.type = recipe.filter ?? 'lowpass';
    filter.frequency.setValueAtTime(recipe.f0, start);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, recipe.f1), start + recipe.dur);
    filter.Q.value = recipe.q ?? 1;
    const gain = ctx.createGain();
    noise.connect(filter).connect(gain).connect(dest);
    this._env(gain, start, recipe.dur, recipe.gain * volume, 0.002, recipe.dur);
    noise.start(start);
    noise.stop(start + recipe.dur + 0.05);
  }

  _playArpeggio(recipe, start, volume, dest) {
    const notes = recipe.notes ?? [440];
    const step = recipe.dur / notes.length;
    notes.forEach((freq, index) => {
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      const at = start + index * step;
      osc.frequency.setValueAtTime(freq, at);
      osc.connect(gain).connect(dest);
      this._env(gain, at, step * 1.6, (recipe.gain / Math.max(2, notes.length * 0.7)) * volume, 0.004, step * 1.6);
      osc.start(at);
      osc.stop(at + step * 2);
    });
  }

  _playExplosion(recipe, start, volume, dest) {
    const ctx = this.ctx;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(900, start);
    filter.frequency.exponentialRampToValueAtTime(60, start + recipe.dur);
    const gain = ctx.createGain();
    noise.connect(filter).connect(gain).connect(dest);
    this._env(gain, start, recipe.dur, recipe.gain * volume, 0.01, recipe.dur);
    noise.start(start);
    noise.stop(start + recipe.dur + 0.1);

    const sub = ctx.createOscillator();
    const subGain = ctx.createGain();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(90, start);
    sub.frequency.exponentialRampToValueAtTime(30, start + recipe.dur * 0.7);
    sub.connect(subGain).connect(dest);
    this._env(subGain, start, recipe.dur * 0.8, recipe.gain * 0.6 * volume, 0.01, recipe.dur * 0.8);
    sub.start(start);
    sub.stop(start + recipe.dur);
  }

  /** Footstep helper: only fires when the accumulator crosses the interval. */
  updateSteps(dt, moving, speedRatio = 1) {
    if (!moving) {
      this._stepAccumulator = Math.min(this._stepAccumulator, 0.2);
      return;
    }
    this._stepAccumulator += dt * (0.8 + speedRatio);
    if (this._stepAccumulator >= 0.42) {
      this._stepAccumulator = 0;
      this.play(SFX.PLAYER_STEP, { volume: 0.6, rate: 0.85 + Math.random() * 0.3 });
    }
  }

  /**
   * Music is generated as a slow evolving pad + pulse. Each state has its own
   * chord progression and tempo so transitions are audible.
   */
  startMusic(state) {
    if (!this.available || !this.buses) return false;
    if (this.currentMusic === state) return true;
    this.stopMusic();
    const config = MUSIC_CONFIG[state];
    if (!config) {
      console.warn(`[Audio] no music config for "${state}"`);
      return false;
    }
    this.currentMusic = state;
    this._musicConfig = config;
    this._musicStep = 0;
    this._scheduleMusicTick(config);
    return true;
  }

  _scheduleMusicTick(config) {
    const beat = config.beat;
    const playStep = () => {
      if (this.currentMusic === null || !this.ctx) return;
      const step = this._musicStep;
      const chord = config.chords[Math.floor(step / config.chordSteps) % config.chords.length];
      const noteIndex = step % chord.length;
      const now = this.ctx.currentTime;
      const root = chord[noteIndex];
      const dest = this.buses.music;
      // Pad
      this._pad(root, now, beat * config.chordSteps * 0.95, config.padGain, dest);
      // Bass pulse on downbeats
      if (step % config.chordSteps === 0) {
        this._bass(chord[0] / 2, now, beat * 1.6, config.bassGain, dest);
      }
      // Percussive tick
      if (config.percussive && step % 2 === 0) {
        this._perc(now, config.percGain, dest);
      }
      this._musicStep += 1;
    };
    playStep();
    const id = setInterval(playStep, beat * 1000);
    this.musicTimers.push(id);
  }

  _pad(freq, at, dur, gainValue, dest) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc2.type = 'triangle';
    osc2.frequency.value = freq * 1.005;
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    osc.connect(filter);
    osc2.connect(filter);
    filter.connect(gain).connect(dest);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(gainValue, at + dur * 0.35);
    gain.gain.linearRampToValueAtTime(0.0001, at + dur);
    osc.start(at);
    osc2.start(at);
    osc.stop(at + dur + 0.05);
    osc2.stop(at + dur + 0.05);
  }

  _bass(freq, at, dur, gainValue, dest) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = Math.max(30, freq);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 300;
    osc.connect(filter).connect(gain).connect(dest);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(gainValue, at + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  _perc(at, gainValue, dest) {
    const ctx = this.ctx;
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 5000;
    const gain = ctx.createGain();
    noise.connect(filter).connect(gain).connect(dest);
    gain.gain.setValueAtTime(gainValue, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.08);
    noise.start(at);
    noise.stop(at + 0.1);
  }

  stopMusic() {
    for (const id of this.musicTimers) clearInterval(id);
    this.musicTimers.length = 0;
    this.currentMusic = null;
  }

  /** Looping industrial ambience: filtered noise + periodic metal clanks. */
  startAmbient(state) {
    if (!this.available || !this.buses) return false;
    if (this.currentAmbient === state) return true;
    this.stopAmbient();
    const config = AMBIENT_CONFIG[state];
    if (!config) {
      console.warn(`[Audio] no ambient config for "${state}"`);
      return false;
    }
    this.currentAmbient = state;
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = config.filter;
    filter.Q.value = 2.5;
    const gain = ctx.createGain();
    gain.gain.value = 0.0001;
    source.connect(filter).connect(gain).connect(this.buses.ambient);
    source.start();
    gain.gain.linearRampToValueAtTime(config.gain, ctx.currentTime + 1.5);

    // Slow LFO on the filter so the room "breathes".
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.06;
    lfoGain.gain.value = config.filter * 0.35;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();

    this.ambientNodes = { source, gain, lfo, filter };
    const clankTimer = setInterval(() => {
      if (this.currentAmbient !== state) return;
      this.play(SFX.HIT_ARMOR, { volume: 0.18, rate: 0.4 + Math.random() * 0.3 });
    }, config.clankInterval);
    this.musicTimers.push(clankTimer);
    return true;
  }

  stopAmbient() {
    if (this.ambientNodes) {
      try {
        const ctx = this.ctx;
        this.ambientNodes.gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
        this.ambientNodes.source.stop(ctx.currentTime + 0.7);
        this.ambientNodes.lfo.stop(ctx.currentTime + 0.7);
      } catch (error) {
        if (this.onError) this.onError(error);
      }
      this.ambientNodes = null;
    }
    if (this.currentAmbient) {
      for (const id of this.musicTimers) clearInterval(id);
      this.musicTimers.length = 0;
    }
    this.currentAmbient = null;
  }

  /** Pause/unpause everything without losing scheduled state. */
  setSuspended(suspended) {
    if (!this.ctx) return;
    if (suspended && this.ctx.state === 'running') {
      this.ctx.suspend().catch(() => {});
    } else if (!suspended && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  dispose() {
    this.stopMusic();
    this.stopAmbient();
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.available = false;
  }
}

function clampVol(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

const MUSIC_CONFIG = {
  [MUSIC_STATES.MENU]: {
    beat: 0.62,
    chordSteps: 4,
    padGain: 0.09,
    bassGain: 0.07,
    percGain: 0.012,
    percussive: false,
    chords: [
      [130.81, 155.56, 196.0],
      [116.54, 146.83, 174.61],
      [110.0, 130.81, 164.81],
      [98.0, 123.47, 146.83],
    ],
  },
  [MUSIC_STATES.EXPLORE]: {
    beat: 0.5,
    chordSteps: 4,
    padGain: 0.07,
    bassGain: 0.075,
    percGain: 0.014,
    percussive: true,
    chords: [
      [110.0, 130.81, 164.81],
      [116.54, 138.59, 174.61],
      [98.0, 123.47, 146.83],
      [103.83, 130.81, 155.56],
    ],
  },
  [MUSIC_STATES.COMBAT]: {
    beat: 0.3,
    chordSteps: 2,
    padGain: 0.055,
    bassGain: 0.1,
    percGain: 0.03,
    percussive: true,
    chords: [
      [82.41, 98.0, 123.47],
      [87.31, 103.83, 130.81],
      [82.41, 110.0, 123.47],
      [73.42, 92.5, 110.0],
    ],
  },
  [MUSIC_STATES.BOSS]: {
    beat: 0.26,
    chordSteps: 2,
    padGain: 0.05,
    bassGain: 0.13,
    percGain: 0.036,
    percussive: true,
    chords: [
      [55.0, 82.41, 110.0],
      [58.27, 87.31, 116.54],
      [51.91, 77.78, 103.83],
      [49.0, 73.42, 98.0],
    ],
  },
  [MUSIC_STATES.EXTRACTION]: {
    beat: 0.42,
    chordSteps: 3,
    padGain: 0.085,
    bassGain: 0.075,
    percGain: 0.018,
    percussive: true,
    chords: [
      [146.83, 174.61, 220.0],
      [164.81, 196.0, 246.94],
      [130.81, 164.81, 196.0],
    ],
  },
  [MUSIC_STATES.RESULTS]: {
    beat: 0.68,
    chordSteps: 4,
    padGain: 0.075,
    bassGain: 0.06,
    percGain: 0.01,
    percussive: false,
    chords: [
      [130.81, 164.81, 196.0],
      [146.83, 174.61, 220.0],
      [164.81, 196.0, 246.94],
      [174.61, 220.0, 261.63],
    ],
  },
};

const AMBIENT_CONFIG = {
  [AMBIENT_STATES.FOUNDRY]: { filter: 420, gain: 0.16, clankInterval: 4200 },
  [AMBIENT_STATES.REACTOR]: { filter: 260, gain: 0.2, clankInterval: 3100 },
  [AMBIENT_STATES.DEPOT]: { filter: 620, gain: 0.13, clankInterval: 5400 },
};
