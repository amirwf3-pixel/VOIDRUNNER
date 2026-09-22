/**
 * Game shell: state machine, main loop, and the bridge between input, screens
 * and the run. This is the only place that knows about every top-level system.
 *
 * States: boot -> menu -> (upgrades | settings | help) and
 *         playing <-> paused -> results
 *
 * The loop is a fixed-order pipeline:
 *   read input -> update active state -> render -> flush edge input.
 */

import { EventBus } from '../core/events.js';
import { Input } from '../core/input.js';
import { Rng, generateSeedCode, isValidSeedCode } from '../core/rng.js';
import { clamp, formatTime } from '../core/math.js';
import { Renderer } from '../render/renderer.js';
import { UIContext } from '../ui/widgets.js';
import { Hud } from '../ui/hud.js';
import {
  HelpScreen,
  MainMenuScreen,
  PauseScreen,
  ResultsScreen,
  SettingsScreen,
  ToastStack,
  UpgradesScreen,
} from '../ui/screens.js';
import { AudioEngine, MUSIC_STATES, SFX } from '../audio/audio.js';
import { SaveSystem } from '../save/save.js';
import { Progression } from '../progression/progression.js';
import { Run, RUN_STATE } from './run.js';

export const GAME_STATE = {
  BOOT: 'boot',
  MENU: 'menu',
  UPGRADES: 'upgrades',
  SETTINGS: 'settings',
  HELP: 'help',
  PLAYING: 'playing',
  PAUSED: 'paused',
  RESULTS: 'results',
  FATAL: 'fatal',
};

/** States that should render the in-game world behind the UI. */
const IN_GAME_STATES = new Set([GAME_STATE.PLAYING, GAME_STATE.PAUSED, GAME_STATE.RESULTS]);

export class Game {
  /**
   * @param {Object} config
   * @param {HTMLCanvasElement} config.canvas
   * @param {HTMLElement} [config.container]
   */
  constructor({ canvas, container = null }) {
    if (!canvas) throw new TypeError('Game requires a canvas element');
    this.canvas = canvas;
    this.container = container ?? canvas.parentElement ?? document.body;
    this.state = GAME_STATE.BOOT;
    this.previousState = GAME_STATE.MENU;
    this.time = 0;
    /** When the current state was entered; used only for UI entrance transitions. */
    this.stateEnteredAt = 0;
    this.frameCount = 0;
    this.fps = 0;
    this._fpsAccumulator = 0;
    this._fpsFrames = 0;
    this.lastFrameTime = 0;
    this.running = false;
    this.rafId = 0;
    this.fatalError = null;
    this.pendingSeed = generateSeedCode();
    this.resultsSummary = null;
    this.resultsResult = null;
    this.settingsReturnState = GAME_STATE.MENU;
    this.resetArmed = false;
    this.toastStack = new ToastStack();
    this.helpReturnState = GAME_STATE.MENU;

    this.errors = [];
    this.events = new EventBus({
      onError: (error, type) => this.reportError(error, `event:${type}`),
    });

    this.saveSystem = new SaveSystem({
      onError: (error, context) => this.reportError(error, `save:${context}`),
    });
    this.profile = this.saveSystem.load();
    if (this.saveSystem.lastLoadWarning) {
      this.toastStack.push(this.saveSystem.lastLoadWarning, 'warn');
    }
    this.progression = new Progression(this.profile);

    this.audio = new AudioEngine({
      getVolume: () => this.profile.settings.audio,
      onError: (error) => this.reportError(error, 'audio'),
    });

    this.input = new Input(canvas);
    this.renderer = new Renderer(canvas, {
      onError: (error, context) => this.reportError(error, `render:${context}`),
    });
    this.ui = new UIContext();
    // The HUD and the renderer both read `ui.settings.video`; without this the
    // HUD threw on every frame that drew the minimap. Settings objects are
    // mutated in place by the settings screen, so a shared reference is stable.
    this.ui.settings = this.profile.settings;
    // Presentation preference only: honour the OS reduced-motion setting so
    // screen transitions never animate for players who ask for stillness.
    this.ui.reducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.hud = new Hud();

    this.screens = {
      menu: new MainMenuScreen(),
      pause: new PauseScreen(),
      settings: new SettingsScreen(),
      upgrades: new UpgradesScreen(),
      help: new HelpScreen(),
      results: new ResultsScreen(),
    };

    this.run = null;
    this.actions = this._buildActions();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this._onVisibility = () => {
      if (document.hidden && this.state === GAME_STATE.PLAYING) this.pause();
    };
    document.addEventListener('visibilitychange', this._onVisibility);
    // Unloading (close, reload, navigate) flushes the profile. A run still in
    // progress is snapshotted first, so the resume point matches the moment the
    // page went away instead of falling back to the last checkpoint; it is the
    // same payload a pause writes and still exactly one storage write.
    this._onBeforeUnload = () => {
      if (!this._checkpointRun()) this.persistProfile();
    };
    window.addEventListener('beforeunload', this._onBeforeUnload);

    this.resize();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  reportError(error, context) {
    const entry = { error, context, time: Date.now() };
    this.errors.push(entry);
    if (this.errors.length > 40) this.errors.shift();
    console.error(`[VOIDRUNNER] ${context}:`, error);
  }

  start() {
    if (this.running) return;
    this.running = true;
    // Nothing else ever leaves BOOT, which left the state machine stuck in
    // "boot" while the menu was already on screen. The loop owning the first
    // frame is what ends the boot phase.
    if (this.state === GAME_STATE.BOOT) this.setState(GAME_STATE.MENU);
    this.lastFrameTime = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      const dt = Math.min(0.05, Math.max(0, (now - this.lastFrameTime) / 1000));
      this.lastFrameTime = now;
      try {
        this.tick(dt);
      } catch (error) {
        this.reportError(error, 'tick');
        this.fatalError = error;
        this.state = GAME_STATE.FATAL;
        this.running = false;
        cancelAnimationFrame(this.rafId);
        this.renderFatal(error);
      }
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    this.input.dispose();
    this.audio.dispose();
    if (this.run) this.run.dispose();
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    const width = rect.width > 0 ? rect.width : window.innerWidth;
    const height = rect.height > 0 ? rect.height : window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = this.renderer.resize(width, height, dpr);
    this.ui.dpr = size.dpr;
    if (this.run) this.run.camera.setViewport(size.width, size.height);
  }

  // -------------------------------------------------------------------------
  // Actions (wired to every UI control)
  // -------------------------------------------------------------------------

  _buildActions() {
    return {
      newRun: () => this.startRun(),
      continueRun: () => this.continueRun(),
      openUpgrades: () => this.setState(GAME_STATE.UPGRADES),
      openSettings: () => {
        this.settingsReturnState = this.state === GAME_STATE.SETTINGS ? GAME_STATE.MENU : this.state;
        this.setState(GAME_STATE.SETTINGS);
      },
      openHelp: () => {
        this.helpReturnState = this.state === GAME_STATE.HELP ? GAME_STATE.MENU : this.state;
        this.setState(GAME_STATE.HELP);
      },
      back: () => this.goBack(),
      quit: () => this.quitToMenu(),
      resume: () => this.resume(),
      restart: () => this.restartRun(),
      toMainMenu: () => this.quitToMenu(),
      saveNow: () => this.persistProfile(),
      setSeed: (seed) => {
        this.pendingSeed = seed;
      },
      getSeed: () => this.pendingSeed,
      rerollSeed: () => {
        this.pendingSeed = generateSeedCode(new Rng((Math.random() * 0xffffffff) >>> 0));
        this.audio.play(SFX.UI_MOVE);
      },
      purchaseUpgrade: (id) => {
        const result = this.progression.purchase(id, 1);
        if (result.ok) this.persistProfile();
        return result;
      },
      resetProgress: () => {
        this.progression.resetAccount();
        this.persistProfile();
      },
    };
  }

  setState(next) {
    if (this.state === next) return;
    this.previousState = this.state;
    this.state = next;
    this.stateEnteredAt = this.time;
    this.events.emit('game:state', { from: this.previousState, to: next });
    if (next === GAME_STATE.MENU) {
      this.audio.startMusic(MUSIC_STATES.MENU);
      this.audio.stopAmbient();
    }
    if (next === GAME_STATE.UPGRADES || next === GAME_STATE.SETTINGS || next === GAME_STATE.HELP) {
      this.audio.startMusic(MUSIC_STATES.MENU);
    }
    if (next === GAME_STATE.PLAYING) {
      this.audio.setSuspended(false);
    }
  }

  goBack() {
    const from = this.state;
    if (from === GAME_STATE.SETTINGS) {
      const target = this.settingsReturnState === GAME_STATE.SETTINGS || this.settingsReturnState === GAME_STATE.BOOT
        ? GAME_STATE.MENU
        : this.settingsReturnState;
      this.setState(target);
    } else if (from === GAME_STATE.HELP) {
      const target = this.helpReturnState === GAME_STATE.HELP || this.helpReturnState === GAME_STATE.BOOT
        ? GAME_STATE.MENU
        : this.helpReturnState;
      this.setState(target);
    } else if (from === GAME_STATE.UPGRADES) {
      this.setState(GAME_STATE.MENU);
    } else {
      this.setState(GAME_STATE.MENU);
    }
    this.audio.play(SFX.UI_BACK);
  }

  // -------------------------------------------------------------------------
  // Run management
  // -------------------------------------------------------------------------

  startRun(seedOverride = null) {
    const seed = seedOverride
      ?? (isValidSeedCode(this.pendingSeed) ? this.pendingSeed.trim() : generateSeedCode());
    this.pendingSeed = seed;
    this._createRun({ seed, startTier: 1, resume: null });
    this.audio.unlock();
    this.setState(GAME_STATE.PLAYING);
    this.events.emit('run:start', { seed });
  }

  continueRun() {
    const resume = this.profile.run;
    if (!resume) {
      this.toastStack.push('No run to continue.', 'warn');
      this.audio.play(SFX.UI_ERROR);
      return;
    }
    this.pendingSeed = resume.seed;
    this._createRun({ seed: resume.seed, startTier: resume.tier, resume });
    this.audio.unlock();
    this.setState(GAME_STATE.PLAYING);
    this.events.emit('run:resume', { seed: resume.seed, tier: resume.tier });
  }

  /**
   * Replays the current contract from sector 1 with the same seed.
   *
   * This is a retry, not an exit: the attempt in progress is intentionally
   * discarded without settlement - no salvage is banked and no run/death is
   * recorded, because the run is not ending, it is starting over. Settling a
   * retry would also let a player bank salvage and then replay the same loot
   * from the same seed, so discarding is the safe side of the asymmetry.
   * Leaving a run for good goes through `quitToMenu()`, whose abandon path
   * settles exactly once like a death.
   */
  restartRun() {
    const seed = this.run ? this.run.seed : this.pendingSeed;
    this._createRun({ seed, startTier: 1, resume: null });
    this.setState(GAME_STATE.PLAYING);
    this.audio.unlock();
    this.toastStack.push('Run restarted.', 'good');
  }

  _createRun({ seed, startTier, resume }) {
    if (this.run) {
      this.run.dispose();
      this.run = null;
    }
    this.run = new Run({
      seed,
      startTier,
      resume,
      profile: this.profile,
      progression: this.progression,
      audio: this.audio,
      events: this.events,
      genParams: {},
      onCheckpoint: () => this._checkpointRun(),
    });
    this.run.particles.density = this.profile.settings.video.particles;
    this.run.floatingText.enabled = this.profile.settings.video.damageNumbers;
    this.run.camera.setViewport(this.renderer.viewWidth, this.renderer.viewHeight);
    this.run.camera.setBounds(this.run.zone.bounds);
    this.resultsSummary = null;
    this.resultsResult = null;
    // The stored run marks it as in-progress; it is re-saved on pause and on
    // every sector change.
    this._checkpointRun();
  }

  /**
   * Refreshes the resumable-run snapshot from the live run and writes it.
   * This is the single writer of `profile.run` during a run: it runs at run
   * creation, on pause (including the automatic pause when the page becomes
   * hidden), on every sector change (via the run's checkpoint hook) and when
   * the page is unloaded. A finished run never leaves a resume behind.
   */
  _checkpointRun() {
    if (!this.run || this.run.finished) return false;
    this.profile.run = this.run.serializeForResume();
    return this.persistProfile();
  }

  pause() {
    if (this.state !== GAME_STATE.PLAYING) return;
    this.setState(GAME_STATE.PAUSED);
    this._checkpointRun();
    this.audio.play(SFX.UI_CLICK);
  }

  resume() {
    if (this.state !== GAME_STATE.PAUSED) return;
    this.setState(GAME_STATE.PLAYING);
    this.audio.play(SFX.UI_CLICK);
  }

  quitToMenu() {
    if (this.run && this.state !== GAME_STATE.RESULTS) {
      this.run.abandon();
      this._settleRun(this.run.result);
    }
    this.run = null;
    this.profile.run = null;
    this.persistProfile();
    this.setState(GAME_STATE.MENU);
  }

  _settleRun(result) {
    if (!result) return;
    // Only settle once per run.
    if (result.__settled) return;
    result.__settled = true;
    const summary = this.progression.settleRun({
      extracted: result.extracted,
      sector: result.sector,
      xp: result.xp,
      cores: result.cores,
      kills: result.kills,
      elapsed: result.elapsed,
      damageDealt: result.damageDealt,
      lootValue: result.lootValue,
      bossKills: result.bossKills,
      seed: result.seed,
    });
    this.resultsSummary = summary;
    this.resultsResult = result;
    this.profile.run = null;
    this.persistProfile();
    return summary;
  }

  persistProfile() {
    if (!this.profile) return false;
    return this.saveSystem.save(this.profile);
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  tick(dt) {
    this.lastDt = dt;
    this.time += dt;
    this.frameCount += 1;
    this._fpsAccumulator += dt;
    this._fpsFrames += 1;
    if (this._fpsAccumulator >= 0.4) {
      this.fps = this._fpsFrames / this._fpsAccumulator;
      this._fpsAccumulator = 0;
      this._fpsFrames = 0;
    }
    this.toastStack.update(dt);
    this._updateActiveState(dt);
    this.render();
    this._handleGlobalInput();
    this.input.endFrame();
  }

  _handleGlobalInput() {
    const input = this.input;
    // Audio must be unlocked by a user gesture.
    if (!this.audio.unlocked && (input.pointerClicked(0) || input.pressed.size > 0)) {
      this.audio.unlock();
    }

    const textFieldActive = this.ui.textFieldActive;
    const typing = this.state === GAME_STATE.MENU && textFieldActive;

    if (!typing && input.wasPressed('pause')) {
      if (this.state === GAME_STATE.PLAYING) this.pause();
      else if (this.state === GAME_STATE.PAUSED) this.resume();
      else if (this.state === GAME_STATE.UPGRADES || this.state === GAME_STATE.HELP || this.state === GAME_STATE.SETTINGS) this.goBack();
    }
    if (input.wasPressed('cancel') && !typing) {
      if (this.state === GAME_STATE.UPGRADES || this.state === GAME_STATE.HELP || this.state === GAME_STATE.SETTINGS) this.goBack();
    }
    // Enter / Space activate whatever the player is pointing at or focused with
    // the keyboard. The results screen keeps its own Enter = New Run shortcut.
    if (!typing && this.state !== GAME_STATE.RESULTS && input.wasPressed('confirm')) {
      this.ui.activateFocused();
    }
    if (this.state === GAME_STATE.RESULTS && !typing && input.wasPressed('confirm')) {
      this.startRun();
    }
  }

  _updateActiveState(dt) {
    switch (this.state) {
      case GAME_STATE.PLAYING: {
        if (!this.run) {
          this.setState(GAME_STATE.MENU);
          return;
        }
        // The aim cursor is needed by both aiming and the crosshair renderer.
        this.run.aimCursor = this.run.camera.screenToWorld(this.input.pointer.x, this.input.pointer.y);
        this.run.update(dt, this.input);
        if (this.run.finished) {
          this._settleRun(this.run.result);
          this.setState(GAME_STATE.RESULTS);
        }
        break;
      }
      case GAME_STATE.PAUSED:
      case GAME_STATE.RESULTS:
      case GAME_STATE.MENU:
      case GAME_STATE.UPGRADES:
      case GAME_STATE.SETTINGS:
      case GAME_STATE.HELP:
      default:
        this.audio.updateSteps(0, false);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render() {
    const ui = this.ui;
    ui.begin(
      this.renderer.ctx,
      this.input,
      this.renderer.viewWidth,
      this.renderer.viewHeight,
      this.time,
      this.lastDt ?? 0.016,
    );
    this.lastUiWidth = ui.width;
    this.lastUiHeight = ui.height;
    // Presentation-only hints for the UI layer: how long the current screen has
    // been on screen, and where toasts should dock (they would otherwise sit on
    // top of the in-run HUD).
    ui.stateTime = this.time - this.stateEnteredAt;
    const toastsVisible = this.toastStack.items.length > 0;
    if (this.state === GAME_STATE.PAUSED || this.state === GAME_STATE.RESULTS) {
      // Full-panel modals: the toast takes a strip of its own at the top and
      // the panel is nudged down, so a notification never covers their content.
      ui.toastAnchor = 'top';
      ui.toastY = 10;
      ui.toastInset = toastsVisible ? 42 : 0;
    } else if (IN_GAME_STATES.has(this.state)) {
      // In-run, toasts drop in under the objective panel.
      ui.toastAnchor = 'top';
      ui.toastY = 150;
      ui.toastInset = 0;
    } else {
      // Menus: above their footer / bottom hints.
      ui.toastAnchor = 'bottom';
      ui.toastY = ui.height - 66;
      ui.toastInset = 0;
    }

    const scene = {
      run: IN_GAME_STATES.has(this.state) ? this.run : null,
      ui,
      time: this.time,
      dt: this.lastDt ?? 0.016,
      fps: this.fps,
      profile: this.profile,
      progression: this.progression,
      audio: this.audio,
      saveSystem: this.saveSystem,
      input: this.input,
      debugSuffix: this.errors.length > 0 ? `  |  ERRORS ${this.errors.length}` : '',
    };

    if (this.state === GAME_STATE.PLAYING && this.run) {
      ui.draw = (ctx, s) => this.hud.draw(ctx, s);
      this.canvas.style.cursor = this.profile.settings.video.cursorLock ? 'none' : 'crosshair';
      this.renderer.draw(scene);
    } else if (IN_GAME_STATES.has(this.state) && this.run) {
      // Pause / results render the frozen world behind the UI.
      if (this.state === GAME_STATE.PAUSED) {
        ui.draw = (ctx, s) => this.hud.draw(ctx, s);
        this.renderer.draw(scene);
        ui.draw = () => {};
        ui.scrim(0.7);
      } else {
        this.renderer.clear();
        ui.scrim(0);
      }
      if (this.state === GAME_STATE.PAUSED) {
        this.screens.pause.draw(this.renderer.ctx, scene, this.actions, { report: this.resultsSummary });
      } else {
        this.screens.results.draw(this.renderer.ctx, scene, this.actions, {
          summary: this.resultsSummary,
          result: this.resultsResult,
        });
      }
    } else {
      ui.draw = null;
      this.renderer.clear();
      this.canvas.style.cursor = 'default';
      this._drawMenuState(this.renderer.ctx, scene);
    }

    // Toasts and error badge render above everything, in CSS pixels.
    const ctx = this.renderer.ctx;
    ctx.save();
    ctx.setTransform(this.ui.dpr ?? 1, 0, 0, this.ui.dpr ?? 1, 0, 0);
    this.toastStack.draw(ui);
    if (this.errors.length > 0 && this.state !== GAME_STATE.FATAL) {
      ui.text(`${this.errors.length} runtime error(s) logged — see console`, ui.width - 16, 16, {
        size: 11,
        color: '#ffb03a',
        align: 'right',
      });
    }
    ctx.restore();

    ui.end();
  }

  _drawMenuState(ctx, scene) {
    const ui = this.ui;
    switch (this.state) {
      case GAME_STATE.UPGRADES:
        this.screens.upgrades.draw(ctx, scene, this.actions, {
          toast: (text, tone) => this.toastStack.push(text, tone),
        });
        break;
      case GAME_STATE.SETTINGS:
        this.screens.settings.draw(ctx, scene, this.actions, {
          overlay: false,
          toast: (text, tone) => this.toastStack.push(text, tone),
          resetArmed: this.resetArmed,
          requestResetConfirm: () => {
            this.resetArmed = true;
            setTimeout(() => {
              this.resetArmed = false;
            }, 4000);
          },
        });
        break;
      case GAME_STATE.HELP:
        this.screens.help.draw(ctx, scene, this.actions, {});
        break;
      case GAME_STATE.MENU:
      default:
        this.screens.menu.draw(ctx, scene, this.actions);
        break;
    }
    ui.drawTooltip();
  }

  renderFatal(error) {
    const ctx = this.renderer.ctx;
    const dpr = this.ui.dpr ?? 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = this.renderer.viewWidth;
    const h = this.renderer.viewHeight;
    ctx.fillStyle = '#0a0508';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ff4d6d';
    ctx.font = '700 26px "Rajdhani", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('VOIDRUNNER ENCOUNTERED A FATAL ERROR', w / 2, h / 2 - 40);
    ctx.fillStyle = '#dce6f2';
    ctx.font = '500 14px "Segoe UI", system-ui, sans-serif';
    ctx.fillText(String(error && error.message ? error.message : error), w / 2, h / 2);
    ctx.fillStyle = '#7d8ea3';
    ctx.font = '400 12px ui-monospace, monospace';
    ctx.fillText('Reload the page to continue. Full details are in the browser console.', w / 2, h / 2 + 30);
  }
}

export { RUN_STATE, formatTime, clamp };
