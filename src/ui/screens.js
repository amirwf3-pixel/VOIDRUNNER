/**
 * Menu screens. Every button maps to a real game transition supplied by the
 * Game class through the `actions` object - there are no inert controls.
 */

import { clamp, clamp01, formatTime } from '../core/math.js';
import { FONTS, FONT_SIZES, PALETTE, rgba } from '../config/palette.js';
import { Rect, VStack, roundRect } from './widgets.js';
import { META_UPGRADES, upgradeCost } from '../config/balance.js';
import { generateSeedCode } from '../core/rng.js';

/**
 * @typedef {Object} MenuActions
 * @property {() => void} newRun
 * @property {() => void} continueRun
 * @property {() => void} openUpgrades
 * @property {() => void} openSettings
 * @property {() => void} openHelp
 * @property {() => void} quit
 * @property {() => void} back
 * @property {() => void} resume
 * @property {() => void} restart
 * @property {() => void} toMainMenu
 * @property {() => void} togglePause
 * @property {(seed: string) => void} setSeed
 * @property {() => void} rerollSeed
 * @property {() => string} getSeed
 * @property {(id: string) => void} purchaseUpgrade
 * @property {() => void} resetProgress
 * @property {() => void} saveNow
 */

export class MainMenuScreen {
  constructor() {
    this.animTime = 0;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} scene
   * @param {MenuActions} actions
   */
  draw(ctx, scene, actions) {
    const ui = scene.ui;
    const { width: w, height: h } = ui;
    const profile = scene.profile;
    this.animTime = ui.time;

    this.drawBackdrop(ctx, ui, w, h);

    const columnW = Math.min(360, w * 0.42);
    const x = Math.max(48, w * 0.4);
    const stack = new VStack(x, h * 0.3, columnW, 12);

    // Title block.
    ui.text('VOID', x, h * 0.2, {
      size: Math.min(76, w * 0.075),
      color: PALETTE.ui,
      font: FONTS.display,
      weight: 800,
      letterSpacing: 8,
    });
    ui.text('RUNNER', x + 4, h * 0.2 + Math.min(62, w * 0.062), {
      size: Math.min(76, w * 0.075),
      color: PALETTE.uiAccent,
      font: FONTS.display,
      weight: 800,
      letterSpacing: 8,
      alpha: 0.95,
    });
    ui.text('EXTRACTION ROGUELITE', x + 6, h * 0.2 + Math.min(96, w * 0.096), {
      size: FONT_SIZES.tiny,
      color: PALETTE.uiDim,
      font: FONTS.display,
      weight: 700,
      letterSpacing: 5,
    });

    const hasRun = Boolean(profile.run);
    const runLabel = hasRun ? 'Continue' : 'No Run In Progress';
    const runHint = hasRun
      ? `SECTOR ${profile.run.tier}  ·  ${formatTime(profile.run.elapsed)}  ·  ${profile.run.seed}`
      : 'Start a new contract to build a run';

    const buttons = [
      { key: 'new', label: 'New Run', variant: 'primary', onClick: () => actions.newRun(), hint: 'ENTER' },
      { key: 'continue', label: runLabel, variant: hasRun ? 'default' : 'ghost', disabled: !hasRun, onClick: () => actions.continueRun(), subtitle: runHint },
      { key: 'upgrades', label: 'Upgrades', onClick: () => actions.openUpgrades(), subtitle: `${profile.account.cores} CORES AVAILABLE` },
      { key: 'settings', label: 'Settings', onClick: () => actions.openSettings() },
      { key: 'help', label: 'Field Manual', onClick: () => actions.openHelp() },
      { key: 'quit', label: 'Quit', variant: 'danger', onClick: () => actions.quit() },
    ];

    for (const button of buttons) {
      const rect = stack.row(button.subtitle ? 56 : 46);
      ui.button(button.key, rect, button.label, {
        onClick: button.onClick,
        disabled: button.disabled,
        variant: button.variant,
        hint: button.hint,
        subtitle: button.subtitle,
      });
    }

    // Seed entry.
    stack.space(8);
    ui.label('RUN SEED (DETERMINISTIC)', x, stack.cursor - 4);
    stack.space(12);
    const seedRect = stack.row(40);
    const seedField = new Rect(seedRect.x, seedRect.y, seedRect.w - 84, seedRect.h);
    const newSeed = ui.textField('seed-field', seedField, actions.getSeed(), {
      placeholder: 'ENTER SEED',
      maxLength: 32,
      onChange: (value) => actions.setSeed(value),
      sanitize: (ch) => (/[A-Za-z0-9\-_ ]/.test(ch) ? ch.toUpperCase() : null),
    });
    void newSeed;
    ui.button('seed-roll', new Rect(seedRect.right - 78, seedRect.y, 78, seedRect.h), 'Random', {
      onClick: () => actions.rerollSeed(),
      variant: 'ghost',
    });
    if (ui.textFieldActive) {
      ui.setTooltip('Click the seed box and type, then press Enter to confirm. Seed controls map generation exactly.');
    }

    // Account summary panel on the right.
    this.drawAccountPanel(ui, profile, new Rect(w - Math.min(360, w * 0.36) - 48, h * 0.24, Math.min(340, w * 0.34), h * 0.52));

    ui.text('WASD move  ·  MOUSE aim  ·  LMB fire  ·  SPACE dash  ·  R reload  ·  Q swap  ·  F kit  ·  ESC pause', w / 2, h - 26, {
      size: FONT_SIZES.micro,
      color: PALETTE.uiFaint,
      align: 'center',
      font: FONTS.display,
      weight: 600,
      letterSpacing: 2,
    });
  }

  drawBackdrop(ctx, ui, w, h) {
    ctx.save();
    const grad = ctx.createRadialGradient(w * 0.28, h * 0.42, 40, w * 0.34, h * 0.5, Math.max(w, h) * 0.85);
    grad.addColorStop(0, 'rgba(18,50,66,0.6)');
    grad.addColorStop(0.5, 'rgba(9,14,22,0.9)');
    grad.addColorStop(1, 'rgba(4,6,10,1)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // Slow drifting industrial grid.
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = rgba(PALETTE.uiAccent, 0.14);
    ctx.lineWidth = 1;
    const cell = 64;
    const offset = (this.animTime * 14) % cell;
    ctx.beginPath();
    for (let gx = -cell + offset; gx < w + cell; gx += cell) {
      ctx.moveTo(Math.round(gx) + 0.5, 0);
      ctx.lineTo(Math.round(gx) + 0.5, h);
    }
    for (let gy = -cell + offset * 0.4; gy < h + cell; gy += cell) {
      ctx.moveTo(0, Math.round(gy) + 0.5);
      ctx.lineTo(w, Math.round(gy) + 0.5);
    }
    ctx.stroke();
    ctx.restore();

    // Silhouette structure on the left for atmosphere.
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#0a1017';
    const baseY = h * 0.92;
    for (let i = 0; i < 9; i += 1) {
      const bw = 46 + ((i * 37) % 60);
      const bh = 120 + ((i * 97) % 260);
      const bx = i * 84 + 20;
      ctx.fillRect(bx, baseY - bh, bw, bh);
      ctx.fillStyle = rgba(PALETTE.uiAccent, 0.12);
      for (let k = 0; k < 3; k += 1) {
        ctx.fillRect(bx + 10, baseY - bh + 20 + k * 40, 8, 8);
      }
      ctx.fillStyle = '#0a1017';
    }
    ctx.restore();
  }

  drawAccountPanel(ui, profile, rect) {
    ui.panel(rect, { alpha: 0.8 });
    ui.heading('OPERATOR', rect.x + 18, rect.y + 26, { size: FONT_SIZES.large, color: PALETTE.uiAccent });
    ui.divider(rect.x + 18, rect.right - 18, rect.y + 44);

    const rows = [
      ['LEVEL', `${profile.account.level}`],
      ['CORES', `${profile.account.cores}`],
      ['RUNS', `${profile.account.totalRuns}`],
      ['EXTRACTIONS', `${profile.account.successfulExtractions}`],
      ['DEATHS', `${profile.account.deaths}`],
      ['BEST SECTOR', `${profile.account.bestSector || '—'}`],
      ['TOTAL KILLS', `${profile.account.totalKills}`],
      ['BEST LOOT', `${profile.account.bestLootRun}`],
      ['FASTEST EXTRACT', profile.account.fastestExtraction > 0 ? formatTime(profile.account.fastestExtraction) : '—'],
      ['PLAYTIME', formatTime(profile.account.totalPlaytimeSeconds)],
    ];
    let y = rect.y + 64;
    for (const [label, value] of rows) {
      ui.statRow(new Rect(rect.x + 18, y, rect.w - 36, 22), label, value, { valueColor: PALETTE.ui });
      y += 24;
    }
  }
}

export class PauseScreen {
  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} scene
   * @param {MenuActions} actions
   * @param {Object} state
   */
  draw(ctx, scene, actions, state = {}) {
    const ui = scene.ui;
    const { width: w, height: h } = ui;
    ui.scrim(0.7);

    const panelW = Math.min(440, w * 0.6);
    const panelH = Math.min(560, h * 0.82);
    const rect = new Rect((w - panelW) / 2, (h - panelH) / 2, panelW, panelH);
    ui.panel(rect, { alpha: 0.96 });

    ui.heading('PAUSED', rect.centerX, rect.y + 38, { align: 'center', color: PALETTE.uiAccent, size: FONT_SIZES.heading });
    const run = scene.run;
    if (run) {
      ui.text(`${run.zone.name}  ·  SECTOR ${run.tier}`, rect.centerX, rect.y + 62, {
        size: FONT_SIZES.tiny,
        color: PALETTE.uiDim,
        align: 'center',
        font: FONTS.display,
        weight: 700,
        letterSpacing: 2,
      });
      ui.text(`SEED ${run.seed}`, rect.centerX, rect.y + 78, {
        size: FONT_SIZES.micro,
        color: PALETTE.uiFaint,
        align: 'center',
        font: FONTS.mono,
      });
    }

    const stack = new VStack(rect.x + 28, rect.y + 104, rect.w - 56, 10);
    const report = state.report;
    const buttons = [
      { key: 'resume', label: 'Resume', variant: 'primary', onClick: () => actions.resume(), hint: 'ESC' },
      { key: 'settings', label: 'Settings', onClick: () => actions.openSettings() },
      { key: 'restart', label: 'Restart Run', onClick: () => actions.restart() },
      { key: 'abandon', label: report ? 'Run Already Ended' : 'Abandon Run', variant: 'danger', disabled: Boolean(report), onClick: () => actions.toMainMenu() },
    ];
    for (const button of buttons) {
      ui.button(button.key, stack.row(44), button.label, {
        onClick: button.onClick,
        variant: button.variant,
        disabled: button.disabled,
        hint: button.hint,
      });
    }

    if (run) {
      stack.space(10);
      ui.divider(rect.x + 28, rect.right - 28, stack.cursor);
      stack.space(14);
      ui.label('RUN STATUS', rect.x + 28, stack.cursor);
      stack.space(16);
      const stats = [
        ['TIME', formatTime(run.elapsed)],
        ['KILLS', `${run.stats.kills}`],
        ['DAMAGE DEALT', `${Math.round(run.stats.damageDealt)}`],
        ['DAMAGE TAKEN', `${Math.round(run.stats.damageTaken)}`],
        ['OBJECTIVES', `${run.stats.objectivesCompleted}`],
        ['LOOT VALUE', `${run.player.lootValue()}`],
        ['CORES', `${run.player.loot.cores ?? 0}`],
        ['ALIVE HOSTILES', `${run.spawner.aliveCount}`],
      ];
      for (const [label, value] of stats) {
        ui.statRow(new Rect(rect.x + 28, stack.cursor, rect.w - 56, 20), label, value);
        stack.space(22);
      }
      stack.space(6);
      ui.text(report ? 'Run settled. Return to the main menu to start again.' : 'Abandoning forfeits this run\'s temporary loot.', rect.centerX, rect.bottom - 22, {
        size: FONT_SIZES.micro,
        color: report ? PALETTE.uiGood : PALETTE.uiWarn,
        align: 'center',
      });
    }
    void ctx;
  }
}

export class SettingsScreen {
  constructor() {
    this.tab = 'audio';
  }

  draw(ctx, scene, actions, state = {}) {
    const ui = scene.ui;
    const { width: w, height: h } = ui;
    if (state.overlay === false) {
      // Rendered as an overlay on top of the pause/menu screen.
    } else {
      ui.scrim(0.76);
    }

    const panelW = Math.min(700, w * 0.84);
    const panelH = Math.min(600, h * 0.88);
    const rect = new Rect((w - panelW) / 2, (h - panelH) / 2, panelW, panelH);
    ui.panel(rect, { alpha: 0.97 });

    ui.heading('SETTINGS', rect.x + 28, rect.y + 34, { color: PALETTE.uiAccent });
    ui.button('close', new Rect(rect.right - 116, rect.y + 18, 96, 34), 'Back', {
      onClick: () => actions.back(),
      variant: 'ghost',
      hint: 'ESC',
    });

    const tabs = [
      { value: 'audio', label: 'Audio' },
      { value: 'video', label: 'Video' },
      { value: 'gameplay', label: 'Gameplay' },
      { value: 'data', label: 'Data' },
    ];
    ui.segmented('tabs', new Rect(rect.x + 28, rect.y + 62, rect.w - 56, 36), tabs, this.tab, {
      onChange: (value) => {
        this.tab = value;
      },
    });

    const content = new Rect(rect.x + 28, rect.y + 118, rect.w - 56, rect.h - 160);
    const settings = scene.profile.settings;

    if (this.tab === 'audio') {
      const rows = [
        ['Master Volume', 'audio.master', 0, 1, 0.05],
        ['Music Volume', 'audio.music', 0, 1, 0.05],
        ['Effects Volume', 'audio.sfx', 0, 1, 0.05],
        ['Ambience Volume', 'audio.ambient', 0, 1, 0.05],
      ];
      let y = content.y + 8;
      for (const [label, path, min, max, step] of rows) {
        ui.label(label, content.x, y - 4);
        const value = getPath(settings, path);
        ui.slider(`slider-${path}`, new Rect(content.x + 220, y, content.w - 300, 24), value, {
          min,
          max,
          step,
          format: (v) => `${Math.round(v * 100)}%`,
          onChange: (v) => {
            setPath(settings, path, v);
            scene.audio.applyVolumes();
            actions.saveNow();
          },
        });
        y += 46;
      }
      ui.text(sessionAudioStatus(scene.audio), content.x, y + 6, {
        size: FONT_SIZES.tiny,
        color: scene.audio.available ? PALETTE.uiGood : PALETTE.uiWarn,
      });
      ui.text('All sound is synthesised at runtime — no external assets required.', content.x, y + 26, {
        size: FONT_SIZES.micro,
        color: PALETTE.uiDim,
      });
      ui.button('test-sfx', new Rect(content.x, y + 46, 160, 34), 'Test Sound', {
        onClick: () => {
          scene.audio.unlock();
          scene.audio.play('ui.confirm');
        },
      });
    } else if (this.tab === 'video') {
      let y = content.y + 8;
      ui.label('Screen Shake', content.x, y + 6);
      ui.slider('slider-shake', new Rect(content.x + 220, y, content.w - 300, 24), settings.video.screenShake, {
        min: 0,
        max: 1.5,
        step: 0.1,
        format: (v) => (v === 0 ? 'OFF' : `${Math.round(v * 100)}%`),
        onChange: (v) => {
          settings.video.screenShake = v;
          actions.saveNow();
        },
      });
      y += 46;

      ui.label('Particle Density', content.x, y + 6);
      ui.slider('slider-particles', new Rect(content.x + 220, y, content.w - 300, 24), settings.video.particles, {
        min: 0,
        max: 1.6,
        step: 0.1,
        format: (v) => `${Math.round(v * 100)}%`,
        onChange: (v) => {
          settings.video.particles = v;
          if (scene.run) scene.run.particles.density = v;
          actions.saveNow();
        },
      });
      y += 54;

      const toggles = [
        ['damageNumbers', 'Damage Numbers'],
        ['bloom', 'Glow Lighting'],
        ['showMinimap', 'Show Minimap'],
        ['showCrosshair', 'Show Crosshair'],
        ['showFps', 'Show Performance Stats'],
      ];
      for (const [key, label] of toggles) {
        ui.toggle(`toggle-${key}`, new Rect(content.x, y, content.w, 26), settings.video[key], {
          label,
          onChange: (v) => {
            settings.video[key] = v;
            if (scene.run) {
              scene.run.floatingText.enabled = settings.video.damageNumbers;
            }
            actions.saveNow();
          },
        });
        y += 34;
      }
    } else if (this.tab === 'gameplay') {
      let y = content.y + 12;
      const toggles = [
        ['autoReload', 'Auto-Reload When Empty'],
        ['holdToExtract', 'Require Standing In Extraction Zone'],
        ['cursorLock', 'Hide System Cursor In Game'],
      ];
      for (const [key, label] of toggles) {
        ui.toggle(`gp-${key}`, new Rect(content.x, y, content.w, 26), settings.gameplay[key], {
          label,
          onChange: (v) => {
            settings.gameplay[key] = v;
            actions.saveNow();
          },
        });
        y += 38;
      }
      ui.label('CONTROLS', content.x, y + 4);
      y += 26;
      const bindings = [
        ['Move', 'W A S D'],
        ['Aim', 'MOUSE'],
        ['Fire', 'LEFT MOUSE'],
        ['Reload', 'R'],
        ['Dash', 'SPACE'],
        ['Sprint', 'HOLD SHIFT'],
        ['Swap Weapon', 'Q / WHEEL'],
        ['Select Weapon', '1 - 4'],
        ['Repair Kit', 'F'],
        ['Armor Plate', 'G'],
        ['Combat Stim', 'T'],
        ['Pause', 'ESC'],
      ];
      for (const [label, key] of bindings) {
        ui.statRow(new Rect(content.x, y, content.w, 22), label, key, { valueColor: PALETTE.uiAccent });
        y += 24;
      }
    } else {
      let y = content.y + 12;
      ui.text('All progress is saved automatically after every run and upgrade purchase.', content.x, y, {
        size: FONT_SIZES.small,
        color: PALETTE.uiDim,
      });
      y += 30;
      const save = scene.saveSystem;
      ui.statRow(new Rect(content.x, y, content.w, 22), 'Save Slot', scene.saveSystem.hasSave() ? 'LOCAL PROFILE' : 'EMPTY');
      y += 26;
      ui.statRow(new Rect(content.x, y, content.w, 22), 'Version', `v${scene.profile.version}`);
      y += 26;
      ui.statRow(new Rect(content.x, y, content.w, 22), 'Account Level', `${scene.profile.account.level}`);
      y += 26;
      ui.statRow(new Rect(content.x, y, content.w, 22), 'Cores', `${scene.profile.account.cores}`);
      y += 40;

      ui.button('save-now', new Rect(content.x, y, 180, 38), 'Save Now', {
        onClick: () => {
          actions.saveNow();
          state.toast?.('Progress saved.', 'good');
        },
      });
      ui.button('reset-progress', new Rect(content.x + 196, y, 220, 38), 'Reset All Progress', {
        variant: 'danger',
        onClick: () => {
          if (state.confirmReset) {
            actions.resetProgress();
            state.toast?.('All progress reset.', 'warn');
          } else if (state.requestResetConfirm) {
            state.requestResetConfirm();
          }
        },
      });
      if (state.resetArmed) {
        ui.text('Press again to permanently erase all upgrades, cores and records.', content.x + 196, y + 50, {
          size: FONT_SIZES.micro,
          color: PALETTE.uiDanger,
        });
      }
      if (save.lastLoadWarning) {
        ui.text(save.lastLoadWarning, content.x, y + 74, { size: FONT_SIZES.micro, color: PALETTE.uiWarn });
      }
    }
    void ctx;
  }
}

export class UpgradesScreen {
  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} scene
   * @param {MenuActions} actions
   * @param {Object} state
   */
  draw(ctx, scene, actions, state = {}) {
    const ui = scene.ui;
    const { width: w, height: h } = ui;
    ui.scrim(0.8);
    const panelW = Math.min(940, w * 0.94);
    const panelH = Math.min(640, h * 0.9);
    const rect = new Rect((w - panelW) / 2, (h - panelH) / 2, panelW, panelH);
    ui.panel(rect, { alpha: 0.97 });

    const profile = scene.profile;
    const progression = scene.progression;

    ui.heading('PERMANENT UPGRADES', rect.x + 28, rect.y + 34, { color: PALETTE.uiAccent });
    ui.text(`CORES: ${profile.account.cores}`, rect.right - 140, rect.y + 34, {
      size: FONT_SIZES.large,
      color: PALETTE.uiWarn,
      font: FONTS.mono,
      weight: 700,
      align: 'right',
    });
    ui.button('close', new Rect(rect.right - 116, rect.y + 56, 96, 32), 'Back', {
      onClick: () => actions.back(),
      variant: 'ghost',
    });

    const bonuses = progression.computeRunBonuses();
    const summaryY = rect.y + 60;
    const summary = [
      `HP +${bonuses.maxHealthAdd}`,
      `ARMOR +${bonuses.maxArmorAdd}`,
      `ENERGY +${bonuses.maxEnergyAdd}`,
      `DMG ${Math.round((bonuses.damageMul - 1) * 100)}%`,
      `LOOT ${Math.round((bonuses.lootMul - 1) * 100)}%`,
      `SALVAGE ${Math.round((0.25 + bonuses.salvageAdd) * 100)}%`,
    ];
    let sx = rect.x + 28;
    for (const entry of summary) {
      ui.text(entry, sx, summaryY + 22, { size: FONT_SIZES.tiny, color: PALETTE.uiGood, font: FONTS.mono, weight: 700 });
      sx += 108;
    }
    ui.divider(rect.x + 28, rect.right - 28, rect.y + 96);

    // Two-column upgrade grid with real purchase handling.
    const columns = panelW > 760 ? 2 : 1;
    const colGap = 18;
    const cardW = (rect.w - 56 - colGap * (columns - 1)) / columns;
    const cardH = 96;
    const startY = rect.y + 112;
    let toast = null;

    META_UPGRADES.forEach((upgrade, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const cardRect = new Rect(
        rect.x + 28 + col * (cardW + colGap),
        startY + row * (cardH + 10),
        cardW,
        cardH,
      );
      if (cardRect.bottom > rect.bottom - 60) return;

      const rank = profile.upgrades[upgrade.id] ?? 0;
      const maxed = rank >= upgrade.maxRank;
      const cost = maxed ? 0 : upgradeCost(upgrade, rank);
      const affordable = !maxed && profile.account.cores >= cost;
      const hovered = cardRect.contains(ui.input.pointer.x, ui.input.pointer.y);

      ui.panel(cardRect, { alpha: hovered ? 0.95 : 0.85, glow: hovered });
      ui.text(upgrade.name.toUpperCase(), cardRect.x + 14, cardRect.y + 18, {
        size: FONT_SIZES.body,
        color: PALETTE.ui,
        font: FONTS.display,
        weight: 700,
        letterSpacing: 1,
      });
      ui.text(upgrade.description, cardRect.x + 14, cardRect.y + 38, {
        size: FONT_SIZES.micro,
        color: PALETTE.uiDim,
        maxWidth: cardRect.w - 120,
      });
      ui.text(upgrade.format(rank).toUpperCase(), cardRect.x + 14, cardRect.y + 58, {
        size: FONT_SIZES.tiny,
        color: PALETTE.uiGood,
        font: FONTS.mono,
        weight: 700,
      });

      // Rank pips.
      for (let i = 0; i < upgrade.maxRank; i += 1) {
        const pipX = cardRect.x + 14 + i * 12;
        const filled = i < rank;
        ctx.fillStyle = filled ? PALETTE.uiAccent : 'rgba(90,105,125,0.35)';
        ctx.fillRect(pipX, cardRect.y + 70, 8, 4);
      }

      const buttonRect = new Rect(cardRect.right - 110, cardRect.y + 48, 96, 34);
      if (maxed) {
        ui.button(`buy-${upgrade.id}`, buttonRect, 'Maxed', { disabled: true, variant: 'ghost' });
      } else {
        ui.button(`buy-${upgrade.id}`, buttonRect, `${cost}`, {
          onClick: () => {
            const result = progression.purchase(upgrade.id, 1);
            if (result.ok) {
              scene.audio.play('ui.confirm');
              actions.saveNow();
              state.toast?.(`${upgrade.name} → rank ${result.rank}`, 'good');
            } else {
              scene.audio.play('ui.error');
              state.toast?.('Not enough cores.', 'warn');
            }
          },
          variant: affordable ? 'primary' : 'default',
          disabled: !affordable,
          icon: '◆',
        });
      }
      if (hovered) {
        ui.setTooltip(maxed ? `${upgrade.name}: fully upgraded` : `${upgrade.name}: rank ${rank}/${upgrade.maxRank} → ${upgrade.format(rank + 1)}`);
      }
      void toast;
    });

    // Refund button.
    const refundRect = new Rect(rect.x + 28, rect.bottom - 48, 220, 34);
    ui.button('refund', refundRect, 'Refund All Upgrades', {
      variant: 'ghost',
      onClick: () => {
        const refund = progression.resetUpgrades();
        actions.saveNow();
        state.toast?.(`Refunded ${refund} cores.`, 'good');
      },
    });

    ui.text('Cores are earned by extracting. Dying keeps only a fraction of them.', rect.centerX, rect.bottom - 26, {
      size: FONT_SIZES.micro,
      color: PALETTE.uiDim,
      align: 'center',
    });
    void ctx;
  }
}

export class HelpScreen {
  draw(ctx, scene, actions) {
    const ui = scene.ui;
    const { width: w, height: h } = ui;
    ui.scrim(0.82);
    const panelW = Math.min(820, w * 0.9);
    const panelH = Math.min(620, h * 0.9);
    const rect = new Rect((w - panelW) / 2, (h - panelH) / 2, panelW, panelH);
    ui.panel(rect, { alpha: 0.97 });

    ui.heading('FIELD MANUAL', rect.x + 28, rect.y + 34, { color: PALETTE.uiAccent });
    ui.button('close', new Rect(rect.right - 116, rect.y + 18, 96, 32), 'Back', {
      onClick: () => actions.back(),
      variant: 'ghost',
    });

    const sections = [
      {
        title: 'THE LOOP',
        lines: [
          'Deploy into an abandoned industrial zone. Fight, loot and complete the objective.',
          'Once the objective is done, extraction unlocks.',
          'Extract to bank everything. Descend to push deeper for better loot and harder enemies.',
          'Dying loses most of your temporary loot — extract to keep it.',
        ],
      },
      {
        title: 'SURVIVAL',
        lines: [
          'Health does not regenerate. Repair kits (F) are your only healing.',
          'Armor soaks damage and erodes as it does. Armor plates (G) restore it.',
          'Energy powers dashing (SPACE) and sprinting (HOLD SHIFT) and regenerates over time.',
          'Taking damage interrupts an extraction channel. Clear the area first.',
        ],
      },
      {
        title: 'COMBAT',
        lines: [
          'Every enemy telegraphs before it strikes. Learn the shapes and step out of them.',
          'Elites (gold rings) have far more health and a shield ability. The Foreman commands boss sectors every third sector.',
          'Shoot barrels to chain explosions. Crates and consoles spill loot.',
          'Aim bloom grows as you hold the trigger. Tap-fire for precision.',
        ],
      },
      {
        title: 'PROGRESSION',
        lines: [
          'CORES extracted buy permanent upgrades between runs.',
          'Account XP levels you up permanently, granting passive bonuses to every future run.',
          'In-run levels grant immediate perks for that run only.',
          'Upgrade chips are carried loot worth a large amount of XP — decide whether to risk them.',
        ],
      },
    ];

    let y = rect.y + 76;
    for (const section of sections) {
      ui.label(section.title, rect.x + 28, y);
      y += 20;
      for (const line of section.lines) {
        ui.text('•', rect.x + 32, y + 8, { size: FONT_SIZES.small, color: PALETTE.uiAccent });
        ui.text(line, rect.x + 48, y + 8, {
          size: FONT_SIZES.small,
          color: PALETTE.uiDim,
          maxWidth: rect.w - 90,
        });
        y += 22;
      }
      y += 12;
    }
    void ctx;
  }
}

/**
 * End-of-run screen: result, loot breakdown, XP and permanent rewards.
 */
export class ResultsScreen {
  constructor() {
    this.anim = 0;
  }

  draw(ctx, scene, actions, state = {}) {
    const ui = scene.ui;
    const { width: w, height: h } = ui;
    this.anim += ui.dt ?? 0;
    const summary = state.summary;
    const result = state.result;

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, result?.extracted ? 'rgba(6,26,24,0.96)' : 'rgba(26,6,12,0.96)');
    grad.addColorStop(1, 'rgba(4,6,10,0.98)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    const panelW = Math.min(940, w * 0.94);
    const panelH = Math.min(640, h * 0.92);
    const rect = new Rect((w - panelW) / 2, (h - panelH) / 2, panelW, panelH);

    const extracted = Boolean(result?.extracted && result.state === 'extracted');
    const title = extracted ? 'EXTRACTION SUCCESSFUL' : 'RUN TERMINATED';
    const color = extracted ? PALETTE.uiGood : PALETTE.uiDanger;

    // Animated reveal: the title bar slides and the numbers tick up.
    const t = clamp01(this.anim / 0.35);
    ui.panel(new Rect(rect.x, rect.y - 10 + (1 - t) * 12, rect.w, 74), { alpha: 0.9 });
    ui.heading(title, rect.centerX, rect.y + 26 + (1 - t) * 10, {
      align: 'center',
      color,
      size: FONT_SIZES.heading,
    });
    ui.text(
      extracted ? 'CARGO SECURED — LOOT BANKED' : `SALVAGE RECOVERED — ${Math.round((summary?.salvageRate ?? 0.25) * 100)}% OF CORES KEPT`,
      rect.centerX,
      rect.y + 52,
      { size: FONT_SIZES.tiny, color: PALETTE.uiDim, align: 'center', font: FONTS.display, weight: 700, letterSpacing: 2 },
    );

    const contentY = rect.y + 84;
    const colW = (rect.w - 72) / 3;
    const left = new Rect(rect.x + 24, contentY, colW, rect.h - 150);
    const mid = new Rect(left.right + 12, contentY, colW, rect.h - 150);
    const right = new Rect(mid.right + 12, contentY, colW, rect.h - 150);

    // --- Column 1: run statistics
    ui.panel(left, { alpha: 0.7 });
    ui.label('RUN STATISTICS', left.x + 14, left.y + 18);
    ui.divider(left.x + 14, left.right - 14, left.y + 30);
    const stats = result
      ? [
          ['SECTOR REACHED', `${result.sector}`],
          ['TIME', formatTime(result.elapsed)],
          ['KILLS', `${result.kills}`],
          ['ELITES KILLED', `${result.elitesKilled}`],
          ['BOSSES KILLED', `${result.bossKills}`],
          ['OBJECTIVES', `${result.objectivesCompleted}`],
          ['DAMAGE DEALT', `${result.damageDealt}`],
          ['DAMAGE TAKEN', `${result.damageTaken}`],
          ['ACCURACY', `${Math.round(result.accuracy * 100)}%`],
          ['SHOTS FIRED', `${result.shotsFired}`],
          ['DASHES', `${result.dashes}`],
          ['RUN LEVEL', `${result.level}`],
        ]
      : [];
    let sy = left.y + 48;
    for (const [label, value] of stats) {
      ui.statRow(new Rect(left.x + 14, sy, left.w - 28, 20), label, value);
      sy += 23;
    }

    // --- Column 2: loot
    ui.panel(mid, { alpha: 0.7 });
    ui.label('RECOVERED LOOT', mid.x + 14, mid.y + 18);
    ui.divider(mid.x + 14, mid.right - 14, mid.y + 30);
    const lootEntries = result
      ? Object.entries(result.loot).filter(([, v]) => v > 0)
      : [];
    let ly = mid.y + 48;
    if (lootEntries.length === 0) {
      ui.text('Nothing recovered.', mid.x + 14, ly, { size: FONT_SIZES.small, color: PALETTE.uiDim });
      ly += 26;
    }
    for (const [key, value] of lootEntries) {
      const label = key === 'scrap' ? 'SCRAP' : key === 'cores' ? 'CORES' : key === 'cells' ? 'CELLS' : key === 'datashard' ? 'DATA SHARDS' : 'INTEL';
      const lootColor = key === 'cores' ? PALETTE.uiWarn : key === 'datashard' ? PALETTE.lootEpic : key === 'intel' ? PALETTE.uiGood : PALETTE.ui;
      ui.statRow(new Rect(mid.x + 14, ly, mid.w - 28, 20), label, `${value}`, { valueColor: lootColor });
      ly += 24;
    }
    ui.divider(mid.x + 14, mid.right - 14, ly + 4);
    ui.statRow(new Rect(mid.x + 14, ly + 22, mid.w - 28, 20), 'LOOT VALUE', `${result?.lootValue ?? 0}`, { valueColor: PALETTE.uiWarn });
    ui.statRow(new Rect(mid.x + 14, ly + 44, mid.w - 28, 20), 'ITEMS COLLECTED', `${result?.lootCollected ?? 0}`);
    if (!extracted && result) {
      ui.text('Lost on death:', mid.x + 14, ly + 74, { size: FONT_SIZES.micro, color: PALETTE.uiDanger });
      ui.text(`${Math.round((1 - (summary?.salvageRate ?? 0.25)) * 100)}% of cores`, mid.x + 14, ly + 90, {
        size: FONT_SIZES.micro,
        color: PALETTE.uiDim,
      });
    }

    // --- Column 3: rewards
    ui.panel(right, { alpha: 0.7 });
    ui.label('PERMANENT REWARDS', right.x + 14, right.y + 18);
    ui.divider(right.x + 14, right.right - 14, right.y + 30);
    const rewards = summary
      ? [
          ['CORES FOUND', `${summary.coresFound}`, PALETTE.ui],
          ['CORES BANKED', `+${summary.coresBanked}`, PALETTE.uiWarn],
          ['XP EARNED', `${summary.xpEarned}`, PALETTE.ui],
          ['XP BANKED', `+${summary.xpBanked}`, PALETTE.xp],
          ['LEVELS GAINED', `${summary.levelsGained}`, PALETTE.xp],
          ['ACCOUNT LEVEL', `${summary.accountLevel}`, PALETTE.uiAccent],
        ]
      : [];
    let ry = right.y + 48;
    for (const [label, value, c] of rewards) {
      ui.statRow(new Rect(right.x + 14, ry, right.w - 28, 20), label, value, { valueColor: c });
      ry += 26;
    }
    ry += 8;
    ui.divider(right.x + 14, right.right - 14, ry);
    ry += 18;
    const xp = scene.progression.xpProgress();
    ui.label('ACCOUNT XP', right.x + 14, ry);
    ry += 16;
    ui.progressBar(new Rect(right.x + 14, ry, right.w - 28, 10), xp.ratio, { color: PALETTE.xp });
    ry += 20;
    ui.text(`LEVEL ${xp.level} — ${xp.current} / ${xp.needed}`, right.x + 14, ry, {
      size: FONT_SIZES.micro,
      color: PALETTE.uiDim,
      font: FONTS.mono,
    });

    // --- Actions
    const actionsY = rect.bottom - 56;
    ui.button('results-menu', new Rect(rect.centerX - 232, actionsY, 220, 42), 'Main Menu', {
      onClick: () => actions.toMainMenu(),
      variant: 'default',
    });
    ui.button('results-again', new Rect(rect.centerX + 12, actionsY, 220, 42), 'New Run', {
      onClick: () => actions.newRun(),
      variant: 'primary',
      hint: 'ENTER',
    });

    ui.text(`SEED ${result?.seed ?? '—'}  ·  ${result?.state?.toUpperCase() ?? ''}`, rect.centerX, rect.bottom - 14, {
      size: FONT_SIZES.micro,
      color: PALETTE.uiFaint,
      align: 'center',
      font: FONTS.mono,
    });
  }
}

/** Live connection status text for the audio settings tab. */
export function sessionAudioStatus(audio) {
  if (!audio) return 'Audio engine unavailable.';
  if (!audio.available) return 'Audio engine not started — click Test Sound or interact to enable.';
  if (audio.ctx && audio.ctx.state === 'suspended') return 'Audio suspended (waiting for interaction).';
  return 'Audio engine online.';
}

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc ? acc[key] : undefined), obj);
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  const target = parts.reduce((acc, key) => acc[key], obj);
  target[last] = value;
}

/** Small confirm/toast overlay helper shared by menu screens. */
export class ToastStack {
  constructor() {
    this.items = [];
  }

  push(text, tone = 'good') {
    this.items.push({ text, tone, life: 2.6 });
    while (this.items.length > 4) this.items.shift();
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      this.items[i].life -= dt;
      if (this.items[i].life <= 0) this.items.splice(i, 1);
    }
  }

  draw(ui) {
    let y = ui.height - 32;
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const item = this.items[i];
      const alpha = clamp01(item.life / 0.5);
      const color = item.tone === 'warn' ? PALETTE.uiWarn : item.tone === 'bad' ? PALETTE.uiDanger : PALETTE.uiGood;
      const w = Math.min(460, ui.width * 0.5);
      const rect = new Rect((ui.width - w) / 2, y, w, 28);
      ctxRound(ui.ctx, rect, 6);
      ui.ctx.fillStyle = rgba(PALETTE.uiPanelSolid, 0.92 * alpha);
      ui.ctx.fill();
      ui.ctx.strokeStyle = rgba(color, 0.5 * alpha);
      ui.ctx.lineWidth = 1;
      ui.ctx.stroke();
      ui.text(item.text, rect.centerX, rect.centerY, {
        size: FONT_SIZES.small,
        color,
        align: 'center',
        alpha,
        font: FONTS.display,
        weight: 700,
      });
      y -= 34;
    }
  }
}

function ctxRound(ctx, rect, radius) {
  roundRect(ctx, rect, radius);
}

export { generateSeedCode, clamp, Rect };
