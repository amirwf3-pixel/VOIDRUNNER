/**
 * Menu screens. Every button maps to a real game transition supplied by the
 * Game class through the `actions` object - there are no inert controls.
 *
 * Layout rules shared by all screens:
 *   - one primary action per screen, visually dominant;
 *   - panels use the same header/rule/spacing scale from the widget toolkit;
 *   - destructive actions (abandon, reset progress) require a second press;
 *   - long copy is wrapped to the panel width instead of being truncated.
 */

import { clamp, clamp01, formatTime } from '../core/math.js';
import { FONTS, FONT_SIZES, PALETTE, rgba } from '../config/palette.js';
import { Rect, VStack, cutRect } from './widgets.js';
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

const LOOP_STEPS = [
  { key: '1', title: 'DEPLOY', text: 'Drop into an abandoned zone with your loadout.' },
  { key: '2', title: 'COMPLETE', text: 'Finish the objective to unlock extraction.' },
  { key: '3', title: 'EXTRACT', text: 'Bank your cargo — or descend for deeper loot.' },
];

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
    const { width: W, height: H } = ui;
    const profile = scene.profile;
    this.animTime = ui.time;

    this.drawBackdrop(ctx, ui, W, H);

    // The page scales down to short viewports instead of overflowing them.
    const v = clamp(Math.min(W / 1280, H / 720), 0.72, 1);
    const left = Math.max(36, W * 0.05);
    const columnW = clamp(W * 0.3, 260, 360);
    const panelW = Math.min(320, W * 0.26);
    const panelX = W - panelW - left;
    const columnX = Math.max(left + 290, Math.min(W * 0.36, panelX - columnW - 48));
    const compact = H < 640;

    this.drawBrand(ui, left, H * 0.16, v, compact);
    // The loop explainer only renders when there is genuinely room for it.
    const loopWidth = Math.min(columnW * 0.95, columnX - left - 36);
    if (!compact && loopWidth >= 210) this.drawLoop(ui, left, H * 0.44, loopWidth, v);

    // ---- primary column
    const reveal = ui.reveal(0.22);
    const run = profile.run;
    let y = Math.max(H * 0.2, 118 * v) + reveal.dy;
    const primaryH = 118 * v;
    if (run) {
      this.drawContractCard(ui, new Rect(columnX, y, columnW, primaryH), run, actions, v);
      y += primaryH + 12 * v;
      ui.button('new', new Rect(columnX, y, columnW, 44 * v), 'New Run', {
        onClick: () => actions.newRun(),
        variant: 'default',
        subtitle: 'Abandons the run in progress',
        icon: '▸',
      });
      y += 44 * v + 10 * v;
    } else {
      ui.button('new', new Rect(columnX, y, columnW, 52 * v), 'New Run', {
        onClick: () => actions.newRun(),
        variant: 'primary',
        hint: 'ENTER',
        icon: '▸',
      });
      y += 52 * v + 10 * v;
    }

    const secondary = [
      { key: 'upgrades', label: 'Upgrades', onClick: () => actions.openUpgrades(), subtitle: `${profile.account.cores} CORES AVAILABLE` },
      { key: 'help', label: 'Field Manual', onClick: () => actions.openHelp(), subtitle: 'Controls, combat and survival' },
      { key: 'settings', label: 'Settings', onClick: () => actions.openSettings(), subtitle: 'Audio, video and gameplay' },
      { key: 'quit', label: 'Quit', variant: 'danger', onClick: () => actions.quit(), subtitle: 'Leaves the game' },
    ];
    const railTop = Math.max(H * 0.2, 118 * v);
    const railGrad = ctx.createLinearGradient(0, railTop, 0, y);
    railGrad.addColorStop(0, rgba(PALETTE.uiAccent, 0.55 * reveal.alpha));
    railGrad.addColorStop(1, rgba(PALETTE.uiAccent, 0.06));
    ctx.save();
    ctx.fillStyle = railGrad;
    ctx.fillRect(columnX - 14, railTop, 2, y - railTop);
    ctx.restore();

    for (const button of secondary) {
      const rect = new Rect(columnX, y, columnW, 46 * v);
      ctx.save();
      ctx.globalAlpha = reveal.alpha;
      ui.button(button.key, rect, button.label, {
        onClick: button.onClick,
        variant: button.variant,
        subtitle: button.subtitle,
      });
      ctx.restore();
      y += 46 * v + 8 * v;
    }

    // ---- seed entry
    y += 6 * v;
    ui.panelLabel('CONTRACT SEED', columnX, y, { color: PALETTE.uiDim });
    ui.text('DETERMINISTIC MAP', columnX + columnW, y, {
      size: FONT_SIZES.micro,
      color: PALETTE.uiGhost,
      align: 'right',
      font: FONTS.display,
      weight: 600,
      letterSpacing: 1.2,
    });
    y += 12 * v;
    const seedRect = new Rect(columnX, y, columnW, 38 * v);
    const seedField = new Rect(seedRect.x, seedRect.y, seedRect.w - 86 * v, seedRect.h);
    ui.textField('seed-field', seedField, actions.getSeed(), {
      placeholder: 'ENTER SEED',
      maxLength: 32,
      onChange: (value) => actions.setSeed(value),
      sanitize: (ch) => (/[A-Za-z0-9\-_ ]/.test(ch) ? ch.toUpperCase() : null),
    });
    ui.button('seed-roll', new Rect(seedRect.right - 80 * v, seedRect.y, 80 * v, seedRect.h), 'Random', {
      onClick: () => actions.rerollSeed(),
      variant: 'ghost',
    });
    if (ui.textFieldActive) {
      ui.setTooltip('Type a seed and press Enter. The same seed always generates the same sector.');
    }

    // ---- operator panel
    const panelTop = Math.max(90 * v, H * 0.16);
    const panelH = Math.min(H - panelTop - 70 * v, 470 * v);
    if (panelX > columnX + columnW + 40 && panelH > 220) {
      this.drawOperatorPanel(ui, scene, new Rect(panelX, panelTop, panelW, panelH), v);
    }

    this.drawControlFooter(ui, W, H, v, compact);
  }

  drawBrand(ui, x, y, v, compact) {
    const titleSize = Math.min(compact ? 44 : 58, 58 * v);
    const lineGap = titleSize * 1.12;
    ui.text('VOID', x, y, {
      size: titleSize,
      color: PALETTE.uiStrong,
      font: FONTS.display,
      weight: 800,
      letterSpacing: titleSize * 0.14,
    });
    ui.text('RUNNER', x, y + lineGap, {
      size: titleSize,
      color: PALETTE.uiAccent,
      font: FONTS.display,
      weight: 800,
      letterSpacing: titleSize * 0.14,
    });
    ui.divider(x + 2, x + 190 * v, y + lineGap * 1.55, { alpha: 0.3 });
    ui.text('EXTRACTION ROGUELITE', x + 3, y + lineGap * 1.55 + 20 * v, {
      size: FONT_SIZES.tiny,
      color: PALETTE.uiDim,
      font: FONTS.display,
      weight: 700,
      letterSpacing: 4,
    });
  }

  /** New players get the whole loop in three lines, on the first screen. */
  drawLoop(ui, x, y, width, v) {
    ui.panelLabel('THE LOOP', x + 2, y, { color: PALETTE.uiGhost });
    let rowY = y + 22 * v;
    for (const step of LOOP_STEPS) {
      const chipW = ui.chip(x + 12, rowY, step.key, { color: PALETTE.uiAccent, filled: true, height: 17 });
      const textX = x + 12 + chipW + 10;
      ui.text(step.title, textX, rowY - 8 * v, {
        size: FONT_SIZES.tiny,
        color: PALETTE.ui,
        font: FONTS.display,
        weight: 800,
        letterSpacing: 1.4,
      });
      ui.paragraph(step.text, textX, rowY + 7 * v, {
        maxWidth: width - (textX - x) - 8,
        size: FONT_SIZES.micro,
        color: PALETTE.uiDim,
        lineHeight: 13,
        maxLines: 2,
      });
      rowY += 44 * v;
    }
  }

  /** Resume card: shows exactly what is waiting to be resumed. */
  drawContractCard(ui, rect, run, actions, v) {
    const objectives = run.objectiveState?.objectives ?? [];
    const done = objectives.filter((o) => o.complete).length;
    const total = Math.max(1, objectives.length);
    ui.panel(rect, { alpha: 0.94, radius: 8, accent: PALETTE.uiAccent, header: true, shadow: true });
    const headerY = rect.y + 15 * v;
    ui.panelLabel('RUN IN PROGRESS', rect.x + 14, headerY);
    ui.text(formatTime(run.elapsed ?? 0), rect.right - 14, headerY, {
      size: FONT_SIZES.tiny,
      color: PALETTE.ui,
      align: 'right',
      font: FONTS.mono,
      weight: 700,
    });

    const metaY = rect.y + 40 * v;
    const chips = [
      { text: `SECTOR ${run.tier ?? 1}`, color: PALETTE.uiAccent },
      { text: `OBJECTIVES ${done}/${total}`, color: done >= total ? PALETTE.uiGood : PALETTE.objective },
      { text: `${run.loot?.cores ?? 0} CORES`, color: PALETTE.uiWarn },
    ];
    let cx = rect.x + 14;
    for (const chip of chips) {
      const width = measure(ui, chip.text, FONT_SIZES.micro) + 16;
      if (cx + width > rect.right - 14) break;
      ui.chip(cx, metaY, chip.text, { color: chip.color, height: 17 });
      cx += width + 6;
    }
    ui.text(`SEED ${run.seed ?? '—'}`, rect.x + 14, metaY + 20 * v, {
      size: FONT_SIZES.micro,
      color: PALETTE.uiGhost,
      font: FONTS.mono,
    });

    const buttonY = rect.bottom - 50 * v;
    ui.button('continue', new Rect(rect.x + 12, buttonY, rect.w - 24, 40 * v), 'Resume Run', {
      onClick: () => actions.continueRun(),
      variant: 'primary',
      hint: 'ENTER',
      icon: '▶',
    });
  }

  drawOperatorPanel(ui, scene, rect, v) {
    const profile = scene.profile;
    ui.panel(rect, { alpha: 0.86, radius: 8, header: true });
    const headerY = rect.y + 16 * v;
    ui.text('OPERATOR', rect.x + 16, headerY, {
      size: FONT_SIZES.body,
      color: PALETTE.uiAccent,
      font: FONTS.display,
      weight: 800,
      letterSpacing: 2,
    });
    const xp = scene.progression.xpProgress();
    ui.text(`LV ${xp.level}`, rect.right - 16, headerY, {
      size: FONT_SIZES.body,
      color: PALETTE.xp,
      align: 'right',
      font: FONTS.display,
      weight: 800,
    });
    const barY = rect.y + 32 * v;
    ui.progressBar(new Rect(rect.x + 16, barY, rect.w - 32, 5), clamp01(xp.ratio ?? 0), { color: PALETTE.xp, radius: 2 });
    ui.text(`${xp.current} / ${xp.needed} XP TO NEXT LEVEL`, rect.x + 16, barY + 16 * v, {
      size: FONT_SIZES.micro,
      color: PALETTE.uiGhost,
      font: FONTS.display,
      weight: 600,
      letterSpacing: 0.8,
    });

    const account = profile.account;
    const groups = [
      {
        title: 'SERVICE RECORD',
        rows: [
          ['RUNS', `${account.totalRuns}`],
          ['EXTRACTIONS', `${account.successfulExtractions}`],
          ['DEATHS', `${account.deaths}`],
          ['BEST SECTOR', `${account.bestSector || '—'}`],
        ],
      },
      {
        title: 'COMBAT',
        rows: [
          ['TOTAL KILLS', `${account.totalKills}`],
          ['BEST LOOT', `${account.bestLootRun}`],
          ['FASTEST EXTRACT', account.fastestExtraction > 0 ? formatTime(account.fastestExtraction) : '—'],
          ['PLAYTIME', formatTime(account.totalPlaytimeSeconds)],
        ],
      },
    ];
    let y = barY + 34 * v;
    for (const group of groups) {
      if (y + 30 > rect.bottom - 16) break;
      ui.divider(rect.x + 16, rect.right - 16, y, { alpha: 0.12 });
      ui.text(group.title, rect.x + 16, y + 14 * v, {
        size: FONT_SIZES.micro,
        color: PALETTE.uiGhost,
        font: FONTS.display,
        weight: 700,
        letterSpacing: 1.6,
      });
      y += 26 * v;
      for (const [label, value] of group.rows) {
        if (y + 20 > rect.bottom - 12) break;
        ui.statRow(new Rect(rect.x + 16, y, rect.w - 32, 20), label, value, {
          valueColor: PALETTE.ui,
          valueSize: FONT_SIZES.small,
        });
        y += 22 * v;
      }
      y += 8 * v;
    }
  }

  drawControlFooter(ui, W, H, v, compact) {
    const full = [
      ['WASD', 'MOVE'], ['MOUSE', 'AIM'], ['LMB', 'FIRE'], ['R', 'RELOAD'], ['Q', 'SWAP WEAPON'],
      ['SPACE', 'DASH'], ['SHIFT', 'SPRINT'], ['F G T', 'KIT / PLATE / STIM'], ['ESC', 'PAUSE'],
    ];
    const short = [['WASD', 'MOVE'], ['MOUSE', 'AIM/FIRE'], ['R', 'RELOAD'], ['SPACE', 'DASH'], ['F G T', 'GEAR'], ['ESC', 'PAUSE']];
    const measureRow = (rows) => {
      let total = 0;
      const measured = rows.map(([key, label]) => {
        const width = measure(ui, key, FONT_SIZES.micro, FONTS.mono, 700) + 22 + measure(ui, label, FONT_SIZES.micro) + 22;
        total += width;
        return { key, label, width };
      });
      return { total, measured };
    };
    let { total: totalW, measured } = measureRow(full);
    if (compact || totalW > W - 60) {
      const shortRow = measureRow(short);
      if (shortRow.total <= W - 60 || shortRow.total < totalW) {
        totalW = shortRow.total;
        measured = shortRow.measured;
      }
    }
    if (totalW > W - 24) return;
    const y = H - (compact ? 22 : 26);
    let x = Math.max(12, W / 2 - totalW / 2);
    for (const entry of measured) {
      ui.keycap(x, y, entry.key);
      ui.text(entry.label, x + measure(ui, entry.key, FONT_SIZES.micro, FONTS.mono, 700) + 16, y, {
        size: FONT_SIZES.micro,
        color: PALETTE.uiGhost,
        font: FONTS.display,
        weight: 600,
        letterSpacing: 0.6,
      });
      x += entry.width;
    }
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
}

export class PauseScreen {
  constructor() {
    this.confirm = null;
    this.confirmTimer = 0;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} scene
   * @param {MenuActions} actions
   * @param {Object} state
   */
  draw(ctx, scene, actions, state = {}) {
    const ui = scene.ui;
    const { width: w, height: h } = ui;
    ui.scrim(0.72, { vignette: true });

    const report = state.report;
    const v = clamp(Math.min(w / 1280, h / 720), 0.75, 1);
    const inset = ui.toastInset ?? 0;
    const panelW = Math.min(500, w * 0.7);
    const panelH = Math.min(640, h * 0.9) - inset;
    const reveal = ui.reveal(0.16);
    const rect = new Rect((w - panelW) / 2, (h - panelH) / 2 + inset + reveal.dy, panelW, panelH);
    ui.panel(rect, { alpha: 0.97 * reveal.alpha, radius: 10, shadow: true, header: true });

    const run = scene.run;
    const headerY = rect.y + 22 * v;
    ui.text(report ? 'RUN ENDED' : 'PAUSED', rect.x + 24, headerY, {
      size: FONT_SIZES.heading,
      color: report ? PALETTE.uiDim : PALETTE.uiAccent,
      font: FONTS.display,
      weight: 800,
      letterSpacing: 3,
    });
    const ruleGrad = ui.ctx.createLinearGradient(rect.x + 24, 0, rect.x + 78, 0);
    ruleGrad.addColorStop(0, rgba(report ? PALETTE.uiDim : PALETTE.uiAccent, 0.65));
    ruleGrad.addColorStop(1, rgba(report ? PALETTE.uiDim : PALETTE.uiAccent, 0));
    ui.ctx.save();
    ui.ctx.fillStyle = ruleGrad;
    ui.ctx.fillRect(rect.x + 24, headerY + 14, 54, 2);
    ui.ctx.restore();
    if (run) {
      ui.text(`${run.zone.name.toUpperCase()} · SECTOR ${run.tier}`, rect.right - 24, headerY - 8 * v, {
        size: FONT_SIZES.micro,
        color: PALETTE.uiDim,
        align: 'right',
        font: FONTS.display,
        weight: 700,
        letterSpacing: 1.4,
      });
      ui.text(`SEED ${run.seed} · ${formatTime(run.elapsed)}`, rect.right - 24, headerY + 8 * v, {
        size: FONT_SIZES.micro,
        color: PALETTE.uiGhost,
        align: 'right',
        font: FONTS.mono,
      });
    }

    let y = rect.y + 64 * v;
    if (run) {
      // Live run status card, two columns.
      const statusH = 118 * v;
      const statusRect = new Rect(rect.x + 20, y, rect.w - 40, statusH);
      ui.panel(statusRect, { alpha: 0.55, radius: 8 });
      const xp = run.xpProgress();
      const columns = [
        [
          ['TIME', formatTime(run.elapsed)],
          ['KILLS', `${run.stats.kills}`],
          ['LOOT VALUE', `${run.player.lootValue()}`],
          ['CORES', `${run.player.loot.cores ?? 0}`],
        ],
        [
          ['OBJECTIVES', `${run.stats.objectivesCompleted}`],
          ['RUN LEVEL', `${xp.level}`],
          ['HEALTH', `${Math.max(0, Math.ceil(run.player.health))} / ${Math.round(run.player.maxHealth)}`],
          ['HOSTILES', `${run.spawner.aliveCount}`],
        ],
      ];
      const colW = (statusRect.w - 36) / 2;
      columns.forEach((rows, index) => {
        let ry = statusRect.y + 22 * v;
        for (const [label, value] of rows) {
          ui.statRow(new Rect(statusRect.x + 14 + index * (colW + 8), ry, colW, 18), label, value, {
            valueSize: FONT_SIZES.small,
            valueColor: index === 0 && label === 'CORES' ? PALETTE.uiWarn : PALETTE.ui,
          });
          ry += 24 * v;
        }
      });
      y += statusH + 14 * v;
    }

    // Actions: destructive ones need a second press, and say so.
    const confirmArmed = this.confirm !== null;
    if (this.confirmTimer > 0) {
      this.confirmTimer -= ui.dt ?? 0;
      if (this.confirmTimer <= 0) this.confirm = null;
    }
    const arm = (key) => {
      this.confirm = key;
      this.confirmTimer = 3.5;
    };

    const actionsList = report
      ? [
          { key: 'menu', label: 'Return to Main Menu', variant: 'primary', onClick: () => actions.toMainMenu(), icon: '◂' },
          { key: 'settings', label: 'Settings', onClick: () => actions.openSettings() },
          { key: 'help', label: 'Field Manual', onClick: () => actions.openHelp() },
        ]
      : [
          { key: 'resume', label: 'Resume Run', variant: 'primary', onClick: () => actions.resume(), hint: 'ESC', icon: '▶' },
          { key: 'settings', label: 'Settings', onClick: () => actions.openSettings(), subtitle: 'Audio, video and gameplay' },
          { key: 'help', label: 'Field Manual', onClick: () => actions.openHelp(), subtitle: 'Controls and survival' },
          {
            key: 'restart',
            label: this.confirm === 'restart' ? 'Confirm Restart' : 'Restart Run',
            onClick: () => {
              if (this.confirm === 'restart') {
                this.confirm = null;
                actions.restart();
              } else {
                arm('restart');
              }
            },
            subtitle: this.confirm === 'restart'
              ? 'Press again — replays this seed from sector 1, banks nothing'
              : 'Discard this attempt and replay the same seed',
            variant: this.confirm === 'restart' ? 'danger' : 'default',
          },
          {
            key: 'abandon',
            label: this.confirm === 'abandon' ? 'Confirm Abandon' : 'Abandon Run',
            onClick: () => {
              if (this.confirm === 'abandon') {
                this.confirm = null;
                actions.toMainMenu();
              } else {
                arm('abandon');
              }
            },
            subtitle: this.confirm === 'abandon'
              ? 'Press again — ends the run and banks nothing'
              : 'Leave the run: forfeits your cargo',
            variant: 'danger',
          },
        ];

    const stack = new VStack(rect.x + 20, y, rect.w - 40, 8 * v);
    for (const button of actionsList) {
      const height = button.subtitle ? 50 * v : 42 * v;
      ui.button(button.key, stack.row(height), button.label, {
        onClick: button.onClick,
        variant: button.variant,
        hint: button.hint,
        icon: button.icon,
        subtitle: button.subtitle,
      });
    }
    y = stack.bottom;

    const footer = report
      ? 'This run has already been settled — nothing else can change.'
      : confirmArmed
        ? 'Confirm to continue.'
        : 'Resume keeps your run exactly as it is.';
    ui.text(footer, rect.centerX, rect.bottom - 16 * v, {
      size: FONT_SIZES.micro,
      color: confirmArmed ? PALETTE.uiWarn : PALETTE.uiGhost,
      align: 'center',
    });
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
      ui.scrim(0.78, { vignette: true });
    }

    const v = clamp(Math.min(w / 1280, h / 720), 0.75, 1);
    const panelW = Math.min(720, w * 0.88);
    const panelH = Math.min(620, h * 0.92);
    const reveal = ui.reveal(0.16);
    const rect = new Rect((w - panelW) / 2, (h - panelH) / 2 + reveal.dy, panelW, panelH);
    ui.panel(rect, { alpha: 0.97 * reveal.alpha, radius: 10, shadow: true, header: true });

    const headerY = rect.y + 30 * v;
    ui.screenTitle(rect.x + 28, headerY, 'Settings', { subtitle: 'Changes are saved immediately' });
    ui.button('close', new Rect(rect.right - 118, rect.y + 18 * v, 96, 34), 'Back', {
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
    ui.segmented('tabs', new Rect(rect.x + 28, rect.y + 66 * v, rect.w - 56, 34), tabs, this.tab, {
      onChange: (value) => {
        this.tab = value;
      },
    });

    const content = new Rect(rect.x + 28, rect.y + 112 * v, rect.w - 56, rect.h - 150 * v);
    const settings = scene.profile.settings;

    if (this.tab === 'audio') {
      this.drawSection(ui, content.x, content.y, 'MIX', content.w);
      const rows = [
        ['Master Volume', 'audio.master', 'Overall loudness'],
        ['Music Volume', 'audio.music', 'Menu and run music'],
        ['Effects Volume', 'audio.sfx', 'Weapons, hits and pickups'],
        ['Ambience Volume', 'audio.ambient', 'Sector atmosphere'],
      ];
      let y = content.y + 34 * v;
      for (const [label, path, hint] of rows) {
        ui.text(label, content.x, y, { size: FONT_SIZES.small, color: PALETTE.ui });
        ui.text(hint, content.x, y + 14 * v, { size: FONT_SIZES.micro, color: PALETTE.uiGhost });
        const value = getPath(settings, path);
        ui.slider(`slider-${path}`, new Rect(content.x + 230, y, content.w - 310, 24), value, {
          min: 0,
          max: 1,
          step: 0.05,
          format: (val) => `${Math.round(val * 100)}%`,
          onChange: (val) => {
            setPath(settings, path, val);
            scene.audio.applyVolumes();
            actions.saveNow();
          },
        });
        y += 46 * v;
      }
      ui.text(sessionAudioStatus(scene.audio), content.x, y + 4 * v, {
        size: FONT_SIZES.micro,
        color: scene.audio.available ? PALETTE.uiGood : PALETTE.uiWarn,
      });
      ui.button('test-sfx', new Rect(content.x, y + 24 * v, 160, 34), 'Test Sound', {
        onClick: () => {
          scene.audio.unlock();
          scene.audio.play('ui.confirm');
        },
      });
    } else if (this.tab === 'video') {
      this.drawSection(ui, content.x, content.y, 'EFFECTS', content.w);
      let y = content.y + 34 * v;
      ui.text('Screen Shake', content.x, y, { size: FONT_SIZES.small, color: PALETTE.ui });
      ui.text('Camera movement when firing and taking hits', content.x, y + 14 * v, { size: FONT_SIZES.micro, color: PALETTE.uiGhost });
      ui.slider('slider-shake', new Rect(content.x + 230, y, content.w - 310, 24), settings.video.screenShake, {
        min: 0,
        max: 1.5,
        step: 0.1,
        format: (val) => (val === 0 ? 'OFF' : `${Math.round(val * 100)}%`),
        onChange: (val) => {
          settings.video.screenShake = val;
          actions.saveNow();
        },
      });
      y += 46 * v;

      ui.text('Particle Density', content.x, y, { size: FONT_SIZES.small, color: PALETTE.ui });
      ui.text('Explosions, impacts and sparks', content.x, y + 14 * v, { size: FONT_SIZES.micro, color: PALETTE.uiGhost });
      ui.slider('slider-particles', new Rect(content.x + 230, y, content.w - 310, 24), settings.video.particles, {
        min: 0,
        max: 1.6,
        step: 0.1,
        format: (val) => `${Math.round(val * 100)}%`,
        onChange: (val) => {
          settings.video.particles = val;
          if (scene.run) scene.run.particles.density = val;
          actions.saveNow();
        },
      });
      y += 52 * v;

      this.drawSection(ui, content.x, y, 'INTERFACE', content.w);
      y += 30 * v;
      const toggles = [
        ['damageNumbers', 'Damage Numbers', 'Floating hit values over enemies'],
        ['bloom', 'Glow Lighting', 'Bloom around lights and muzzle flashes'],
        ['showMinimap', 'Show Minimap', 'Tactical map in the top-right corner'],
        ['showCrosshair', 'Show Crosshair', 'Aim reticle at the cursor'],
        ['showFps', 'Show Performance Stats', 'FPS, AI count and effect count'],
      ];
      for (const [key, label, hint] of toggles) {
        ui.toggle(`toggle-${key}`, new Rect(content.x, y, 200, 24), settings.video[key], {
          label,
          onChange: (val) => {
            settings.video[key] = val;
            if (scene.run) scene.run.floatingText.enabled = settings.video.damageNumbers;
            actions.saveNow();
          },
        });
        ui.text(hint, content.x + 220, y + 12, { size: FONT_SIZES.micro, color: PALETTE.uiGhost });
        y += 34 * v;
      }
    } else if (this.tab === 'gameplay') {
      this.drawSection(ui, content.x, content.y, 'ASSISTANCE', content.w);
      let y = content.y + 34 * v;
      const toggles = [
        ['autoReload', 'Auto-Reload When Empty', 'Reload automatically once the magazine runs dry'],
        ['holdToExtract', 'Require Standing In Extraction Zone', 'Extraction only channels while inside the beacon'],
        ['cursorLock', 'Hide System Cursor In Game', 'The game draws its own reticle'],
      ];
      for (const [key, label, hint] of toggles) {
        ui.toggle(`gp-${key}`, new Rect(content.x, y, 240, 24), settings.gameplay[key], {
          label,
          onChange: (val) => {
            settings.gameplay[key] = val;
            actions.saveNow();
          },
        });
        ui.text(hint, content.x, y + 26 * v, { size: FONT_SIZES.micro, color: PALETTE.uiGhost });
        y += 48 * v;
      }

      this.drawSection(ui, content.x, y + 4 * v, 'CONTROLS', content.w);
      y += 32 * v;
      const bindings = [
        ['Move', 'W A S D'],
        ['Aim / Fire', 'MOUSE / LMB'],
        ['Reload', 'R'],
        ['Swap Weapon', 'Q / WHEEL'],
        ['Select Weapon', '1 - 4'],
        ['Dash', 'SPACE'],
        ['Sprint', 'HOLD SHIFT'],
        ['Repair Kit', 'F'],
        ['Armor Plate', 'G'],
        ['Combat Stim', 'T'],
        ['Pause', 'ESC'],
      ];
      const cols = content.w > 560 ? 2 : 1;
      const colW = (content.w - (cols - 1) * 24) / cols;
      bindings.forEach(([label, key], index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        ui.statRow(new Rect(content.x + col * (colW + 24), y + row * 22 * v, colW, 20), label, key, {
          valueColor: PALETTE.uiAccent,
          valueSize: FONT_SIZES.small,
        });
      });
    } else {
      this.drawSection(ui, content.x, content.y, 'PROFILE DATA', content.w);
      let y = content.y + 34 * v;
      ui.paragraph('Progress is saved automatically after every run, purchase and settings change. A run in progress is checkpointed when you pause, descend or leave the page.', content.x, y, {
        maxWidth: content.w,
        size: FONT_SIZES.small,
        color: PALETTE.uiDim,
      });
      y += 46 * v;
      const rows = [
        ['SAVE SLOT', scene.saveSystem.hasSave() ? 'LOCAL PROFILE' : 'EMPTY'],
        ['SAVE VERSION', `v${scene.profile.version}`],
        ['ACCOUNT LEVEL', `${scene.profile.account.level}`],
        ['CORES', `${scene.profile.account.cores}`],
        ['UPGRADE RANKS', `${Object.values(scene.profile.upgrades).reduce((a, b) => a + (Number(b) || 0), 0)}`],
      ];
      for (const [label, value] of rows) {
        ui.statRow(new Rect(content.x, y, content.w, 20), label, value, { valueColor: PALETTE.ui });
        y += 24 * v;
      }

      y += 12 * v;
      ui.button('save-now', new Rect(content.x, y, 180, 38), 'Save Now', {
        onClick: () => {
          actions.saveNow();
          state.toast?.('Progress saved.', 'good');
        },
      });
      ui.button('reset-progress', new Rect(content.x + 196, y, 220, 38), state.resetArmed ? 'Confirm Reset' : 'Reset All Progress', {
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
        ui.text('Press again to permanently erase all upgrades, cores and records.', content.x, y + 50 * v, {
          size: FONT_SIZES.micro,
          color: PALETTE.uiDanger,
        });
      }
      if (scene.saveSystem.lastLoadWarning) {
        const warnY = y + (state.resetArmed ? 72 : 46) * v;
        const warnRect = new Rect(content.x, warnY, content.w, 30);
        ui.panel(warnRect, { alpha: 0.5, radius: 6, accent: PALETTE.uiWarn });
        ui.text(scene.saveSystem.lastLoadWarning, content.x + 12, warnRect.centerY, {
          size: FONT_SIZES.micro,
          color: PALETTE.uiWarn,
          maxWidth: content.w - 24,
        });
      }
    }
    void ctx;
  }

  drawSection(ui, x, y, title, width) {
    ui.panelLabel(title, x, y, { color: PALETTE.uiAccent });
    ui.divider(x, x + (width ?? 0), y + 10, { alpha: 0.1 });
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
    ui.scrim(0.82, { vignette: true });
    const v = clamp(Math.min(w / 1280, h / 720), 0.75, 1);
    const panelW = Math.min(960, w * 0.95);
    const panelH = Math.min(660, h * 0.93);
    const reveal = ui.reveal(0.16);
    const rect = new Rect((w - panelW) / 2, (h - panelH) / 2 + reveal.dy, panelW, panelH);
    ui.panel(rect, { alpha: 0.97 * reveal.alpha, radius: 10, shadow: true, header: true });

    const profile = scene.profile;
    const progression = scene.progression;
    const headerY = rect.y + 30 * v;
    ui.screenTitle(rect.x + 28, headerY, 'Permanent Upgrades', { subtitle: 'Bought with CORES earned by extracting. They apply to every future run.' });
    const coresLabel = `${profile.account.cores} CORES`;
    const coresW = measure(ui, coresLabel, FONT_SIZES.body) + 24;
    ui.chip(rect.right - 132 - coresW, headerY - 6 * v, coresLabel, {
      color: PALETTE.uiWarn,
      filled: true,
      size: FONT_SIZES.body,
      height: 24,
      icon: '◆',
    });
    ui.button('close', new Rect(rect.right - 116, rect.y + 20 * v, 96, 34), 'Back', {
      onClick: () => actions.back(),
      variant: 'ghost',
      hint: 'ESC',
    });

    // Current bonuses, so the effect of each purchase is always visible.
    const bonuses = progression.computeRunBonuses();
    const summaryY = rect.y + 80 * v;
    const summary = [
      `HP +${bonuses.maxHealthAdd}`,
      `ARMOR +${bonuses.maxArmorAdd}`,
      `ENERGY +${bonuses.maxEnergyAdd}`,
      `DAMAGE ${Math.round((bonuses.damageMul - 1) * 100)}%`,
      `LOOT ${Math.round((bonuses.lootMul - 1) * 100)}%`,
      `SALVAGE ${Math.round((0.25 + bonuses.salvageAdd) * 100)}%`,
    ];
    let sx = rect.x + 28;
    for (const entry of summary) {
      const width = measure(ui, entry, FONT_SIZES.micro) + 16;
      if (sx + width > rect.right - 28) break;
      ui.chip(sx, summaryY, entry, { color: PALETTE.uiGood, height: 18 });
      sx += width + 6;
    }
    ui.divider(rect.x + 28, rect.right - 28, summaryY + 18 * v, { alpha: 0.12 });

    // Two-column upgrade grid with real purchase handling.
    const columns = panelW > 780 ? 2 : 1;
    const colGap = 18;
    const cardW = (rect.w - 56 - colGap * (columns - 1)) / columns;
    const startY = rect.y + 104 * v;
    const rows = Math.ceil(META_UPGRADES.length / columns);
    const available = rect.bottom - 62 - startY;
    const cardH = clamp(available / Math.max(1, rows) - 10, 78, 104);
    const perRow = cardH + 10;

    META_UPGRADES.forEach((upgrade, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const cardRect = new Rect(
        rect.x + 28 + col * (cardW + colGap),
        startY + row * perRow,
        cardW,
        cardH,
      );
      if (cardRect.bottom > rect.bottom - 56) return;

      const rank = profile.upgrades[upgrade.id] ?? 0;
      const maxed = rank >= upgrade.maxRank;
      const cost = maxed ? 0 : upgradeCost(upgrade, rank);
      const affordable = !maxed && profile.account.cores >= cost;
      const hovered = cardRect.contains(ui.input.pointer.x, ui.input.pointer.y);

      ui.panel(cardRect, {
        alpha: hovered ? 0.96 : 0.86,
        glow: hovered || affordable,
        radius: 8,
        accent: maxed ? PALETTE.uiGood : affordable ? PALETTE.uiAccent : null,
      });
      if (hovered) ui.setTooltip(maxed ? `${upgrade.name}: fully upgraded` : `${upgrade.name}: rank ${rank}/${upgrade.maxRank} → ${upgrade.format(rank + 1)}`);

      const inner = new Rect(cardRect.x + 14, cardRect.y + 10, cardRect.w - 136, cardRect.h - 20);
      ui.text(upgrade.name.toUpperCase(), inner.x, inner.y + 8, {
        size: FONT_SIZES.body,
        color: PALETTE.uiStrong,
        font: FONTS.display,
        weight: 800,
        letterSpacing: 1,
      });
      const rankLabel = `${rank} / ${upgrade.maxRank}`;
      ui.text(rankLabel, cardRect.right - 14, inner.y + 8, {
        size: FONT_SIZES.micro,
        color: maxed ? PALETTE.uiGood : PALETTE.uiDim,
        align: 'right',
        font: FONTS.mono,
        weight: 700,
      });

      const roomForCopy = cardRect.h - 62;
      const descLines = roomForCopy >= 26 ? 2 : roomForCopy >= 13 ? 1 : 0;
      if (descLines > 0) {
        ui.paragraph(upgrade.description, inner.x, inner.y + 26, {
          maxWidth: cardRect.w - 150,
          size: FONT_SIZES.micro,
          color: PALETTE.uiDim,
          lineHeight: 13,
          maxLines: descLines,
        });
      }

      // Rank pips, then the current → next effect.
      const pipY = cardRect.bottom - 32;
      const pipW = Math.min(14, (cardRect.w - 160) / upgrade.maxRank);
      for (let i = 0; i < upgrade.maxRank; i += 1) {
        const filled = i < rank;
        ctx.fillStyle = filled ? PALETTE.uiAccent : 'rgba(90,105,125,0.3)';
        ctx.fillRect(inner.x + i * (pipW + 3), pipY, pipW, 5);
      }
      const effect = maxed
        ? `${upgrade.format(rank)} · MAXED`
        : `${upgrade.format(rank)} → ${upgrade.format(rank + 1)}`;
      ui.text(effect, inner.x, cardRect.bottom - 15, {
        size: FONT_SIZES.micro,
        color: maxed ? PALETTE.uiGood : PALETTE.ui,
        font: FONTS.mono,
        weight: 700,
      });

      const buttonH = Math.min(34, cardRect.h - 26);
      const buttonRect = new Rect(cardRect.right - 122, cardRect.centerY - buttonH / 2 + (cardH < 92 ? 0 : 6), 108, buttonH);
      if (maxed) {
        ui.button(`buy-${upgrade.id}`, buttonRect, 'Maxed', { disabled: true, variant: 'ghost' });
      } else {
        ui.button(`buy-${upgrade.id}`, buttonRect, 'Upgrade', {
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
          variant: affordable ? 'primary' : 'ghost',
          disabled: !affordable,
          subtitle: `${cost} CORES`,
        });
      }
    });

    // Refund + guidance.
    ui.button('refund', new Rect(rect.x + 28, rect.bottom - 46, 230, 34), 'Refund All Upgrades', {
      variant: 'ghost',
      onClick: () => {
        const refund = progression.resetUpgrades();
        actions.saveNow();
        state.toast?.(`Refunded ${refund} cores.`, 'good');
      },
    });
    ui.text('CORES are earned by extracting. Dying keeps only a fraction of them.', rect.right - 28, rect.bottom - 29, {
      size: FONT_SIZES.micro,
      color: PALETTE.uiGhost,
      align: 'right',
    });
  }
}

export class HelpScreen {
  constructor() {
    this.sections = [
      {
        title: 'THE LOOP',
        lines: [
          'Deploy into an abandoned zone. Fight, loot and complete the objective.',
          'Completing it unlocks extraction — the green beacon on your map.',
          'Extract to bank everything, or descend for a deeper, richer sector.',
          'Dying forfeits most of your cargo. Extract to keep it.',
        ],
      },
      {
        title: 'SURVIVAL',
        lines: [
          'Health does not regenerate: repair kits (F) are your only healing.',
          'Armor soaks damage and wears down — armor plates (G) restore it.',
          'Energy powers dash (SPACE) and sprint (SHIFT) and refills over time.',
          'Taking damage interrupts an extraction channel. Clear the area first.',
        ],
      },
      {
        title: 'COMBAT',
        lines: [
          'Every enemy telegraphs before it strikes. Step out of the shape.',
          'Elites (gold) are tanky and shielded. A boss commands every third sector.',
          'Shoot barrels to chain explosions. Crates and consoles spill loot.',
          'Aim bloom grows while you hold fire — tap-fire for precision.',
        ],
      },
      {
        title: 'PROGRESSION',
        lines: [
          'CORES extracted buy permanent upgrades between runs.',
          'Account XP levels you up permanently, adding passive bonuses.',
          'In-run levels grant immediate perks for that run only.',
          'Upgrade chips bank run XP the moment you grab them — worth a detour.',
        ],
      },
    ];
    this.steps = [
      ['Move with W A S D', 'Aim with the mouse, fire with the left button.'],
      ['Reload with R', 'Weapon swap is Q, or the mouse wheel.'],
      ['Use F / G / T', 'Repair kit, armor plate, combat stim.'],
      ['Watch the objective panel', 'It always states what to do next.'],
    ];
  }

  draw(ctx, scene, actions) {
    const ui = scene.ui;
    const { width: w, height: h } = ui;
    ui.scrim(0.84, { vignette: true });
    const v = clamp(Math.min(w / 1280, h / 720), 0.75, 1);
    const panelW = Math.min(900, w * 0.93);
    const panelH = Math.min(660, h * 0.93);
    const reveal = ui.reveal(0.16);
    const rect = new Rect((w - panelW) / 2, (h - panelH) / 2 + reveal.dy, panelW, panelH);
    ui.panel(rect, { alpha: 0.97 * reveal.alpha, radius: 10, shadow: true, header: true });

    const headerY = rect.y + 30 * v;
    ui.screenTitle(rect.x + 28, headerY, 'Field Manual', { subtitle: 'Everything you need for the first run and the hundredth.' });
    ui.button('close', new Rect(rect.right - 116, rect.y + 20 * v, 96, 34), 'Back', {
      onClick: () => actions.back(),
      variant: 'ghost',
      hint: 'ESC',
    });

    // First steps: the shortest path to competence.
    const stepsY = rect.y + 66 * v;
    const stepsRect = new Rect(rect.x + 28, stepsY, rect.w - 56, 96 * v);
    ui.panel(stepsRect, { alpha: 0.5, radius: 8 });
    ui.panelLabel('FIRST 60 SECONDS', stepsRect.x + 14, stepsRect.y + 15 * v);
    const stepCols = w > 760 ? 2 : 1;
    const stepRows = Math.ceil(this.steps.length / stepCols);
    const stepColW = (stepsRect.w - 28 - (stepCols - 1) * 18) / stepCols;
    const stepRowH = (stepsRect.h - 38 * v) / stepRows;
    this.steps.forEach(([title, text], index) => {
      const col = index % stepCols;
      const row = Math.floor(index / stepCols);
      const x = stepsRect.x + 14 + col * (stepColW + 18);
      const sy = stepsRect.y + 34 * v + row * stepRowH;
      ctx.fillStyle = rgba(PALETTE.uiAccent, 0.8);
      ctx.fillRect(x, sy - 3, 3, 9);
      ui.text(title, x + 9, sy + 1, {
        size: FONT_SIZES.micro,
        color: PALETTE.ui,
        font: FONTS.display,
        weight: 700,
        maxWidth: stepColW - 10,
      });
      ui.paragraph(text, x + 9, sy + 14 * v, {
        maxWidth: stepColW - 10,
        size: FONT_SIZES.micro,
        color: PALETTE.uiGhost,
        lineHeight: 13,
        maxLines: 3,
      });
    });

    // Two columns of wrapped sections.
    const bodyTop = stepsRect.bottom + 18 * v;
    const colGap = 24;
    const colW = (rect.w - 56 - colGap) / 2;
    const sections = this.sections;
    const perCol = Math.ceil(sections.length / 2);
    for (let col = 0; col < 2; col += 1) {
      const x = rect.x + 28 + col * (colW + colGap);
      let y = bodyTop;
      for (let i = col * perCol; i < Math.min(sections.length, (col + 1) * perCol); i += 1) {
        const section = sections[i];
        ui.panelLabel(section.title, x, y, { color: PALETTE.objective });
        ui.divider(x, x + colW, y + 9, { alpha: 0.1 });
        y += 20 * v;
        for (const line of section.lines) {
          if (y > rect.bottom - 24) break;
          ctx.fillStyle = rgba(PALETTE.uiAccent, 0.7);
          ctx.fillRect(x, y - 3, 3, 3);
          const drawn = ui.paragraph(line, x + 12, y, {
            maxWidth: colW - 12,
            size: FONT_SIZES.micro,
            color: PALETTE.uiDim,
            lineHeight: 14,
            maxLines: 3,
          });
          y += Math.max(1, drawn) * 14 + 8;
        }
        y += 10 * v;
      }
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
    const v = clamp(Math.min(w / 1280, h / 720), 0.75, 1);

    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, result?.extracted ? 'rgba(6,26,24,0.96)' : 'rgba(26,6,12,0.96)');
    grad.addColorStop(1, 'rgba(4,6,10,0.98)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    const inset = ui.toastInset ?? 0;
    const panelW = Math.min(960, w * 0.95);
    const panelH = Math.min(660, h * 0.94) - inset;
    const rect = new Rect((w - panelW) / 2, (h - panelH) / 2 + inset, panelW, panelH);

    const extracted = Boolean(result?.extracted && result.state === 'extracted');
    const title = extracted ? 'EXTRACTION SUCCESSFUL' : result?.state === 'abandoned' ? 'RUN ABANDONED' : 'RUN TERMINATED';
    const color = extracted ? PALETTE.uiGood : PALETTE.uiDanger;

    // Animated reveal: the header slides in and the numbers settle.
    const t = clamp01(this.anim / 0.35);
    const headerH = 84 * v;
    ui.panel(new Rect(rect.x, rect.y - 10 + (1 - t) * 12, rect.w, headerH), { alpha: 0.92, radius: 10, accent: color, shadow: true, header: true });
    ui.text(title, rect.x + 24, rect.y + 26 * v + (1 - t) * 10, {
      size: FONT_SIZES.heading,
      color,
      font: FONTS.display,
      weight: 800,
      letterSpacing: 3,
    });
    ui.text(
      extracted
        ? 'CARGO SECURED — EVERYTHING WAS BANKED'
        : `SALVAGE RECOVERED — ${Math.round((summary?.salvageRate ?? 0.25) * 100)}% OF CORES KEPT`,
      rect.x + 24,
      rect.y + 50 * v + (1 - t) * 10,
      { size: FONT_SIZES.micro, color: PALETTE.uiDim, font: FONTS.display, weight: 700, letterSpacing: 1.6 },
    );
    const meta = [
      `SECTOR ${result?.sector ?? '—'}`,
      `${formatTime(result?.elapsed ?? 0)}`,
      `${result?.kills ?? 0} KILLS`,
      `SEED ${result?.seed ?? '—'}`,
    ];
    ui.text(meta.join('   ·   '), rect.right - 24, rect.y + 26 * v + (1 - t) * 10, {
      size: FONT_SIZES.micro,
      color: PALETTE.uiGhost,
      align: 'right',
      font: FONTS.mono,
    });

    // Outcome strip: the four numbers that matter most.
    const outcomes = [
      { label: 'CARGO VALUE', value: `${result?.lootValue ?? 0}`, color: PALETTE.ui },
      { label: 'CORES BANKED', value: `+${summary?.coresBanked ?? 0}`, color: PALETTE.uiWarn },
      { label: 'XP BANKED', value: `+${summary?.xpBanked ?? 0}`, color: PALETTE.xp },
      { label: 'LEVELS GAINED', value: `${summary?.levelsGained ?? 0}`, color: PALETTE.uiAccent },
    ];
    const stripY = rect.y + headerH + 6 * v;
    const stripH = 54 * v;
    const cellW = (rect.w - 30 * (outcomes.length - 1)) / outcomes.length;
    outcomes.forEach((entry, index) => {
      const cell = new Rect(rect.x + index * (cellW + 30), stripY, cellW, stripH);
      ui.panel(cell, { alpha: 0.6, radius: 8 });
      ui.text(entry.label, cell.x + 14, cell.y + 16 * v, {
        size: FONT_SIZES.micro,
        color: PALETTE.uiGhost,
        font: FONTS.display,
        weight: 700,
        letterSpacing: 1.4,
      });
      ui.text(entry.value, cell.x + 14, cell.y + 36 * v, {
        size: FONT_SIZES.large,
        color: entry.color,
        font: FONTS.mono,
        weight: 700,
      });
    });

    const contentY = stripY + stripH + 12 * v;
    const colW = (rect.w - 48 - 24) / 3;
    const left = new Rect(rect.x + 24, contentY, colW, rect.bottom - contentY - 74 * v);
    const mid = new Rect(left.right + 12, contentY, colW, left.h);
    const right = new Rect(mid.right + 12, contentY, colW, left.h);

    // --- Column 1: run statistics
    ui.panel(left, { alpha: 0.72, radius: 8, header: true });
    ui.panelHeader(left, 'RUN SUMMARY', { meta: result ? `${result.state.toUpperCase()}` : '', y: left.y });
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
      if (sy > left.bottom - 18) break;
      ui.statRow(new Rect(left.x + 14, sy, left.w - 28, 18), label, value, { valueSize: FONT_SIZES.small });
      sy += 22 * v;
    }

    // --- Column 2: loot
    ui.panel(mid, { alpha: 0.72, radius: 8, header: true });
    ui.panelHeader(mid, 'CARGO MANIFEST', { meta: `${result?.lootCollected ?? 0} ITEMS`, y: mid.y });
    const lootEntries = result ? Object.entries(result.loot).filter(([, value]) => value > 0) : [];
    let ly = mid.y + 48;
    if (lootEntries.length === 0) {
      ui.text('Nothing recovered.', mid.x + 14, ly, { size: FONT_SIZES.small, color: PALETTE.uiGhost });
      ly += 24;
    }
    for (const [key, value] of lootEntries) {
      const label = key === 'scrap' ? 'SCRAP' : key === 'cores' ? 'CORES' : key === 'cells' ? 'CELLS' : key === 'datashard' ? 'DATA SHARDS' : 'INTEL';
      const lootColor = key === 'cores' ? PALETTE.uiWarn : key === 'datashard' ? PALETTE.lootEpic : key === 'intel' ? PALETTE.uiGood : PALETTE.ui;
      ui.statRow(new Rect(mid.x + 14, ly, mid.w - 28, 18), label, `${value}`, { valueColor: lootColor, valueSize: FONT_SIZES.small });
      ly += 22 * v;
    }
    ui.divider(mid.x + 14, mid.right - 14, ly + 4, { alpha: 0.16 });
    ui.statRow(new Rect(mid.x + 14, ly + 22, mid.w - 28, 18), 'CARGO VALUE', `${result?.lootValue ?? 0}`, { valueColor: PALETTE.uiWarn, valueSize: FONT_SIZES.small });
    ui.statRow(new Rect(mid.x + 14, ly + 44, mid.w - 28, 18), 'ITEMS COLLECTED', `${result?.lootCollected ?? 0}`, { valueSize: FONT_SIZES.small });
    if (!extracted && result) {
      const lostY = Math.min(ly + 78, mid.bottom - 46);
      ui.text('LOST ON DEATH', mid.x + 14, lostY, {
        size: FONT_SIZES.micro,
        color: PALETTE.uiDanger,
        font: FONTS.display,
        weight: 700,
        letterSpacing: 1.2,
      });
      ui.text(`${Math.round((1 - (summary?.salvageRate ?? 0.25)) * 100)}% of cores · found gear is gone for good`, mid.x + 14, lostY + 16, {
        size: FONT_SIZES.micro,
        color: PALETTE.uiGhost,
        maxWidth: mid.w - 28,
      });
    }

    // --- Column 3: rewards
    ui.panel(right, { alpha: 0.72, radius: 8, header: true });
    ui.panelHeader(right, 'PERMANENT REWARDS', { meta: '', y: right.y });
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
      ui.statRow(new Rect(right.x + 14, ry, right.w - 28, 18), label, value, { valueColor: c, valueSize: FONT_SIZES.small });
      ry += 24 * v;
    }
    ry += 6;
    const xp = scene.progression.xpProgress();
    ui.divider(right.x + 14, right.right - 14, ry, { alpha: 0.16 });
    ui.text('ACCOUNT XP', right.x + 14, ry + 14, {
      size: FONT_SIZES.micro,
      color: PALETTE.uiGhost,
      font: FONTS.display,
      weight: 700,
      letterSpacing: 1.4,
    });
    ui.progressBar(new Rect(right.x + 14, ry + 24, right.w - 28, 8), clamp01(xp.ratio ?? 0), { color: PALETTE.xp });
    ui.text(`LEVEL ${xp.level} — ${xp.current} / ${xp.needed}`, right.x + 14, ry + 42, {
      size: FONT_SIZES.micro,
      color: PALETTE.uiDim,
      font: FONTS.mono,
    });

    // --- Next step + actions
    const hint = extracted
      ? 'NEXT: spend your cores on permanent upgrades, then deploy again.'
      : 'NEXT: extract before you die to bank your cargo and cores.';
    ui.text(hint, rect.centerX, rect.bottom - 74 * v, {
      size: FONT_SIZES.micro,
      color: PALETTE.uiDim,
      align: 'center',
      font: FONTS.display,
      weight: 600,
      letterSpacing: 1.2,
    });

    const actionsY = rect.bottom - 46 * v;
    const buttonW = Math.min(200, (rect.w - 24 * 2) / 3);
    ui.button('results-menu', new Rect(rect.centerX - buttonW * 1.5 - 12, actionsY, buttonW, 40 * v), 'Main Menu', {
      onClick: () => actions.toMainMenu(),
      variant: 'ghost',
    });
    ui.button('results-upgrades', new Rect(rect.centerX - buttonW / 2, actionsY, buttonW, 40 * v), 'Upgrades', {
      onClick: () => actions.openUpgrades(),
      variant: 'default',
      subtitle: `${scene.profile.account.cores} CORES`,
    });
    ui.button('results-again', new Rect(rect.centerX + buttonW / 2 + 12, actionsY, buttonW, 40 * v), 'New Run', {
      onClick: () => actions.newRun(),
      variant: 'primary',
      hint: 'ENTER',
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

/** Measures a string with the toolkit's display font. */
function measure(ui, str, size, font = FONTS.display, weight = 700) {
  const ctx = ui.ctx;
  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
  const width = ctx.measureText(String(str)).width;
  ctx.restore();
  return width;
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
    // In-run toasts dock under the objective panel: the bottom of the screen
    // belongs to the HUD (gear strip), and toasts must never cover it.
    const dock = ui.toastAnchor ?? 'bottom';
    const anchorY = ui.toastY ?? (dock === 'top' ? 150 : ui.height - 34);
    const step = 36;
    let y = anchorY;
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      const item = this.items[i];
      const alpha = clamp01(item.life / 0.5);
      const appear = clamp01((2.6 - item.life) / 0.15);
      const color = item.tone === 'warn' ? PALETTE.uiWarn : item.tone === 'bad' ? PALETTE.uiDanger : PALETTE.uiGood;
      const glyph = item.tone === 'warn' ? '!' : item.tone === 'bad' ? '×' : '✓';
      const w = Math.min(470, ui.width * 0.55);
      const rect = new Rect((ui.width - w) / 2, y + (1 - appear) * (dock === 'top' ? -6 : 6), w, 30);
      cutRect(ui.ctx, rect, 6, 12);
      ui.ctx.fillStyle = rgba(PALETTE.uiPanelSolid, 0.94 * alpha);
      ui.ctx.fill();
      ui.ctx.strokeStyle = rgba(color, 0.5 * alpha);
      ui.ctx.lineWidth = 1;
      ui.ctx.stroke();
      ui.ctx.save();
      ui.ctx.globalAlpha = alpha;
      ui.ctx.fillStyle = color;
      ui.ctx.fillRect(rect.x + 1, rect.y + 4, 3, rect.h - 8);
      ui.ctx.restore();
      ui.text(glyph, rect.x + 16, rect.centerY, {
        size: FONT_SIZES.small,
        color,
        align: 'center',
        alpha,
        font: FONTS.display,
        weight: 800,
      });
      ui.text(item.text, rect.centerX + 6, rect.centerY, {
        size: FONT_SIZES.small,
        color,
        align: 'center',
        alpha,
        font: FONTS.display,
        weight: 700,
        maxWidth: rect.w - 48,
      });
      y += dock === 'top' ? step : -step;
    }
  }
}

export { generateSeedCode, clamp, Rect };
