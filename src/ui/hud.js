/**
 * In-game HUD.
 *
 * Layout is anchored to the viewport edges and scales with a single `hudScale`
 * so it stays readable at any resolution. Draws:
 *   health / armor / energy / XP  (bottom-left)
 *   weapon + ammo + reserve       (bottom-right)
 *   objective + sector + timer    (top-center)
 *   minimap + extraction status   (top-right)
 *   pickup ticker                 (left)
 */

import { clamp, clamp01, formatTime } from '../core/math.js';
import { FONTS, FONT_SIZES, PALETTE, rgba } from '../config/palette.js';
import { Rect, roundRect } from './widgets.js';
import { AMMO_LABELS, WEAPON_TIER_COLORS } from '../config/weapons.js';
import { PLAYER_BASE } from '../config/balance.js';

export class Hud {
  constructor() {
    this.showFps = false;
    this.clock = 0;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} scene
   */
  draw(ctx, scene) {
    const run = scene.run;
    const ui = scene.ui;
    if (!run) return;
    this.clock += scene.dt ?? 0;

    const w = ui.width;
    const h = ui.height;
    const scale = clamp(Math.min(w / 1280, h / 720), 0.75, 1.4);
    const pad = 18 * scale;

    ctx.save();
    ctx.setTransform(ui.dpr ?? 1, 0, 0, ui.dpr ?? 1, 0, 0);

    this.drawVitals(ctx, run, ui, new Rect(pad, h - pad - 96 * scale, 320 * scale, 96 * scale), scale);
    this.drawWeapon(ctx, run, ui, new Rect(w - pad - 320 * scale, h - pad - 92 * scale, 320 * scale, 92 * scale), scale);
    this.drawObjective(ctx, run, ui, w, scale, pad);
    if (ui.settings.video.showMinimap) {
      this.drawMinimap(ctx, run, ui, new Rect(w - pad - 168 * scale, pad, 168 * scale, 168 * scale), scale);
    }
    this.drawPickupLog(ctx, run, ui, pad, h - pad - 200 * scale, scale);
    this.drawExtractionPrompt(ctx, run, ui, w, h, scale);
    this.drawCenterBanner(ctx, run, ui, w, h, scale);
    if (ui.settings.video.showFps) {
      ui.text(`${Math.round(scene.fps ?? 0)} FPS  |  ${run.spawner.enemies.filter((e) => e.alive).length} AI  |  ${run.particles.activeCount} FX${scene.debugSuffix ?? ''}`, pad, pad + 12, {
        size: FONT_SIZES.micro,
        color: this.clock % 2 < 1 ? PALETTE.uiGood : PALETTE.uiGood,
        font: FONTS.mono,
        alpha: 0.85,
      });
    }
    ctx.restore();
  }

  drawVitals(ctx, run, ui, rect, scale) {
    const player = run.player;
    const barW = rect.w - 12;
    const barH = 17 * scale;
    const gap = 7 * scale;
    let y = rect.y;

    ui.panel(new Rect(rect.x - 6, rect.y - 10, rect.w + 12, rect.h + 14), { alpha: 0.72 });

    // Health.
    ui.label('VITALS', rect.x + 4, y - 2, { size: FONT_SIZES.micro });
    ui.text(`${Math.ceil(player.health)}`, rect.right - 4, y - 2, {
      size: FONT_SIZES.small,
      color: player.health / player.maxHealth < 0.3 ? PALETTE.uiDanger : PALETTE.ui,
      align: 'right',
      font: FONTS.mono,
      weight: 700,
    });
    ui.progressBar(new Rect(rect.x + 4, y + 8 * scale, barW, barH), player.health / player.maxHealth, {
      color: player.health / player.maxHealth < 0.3 ? PALETTE.uiDanger : PALETTE.health,
    });

    // Low-health heartbeat outline.
    if (player.health / player.maxHealth < 0.3 && player.alive) {
      const pulse = (Math.sin(this.clock * 8) + 1) / 2;
      ctx.save();
      roundRect(ctx, new Rect(rect.x + 2, y + 6 * scale, barW + 4, barH + 4), 4);
      ctx.strokeStyle = rgba(PALETTE.uiDanger, 0.3 + pulse * 0.5);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    }
    y += barH + gap + 8 * scale;

    // Armor.
    const armorMax = Math.max(player.maxArmor, 50);
    ui.label('ARMOR', rect.x + 4, y - 2, { size: FONT_SIZES.micro });
    ui.text(`${Math.ceil(player.armor)}`, rect.right - 4, y - 2, {
      size: FONT_SIZES.micro,
      color: PALETTE.armor,
      align: 'right',
      font: FONTS.mono,
      weight: 700,
    });
    ui.progressBar(new Rect(rect.x + 4, y + 6 * scale, barW, barH * 0.62), clamp01(player.armor / armorMax), {
      color: PALETTE.armor,
    });
    y += barH * 0.62 + gap + 8 * scale;

    // Energy.
    ui.label('ENERGY', rect.x + 4, y - 2, { size: FONT_SIZES.micro });
    ui.text(`${Math.ceil(player.energy)}`, rect.right - 4, y - 2, {
      size: FONT_SIZES.micro,
      color: PALETTE.energy,
      align: 'right',
      font: FONTS.mono,
      weight: 700,
    });
    ui.progressBar(new Rect(rect.x + 4, y + 6 * scale, barW, barH * 0.62), clamp01(player.energy / player.maxEnergy), {
      color: player.isSprinting ? PALETTE.uiAccent : PALETTE.energy,
    });
    y += barH * 0.62 + gap + 6 * scale;

    // In-run XP.
    const xp = run.xpProgress();
    ui.progressBar(new Rect(rect.x + 4, y + 2, barW, 5 * scale), xp.ratio, { color: PALETTE.xp });
    ui.text(`LV ${xp.level}`, rect.x + 4, y + 13 * scale, { size: FONT_SIZES.micro, color: PALETTE.xp, font: FONTS.display, weight: 700 });
    ui.text(`${xp.current} / ${xp.needed}`, rect.right - 4, y + 13 * scale, {
      size: FONT_SIZES.micro,
      color: PALETTE.uiDim,
      align: 'right',
      font: FONTS.mono,
    });
  }

  drawWeapon(ctx, run, ui, rect, scale) {
    const player = run.player;
    const weapon = player.weapon;
    ui.panel(new Rect(rect.x - 6, rect.y - 10, rect.w + 12, rect.h + 14), { alpha: 0.72 });
    if (!weapon) return;

    const def = weapon.def;
    const tierColor = WEAPON_TIER_COLORS[weapon.tier] ?? PALETTE.uiDim;

    // Weapon name + tier.
    ui.text(def.short ?? def.name.toUpperCase(), rect.right - 4, rect.y + 2, {
      size: FONT_SIZES.large,
      color: PALETTE.ui,
      align: 'right',
      font: FONTS.display,
      weight: 700,
      letterSpacing: 1,
    });
    ui.label(`TIER ${weapon.tier}`, rect.x + 4, rect.y + 2, { color: tierColor });

    // Magazines held (empty pips) + rounds.
    const magY = rect.y + 22 * scale;
    const pipW = clamp((rect.w - 20) / weapon.magazineSize, 1.6, 7);
    const pipGap = 1.4;
    const maxPips = Math.floor((rect.w - 10) / (pipW + pipGap));
    const visible = Math.min(weapon.magazineSize, maxPips);
    const perPip = weapon.magazineSize / visible;
    for (let i = 0; i < visible; i += 1) {
      const threshold = i * perPip;
      const filled = weapon.ammo - threshold;
      const ratio = clamp01(filled / perPip);
      const x = rect.x + 4 + i * (pipW + pipGap);
      ctx.fillStyle = 'rgba(8,12,18,0.9)';
      ctx.fillRect(x, magY, pipW, 12 * scale);
      if (ratio > 0) {
        ctx.fillStyle = ratio >= 1 ? def.color : rgba(def.color, 0.5 + ratio * 0.5);
        ctx.fillRect(x, magY, pipW, 12 * scale * ratio);
      }
    }

    // Reload bar replaces the pips while reloading.
    if (weapon.isReloading) {
      ui.progressBar(new Rect(rect.x + 4, magY, rect.w - 8, 12 * scale), weapon.reloadProgress(), {
        color: PALETTE.uiWarn,
        label: 'RELOADING',
      });
    }

    // Ammo numbers.
    const ammoY = magY + 22 * scale;
    const reserve = player.ammo.get(def.ammo);
    ui.text(`${weapon.ammo}`, rect.right - 4, ammoY, {
      size: FONT_SIZES.heading,
      color: weapon.ammo === 0 ? PALETTE.uiDanger : PALETTE.ui,
      align: 'right',
      font: FONTS.mono,
      weight: 700,
    });
    ui.text(`/ ${reserve}`, rect.right - 62 * scale, ammoY, {
      size: FONT_SIZES.body,
      color: PALETTE.uiDim,
      align: 'right',
      font: FONTS.mono,
    });
    ui.label(`${AMMO_LABELS[def.ammo]}`, rect.x + 4, ammoY - 8 * scale, { size: FONT_SIZES.micro });

    // Loadout list.
    let lx = rect.x + 4;
    const ly = rect.bottom - 2;
    for (let i = 0; i < player.weapons.length; i += 1) {
      const w = player.weapons[i];
      const active = i === player.weaponIndex;
      const label = `${i + 1} ${w.def.short}`;
      ctx.font = `700 ${FONT_SIZES.micro}px ${FONTS.display}`;
      const tw = ctx.measureText(label).width + 10;
      const box = new Rect(lx, ly - 9, tw, 15);
      ctx.fillStyle = active ? rgba(PALETTE.uiAccent, 0.2) : 'rgba(12,18,26,0.7)';
      ctx.fillRect(box.x, box.y, box.w, box.h);
      if (active) {
        ctx.strokeStyle = rgba(PALETTE.uiAccent, 0.7);
        ctx.lineWidth = 1;
        ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
      }
      ui.text(label, box.centerX, box.centerY, {
        size: FONT_SIZES.micro,
        color: active ? PALETTE.uiAccent : PALETTE.uiDim,
        align: 'center',
        font: FONTS.display,
        weight: 700,
      });
      lx += tw + 5;
      if (lx > rect.right - 20) break;
    }

    // Consumables and dash pips.
    this.drawConsumables(ctx, ui, player, new Rect(rect.x - 4, rect.y - 44 * scale, rect.w, 30 * scale), scale);
  }

  drawConsumables(ctx, ui, player, rect, scale) {
    const items = [
      { key: 'medkit', label: 'F', name: 'KIT', count: player.consumables.medkit ?? 0, color: PALETTE.health },
      { key: 'armorplate', label: 'G', name: 'PLATE', count: player.consumables.armorplate ?? 0, color: PALETTE.armor },
      { key: 'stim', label: 'T', name: 'STIM', count: player.consumables.stim ?? 0, color: PALETTE.energy },
    ];
    let x = rect.right;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      const boxW = 62 * scale;
      const boxH = 24 * scale;
      const box = new Rect(x - boxW, rect.y, boxW, boxH);
      ctx.fillStyle = item.count > 0 ? 'rgba(12,20,28,0.8)' : 'rgba(10,14,20,0.5)';
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.strokeStyle = item.count > 0 ? rgba(item.color, 0.5) : 'rgba(90,100,115,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
      ui.text(item.name, box.x + 6, box.centerY, {
        size: FONT_SIZES.micro,
        color: item.count > 0 ? item.color : PALETTE.uiFaint,
        font: FONTS.display,
        weight: 700,
      });
      ui.text(`${item.count}`, box.right - 6, box.centerY, {
        size: FONT_SIZES.small,
        color: item.count > 0 ? PALETTE.ui : PALETTE.uiFaint,
        align: 'right',
        font: FONTS.mono,
        weight: 700,
      });
      ui.keycap(box.x + 6, box.bottom + 12 * scale, item.label);
      x -= boxW + 6 * scale;
    }

    // Dash cooldown indicator.
    const dashRatio = 1 - player.dashCooldown / PLAYER_BASE.dashCooldown;
    const dashReady = player.dashCooldown <= 0 && player.energy >= PLAYER_BASE.dashCost;
    const dRect = new Rect(rect.x, rect.bottom + 4 * scale, 56 * scale, 5 * scale);
    ui.progressBar(dRect, dashReady ? 1 : Math.max(0, dashRatio), {
      color: dashReady ? PALETTE.uiGood : PALETTE.uiFaint,
    });
    ui.text('DASH', dRect.x + dRect.w + 6, dRect.centerY, {
      size: FONT_SIZES.micro,
      color: dashReady ? PALETTE.uiGood : PALETTE.uiFaint,
      font: FONTS.display,
      weight: 700,
    });
  }

  drawObjective(ctx, run, ui, width, scale, pad) {
    const info = run.objectives.describe(run.objectives.main);
    const boxW = 380 * scale;
    const boxH = 56 * scale;
    const rect = new Rect((width - boxW) / 2, pad - 4, boxW, boxH);
    ui.panel(rect, { alpha: 0.72 });

    const complete = run.objectives.allComplete;
    const color = complete ? PALETTE.uiGood : PALETTE.objective;

    ui.label(complete ? 'OBJECTIVE COMPLETE' : 'OBJECTIVE', rect.x + 12, rect.y + 14 * scale, { color });
    ui.text(info.title, rect.right - 12, rect.y + 14 * scale, {
      size: FONT_SIZES.small,
      color: PALETTE.ui,
      align: 'right',
      font: FONTS.display,
      weight: 700,
      letterSpacing: 1,
    });
    ui.text(info.detail, rect.x + 12, rect.y + 34 * scale, {
      size: FONT_SIZES.tiny,
      color: complete ? PALETTE.uiGood : PALETTE.uiDim,
    });

    const main = run.objectives.main;
    if (main && !complete) {
      ui.progressBar(new Rect(rect.x + 12, rect.bottom - 10 * scale, rect.w - 24, 5 * scale), main.progress / main.target, {
        color,
      });
    }

    // Sector + timer.
    const sectorText = `SECTOR ${run.tier}  ·  ${run.zone.name}`;
    ui.text(sectorText, width / 2, rect.y - 14 * scale, {
      size: FONT_SIZES.tiny,
      color: PALETTE.uiDim,
      align: 'center',
      font: FONTS.display,
      weight: 700,
      letterSpacing: 2,
    });
    ui.text(formatTime(run.elapsed), width / 2, rect.bottom + 16 * scale, {
      size: FONT_SIZES.small,
      color: PALETTE.ui,
      align: 'center',
      font: FONTS.mono,
      weight: 700,
    });
    ui.text(`+${run.descendZone ? 'EXTRACT / DESCEND' : 'EXTRACT'}`, width / 2, rect.bottom + 32 * scale, {
      size: FONT_SIZES.micro,
      color: complete ? PALETTE.uiGood : PALETTE.uiFaint,
      align: 'center',
      font: FONTS.display,
      weight: 700,
      letterSpacing: 1.4,
    });
  }

  drawMinimap(ctx, run, ui, rect, scale) {
    const map = run.zone.map;
    ui.panel(rect, { alpha: 0.8 });
    const inner = rect.inset(6);
    const sx = inner.w / map.worldWidth;
    const sy = inner.h / map.worldHeight;
    const s = Math.min(sx, sy);
    const offsetX = inner.x + (inner.w - map.worldWidth * s) / 2;
    const offsetY = inner.y + (inner.h - map.worldHeight * s) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(inner.x, inner.y, inner.w, inner.h);
    ctx.clip();

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
      ctx.fillStyle = rgba(color, room.type === 'combat' ? 0.35 : 0.55);
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

    // Loot.
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
      const pulse = 2 + Math.sin(run.elapsed * 4) * 1.2;
      ctx.strokeStyle = PALETTE.objective;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, pulse + 1, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Extraction + descent.
    const ex = project(run.extractionZone.x, run.extractionZone.y);
    ctx.strokeStyle = run.objectives.allComplete ? PALETTE.extraction : PALETTE.uiFaint;
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
      ctx.strokeStyle = PALETTE.descend;
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

    ui.label(run.zone.name.split(' ')[0], rect.x + 6, rect.bottom + 10 * scale, { size: FONT_SIZES.micro });
  }

  drawPickupLog(ctx, run, ui, x, y, scale) {
    void ctx;
    let cursorY = y;
    for (let i = run.pickupLog.length - 1; i >= 0; i -= 1) {
      const entry = run.pickupLog[i];
      const alpha = clamp01(entry.life / 0.6);
      const rect = new Rect(x, cursorY - 22 * scale, 240 * scale, 20 * scale);
      ui.panel(rect, { alpha: 0.7 * alpha });
      ui.text(entry.text, rect.x + 10, rect.centerY, {
        size: FONT_SIZES.tiny,
        color: entry.color,
        alpha,
        font: FONTS.display,
        weight: 700,
      });
      if (entry.detail) {
        ui.text(entry.detail, rect.right - 10, rect.centerY, {
          size: FONT_SIZES.tiny,
          color: PALETTE.ui,
          align: 'right',
          alpha,
          font: FONTS.mono,
        });
      }
      cursorY -= 24 * scale;
    }
  }

  /** Prompts the player when they are standing in a usable zone. */
  drawExtractionPrompt(ctx, run, ui, width, height, scale) {
    void ctx;
    const player = run.player;
    const zones = [
      { zone: run.extractionZone, label: 'EXTRACT', color: PALETTE.extraction, key: null },
      { zone: run.descendZone, label: 'DESCEND TO NEXT SECTOR', color: PALETTE.descend, key: null },
    ];
    let y = height * 0.62;
    for (const entry of zones) {
      if (!entry.zone) continue;
      if (!entry.zone.isNear(player.x, player.y, 90)) continue;
      const inside = entry.zone.contains(player.x, player.y);
      const ready = run.objectives.allComplete;
      const boxW = 320 * scale;
      const rect = new Rect((width - boxW) / 2, y, boxW, 46 * scale);
      ui.panel(rect, { alpha: 0.85, border: true });
      ui.label(entry.label, rect.centerX, rect.y + 14 * scale, {
        color: ready ? entry.color : PALETTE.uiWarn,
        align: 'center',
        size: FONT_SIZES.micro,
      });
      if (!ready) {
        ui.text('COMPLETE THE OBJECTIVE FIRST', rect.centerX, rect.y + 30 * scale, {
          size: FONT_SIZES.tiny,
          color: PALETTE.uiWarn,
          align: 'center',
          font: FONTS.display,
          weight: 700,
        });
      } else if (!inside) {
        ui.text('MOVE INTO THE ZONE TO CHANNEL', rect.centerX, rect.y + 30 * scale, {
          size: FONT_SIZES.tiny,
          color: PALETTE.uiDim,
          align: 'center',
          font: FONTS.display,
          weight: 700,
        });
      } else {
        const zone = entry.zone;
        ui.progressBar(new Rect(rect.x + 12, rect.bottom - 14 * scale, rect.w - 24, 7 * scale), zone.progress / zone.channelTime, {
          color: entry.color,
        });
        ui.text(zone.active ? 'CHANNELLING… STAY IN THE ZONE' : 'CHANNEL HELD', rect.centerX, rect.y + 30 * scale, {
          size: FONT_SIZES.tiny,
          color: entry.color,
          align: 'center',
          font: FONTS.display,
          weight: 700,
        });
      }
      y += 56 * scale;
    }
  }

  drawCenterBanner(ctx, run, ui, width, height, scale) {
    void ctx;
    // Boss warning while a live boss is sleeping.
    const boss = run.spawner.boss;
    if (boss && boss.alive && !boss.alerted) {
      ui.text('HOSTILE COMMAND SIGNATURE DETECTED', width / 2, height * 0.24, {
        size: FONT_SIZES.small,
        color: PALETTE.boss,
        align: 'center',
        font: FONTS.display,
        weight: 700,
        letterSpacing: 2,
        alpha: 0.6 + (Math.sin(this.clock * 3) + 1) * 0.2,
      });
    }
    if (run.threatLevel > 0.4) {
      const alpha = clamp01(run.threatLevel) * 0.5;
      ui.text('COMBAT', width / 2, height - 40 * scale, {
        size: FONT_SIZES.micro,
        color: PALETTE.hostile,
        align: 'center',
        font: FONTS.display,
        weight: 700,
        alpha,
        letterSpacing: 4,
      });
    }
  }
}
