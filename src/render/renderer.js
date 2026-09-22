/**
 * World renderer.
 *
 * Everything on screen is drawn procedurally (no textures, no sprites), which
 * keeps the project self-contained and gives full control over readability.
 *
 * Draw order is fixed and documented so visual bugs are easy to reason about:
 *   background -> floor/walls -> decor -> zones -> props -> loot -> enemies ->
 *   projectiles -> player -> particles -> lighting -> floating text -> minimap
 */

import { TAU, clamp, damp, dist2, lerp } from '../core/math.js';
import { FLOOR, SOLID, TILE } from '../world/tilemap.js';
import { FONTS, PALETTE, rgba } from '../config/palette.js';
import { ELITE_ABILITY, ENEMY_STATES } from '../config/enemies.js';
import { DROP_KIND } from '../loot/loot.js';
import { PROP_KINDS } from '../world/world.js';

const LIGHT_AMBIENT = { r: 96, g: 104, b: 124 };

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onError?: (e: Error, ctx: string) => void}} [options]
   */
  constructor(canvas, options = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new TypeError('Renderer requires a canvas element');
    }
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw new Error('2D canvas context unavailable');
    this.onError = options.onError ?? null;
    this.width = canvas.width;
    this.height = canvas.height;
    this.dpr = 1;
    this.lightCanvas = document.createElement('canvas');
    this.lightCtx = this.lightCanvas.getContext('2d');
    this.lightCanvas.width = Math.max(1, Math.floor(this.width));
    this.lightCanvas.height = Math.max(1, Math.floor(this.height));
    this.frame = 0;
    this.enableBloom = true;
  }

  resize(cssWidth, cssHeight, dpr = 1) {
    const w = Math.max(320, Math.floor(cssWidth));
    const h = Math.max(240, Math.floor(cssHeight));
    this.dpr = clamp(dpr, 1, 2.5);
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.width = this.canvas.width;
    this.height = this.canvas.height;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.lightCanvas.width = this.width;
    this.lightCanvas.height = this.height;
    return { width: w, height: h, dpr: this.dpr };
  }

  /** CSS-pixel size of the drawing buffer. */
  get viewWidth() {
    return this.width / this.dpr;
  }

  get viewHeight() {
    return this.height / this.dpr;
  }

  clear(color = PALETTE.void) {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  /**
   * @param {Object} scene
   * @param {import('../game/run.js').Run|null} scene.run
   * @param {Object} scene.ui
   * @param {number} scene.time
   * @param {number} scene.fps
   */
  draw(scene) {
    const ctx = this.ctx;
    this.frame += 1;
    this.enableBloom = scene.ui?.settings?.video?.bloom ?? true;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = PALETTE.void;
    ctx.fillRect(0, 0, this.viewWidth, this.viewHeight);

    const run = scene.run;
    if (run) {
      this.drawWorld(ctx, run, scene);
    }

    // UI is drawn after lighting so it is never dimmed.
    if (scene.ui && typeof scene.ui.draw === 'function') {
      scene.ui.draw(ctx, scene);
    }
  }

  // -------------------------------------------------------------------------
  // World
  // -------------------------------------------------------------------------

  drawWorld(ctx, run, scene) {
    const camera = run.camera;
    const view = camera.visibleRect(48);
    const tint = run.tint ?? { floor: PALETTE.floor, accent: PALETTE.uiAccent };

    this.drawVoid(ctx, camera, tint);
    ctx.save();
    camera.applyTransform(ctx);
    this.drawTiles(ctx, run, view, tint);
    this.drawDecor(ctx, run, view);
    this.drawZones(ctx, run);
    this.drawObjectiveMarkers(ctx, run);
    this.drawProps(ctx, run, view);
    this.drawLoot(ctx, run, view);
    this.drawEnemies(ctx, run, view);
    this.drawProjectiles(ctx, run, view);
    this.drawPlayer(ctx, run);
    run.particles.draw(ctx, view);
    ctx.restore();

    // Screen-space lighting composite.
    this.drawLighting(ctx, run, view, tint);

    // Floating text is drawn in world space but after lighting so it stays crisp.
    ctx.save();
    camera.applyTransform(ctx);
    run.floatingText.draw(ctx, camera, view);
    ctx.restore();

    this.drawScreenEffects(ctx, run, scene);
  }

  /** Parallax void pattern behind the map so the world never looks empty. */
  drawVoid(ctx, camera, tint) {
    const w = this.viewWidth;
    const h = this.viewHeight;
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, '#05070c');
    gradient.addColorStop(1, '#070a11');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    const cell = 96;
    const offsetX = -(camera.renderX * 0.12) % cell;
    const offsetY = -(camera.renderY * 0.12) % cell;
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = rgba(tint.accent, 0.06);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = offsetX; x < w + cell; x += cell) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, h);
    }
    for (let y = offsetY; y < h + cell; y += cell) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(w, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawTiles(ctx, run, view, tint) {
    const map = run.zone.map;
    const ts = map.tileSize;
    const minTx = clamp(Math.floor(view.x / ts) - 1, 0, map.width - 1);
    const maxTx = clamp(Math.ceil((view.x + view.w) / ts) + 1, 0, map.width - 1);
    const minTy = clamp(Math.floor(view.y / ts) - 1, 0, map.height - 1);
    const maxTy = clamp(Math.ceil((view.y + view.h) / ts) + 1, 0, map.height - 1);

    // Floors first so wall highlights overlay cleanly.
    ctx.fillStyle = tint.floor;
    for (let ty = minTy; ty <= maxTy; ty += 1) {
      const base = ty * map.width;
      for (let tx = minTx; tx <= maxTx; tx += 1) {
        if (map.tiles[base + tx] !== FLOOR) continue;
        ctx.fillRect(tx * ts, ty * ts, ts, ts);
      }
    }

    // Subtle floor patterning: a lighter checker every other tile.
    ctx.fillStyle = rgba(tint.accent, 0.014);
    for (let ty = minTy; ty <= maxTy; ty += 2) {
      const base = ty * map.width;
      for (let tx = minTx + (ty % 4 === 0 ? 0 : 1); tx <= maxTx; tx += 2) {
        if (map.tiles[base + tx] !== FLOOR) continue;
        ctx.fillRect(tx * ts, ty * ts, ts, ts);
      }
    }

    // Walls: solid tiles touching floor become visible structure.
    for (let ty = minTy; ty <= maxTy; ty += 1) {
      for (let tx = minTx; tx <= maxTx; tx += 1) {
        if (map.tiles[ty * map.width + tx] !== SOLID) continue;
        const touchesFloor =
          map.isFloor(tx + 1, ty) || map.isFloor(tx - 1, ty) || map.isFloor(tx, ty + 1) || map.isFloor(tx, ty - 1);
        if (!touchesFloor) continue;
        const x = tx * ts;
        const y = ty * ts;
        ctx.fillStyle = PALETTE.wall;
        ctx.fillRect(x, y, ts, ts);
        // Top face for tiles whose "north" is also solid, giving depth.
        ctx.fillStyle = PALETTE.wallTop;
        if (!map.isFloor(tx, ty - 1)) ctx.fillRect(x, y, ts, ts * 0.45);
        // Edge highlights on the sides that face open floor.
        ctx.fillStyle = rgba(tint.accent, 0.16);
        if (map.isFloor(tx + 1, ty)) ctx.fillRect(x + ts - 3, y, 3, ts);
        if (map.isFloor(tx - 1, ty)) ctx.fillRect(x, y, 3, ts);
        if (map.isFloor(tx, ty + 1)) ctx.fillRect(x, y + ts - 3, ts, 3);
        if (map.isFloor(tx, ty - 1)) ctx.fillRect(x, y, ts, 3);
      }
    }
  }

  drawDecor(ctx, run, view) {
    const decor = run.zone.decor;
    if (!decor) return;
    ctx.save();
    for (const d of decor) {
      if (d.x < view.x || d.x > view.x + view.w || d.y < view.y || d.y > view.y + view.h) continue;
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(d.angle);
      ctx.scale(d.scale, d.scale);
      ctx.globalAlpha = 0.5;
      switch (d.kind) {
        case 'grate':
          ctx.strokeStyle = 'rgba(120,150,180,0.18)';
          ctx.lineWidth = 1;
          for (let i = -8; i <= 8; i += 4) {
            ctx.beginPath();
            ctx.moveTo(i, -10);
            ctx.lineTo(i, 10);
            ctx.stroke();
          }
          break;
        case 'stain':
          ctx.fillStyle = 'rgba(20,26,36,0.75)';
          ctx.beginPath();
          ctx.ellipse(0, 0, 16, 11, 0, 0, TAU);
          ctx.fill();
          break;
        case 'cable':
          ctx.strokeStyle = 'rgba(60,80,100,0.5)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(-20, 0);
          ctx.quadraticCurveTo(0, 9, 20, -2);
          ctx.stroke();
          break;
        case 'marking':
          ctx.strokeStyle = 'rgba(200,180,90,0.14)';
          ctx.lineWidth = 3;
          ctx.strokeRect(-14, -14, 28, 28);
          break;
        case 'rubble':
        default:
          ctx.fillStyle = 'rgba(40,48,62,0.85)';
          for (let i = 0; i < 4; i += 1) {
            const a = (d.seed + i * 37) % 360;
            ctx.beginPath();
            ctx.arc(Math.cos(a) * 10, Math.sin(a) * 10, 2 + (i % 3), 0, TAU);
            ctx.fill();
          }
          break;
      }
      ctx.restore();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  drawZones(ctx, run) {
    run.extractionZone.draw(ctx);
    if (run.descendZone) run.descendZone.draw(ctx);
  }

  drawObjectiveMarkers(ctx, run) {
    const markers = run.objectives.activeMarkers();
    const pulse = (Math.sin(run.elapsed * 3) + 1) / 2;
    for (const marker of markers) {
      if (marker.type === 'eliminate' || marker.type === 'boss') {
        ctx.save();
        ctx.globalAlpha = 0.35 + pulse * 0.25;
        ctx.strokeStyle = marker.type === 'boss' ? '#ff5c33' : PALETTE.objective;
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 8]);
        ctx.lineDashOffset = -run.elapsed * 20;
        ctx.beginPath();
        ctx.arc(marker.x, marker.y, 34 + pulse * 6, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
  }

  drawProps(ctx, run, view) {
    const props = run.world.props;
    for (const prop of props) {
      if (!prop.alive) continue;
      if (prop.x < view.x - 60 || prop.x > view.x + view.w + 60) continue;
      if (prop.y < view.y - 60 || prop.y > view.y + view.h + 60) continue;
      ctx.save();
      ctx.translate(prop.x, prop.y);
      ctx.rotate(prop.angle);
      const s = prop.size;
      const flash = prop.hitFlash > 0 ? prop.hitFlash / 0.12 : 0;
      const healthRatio = prop.destructible ? clamp(prop.health / prop.maxHealth, 0, 1) : 1;

      switch (prop.kind) {
        case PROP_KINDS.BARREL:
          ctx.fillStyle = '#3a2b20';
          ctx.fillRect(-s / 2, -s / 2, s, s);
          ctx.fillStyle = flash > 0 ? '#ffd9a0' : '#5a3a24';
          ctx.fillRect(-s / 2 + 2, -s / 2 + 2, s - 4, s - 4);
          ctx.fillStyle = 'rgba(255,140,60,0.75)';
          ctx.fillRect(-s / 2, -2, s, 3);
          ctx.beginPath();
          ctx.arc(0, 0, 3, 0, TAU);
          ctx.fill();
          break;
        case PROP_KINDS.CRATE:
          ctx.fillStyle = '#2b2419';
          ctx.fillRect(-s / 2, -s / 2, s, s);
          ctx.strokeStyle = flash > 0 ? '#ffe8b0' : '#5d5138';
          ctx.lineWidth = 2;
          ctx.strokeRect(-s / 2 + 1, -s / 2 + 1, s - 2, s - 2);
          ctx.beginPath();
          ctx.moveTo(-s / 2 + 2, -s / 2 + 2);
          ctx.lineTo(s / 2 - 2, s / 2 - 2);
          ctx.stroke();
          break;
        case PROP_KINDS.CONSOLE:
          ctx.fillStyle = '#1b2430';
          ctx.fillRect(-s / 2, -s / 2, s, s);
          ctx.fillStyle = rgba(run.tint.accent, 0.5 + flash * 0.5);
          ctx.fillRect(-s / 2 + 4, -s / 2 + 4, s - 8, 6);
          ctx.fillStyle = 'rgba(110,227,196,0.35)';
          ctx.fillRect(-s / 2 + 4, -2, s - 8, 3);
          break;
        case PROP_KINDS.GIRDER:
          ctx.fillStyle = '#212a36';
          ctx.fillRect(-s / 2, -6, s, 12);
          ctx.fillStyle = '#333f50';
          for (let i = -s / 2 + 3; i < s / 2 - 3; i += 8) ctx.fillRect(i, -5, 3, 10);
          break;
        case PROP_KINDS.VENT:
          ctx.fillStyle = 'rgba(70,90,110,0.6)';
          ctx.beginPath();
          ctx.arc(0, 0, s / 2, 0, TAU);
          ctx.fill();
          ctx.strokeStyle = 'rgba(180,200,220,0.25)';
          ctx.lineWidth = 1.5;
          for (let i = -1; i <= 1; i += 1) {
            ctx.beginPath();
            ctx.moveTo(-s / 2 + 3, i * 5);
            ctx.lineTo(s / 2 - 3, i * 5);
            ctx.stroke();
          }
          break;
        case PROP_KINDS.REACTOR: {
          const glow = 0.4 + pulseGlow(run.elapsed, 2) * 0.5;
          ctx.fillStyle = '#20283a';
          ctx.beginPath();
          ctx.arc(0, 0, s / 2, 0, TAU);
          ctx.fill();
          ctx.strokeStyle = flash > 0 ? '#ffffff' : rgba('#ffb03a', 0.5 + glow * 0.5);
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(0, 0, s / 2 - 3, 0, TAU);
          ctx.stroke();
          ctx.fillStyle = rgba('#ffb03a', 0.35 + glow * 0.4);
          ctx.beginPath();
          ctx.arc(0, 0, s / 5, 0, TAU);
          ctx.fill();
          break;
        }
        default:
          ctx.fillStyle = PALETTE.obstacleTop;
          ctx.fillRect(-s / 2, -s / 2, s, s);
          break;
      }

      if (flash > 0) {
        ctx.globalAlpha = clamp(flash, 0, 0.7);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(-s / 2, -s / 2, s, s);
        ctx.globalAlpha = 1;
      }
      ctx.restore();

      if (prop.destructible && healthRatio < 0.999) {
        const w = prop.size;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(prop.x - w / 2, prop.y - prop.size / 2 - 10, w, 4);
        ctx.fillStyle = prop.kind === PROP_KINDS.REACTOR ? PALETTE.objective : '#ff8a5c';
        ctx.fillRect(prop.x - w / 2, prop.y - prop.size / 2 - 10, w * healthRatio, 4);
      }
    }
    ctx.globalAlpha = 1;
  }

  drawLoot(ctx, run, view) {
    const t = run.elapsed;
    for (const drop of run.loot.drops) {
      if (!drop.active) continue;
      if (drop.x < view.x - 40 || drop.x > view.x + view.w + 40) continue;
      if (drop.y < view.y - 40 || drop.y > view.y + view.h + 40) continue;
      const bob = Math.sin(drop.bob) * 2.2;
      const color = drop.color;
      ctx.save();
      ctx.translate(drop.x, drop.y + bob);

      // Beam so loot is visible from far away without a marker system.
      if (this.enableBloom) {
        ctx.globalCompositeOperation = 'lighter';
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, drop.radius * 3.2);
        gradient.addColorStop(0, rgba(color, 0.4));
        gradient.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(0, 0, drop.radius * 3.2, 0, TAU);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }

      ctx.fillStyle = rgba(color, 0.9);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1.5;
      switch (drop.kind) {
        case DROP_KIND.WEAPON:
          ctx.beginPath();
          ctx.moveTo(-8, 7);
          ctx.lineTo(6, -7);
          ctx.lineTo(10, -3);
          ctx.lineTo(-4, 11);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.85)';
          ctx.fillRect(4, -8, 7, 3);
          break;
        case DROP_KIND.CONSUMABLE:
          ctx.beginPath();
          ctx.rect(-7, -9, 14, 18);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#0b1119';
          if (drop.key === 'medkit') {
            ctx.fillRect(-2, -5, 4, 10);
            ctx.fillRect(-5, -2, 10, 4);
          } else if (drop.key === 'armorplate') {
            ctx.beginPath();
            ctx.moveTo(0, -5);
            ctx.lineTo(4, -2);
            ctx.lineTo(0, 5);
            ctx.lineTo(-4, -2);
            ctx.closePath();
            ctx.fill();
          } else {
            ctx.beginPath();
            ctx.arc(0, 0, 3.5, 0, TAU);
            ctx.fill();
          }
          break;
        case DROP_KIND.CHIP:
          ctx.beginPath();
          ctx.rect(-8, -8, 16, 16);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#0b1119';
          ctx.fillRect(-4, -4, 8, 8);
          break;
        case DROP_KIND.AMMO:
          ctx.beginPath();
          ctx.rect(-7, -6, 14, 12);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#0b1119';
          for (let i = -4; i <= 4; i += 4) ctx.fillRect(i, -3, 2, 6);
          break;
        case DROP_KIND.OBJECTIVE: {
          const pulse = 0.6 + pulseGlow(t, 4) * 0.4;
          ctx.rotate(t * 1.2);
          ctx.fillStyle = rgba(color, pulse);
          ctx.beginPath();
          ctx.moveTo(0, -11);
          ctx.lineTo(11, 0);
          ctx.lineTo(0, 11);
          ctx.lineTo(-11, 0);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          break;
        }
        default:
          ctx.beginPath();
          ctx.arc(0, 0, 6, 0, TAU);
          ctx.fill();
          ctx.stroke();
          break;
      }

      // Stack count for resources.
      if ((drop.kind === DROP_KIND.RESOURCE || drop.kind === DROP_KIND.AMMO) && drop.amount > 1) {
        ctx.font = `700 11px ${FONTS.display}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,0,0,0.8)';
        ctx.fillText(`${drop.amount}`, 1, 22);
        ctx.fillStyle = '#dce6f2';
        ctx.fillText(`${drop.amount}`, 0, 21);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  drawEnemies(ctx, run, view) {
    for (const enemy of run.spawner.enemies) {
      const dying = !enemy.alive;
      if (dying && enemy.deathTimer > 1.4) continue;
      if (enemy.x < view.x - 80 || enemy.x > view.x + view.w + 80) continue;
      if (enemy.y < view.y - 80 || enemy.y > view.y + view.h + 80) continue;

      ctx.save();
      // A stagger throws the body away from whoever hit it. In a squad fight the
      // stagger is the one opening worth noticing, and it used to be invisible:
      // the state existed only inside the AI, so a cancelled telegraph looked
      // exactly like a normal hit.
      let staggerX = 0;
      let staggerY = 0;
      if (enemy.state === ENEMY_STATES.STAGGER && enemy.staggerTimer > 0) {
        const lean = clamp(enemy.staggerTimer / 0.2, 0, 1) * 7;
        staggerX = -Math.cos(enemy.lastHitAngle) * lean;
        staggerY = -Math.sin(enemy.lastHitAngle) * lean;
      }
      ctx.translate(enemy.x + staggerX, enemy.y + staggerY);
      if (dying) {
        const t = clamp(1 - enemy.deathTimer / 1.4, 0, 1);
        ctx.globalAlpha = t * 0.8;
        ctx.scale(0.7 + t * 0.6, 0.7 + t * 0.6);
      }

      // Telegraph indicator before the attack lands.
      if (enemy.state === ENEMY_STATES.TELEGRAPH) {
        const total = enemy.isBoss ? (enemy.pendingAttack?.telegraph ?? 1) : enemy.telegraphTime;
        const ratio = clamp(1 - enemy.attackWindup / Math.max(0.001, total), 0, 1);
        this.drawTelegraph(ctx, enemy, ratio);
      }

      const flash = enemy.hitFlash;
      const bodyColor = flash > 0 ? '#ffffff' : enemy.color;
      const accent = enemy.accent;
      const r = enemy.radius;

      // Contact shadow.
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(0, r * 0.55, r * 0.95, r * 0.45, 0, 0, TAU);
      ctx.fill();

      ctx.rotate(enemy.heading);
      switch (enemy.def.role) {
        case 'charger':
          ctx.fillStyle = bodyColor;
          ctx.beginPath();
          ctx.moveTo(r * 1.35, 0);
          ctx.lineTo(-r * 0.75, -r * 0.8);
          ctx.lineTo(-r * 0.35, 0);
          ctx.lineTo(-r * 0.75, r * 0.8);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = accent;
          ctx.beginPath();
          ctx.arc(r * 0.35, 0, r * 0.28, 0, TAU);
          ctx.fill();
          break;
        case 'ranged':
          ctx.fillStyle = bodyColor;
          ctx.beginPath();
          ctx.moveTo(-r, -r * 0.85);
          ctx.lineTo(r * 0.8, -r * 0.5);
          ctx.lineTo(r * 1.15, 0);
          ctx.lineTo(r * 0.8, r * 0.5);
          ctx.lineTo(-r, r * 0.85);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = accent;
          ctx.fillRect(r * 0.35, -2.5, r * 1.1, 5);
          ctx.beginPath();
          ctx.arc(-r * 0.1, 0, r * 0.34, 0, TAU);
          ctx.fill();
          break;
        case 'heavy':
          ctx.fillStyle = bodyColor;
          ctx.fillRect(-r * 0.85, -r * 0.95, r * 1.7, r * 1.9);
          ctx.fillStyle = '#2a1c16';
          ctx.fillRect(-r * 0.5, -r * 0.7, r * 1.0, r * 1.4);
          ctx.fillStyle = accent;
          ctx.fillRect(r * 0.7, -r * 0.9, r * 0.55, r * 1.8);
          ctx.beginPath();
          ctx.arc(0, 0, r * 0.3, 0, TAU);
          ctx.fill();
          break;
        case 'boss': {
          const phaseGlow = 0.4 + pulseGlow(run.elapsed, 1.6) * 0.5;
          ctx.fillStyle = bodyColor;
          ctx.beginPath();
          for (let i = 0; i < 6; i += 1) {
            const a = (i / 6) * TAU;
            const rad = i % 2 === 0 ? r * 1.15 : r * 0.85;
            if (i === 0) ctx.moveTo(Math.cos(a) * rad, Math.sin(a) * rad);
            else ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
          }
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = rgba(accent, 0.5 + phaseGlow * 0.5);
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.fillStyle = accent;
          ctx.beginPath();
          ctx.arc(0, 0, r * 0.36, 0, TAU);
          ctx.fill();
          ctx.fillStyle = '#1a0f0a';
          ctx.fillRect(r * 0.6, -r * 0.9, r * 0.5, r * 0.28);
          ctx.fillRect(r * 0.6, r * 0.62, r * 0.5, r * 0.28);
          break;
        }
        default: {
          // Husk: humanoid silhouette.
          ctx.fillStyle = bodyColor;
          ctx.beginPath();
          ctx.arc(0, 0, r * 0.78, 0, TAU);
          ctx.fill();
          ctx.fillStyle = '#2a1f18';
          ctx.fillRect(-r * 0.2, -r * 0.95, r * 0.4, r * 1.9);
          ctx.fillStyle = accent;
          ctx.fillRect(r * 0.55, -r * 0.18, r * 0.9, r * 0.36);
          break;
        }
      }
      ctx.rotate(-enemy.heading);

      // Elite / champion aura ring.
      if (enemy.isElite) {
        ctx.strokeStyle = rgba(PALETTE.hostileElite, 0.6);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, r + 7 + Math.sin(run.elapsed * 4) * 1.5, 0, TAU);
        ctx.stroke();
      }
      if (enemy.shield > 0) {
        ctx.strokeStyle = rgba('#7fe6ff', 0.75);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, r + 5, 0, TAU);
        ctx.stroke();
      }

      // Elite ability sigil: a short-lived badge in the ability's colour, so an
      // ability that already resolved is still readable a beat later, when the
      // player is looking at what it did rather than at the caster.
      if (enemy.abilityFx) {
        const fx = enemy.abilityFx;
        const life = clamp(fx.t / 0.5, 0, 1);
        const pulse = clamp(fx.t / 0.45, 0, 1);
        ctx.strokeStyle = rgba(fx.color, 0.35 + life * 0.5);
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, r + 9 + (1 - pulse) * 10, 0, TAU);
        ctx.stroke();
        ctx.strokeStyle = rgba(fx.color, 0.2 + life * 0.35);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, r + 15 + (1 - pulse) * 6, 0, TAU);
        ctx.stroke();
        // A burst gets its fan drawn where it fired: the warning the ability
        // never had, and the only reason a player learns which way it went.
        if (fx.kind === ELITE_ABILITY.BURST) {
          const angle = enemy.telegraphAngle ?? enemy.heading;
          ctx.save();
          ctx.globalAlpha = life * 0.5;
          ctx.fillStyle = rgba(fx.color, 1);
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.arc(0, 0, r + 120 * (1 - pulse), angle - 0.5, angle + 0.5);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }

      ctx.restore();

      // Health bars (elites, boss, or recently damaged enemies).
      const showBar = enemy.isBoss || enemy.isElite || (enemy.alive && enemy.healthRatio < 0.999 && enemy.hitFlash > 0);
      if (showBar && enemy.alive) {
        this.drawEnemyHealthBar(ctx, enemy);
      }
    }
    ctx.globalAlpha = 1;
  }

  drawTelegraph(ctx, enemy, ratio) {
    const color = enemy.accent;
    ctx.save();
    ctx.globalAlpha = 0.25 + ratio * 0.35;
    const kind = enemy.isBoss ? enemy.pendingAttack?.kind : enemy.telegraphKind;
    const angle = enemy.telegraphAngle ?? enemy.heading;
    if (kind === 'ranged' || kind === 'burst' || kind === 'sweep' || kind === 'lance' || kind === 'charger') {
      // Directional cone showing where the shot/charge will go. Lances reach
      // across the arena, so their cone has to be long and narrow to read as
      // "this one is aimed at you from here".
      const range = kind === 'charger' ? 220
        : kind === 'lance' ? 620
          : kind === 'ranged' ? Math.min(enemy.attackRange ?? 420, 460) : 420;
      const half = kind === 'charger' ? 0.22 : kind === 'sweep' ? 0.5 : kind === 'lance' ? 0.12 : 0.24;
      ctx.rotate(angle);
      ctx.fillStyle = rgba(color, 0.3);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, range, -half, half);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = rgba(color, 0.6);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      // Radial pulse for melee / slam / the endgame arena's ground pods. The
      // slam radius comes from the attack spec so an arena can retune it
      // without the warning circle misreporting the hitbox.
      const radius = kind === 'slam' ? (enemy.pendingAttack?.radius ?? 120)
        : kind === 'pods' ? 170
          : enemy.radius + 26;
      ctx.strokeStyle = rgba(color, 0.8);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, radius * (0.6 + ratio * 0.5), 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 0.15 + ratio * 0.25;
      ctx.fillStyle = rgba(color, 0.5);
      ctx.beginPath();
      ctx.arc(0, 0, radius * (0.6 + ratio * 0.5), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  drawEnemyHealthBar(ctx, enemy) {
    const width = enemy.isBoss ? 120 : enemy.isElite ? 44 : 30;
    const x = enemy.x - width / 2;
    const y = enemy.y - enemy.radius - (enemy.isBoss ? 26 : 14);
    const h = enemy.isBoss ? 7 : 4;
    const ratio = enemy.healthRatio;
    const shieldRatio = enemy.maxShield > 0 ? enemy.shield / enemy.maxShield : 0;

    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(x - 1, y - 1, width + 2, h + 2);
    ctx.fillStyle = enemy.isBoss ? PALETTE.health : rgba(PALETTE.health, 0.9);
    ctx.fillRect(x, y, width * ratio, h);
    if (shieldRatio > 0) {
      ctx.fillStyle = rgba('#7fe6ff', 0.8);
      ctx.fillRect(x, y, width * shieldRatio, h);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(x, y, width * ratio, 1);

    if (enemy.isBoss) {
      ctx.font = `700 11px ${FONTS.display}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffb03a';
      ctx.fillText(`${enemy.displayName}  —  ${enemy.phaseName}`, enemy.x, y - 6);
    }
  }

  drawProjectiles(ctx, run, view) {
    run.projectiles.draw(ctx, view);
  }

  drawPlayer(ctx, run) {
    const player = run.player;
    if (!player.alive) {
      ctx.save();
      ctx.translate(player.x, player.y);
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = PALETTE.health;
      ctx.beginPath();
      ctx.arc(0, 0, player.radius * 1.4, 0, TAU);
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
      return;
    }
    ctx.save();
    ctx.translate(player.x, player.y);

    // Dash after-image.
    if (player.isDashing) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = PALETTE.player;
      ctx.beginPath();
      ctx.arc(-player.vx * 0.03, -player.vy * 0.03, player.radius, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Personal light ring.
    if (this.enableBloom) {
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 110);
      g.addColorStop(0, rgba(PALETTE.player, 0.16));
      g.addColorStop(1, rgba(PALETTE.player, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 110, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(0, player.radius * 0.6, player.radius, player.radius * 0.45, 0, 0, TAU);
    ctx.fill();

    // Legs animate with the walk cycle.
    const swing = Math.sin(player.walkCycle) * 4;
    ctx.strokeStyle = PALETTE.playerDark;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-3, 2);
    ctx.lineTo(-3 + swing, 12);
    ctx.moveTo(3, 2);
    ctx.lineTo(3 - swing, 12);
    ctx.stroke();

    ctx.rotate(player.aimAngle);

    // Body.
    const invulnBlink = player.invulnTimer > 0 && Math.floor(player.invulnTimer * 24) % 2 === 0;
    ctx.globalAlpha = invulnBlink ? 0.55 : 1;
    ctx.fillStyle = player.hitFlash > 0 ? '#ffffff' : PALETTE.player;
    ctx.beginPath();
    ctx.arc(0, 0, player.radius, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#0a1a22';
    ctx.beginPath();
    ctx.arc(0, 0, player.radius * 0.62, 0, TAU);
    ctx.fill();
    ctx.fillStyle = rgba(PALETTE.player, 0.9);
    ctx.beginPath();
    ctx.arc(0, 0, player.radius * 0.3, 0, TAU);
    ctx.fill();

    // Weapon barrel.
    const weapon = player.weapon;
    if (weapon) {
      const len = 12 + (weapon.def.id === 'railpiercer' ? 10 : weapon.def.id === 'breaker' ? 6 : 0);
      ctx.fillStyle = '#c4d2e2';
      ctx.fillRect(player.radius * 0.4, -3, len, 6);
      ctx.fillStyle = weapon.def.color;
      ctx.fillRect(player.radius * 0.4 + len - 3, -2, 3, 4);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // Aim reticle line (fades with distance for readability).
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.strokeStyle = PALETTE.player;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(player.x + player.aimDir.x * 22, player.y + player.aimDir.y * 22);
    ctx.lineTo(player.x + player.aimDir.x * 160, player.y + player.aimDir.y * 160);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    ctx.globalAlpha = 1;

    // World-space cursor.
    if (run.settings.video.showCrosshair) {
      const cursor = run.aimCursor ?? null;
      if (cursor) {
        ctx.save();
        ctx.translate(cursor.x, cursor.y);
        ctx.strokeStyle = rgba(PALETTE.uiAccent, 0.85);
        ctx.lineWidth = 1.5;
        const spread = weapon ? 6 + weapon.effectiveSpread() * 90 : 8;
        ctx.beginPath();
        ctx.arc(0, 0, spread, 0, TAU);
        ctx.stroke();
        for (let i = 0; i < 4; i += 1) {
          const a = (i / 4) * TAU;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * (spread + 3), Math.sin(a) * (spread + 3));
          ctx.lineTo(Math.cos(a) * (spread + 9), Math.sin(a) * (spread + 9));
          ctx.stroke();
        }
        ctx.fillStyle = rgba(PALETTE.uiAccent, 0.9);
        ctx.fillRect(-1, -1, 2, 2);
        ctx.restore();
      }
    }
  }

  /** Screen-space lighting: darken, then add every light with 'lighter'. */
  drawLighting(ctx, run, view, tint) {
    const lctx = this.lightCtx;
    if (!lctx) return;
    const w = this.width;
    const h = this.height;

    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = 'source-over';
    lctx.fillStyle = `rgb(${LIGHT_AMBIENT.r}, ${LIGHT_AMBIENT.g}, ${LIGHT_AMBIENT.b})`;
    lctx.fillRect(0, 0, w, h);

    const zoom = run.camera.zoom;
    const originX = (view.x + view.w / 2 - run.camera.renderX) * zoom + w / 2;
    const originY = (view.y + view.h / 2 - run.camera.renderY) * zoom + h / 2;

    lctx.globalCompositeOperation = 'lighter';
    const drawLight = (worldX, worldY, radius, color, intensity) => {
      const sx = originX + (worldX - (view.x + view.w / 2)) * zoom;
      const sy = originY + (worldY - (view.y + view.h / 2)) * zoom;
      const screenRadius = radius * zoom;
      if (sx + screenRadius < 0 || sx - screenRadius > w || sy + screenRadius < 0 || sy - screenRadius > h) return;
      const g = lctx.createRadialGradient(sx, sy, 0, sx, sy, screenRadius);
      g.addColorStop(0, rgba(color, intensity));
      g.addColorStop(0.55, rgba(color, intensity * 0.35));
      g.addColorStop(1, rgba(color, 0));
      lctx.fillStyle = g;
      lctx.beginPath();
      lctx.arc(sx, sy, screenRadius, 0, TAU);
      lctx.fill();
    };

    for (const light of run.zone.lights) {
      const pulse = light.pulse > 0 ? 0.75 + Math.sin(run.elapsed * 2.4) * 0.25 : 1;
      drawLight(light.x, light.y, light.radius, light.color, light.intensity * pulse * 0.85);
    }
    // Player light keeps the game readable everywhere.
    drawLight(run.player.x, run.player.y, 300, PALETTE.player, 0.4);
    // Emissive gameplay objects.
    drawLight(run.extractionZone.x, run.extractionZone.y, 220, PALETTE.extraction, 0.4);
    if (run.descendZone) drawLight(run.descendZone.x, run.descendZone.y, 200, PALETTE.descend, 0.35);
    for (const enemy of run.spawner.enemies) {
      if (!enemy.alive) continue;
      const light = enemy.isBoss ? 320 : enemy.isElite ? 120 : 64;
      drawLight(enemy.x, enemy.y, light, enemy.accent, enemy.isBoss ? 0.5 : 0.22);
    }
    for (const drop of run.loot.drops) {
      if (!drop.active) continue;
      drawLight(drop.x, drop.y, drop.rarity === 'common' ? 40 : 90, drop.color, 0.28);
    }
    if (run.player.weapon && run.player.weapon.state === 'firing') {
      drawLight(run.player.x, run.player.y, 140, run.player.weapon.def.color, 0.3);
    }
    drawLight(run.player.x, run.player.y, 90, run.tint?.accent ?? PALETTE.uiAccent, 0.18 * run.threatLevel);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.lightCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    void tint;
  }

  drawScreenEffects(ctx, run, scene) {
    const w = this.viewWidth;
    const h = this.viewHeight;

    // Damage vignette tinted by health.
    const healthRatio = run.player.maxHealth > 0 ? run.player.health / run.player.maxHealth : 0;
    const lowHealth = clamp(1 - healthRatio / 0.4, 0, 1);
    const vignette = Math.max(run.damageVignette * 0.6, lowHealth * 0.55);
    if (vignette > 0.001) {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.72);
      g.addColorStop(0, 'rgba(255,60,90,0)');
      g.addColorStop(1, rgba(PALETTE.health, vignette));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // Directional damage indicator.
    if (run.damageVignette > 0.05) {
      const angle = Math.atan2(run.hitDirection.y, run.hitDirection.x);
      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.rotate(angle);
      ctx.globalAlpha = run.damageVignette * 0.55;
      ctx.strokeStyle = PALETTE.health;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, Math.min(w, h) * 0.34, -0.35, 0.35);
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    // Flash (explosions, boss death, sector transitions).
    if (run.flash > 0.001) {
      ctx.fillStyle = rgba('#ffffff', clamp(run.flash, 0, 1) * 0.35);
      ctx.fillRect(0, 0, w, h);
    }

    // Muzzle/ambient scanline texture for a subtle CRT-industrial feel.
    if (this.enableBloom) {
      ctx.save();
      ctx.globalAlpha = 0.035;
      ctx.fillStyle = '#8fd6ff';
      for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
      ctx.restore();
    }

    // Boss health banner.
    const boss = run.spawner.boss;
    if (boss && boss.alive && boss.alerted) {
      const width = Math.min(680, w * 0.6);
      const x = (w - width) / 2;
      const y = 18;
      ctx.fillStyle = 'rgba(5,8,13,0.82)';
      ctx.fillRect(x - 6, y - 6, width + 12, 40);
      ctx.strokeStyle = rgba('#ff5c33', 0.55);
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 6, y - 6, width + 12, 40);
      ctx.fillStyle = '#0b1119';
      ctx.fillRect(x, y + 14, width, 10);
      ctx.fillStyle = PALETTE.boss;
      ctx.fillRect(x, y + 14, width * boss.healthRatio, 10);
      ctx.fillStyle = '#ffb03a';
      ctx.font = `700 13px ${FONTS.display}`;
      ctx.textAlign = 'left';
      ctx.fillText(`${boss.displayName}`, x, y + 8);
      ctx.textAlign = 'right';
      ctx.fillStyle = PALETTE.uiWarn;
      ctx.fillText(`PHASE ${boss.phaseName}`, x + width, y + 8);
    }
    void scene;
  }
}

function pulseGlow(time, speed) {
  return (Math.sin(time * speed) + 1) / 2;
}

export { PALETTE, rgba, FONTS, lerp, damp, dist2, TILE };
