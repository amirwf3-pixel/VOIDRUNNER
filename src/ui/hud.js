/**
 * In-game HUD.
 *
 * Layout is anchored to the viewport edges and scales with a single `scale`
 * factor so it stays readable at any resolution. Reading order is deliberate:
 *
 *   top-left      performance stats (opt-in)
 *   top-centre    sector, objective, progress, extraction state
 *   top-right     minimap + legend
 *   left-middle   pickup ticker
 *   bottom-left   survival: health / armor / energy / dash
 *   bottom-left+  in-run level, XP and earned perks
 *   bottom-centre consumables
 *   bottom-right  weapon, ammo, reload, loadout
 *   centre        transient state banners + action prompts
 *   screen edges  off-screen objective / extraction indicators
 *
 * The HUD is a pure reader: it never mutates run state. Transient banners are
 * derived by watching state transitions between frames (level, objectives,
 * extraction readiness), which keeps gameplay and persistence untouched.
 */

import { clamp, clamp01, formatTime } from '../core/math.js';
import { FONTS, FONT_SIZES, PALETTE, rgba } from '../config/palette.js';
import { Rect, cutRect } from './widgets.js';
import { AMMO_LABELS, WEAPON_TIER_COLORS, WEAPON_TIER_NAMES } from '../config/weapons.js';
import { MAX_SECTOR, PLAYER_BASE } from '../config/balance.js';
import { RUN_PERKS } from '../game/run.js';

/** Every HUD surface uses one panel alpha so the layers read consistently. */
const HUD_PANEL_ALPHA = 0.8;

/** Consumable slots: key binding, display name, colour, inventory key. */
const CONSUMABLE_SLOTS = [
  { key: 'F', name: 'KIT', stat: 'medkit', color: PALETTE.health },
  { key: 'G', name: 'PLATE', stat: 'armorplate', color: PALETTE.armor },
  { key: 'T', name: 'STIM', stat: 'stim', color: PALETTE.energy },
];

export class Hud {
  constructor() {
    this.showFps = false;
    this.clock = 0;
    this.banner = null;
    this.pendingLevel = null;
    this._memo = { runKey: null };
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} scene
   */
  draw(ctx, scene) {
    const run = scene.run;
    const ui = scene.ui;
    if (!run) return;
    const dt = scene.dt ?? 0;
    this.clock += dt;

    const w = ui.width;
    const h = ui.height;
    const scale = clamp(Math.min(w / 1280, h / 720), 0.8, 1.4);
    // Type stays near its design size while geometry scales: shrinking both
    // together made small viewports unreadable and let rows collide.
    this._scale = scale;
    const pad = Math.round(16 * scale);

    ctx.save();
    ctx.setTransform(ui.dpr ?? 1, 0, 0, ui.dpr ?? 1, 0, 0);

    this.updateBanners(run, dt);

    this.drawObjective(ctx, run, ui, w, scale, pad);
    if (ui.settings.video.showMinimap) {
      this.drawMinimap(ctx, run, ui, new Rect(w - pad - 172 * scale, pad, 172 * scale, 172 * scale), scale);
    }
    this.drawVitals(ctx, run, ui, new Rect(pad, h - pad - 96 * scale, 340 * scale, 96 * scale), scale);
    this.drawLevelStrip(ctx, run, ui, new Rect(pad, h - pad - 96 * scale - 46 * scale, 340 * scale, 40 * scale), scale);
    this.drawWeapon(ctx, run, ui, new Rect(w - pad - 372 * scale, h - pad - 118 * scale, 372 * scale, 118 * scale), scale);
    this.drawGearStrip(ctx, run, ui, new Rect(w / 2 - 150 * scale, h - pad - 30 * scale, 300 * scale, 30 * scale), scale);
    this.drawPickupLog(ctx, run, ui, pad, h - pad - 200 * scale, scale);
    this.drawEdgeIndicators(ctx, run, ui, w, h, scale, pad);
    this.drawThreat(ctx, run, ui, w, h, scale);
    this.drawPrompts(ctx, run, ui, w, h, scale);
    this.drawBanners(ctx, run, ui, w, h, scale);
    this.drawOnboarding(ctx, run, ui, w, h, scale, scene);
    if (ui.settings.video.showFps) this.drawPerf(ctx, run, ui, scene, pad, scale);

    ctx.restore();
  }

  /** Scales a design font size for the current viewport. */
  fs(base) {
    const scale = this._scale ?? 1;
    return Math.max(9, Math.round(base * (0.72 + 0.28 * scale)));
  }

  // -------------------------------------------------------------------------
  // Transient feedback (derived from state transitions, never mutating them)
  // -------------------------------------------------------------------------

  updateBanners(run, dt) {
    const memo = this._memo;
    const runKey = `${run.seed}:${run.tier}`;
    // Hit feedback decays independently of the sector banner timer.
    this.hitFlash = Math.max(0, (this.hitFlash ?? 0) - dt * 3.2);
    if (this.hitChip) {
      this.hitChip.life -= dt;
      if (this.hitChip.life <= 0) this.hitChip = null;
    }
    if (memo.runKey !== runKey) {
      // New run or new sector: re-baseline and announce the sector itself.
      const first = memo.runKey !== null;
      memo.runKey = runKey;
      memo.level = run.level;
      memo.objectivesDone = run.stats.objectivesCompleted;
      memo.allComplete = run.objectives.allComplete;
      memo.health = run.player.health;
      memo.armor = run.player.armor;
      // Baselines the arena flag too: a sector resumed after the waves already
      // triggered must not announce them a second time.
      memo.bossWaves = Boolean(run.bossWavesTriggered);
      this.banner = null;
      this.pendingLevel = null;
      if (first) {
        // Naming the garrison profile puts the sector's character on screen:
        // the same depth can field a firing line or a swarm, and the mix is a
        // tactical fact the player should be able to read before the shooting
        // starts rather than deduce from the bodies.
        const profile = run.zone.threatProfile?.name;
        const sub = run.descendZone ? 'OBJECTIVE + DESCENT AVAILABLE' : 'OBJECTIVE ACTIVE';
        this.showBanner(`SECTOR ${run.tier}`, profile ? `${sub} · ${profile} GARRISON` : sub, PALETTE.uiAccent, 2.2);
      }
      return;
    }

    // One banner at a time, so the most consequential event gets the frame. A
    // level-up that lands on the same kill as the unlock used to win that race
    // and bury the unlock entirely; instead it is held and shown straight after.
    const unlockedNow = !memo.allComplete && run.objectives.allComplete;
    const leveledNow = run.level > memo.level;
    // Boss arena locking in: the support waves are summoned the moment the
    // player enters, so this warning is time critical and outranks a level-up
    // (which is held, not dropped, exactly like the unlock case below).
    const wavesNow = run.bossWavesTriggered && !memo.bossWaves;
    if (wavesNow) {
      this.showBanner('BOSS ARENA', 'SUPPORT WAVES INBOUND', PALETTE.boss, 2.6);
      if (leveledNow) this.pendingLevel = run.level;
      memo.bossWaves = true;
      memo.level = run.level;
      memo.objectivesDone = run.stats.objectivesCompleted;
      memo.allComplete = run.objectives.allComplete;
      return;
    }
    if (unlockedNow) {
      // Purge sectors unlock with the margin intact, so name the leftovers here:
      // the alternative is a player hunting ghosts for a count that is already met.
      const left = run.objectives.main?.type === 'eliminate' ? hostilesRemaining(run) : 0;
      const sub = left > 0
        ? `${left} HOSTILE${left === 1 ? '' : 'S'} STILL ACTIVE · BEACON IS OPEN`
        : 'HEAD TO THE GREEN BEACON';
      this.showBanner('EXTRACTION UNLOCKED', sub, PALETTE.uiGood, left > 0 ? 3.2 : 2.6);
      if (leveledNow) this.pendingLevel = run.level;
    } else if (leveledNow) {
      // Several levels can land at once: name the newest perk actually gained.
      const perk = RUN_PERKS.filter((p) => p.level <= run.level).pop();
      this.showBanner(`LEVEL ${run.level}`, perk ? perk.text : 'IN-RUN UPGRADE', PALETTE.xp, 2.4);
    } else if (run.stats.objectivesCompleted > memo.objectivesDone) {
      this.showBanner('OBJECTIVE COMPLETE', 'PROGRESS SAVED', PALETTE.objective, 2.0);
    } else if (this.pendingLevel && !this.banner) {
      const perk = RUN_PERKS.filter((p) => p.level <= this.pendingLevel).pop();
      this.showBanner(`LEVEL ${this.pendingLevel}`, perk ? perk.text : 'IN-RUN UPGRADE', PALETTE.xp, 2.4);
      this.pendingLevel = null;
    }

    // Damage taken: the vitals panel flashes and shows what the hit cost, so
    // the numbers and the screen vignette agree about what just happened.
    const health = run.player.health;
    const armor = run.player.armor;
    const lost = memo.health - health;
    if (lost > 0.5 && run.player.alive) {
      this.hitFlash = 1;
      this.hitChip = { amount: Math.round(lost), life: 1.1, max: 1.1 };
    } else if (heapLost(memo, armor)) {
      this.hitFlash = Math.max(this.hitFlash ?? 0, 0.5);
    }
    memo.health = health;
    memo.armor = armor;

    memo.level = run.level;
    memo.objectivesDone = run.stats.objectivesCompleted;
    memo.allComplete = run.objectives.allComplete;

    if (this.banner) {
      this.banner.life -= dt;
      if (this.banner.life <= 0) this.banner = null;
    }
  }

  showBanner(text, sub, color, life = 2.2) {
    this.banner = { text, sub, color, life, max: life };
  }

  // -------------------------------------------------------------------------
  // Bottom-left: survival
  // -------------------------------------------------------------------------

  drawVitals(ctx, run, ui, rect, scale) {
    const player = run.player;
    const danger = player.health / Math.max(1, player.maxHealth) < 0.3;
    const critical = player.health / Math.max(1, player.maxHealth) < 0.18;

    const headerY = rect.y + 15 * scale;
    ui.panel(rect, { alpha: HUD_PANEL_ALPHA, header: true, radius: 8 });
    ui.panelLabel('SURVIVAL', rect.x + 14, headerY);
    if (danger && player.alive) {
      const pulse = (Math.sin(this.clock * 7) + 1) / 2;
      const text = critical ? 'CRITICAL' : 'LOW HEALTH';
      const width = ctx_measure(ui, text, this.fs(FONT_SIZES.micro)) + 16;
      ui.chip(rect.right - 14 - width, headerY, text, {
        color: rgba(PALETTE.uiDanger, 0.65 + pulse * 0.35),
        filled: true,
      });
    }

    const barX = rect.x + 14;
    const barW = rect.w - 28;

    // Health.
    const healthRatio = clamp01(player.health / Math.max(1, player.maxHealth));
    ui.text('HP', barX, rect.y + 38, { size: this.fs(FONT_SIZES.tiny), color: danger ? PALETTE.uiDanger : PALETTE.uiDim, font: FONTS.display, weight: 700, letterSpacing: 1.2 });
    ui.text(`${Math.ceil(player.health)} / ${Math.round(player.maxHealth)}`, rect.right - 14, rect.y + 38, {
      size: this.fs(FONT_SIZES.small),
      color: danger ? PALETTE.uiDanger : PALETTE.uiStrong,
      align: 'right',
      font: FONTS.mono,
      weight: 700,
    });
    ui.progressBar(new Rect(barX, rect.y + 48 * scale, barW, 12 * scale), healthRatio, {
      color: danger ? PALETTE.uiDanger : PALETTE.health,
      ticks: 4,
      glow: danger || this.hitFlash > 0.02,
    });
    if (this.hitFlash > 0.02) {
      // Impact frame: the bar itself reports the hit, not just the screen.
      ctx.save();
      ctx.globalAlpha = clamp01(this.hitFlash) * 0.9;
      ctx.strokeStyle = PALETTE.uiDanger;
      ctx.lineWidth = 1.5;
      cutRect(ctx, new Rect(barX - 2, rect.y + 46 * scale, barW + 4, 16 * scale), 4, 6);
      ctx.stroke();
      ctx.restore();
    }
    if (this.hitChip) {
      // Sits on the HP readout row (empty middle), lifting as it fades.
      const life = clamp01(this.hitChip.life / this.hitChip.max);
      const label = `-${this.hitChip.amount}`;
      const chipY = rect.y + 38 * scale - (1 - life) * 7 * scale;
      ctx.save();
      ctx.globalAlpha = Math.min(1, life * 1.7);
      ui.chip(rect.centerX, chipY, label, {
        color: PALETTE.uiDanger,
        filled: true,
        size: this.fs(FONT_SIZES.small),
        height: 17 * scale,
      });
      ctx.restore();
    }

    // Armor and energy, side by side (they are comparable, secondary pools).
    const halfW = (barW - 10) / 2;
    const secondY = rect.y + 66 * scale;
    const armorMax = Math.max(player.maxArmor, 50);
    ui.text('ARMOR', barX, secondY, { size: this.fs(FONT_SIZES.micro), color: PALETTE.uiDim, font: FONTS.display, weight: 700, letterSpacing: 1 });
    ui.text(`${Math.ceil(player.armor)}`, barX + halfW, secondY, {
      size: this.fs(FONT_SIZES.micro),
      color: PALETTE.armor,
      align: 'right',
      font: FONTS.mono,
      weight: 700,
    });
    ui.progressBar(new Rect(barX, secondY + 6 * scale, halfW, 6 * scale), clamp01(player.armor / armorMax), {
      color: PALETTE.armor,
      radius: 2,
    });

    const energyX = barX + halfW + 10;
    ui.text('ENERGY', energyX, secondY, { size: this.fs(FONT_SIZES.micro), color: PALETTE.uiDim, font: FONTS.display, weight: 700, letterSpacing: 1 });
    ui.text(`${Math.ceil(player.energy)}`, energyX + halfW, secondY, {
      size: this.fs(FONT_SIZES.micro),
      color: PALETTE.energy,
      align: 'right',
      font: FONTS.mono,
      weight: 700,
    });
    ui.progressBar(new Rect(energyX, secondY + 6 * scale, halfW, 6 * scale), clamp01(player.energy / Math.max(1, player.maxEnergy)), {
      color: player.isSprinting ? PALETTE.uiGood : PALETTE.energy,
      radius: 2,
      marker: PLAYER_BASE.dashCost / Math.max(1, player.maxEnergy),
    });

    // Dash readiness lives with the pools it spends.
    const dashRatio = 1 - clamp01(player.dashCooldown / PLAYER_BASE.dashCooldown);
    const dashReady = player.dashCooldown <= 0 && player.energy >= PLAYER_BASE.dashCost;
    ui.text('DASH', barX, rect.bottom - 12 * scale, {
      size: this.fs(FONT_SIZES.micro),
      color: dashReady ? PALETTE.uiGood : PALETTE.uiDisabled,
      font: FONTS.display,
      weight: 700,
      letterSpacing: 1,
    });
    ui.progressBar(new Rect(barX + 40 * scale, rect.bottom - 15 * scale, barW - 40 * scale, 5 * scale), !dashReady && player.dashCooldown > 0 ? dashRatio : 1, {
      color: dashReady ? PALETTE.uiGood : PALETTE.uiDisabled,
      radius: 2,
    });
    void ctx;
  }

  /** In-run level, XP and the perks earned this run. */
  drawLevelStrip(ctx, run, ui, rect, scale) {
    const xp = run.xpProgress();
    const fs = (base) => this.fs(base);
    ui.panel(rect, { alpha: HUD_PANEL_ALPHA, radius: 8 });
    const topY = rect.y + 13 * scale;
    ui.text(`LV ${xp.level}`, rect.x + 14, topY, {
      size: fs(FONT_SIZES.small),
      color: PALETTE.xp,
      font: FONTS.display,
      weight: 800,
      letterSpacing: 1,
    });
    ui.text(`${xp.current} / ${xp.needed} XP`, rect.right - 14, topY, {
      size: fs(FONT_SIZES.micro),
      color: PALETTE.uiDim,
      align: 'right',
      font: FONTS.mono,
    });
    ui.progressBar(new Rect(rect.x + 14, topY + 9 * scale, rect.w - 28, Math.max(3, 5 * scale)), xp.ratio, { color: PALETTE.xp, radius: 2 });

    // Earned perks, newest last: the player can always see what they gained.
    const earned = RUN_PERKS.slice(0, run.perkIndex);
    if (earned.length > 0) {
      let x = rect.x + 14;
      const y = rect.bottom - 10 * scale;
      const shown = earned.slice(-4);
      for (const perk of shown) {
        const label = perk.text.replace(/^\+/, '');
        const width = ctx_measure(ui, label, fs(FONT_SIZES.micro)) + 14;
        if (x + width > rect.right - 30) break;
        ui.chip(x, y, label, { color: PALETTE.uiGood, size: this.fs(FONT_SIZES.micro), height: Math.max(12, 14 * scale) });
        x += width + 5;
      }
      const hidden = earned.length - shown.length;
      if (hidden > 0) ui.chip(x, y, `+${hidden}`, { color: PALETTE.uiGhost, height: Math.max(12, 14 * scale) });
    } else {
      ui.text('KILL AND LOOT TO LEVEL UP', rect.x + 14, rect.bottom - 10 * scale, {
        size: this.fs(FONT_SIZES.micro),
        color: PALETTE.uiGhost,
        font: FONTS.display,
        weight: 600,
        letterSpacing: 0.8,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Bottom-right: weapon
  // -------------------------------------------------------------------------

  drawWeapon(ctx, run, ui, rect, scale) {
    const player = run.player;
    const weapon = player.weapon;
    ui.panel(rect, { alpha: HUD_PANEL_ALPHA, header: true, radius: 8 });
    ui.panelLabel('WEAPON', rect.x + 14, rect.y + 16);
    if (!weapon) {
      ui.text('NO WEAPON EQUIPPED', rect.centerX, rect.centerY, { size: this.fs(FONT_SIZES.tiny), color: PALETTE.uiGhost, align: 'center' });
      return;
    }

    const def = weapon.def;
    const tierColor = WEAPON_TIER_COLORS[weapon.tier] ?? PALETTE.uiDim;
    const tierName = (WEAPON_TIER_NAMES[weapon.tier] ?? '').toUpperCase();
    const reserve = player.ammo.get(def.ammo);
    const empty = weapon.ammo <= 0 && !weapon.isReloading;
    const noReserve = reserve <= 0;

    const tierLabel = `TIER ${weapon.tier}${tierName ? ` · ${tierName}` : ''}`;
    const chipW = ctx_measure(ui, tierLabel, this.fs(FONT_SIZES.micro)) + 16;
    ui.chip(rect.right - 14 - chipW, rect.y + 16, tierLabel, { color: tierColor, filled: true, height: 18 * scale });

    // Weapon identity.
    ui.text(def.short ?? def.name.toUpperCase(), rect.x + 14, rect.y + 38 * scale, {
      size: this.fs(FONT_SIZES.large),
      color: PALETTE.uiStrong,
      font: FONTS.display,
      weight: 800,
      letterSpacing: 1.2,
      maxWidth: rect.w - 28 - 96 * scale,
    });
    ui.text(AMMO_LABELS[def.ammo] ?? def.ammo, rect.x + 14, rect.y + 56 * scale, {
      size: this.fs(FONT_SIZES.micro),
      color: PALETTE.uiGhost,
      font: FONTS.display,
      weight: 600,
      letterSpacing: 1,
    });

    // Magazine state: pips for the current magazine, numbers for the reserve.
    const magY = rect.y + 66 * scale;
    const rightBlock = 108 * scale;
    const pipAreaW = rect.w - 28 - rightBlock;
    const pipW = clamp(pipAreaW / Math.max(1, weapon.magazineSize), 1.6, 6);
    const pipGap = 1.4;
    const maxPips = Math.floor(pipAreaW / (pipW + pipGap));
    const visible = Math.min(weapon.magazineSize, maxPips);
    const perPip = weapon.magazineSize / Math.max(1, visible);
    for (let i = 0; i < visible; i += 1) {
      const threshold = i * perPip;
      const ratio = clamp01((weapon.ammo - threshold) / perPip);
      const x = rect.x + 14 + i * (pipW + pipGap);
      ctx.fillStyle = rgba(PALETTE.uiTrack, 1);
      ctx.fillRect(x, magY + 2 * scale, pipW, 11 * scale);
      if (ratio > 0) {
        ctx.fillStyle = ratio >= 1 ? def.color : rgba(def.color, 0.45 + ratio * 0.55);
        ctx.fillRect(x, magY + 2 * scale, pipW, 11 * scale * ratio);
      }
    }

    ui.text(`${weapon.ammo}`, rect.right - 14, magY + 4 * scale, {
      size: this.fs(FONT_SIZES.large),
      color: empty ? PALETTE.uiDanger : PALETTE.uiStrong,
      align: 'right',
      font: FONTS.mono,
      weight: 700,
    });
    ui.text(`/ ${reserve}`, rect.right - 14, magY + 24 * scale, {
      size: this.fs(FONT_SIZES.small),
      color: noReserve ? PALETTE.uiWarn : PALETTE.uiDim,
      align: 'right',
      font: FONTS.mono,
      weight: 600,
    });

    // Reload feedback occupies the pip row so nothing shifts around.
    if (weapon.isReloading) {
      ui.progressBar(new Rect(rect.x + 14, magY + 2 * scale, pipAreaW, 11 * scale), weapon.reloadProgress(), {
        color: PALETTE.uiWarn,
        label: 'RELOADING',
        showFraction: true,
        radius: 2,
      });
    } else if (empty) {
      const emptyLabel = noReserve ? 'NO AMMO — [Q] SWAP' : 'EMPTY — [R] RELOAD';
      const emptyWidth = ctx_measure(ui, emptyLabel, this.fs(FONT_SIZES.micro)) + 20;
      if (emptyWidth <= pipAreaW) {
        ui.chip(rect.x + 14, magY + 7 * scale, emptyLabel, {
          color: noReserve ? PALETTE.uiWarn : PALETTE.uiDanger,
          filled: true,
          height: 16,
        });
      } else {
        ui.text(emptyLabel, rect.x + 14, magY + 7 * scale, {
          size: this.fs(FONT_SIZES.micro),
          color: noReserve ? PALETTE.uiWarn : PALETTE.uiDanger,
          font: FONTS.display,
          weight: 800,
          letterSpacing: 0.8,
        });
      }
    }

    // Loadout: numbered slots with tier colour so swapping is obvious.
    let lx = rect.x + 14;
    const ly = rect.bottom - 14 * scale;
    for (let i = 0; i < player.weapons.length; i += 1) {
      const slot = player.weapons[i];
      if (!slot) continue;
      const active = i === player.weaponIndex;
      const slotTier = WEAPON_TIER_COLORS[slot.tier] ?? PALETTE.uiDim;
      const label = `${i + 1} ${(slot.def.short ?? slot.def.name).toUpperCase()}`;
      const tw = ctx_measure(ui, label, this.fs(FONT_SIZES.micro), FONTS.display, 700) + 12;
      if (lx + tw > rect.right - 14) break;
      const box = new Rect(lx, ly - 8 * scale, tw, 16 * scale);
      cutRect(ctx, box, 3, 5);
      ctx.fillStyle = active ? rgba(PALETTE.uiAccent, 0.18) : 'rgba(255,255,255,0.03)';
      ctx.fill();
      ctx.strokeStyle = active ? rgba(PALETTE.uiAccent, 0.75) : 'rgba(120,140,165,0.18)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ui.text(label, box.centerX, box.centerY, {
        size: this.fs(FONT_SIZES.micro),
        color: active ? PALETTE.uiAccent : slotTier,
        align: 'center',
        font: FONTS.display,
        weight: 700,
      });
      lx += tw + 5;
    }
    if (player.weapons.length > 1) {
      ui.text('[Q] SWAP', rect.right - 14, rect.bottom - 14 * scale, {
        size: this.fs(FONT_SIZES.micro),
        color: PALETTE.uiGhost,
        align: 'right',
        font: FONTS.display,
        weight: 600,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Bottom-centre: consumables
  // -------------------------------------------------------------------------

  drawGearStrip(ctx, run, ui, rect, scale) {
    const player = run.player;
    const boxes = CONSUMABLE_SLOTS.map((slot) => ({
      ...slot,
      count: player.consumables[slot.stat] ?? 0,
    }));
    const gap = 6 * scale;
    const widths = boxes.map((box) => Math.max(
      78 * scale,
      30 + ctx_measure(ui, box.name, this.fs(FONT_SIZES.micro)) + ctx_measure(ui, `${box.count}`, this.fs(FONT_SIZES.small)) + 22,
    ));
    const totalW = widths.reduce((a, b) => a + b, 0) + (boxes.length - 1) * gap;
    let x = rect.centerX - totalW / 2;
    const y = rect.y;

    for (let index = 0; index < boxes.length; index += 1) {
      const box = boxes[index];
      const boxW = widths[index];
      const rect2 = new Rect(x, y, boxW, rect.h);
      const usable = box.count > 0;
      cutRect(ctx, rect2, 4, 6);
      ctx.fillStyle = usable ? 'rgba(12,20,28,0.82)' : 'rgba(10,14,20,0.55)';
      ctx.fill();
      ctx.strokeStyle = usable ? rgba(box.color, 0.5) : 'rgba(90,100,115,0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ui.keyHint(rect2.x + 8, rect2.centerY, box.key, box.name, {
        size: this.fs(FONT_SIZES.micro),
        color: usable ? box.color : PALETTE.uiDisabled,
      });
      ui.text(`${box.count}`, rect2.right - 8, rect2.centerY, {
        size: this.fs(FONT_SIZES.small),
        color: usable ? PALETTE.ui : PALETTE.uiDisabled,
        align: 'right',
        font: FONTS.mono,
        weight: 700,
      });
      x += boxW + gap;
    }
  }

  // -------------------------------------------------------------------------
  // Top-centre: sector + objective
  // -------------------------------------------------------------------------

  drawObjective(ctx, run, ui, width, scale, pad) {
    const objectives = run.objectives;
    const info = objectives.describe(objectives.main);
    const complete = objectives.allComplete;
    // A purge objective completes before the sector is empty (its target keeps
    // a margin so a single unreachable straggler cannot dead-end the run), so
    // say plainly what is left rather than letting the unlock look arbitrary.
    let detail = info.detail;
    if (complete && objectives.main?.type === 'eliminate') {
      const left = hostilesRemaining(run);
      if (left > 0) detail = `${info.detail} · ${left} still active`;
    }
    const boxW = Math.min(470 * scale, width - 2 * pad - 200);
    const list = objectives.objectives ?? [];
    const extraRows = Math.max(0, list.length - 1);
    const boxH = 96 * scale + extraRows * 14 * scale;
    const rect = new Rect((width - boxW) / 2, pad, boxW, boxH);

    ui.panel(rect, { alpha: HUD_PANEL_ALPHA, header: true, radius: 8 });

    // Sector + depth + clock.
    ui.text(`SECTOR ${run.tier} / ${MAX_SECTOR}`, rect.x + 14, rect.y + 16, {
      size: this.fs(FONT_SIZES.tiny),
      color: PALETTE.uiAccent,
      font: FONTS.display,
      weight: 800,
      letterSpacing: 1.6,
    });
    const sectorLabel = `SECTOR ${run.tier} / ${MAX_SECTOR}`;
    const timeLabel = formatTime(run.elapsed);
    const sideW = ctx_measure(ui, sectorLabel, this.fs(FONT_SIZES.tiny), FONTS.display, 800)
      + ctx_measure(ui, timeLabel, this.fs(FONT_SIZES.tiny), FONTS.mono, 700) + 52;
    const zoneLabel = run.zone.name.toUpperCase();
    if (ctx_measure(ui, zoneLabel, this.fs(FONT_SIZES.micro), FONTS.display, 600) + sideW < rect.w) {
      ui.text(zoneLabel, rect.centerX, rect.y + 16, {
        size: this.fs(FONT_SIZES.micro),
        color: PALETTE.uiGhost,
        align: 'center',
        font: FONTS.display,
        weight: 600,
        letterSpacing: 1.4,
      });
    }
    ui.text(formatTime(run.elapsed), rect.right - 14, rect.y + 16, {
      size: this.fs(FONT_SIZES.tiny),
      color: PALETTE.ui,
      align: 'right',
      font: FONTS.mono,
      weight: 700,
    });

    // Depth ticks: how deep the run has travelled, and how much is left.
    const depthY = rect.y + 27 * scale;
    const depthW = rect.w - 28;
    const step = depthW / MAX_SECTOR;
    for (let i = 0; i < MAX_SECTOR; i += 1) {
      ctx.fillStyle = i < run.tier ? rgba(PALETTE.uiAccent, 0.75) : 'rgba(120,140,165,0.18)';
      ctx.fillRect(rect.x + 14 + i * step + 1, depthY, step - 3, 2);
    }

    // Objective headline.
    const titleColor = complete ? PALETTE.uiGood : PALETTE.objective;
    ui.text(info.title.toUpperCase(), rect.x + 14, rect.y + 46 * scale, {
      size: this.fs(FONT_SIZES.small),
      color: titleColor,
      font: FONTS.display,
      weight: 800,
      letterSpacing: 1,
      maxWidth: rect.w - 120,
    });
    const main = objectives.main;
    if (main && !complete) {
      ui.text(`${Math.min(main.progress, main.target)} / ${main.target}`, rect.right - 14, rect.y + 46 * scale, {
        size: this.fs(FONT_SIZES.small),
        color: PALETTE.uiStrong,
        align: 'right',
        font: FONTS.mono,
        weight: 700,
      });
    } else {
      ui.text('DONE', rect.right - 14, rect.y + 46 * scale, {
        size: this.fs(FONT_SIZES.small),
        color: PALETTE.uiGood,
        align: 'right',
        font: FONTS.mono,
        weight: 700,
      });
    }
    ui.text(detail, rect.x + 14, rect.y + 62 * scale, {
      size: this.fs(FONT_SIZES.micro),
      color: PALETTE.uiDim,
      maxWidth: rect.w - 28,
    });
    ui.progressBar(new Rect(rect.x + 14, rect.y + 71 * scale, rect.w - 28, 5 * scale), info.ratio, {
      color: titleColor,
      radius: 2,
    });

    // Secondary objectives (zones can carry more than one).
    let rowY = rect.y + 88 * scale;
    for (const objective of list.slice(1)) {
      const done = objective.complete;
      const sub = objectives.describe(objective);
      ctx.fillStyle = done ? PALETTE.uiGood : rgba(PALETTE.objective, 0.8);
      ctx.fillRect(rect.x + 14, rowY - 2, 3, 8);
      ui.text(sub.title.toUpperCase(), rect.x + 22, rowY + 2, {
        size: this.fs(FONT_SIZES.micro),
        color: done ? PALETTE.uiGood : PALETTE.uiDim,
        font: FONTS.display,
        weight: 600,
        letterSpacing: 0.6,
      });
      ui.text(done ? '✓' : `${Math.min(objective.progress, objective.target)}/${objective.target}`, rect.right - 14, rowY + 2, {
        size: this.fs(FONT_SIZES.micro),
        color: done ? PALETTE.uiGood : PALETTE.uiDim,
        align: 'right',
        font: FONTS.mono,
        weight: 700,
      });
      rowY += 14 * scale;
    }

    // State line: what the player should do next.
    const stateY = rect.bottom - 13 * scale;
    ui.divider(rect.x + 14, rect.right - 14, stateY - 12 * scale, { alpha: 0.12 });
    const remaining = list.filter((o) => !o.complete).length;
    if (complete) {
      const pulse = (Math.sin(this.clock * 4) + 1) / 2;
      const text = run.descendZone ? 'EXTRACT TO BANK · OR DESCEND FOR MORE' : 'EXTRACT TO BANK YOUR CARGO';
      ui.text(text, rect.centerX, stateY, {
        size: this.fs(FONT_SIZES.micro),
        color: rgba(PALETTE.uiGood, 0.75 + pulse * 0.25),
        align: 'center',
        font: FONTS.display,
        weight: 800,
        letterSpacing: 1.4,
      });
    } else {
      ui.text(
        remaining > 1 ? `EXTRACTION LOCKED — ${remaining} OBJECTIVES REMAIN` : 'EXTRACTION LOCKED — COMPLETE THE OBJECTIVE',
        rect.centerX,
        stateY,
        {
          size: this.fs(FONT_SIZES.micro),
          color: PALETTE.uiGhost,
          align: 'center',
          font: FONTS.display,
          weight: 700,
          letterSpacing: 1.2,
        },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Top-right: minimap
  // -------------------------------------------------------------------------

  drawMinimap(ctx, run, ui, rect, scale) {
    const map = run.zone.map;
    const headerH = 26;
    const legendH = 20;
    ui.panel(rect, { alpha: HUD_PANEL_ALPHA, header: true, radius: 8 });
    const title = 'TACTICAL MAP';
    const counter = `${run.spawner.aliveCount} HOSTILE${run.spawner.aliveCount === 1 ? '' : 'S'}`;
    const titleW = ctx_measure(ui, title, this.fs(FONT_SIZES.micro)) + 20;
    const counterW = ctx_measure(ui, counter, this.fs(FONT_SIZES.micro)) + 20;
    const compact = titleW + counterW > rect.w;
    ui.text(compact ? 'MAP' : title, rect.x + 10, rect.y + 14, {
      size: this.fs(FONT_SIZES.micro),
      color: PALETTE.uiAccent,
      font: FONTS.display,
      weight: 700,
      letterSpacing: 1.2,
    });
    if (!compact) {
      ui.text(counter, rect.right - 10, rect.y + 14, {
        size: this.fs(FONT_SIZES.micro),
        color: PALETTE.uiDim,
        align: 'right',
        font: FONTS.mono,
      });
    }

    const inner = new Rect(rect.x + 6, rect.y + headerH, rect.w - 12, rect.h - headerH - legendH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(inner.x, inner.y, inner.w, inner.h);
    ctx.clip();
    ctx.fillStyle = 'rgba(3,6,10,0.85)';
    ctx.fillRect(inner.x, inner.y, inner.w, inner.h);

    const sx = inner.w / map.worldWidth;
    const sy = inner.h / map.worldHeight;
    const s = Math.min(sx, sy);
    const offsetX = inner.x + (inner.w - map.worldWidth * s) / 2;
    const offsetY = inner.y + (inner.h - map.worldHeight * s) / 2;

    // Rooms as blocks (cheap and readable).
    for (const room of run.zone.rooms) {
      const roomRect = new Rect(
        offsetX + room.rect.x * s,
        offsetY + room.rect.y * s,
        Math.max(2, room.rect.w * s),
        Math.max(2, room.rect.h * s),
      );
      const color = room.type === 'exit'
        ? PALETTE.extraction
        : room.type === 'objective'
          ? PALETTE.objective
          : room.type === 'boss'
            ? PALETTE.boss
            : room.type === 'vault'
              ? PALETTE.lootEpic
              : PALETTE.uiFaint;
      const isPlain = room.type === 'combat';
      ctx.fillStyle = isPlain ? rgba(PALETTE.uiDim, 0.22) : rgba(color, 0.6);
      ctx.fillRect(roomRect.x, roomRect.y, roomRect.w, roomRect.h);
    }

    // Corridor spine.
    ctx.strokeStyle = rgba(PALETTE.uiFaint, 0.5);
    ctx.lineWidth = Math.max(1, 2 * s * 32);
    ctx.beginPath();
    for (const corridor of run.zone.corridors ?? []) {
      ctx.moveTo(offsetX + corridor.from.x * map.tileSize * s, offsetY + corridor.from.y * map.tileSize * s);
      ctx.lineTo(offsetX + corridor.to.x * map.tileSize * s, offsetY + corridor.to.y * map.tileSize * s);
    }
    ctx.stroke();

    const project = (worldX, worldY) => ({
      x: offsetX + worldX * s,
      y: offsetY + worldY * s,
    });

    // Loot worth travelling for.
    for (const drop of run.loot.drops) {
      if (!drop.active) continue;
      if (drop.rarity === 'common') continue;
      const p = project(drop.x, drop.y);
      ctx.fillStyle = drop.color;
      ctx.fillRect(p.x - 1, p.y - 1, 2.5, 2.5);
    }

    // Enemies (only alerted ones, to avoid trivialising the map).
    for (const enemy of run.spawner.enemies) {
      if (!enemy.alive || !enemy.alerted) continue;
      const p = project(enemy.x, enemy.y);
      ctx.fillStyle = enemy.isBoss ? PALETTE.boss : enemy.isElite ? PALETTE.hostileElite : PALETTE.hostile;
      ctx.beginPath();
      ctx.arc(p.x, p.y, enemy.isBoss ? 3.5 : 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Objective markers.
    for (const marker of run.objectives.activeMarkers()) {
      const p = project(marker.x, marker.y);
      const pulse = 3 + Math.sin(run.elapsed * 4) * 1.4;
      ctx.strokeStyle = PALETTE.objective;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, pulse, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Extraction + descent beacons.
    const ex = project(run.extractionZone.x, run.extractionZone.y);
    ctx.strokeStyle = run.objectives.allComplete ? PALETTE.extraction : PALETTE.uiDisabled;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ex.x, ex.y, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ex.x - 6, ex.y);
    ctx.lineTo(ex.x + 6, ex.y);
    ctx.moveTo(ex.x, ex.y - 6);
    ctx.lineTo(ex.x, ex.y + 6);
    ctx.stroke();

    if (run.descendZone) {
      const dx = project(run.descendZone.x, run.descendZone.y);
      ctx.strokeStyle = run.objectives.allComplete ? PALETTE.descend : PALETTE.uiDisabled;
      ctx.beginPath();
      ctx.arc(dx.x, dx.y, 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Player.
    const p = project(run.player.x, run.player.y);
    ctx.fillStyle = PALETTE.player;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = rgba(PALETTE.player, 0.6);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + Math.cos(run.player.aimAngle) * 9, p.y + Math.sin(run.player.aimAngle) * 9);
    ctx.stroke();
    ctx.restore();

    // Legend: what the colours on the map mean.
    const legendY = rect.bottom - 11;
    const legend = [
      { color: PALETTE.player, label: 'YOU' },
      { color: PALETTE.objective, label: 'OBJ' },
      { color: PALETTE.extraction, label: 'EXIT' },
    ];
    let lx = rect.x + 10;
    const limit = rect.right - 8;
    for (const entry of legend) {
      const labelW = ctx_measure(ui, entry.label, this.fs(FONT_SIZES.micro), FONTS.display, 600);
      if (lx + 9 + labelW > limit) break;
      ctx.fillStyle = entry.color;
      ctx.beginPath();
      ctx.arc(lx + 3, legendY, 3, 0, Math.PI * 2);
      ctx.fill();
      ui.text(entry.label, lx + 9, legendY, {
        size: this.fs(FONT_SIZES.micro),
        color: PALETTE.uiGhost,
        font: FONTS.display,
        weight: 600,
        letterSpacing: 0.6,
      });
      lx += 9 + labelW + 12;
    }
    void scale;
  }

  // -------------------------------------------------------------------------
  // Left: pickup ticker
  // -------------------------------------------------------------------------

  drawPickupLog(ctx, run, ui, x, y, scale) {
    let cursorY = y;
    for (let i = run.pickupLog.length - 1; i >= 0; i -= 1) {
      const entry = run.pickupLog[i];
      const alpha = clamp01(entry.life / 0.6);
      const rect = new Rect(x, cursorY - 22 * scale, 250 * scale, 20 * scale);
      ui.panel(rect, { alpha: 0.68 * alpha, radius: 4 });
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = entry.color;
      ctx.fillRect(rect.x + 1, rect.y + 2, 3, rect.h - 4);
      ctx.restore();
      ui.text(entry.text, rect.x + 11, rect.centerY, {
        size: this.fs(FONT_SIZES.micro),
        color: entry.color,
        alpha,
        font: FONTS.display,
        weight: 700,
        letterSpacing: 0.8,
        maxWidth: rect.w - 80,
      });
      if (entry.detail) {
        ui.text(entry.detail, rect.right - 10, rect.centerY, {
          size: this.fs(FONT_SIZES.micro),
          color: PALETTE.ui,
          align: 'right',
          alpha,
          font: FONTS.mono,
          weight: 700,
        });
      }
      cursorY -= 24 * scale;
    }
  }

  // -------------------------------------------------------------------------
  // Off-screen objective indicators
  // -------------------------------------------------------------------------

  drawEdgeIndicators(ctx, run, ui, width, height, scale, pad) {
    const camera = run.camera;
    if (!camera || typeof camera.worldToScreen !== 'function') return;
    const player = run.player;
    const targets = [];

    const marker = run.objectives.nearestMarkerDistance ? nearestTarget(run) : null;
    if (marker) targets.push({ x: marker.x, y: marker.y, label: 'OBJECTIVE', color: PALETTE.objective });
    const ready = run.objectives.allComplete;
    targets.push({
      x: run.extractionZone.x,
      y: run.extractionZone.y,
      label: ready ? 'EXTRACT' : 'EXIT (LOCKED)',
      color: ready ? PALETTE.extraction : PALETTE.uiGhost,
      dim: !ready,
    });
    if (run.descendZone) {
      targets.push({
        x: run.descendZone.x,
        y: run.descendZone.y,
        label: ready ? 'DESCEND' : 'DESCENT (LOCKED)',
        color: ready ? PALETTE.descend : PALETTE.uiGhost,
        dim: !ready,
      });
    }

    const inset = new Rect(pad + 90 * scale, pad + 120 * scale, width - 2 * (pad + 90 * scale), height - 2 * (pad + 120 * scale));
    const tile = run.zone.map.tileSize || 32;
    let drawn = 0;
    for (const target of targets) {
      if (drawn >= 2) break;
      if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) continue;
      const screen = camera.worldToScreen(target.x, target.y);
      const insideView = screen.x > inset.x && screen.x < inset.right && screen.y > inset.y && screen.y < inset.bottom;
      const dist = Math.hypot(target.x - player.x, target.y - player.y);
      if (insideView && dist < tile * 8) continue;
      if (target.dim && dist > tile * 40) continue;
      const cx = clamp(screen.x, inset.x, inset.right);
      const cy = clamp(screen.y, inset.y, inset.bottom);
      const angle = Math.atan2(screen.y - height / 2, screen.x - width / 2);
      this.drawChevron(ctx, ui, cx, cy, angle, target, dist / tile, scale);
      drawn += 1;
    }
  }

  drawChevron(ctx, ui, x, y, angle, target, meters, scale) {
    const color = target.color;
    const size = 7 * scale;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(size * 1.6, 0);
    ctx.lineTo(-size, -size);
    ctx.lineTo(-size * 0.4, 0);
    ctx.lineTo(-size, size);
    ctx.closePath();
    ctx.fillStyle = rgba(color, target.dim ? 0.45 : 0.9);
    ctx.fill();
    ctx.restore();

    const distance = Number.isFinite(meters) ? `${Math.max(1, Math.round(meters))}m` : '';
    const label = `${target.label} ${distance}`.trim();
    const w = ctx_measure(ui, label, this.fs(FONT_SIZES.micro), FONTS.display, 700) + 16;
    const h = 16 * scale;
    const below = y < ui.height * 0.62;
    const rect = new Rect(x - w / 2, below ? y + 12 * scale : y - 12 * scale - h, w, h);
    const clampedX = clamp(rect.x, 6, Math.max(6, ui.width - rect.w - 6));
    const clampedY = clamp(rect.y, 6, Math.max(6, ui.height - rect.h - 6));
    const placed = new Rect(clampedX, clampedY, rect.w, rect.h);
    cutRect(ctx, placed, 3, 5);
    ctx.fillStyle = 'rgba(6,10,16,0.85)';
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.5);
    ctx.lineWidth = 1;
    ctx.stroke();
    ui.text(label, placed.centerX, placed.centerY, {
      size: this.fs(FONT_SIZES.micro),
      color: rgba(color, target.dim ? 0.7 : 1),
      align: 'center',
      font: FONTS.display,
      weight: 700,
      letterSpacing: 0.8,
    });
  }

  // -------------------------------------------------------------------------
  // Combat state + action prompts
  // -------------------------------------------------------------------------

  drawThreat(ctx, run, ui, width, height, scale) {
    if (!(run.threatLevel > 0.05)) return;
    const w = 150 * scale;
    const rect = new Rect(width / 2 - w / 2, height - 62 * scale, w, 16 * scale);
    ui.progressBar(new Rect(rect.x, rect.y, rect.w, 4 * scale), clamp01(run.threatLevel), {
      color: PALETTE.hostile,
      radius: 2,
    });
    // Drawn straight over the world, so it carries its own contrast: a shadowed
    // label stays readable on bright floors and in dark corridors alike.
    ui.text('COMBAT', rect.centerX, rect.bottom + 6 * scale, {
      size: this.fs(FONT_SIZES.micro),
      color: rgba(PALETTE.hostile, 0.9),
      align: 'center',
      font: FONTS.display,
      weight: 800,
      letterSpacing: 3,
      shadow: true,
    });
    void ctx;
  }

  /** Prompts when the player is standing near a usable zone. */
  drawPrompts(ctx, run, ui, width, height, scale) {
    const player = run.player;
    const ready = run.objectives.allComplete;
    const zones = [
      { zone: run.extractionZone, label: 'EXTRACTION', color: PALETTE.extraction, hint: 'BANKS ALL CARGO' },
      { zone: run.descendZone, label: `DESCEND TO SECTOR ${run.tier + 1}`, color: PALETTE.descend, hint: 'DEEPER SECTOR · BETTER LOOT' },
    ];
    let y = height * 0.6;
    for (const entry of zones) {
      if (!entry.zone) continue;
      if (!entry.zone.isNear(player.x, player.y, 110)) continue;
      const inside = entry.zone.contains(player.x, player.y);
      const boxW = 340 * scale;
      const boxH = 54 * scale;
      const rect = new Rect((width - boxW) / 2, y, boxW, boxH);
      ui.panel(rect, { alpha: 0.88, radius: 8, accent: ready ? entry.color : PALETTE.uiWarn });

      if (!ready) {
        ui.label(entry.label, rect.x + 16, rect.y + 18, { color: PALETTE.uiWarn });
        ui.text('LOCKED — COMPLETE THE OBJECTIVE FIRST', rect.x + 16, rect.y + 36 * scale, {
          size: this.fs(FONT_SIZES.micro),
          color: PALETTE.uiDim,
          font: FONTS.display,
          weight: 700,
          letterSpacing: 1,
        });
      } else if (!inside) {
        ui.label(entry.label, rect.x + 16, rect.y + 18, { color: entry.color });
        ui.text('MOVE INTO THE ZONE TO CHANNEL', rect.x + 16, rect.y + 36 * scale, {
          size: this.fs(FONT_SIZES.micro),
          color: PALETTE.uiDim,
          font: FONTS.display,
          weight: 700,
          letterSpacing: 1,
        });
        ui.text(entry.hint, rect.right - 16, rect.y + 18, {
          size: this.fs(FONT_SIZES.micro),
          color: PALETTE.uiGhost,
          align: 'right',
          font: FONTS.display,
          weight: 600,
          letterSpacing: 0.8,
        });
      } else {
        const zone = entry.zone;
        const ratio = clamp01(zone.progress / Math.max(0.001, zone.channelTime));
        ui.label(entry.label, rect.x + 16, rect.y + 18, { color: entry.color });
        ui.text(`${Math.round(ratio * 100)}%`, rect.right - 16, rect.y + 18, {
          size: this.fs(FONT_SIZES.body),
          color: entry.color,
          align: 'right',
          font: FONTS.mono,
          weight: 700,
        });
        ui.progressBar(new Rect(rect.x + 16, rect.y + 30 * scale, rect.w - 32, 8 * scale), ratio, {
          color: entry.color,
          label: zone.active ? 'CHANNELLING — HOLD POSITION' : 'CHANNEL HELD',
          labelSize: this.fs(FONT_SIZES.micro),
        });
        ui.text('TAKING DAMAGE INTERRUPTS', rect.right - 16, rect.bottom - 8 * scale, {
          size: this.fs(FONT_SIZES.micro),
          color: rgba(PALETTE.uiWarn, 0.8),
          align: 'right',
          font: FONTS.display,
          weight: 600,
          letterSpacing: 0.8,
        });
      }
      y += boxH + 10 * scale;
    }
    void ctx;
  }

  /** Centre banners: boss warning, level-ups, objective state changes. */
  drawBanners(ctx, run, ui, width, height, scale) {
    const boss = run.spawner.boss;
    if (boss && boss.alive && !boss.alerted) {
      const pulse = (Math.sin(this.clock * 3) + 1) / 2;
      const text = 'HOSTILE COMMAND SIGNATURE DETECTED';
      const w = ctx_measure(ui, text, this.fs(FONT_SIZES.small), FONTS.display, 800) + 120;
      const rect = new Rect(width / 2 - w / 2, height * 0.22, w, 30 * scale);
      ui.panel(rect, { alpha: 0.55 + pulse * 0.2, radius: 6, accent: PALETTE.boss });
      ui.text('WARNING', rect.x + 14, rect.centerY, {
        size: this.fs(FONT_SIZES.micro),
        color: PALETTE.boss,
        font: FONTS.display,
        weight: 800,
        letterSpacing: 2,
      });
      ui.text(text, rect.centerX + 20, rect.centerY, {
        size: this.fs(FONT_SIZES.small),
        color: rgba(PALETTE.boss, 0.75 + pulse * 0.25),
        align: 'center',
        font: FONTS.display,
        weight: 700,
        letterSpacing: 2,
      });
    }

    const banner = this.banner;
    if (!banner) return;
    const t = 1 - banner.life / banner.max; // 0 -> 1 over its lifetime
    const appear = clamp01(t / 0.12);
    const fade = clamp01((1 - t) / 0.25);
    const alpha = Math.min(appear, fade);
    const y = height * 0.32 - (1 - appear) * 8;
    const textW = ctx_measure(ui, banner.text, this.fs(FONT_SIZES.heading), FONTS.display, 800);
    const subW = banner.sub ? ctx_measure(ui, banner.sub, this.fs(FONT_SIZES.tiny), FONTS.display, 700) : 0;
    const w = Math.max(textW, subW) + 72;
    const rect = new Rect(width / 2 - w / 2, y - 26 * scale, w, 52 * scale);
    ctx.save();
    ctx.globalAlpha = alpha;
    ui.panel(rect, { alpha: 0.86, radius: 8, accent: banner.color });
    ui.text(banner.text, rect.centerX, rect.y + 20 * scale, {
      size: this.fs(FONT_SIZES.heading),
      color: banner.color,
      align: 'center',
      font: FONTS.display,
      weight: 800,
      letterSpacing: 3,
    });
    if (banner.sub) {
      ui.text(banner.sub.toUpperCase(), rect.centerX, rect.y + 39 * scale, {
        size: this.fs(FONT_SIZES.tiny),
        color: PALETTE.ui,
        align: 'center',
        font: FONTS.display,
        weight: 700,
        letterSpacing: 1.6,
      });
    }
    ctx.restore();
  }

  /**
   * First-deployment hint. Shows only while the account has never completed a
   * run and fades away on its own; it teaches the loop without any modal.
   */
  drawOnboarding(ctx, run, ui, width, height, scale, scene) {
    const totalRuns = scene.profile?.account?.totalRuns;
    if (totalRuns !== 0) return;
    const life = 18 - run.elapsed;
    if (life <= 0) return;
    const alpha = clamp01(Math.min(1, life / 3));

    const lines = [
      'FINISH THE OBJECTIVE, THEN REACH THE GREEN BEACON TO BANK YOUR LOOT',
      'WASD MOVE · MOUSE AIM · LMB FIRE · R RELOAD · SPACE DASH · F G T GEAR',
    ];
    const size = this.fs(FONT_SIZES.micro);
    let boxW = 0;
    for (const line of lines) boxW = Math.max(boxW, ctx_measure(ui, line, size, FONTS.display, 700));
    boxW = Math.min(boxW + 40, width - 60);
    const boxH = 56 * scale;
    const rect = new Rect(width / 2 - boxW / 2, height * 0.45 - boxH / 2, boxW, boxH);
    ctx.save();
    ctx.globalAlpha = alpha;
    ui.panel(rect, { alpha: 0.72, radius: 8, accent: PALETTE.objective });
    ui.text('FIRST DEPLOYMENT', rect.centerX, rect.y + 16 * scale, {
      size: this.fs(FONT_SIZES.micro),
      color: PALETTE.objective,
      align: 'center',
      font: FONTS.display,
      weight: 800,
      letterSpacing: 2,
    });
    ui.paragraph(lines[0], rect.x + 18, rect.y + 30 * scale, {
      maxWidth: rect.w - 36,
      size,
      color: PALETTE.ui,
      font: FONTS.display,
      weight: 600,
      lineHeight: 13,
      maxLines: 1,
    });
    ui.text(lines[1], rect.centerX, rect.bottom - 12 * scale, {
      size,
      color: PALETTE.uiGhost,
      align: 'center',
      font: FONTS.display,
      weight: 600,
      maxWidth: rect.w - 24,
    });
    ctx.restore();
  }

  drawPerf(ctx, run, ui, scene, pad, scale) {
    void ctx;
    const text = `${Math.round(scene.fps ?? 0)} FPS · ${run.spawner.aliveCount} AI · ${run.particles.activeCount} FX${scene.debugSuffix ?? ''}`;
    const w = ctx_measure(ui, text, this.fs(FONT_SIZES.micro), FONTS.mono, 600) + 20;
    const rect = new Rect(pad, pad, w, 20 * scale);
    ui.panel(rect, { alpha: 0.6, radius: 4 });
    ui.text(text, rect.centerX, rect.centerY, {
      size: this.fs(FONT_SIZES.micro),
      color: PALETTE.uiGood,
      align: 'center',
      font: FONTS.mono,
      weight: 600,
    });
  }
}

function nearestTarget(run) {
  const markers = run.objectives.activeMarkers();
  if (!markers || markers.length === 0) return null;
  const player = run.player;
  let best = null;
  let bestD = Infinity;
  for (const marker of markers) {
    const d = (marker.x - player.x) ** 2 + (marker.y - player.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = marker;
    }
  }
  return best;
}

/** True when armor absorbed part of a hit (armor dropping on its own). */
function heapLost(memo, armor) {
  const before = memo.armor ?? armor;
  return armor < before - 0.5;
}

/**
 * Hostiles the sector has not accounted for yet: still standing plus those the
 * spawner has not brought in. Bosses are excluded — they are their own
 * objective and never part of a purge count.
 */
function hostilesRemaining(run) {
  const spawner = run.spawner;
  let left = 0;
  for (const enemy of spawner.enemies) {
    if (enemy.alive && !enemy.isBoss) left += 1;
  }
  for (const spec of spawner.pending) {
    if (!spec.spawned && !spec.isBoss) left += 1;
  }
  return left;
}

/** Measures text with the same font stack the widget toolkit draws with. */
function ctx_measure(ui, str, size, font = FONTS.display, weight = 700) {
  const ctx = ui.ctx;
  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
  const width = ctx.measureText(String(str)).width;
  ctx.restore();
  return width;
}
