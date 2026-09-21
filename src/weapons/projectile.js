/**
 * Projectile simulation. Single pooled array, fixed-order updates, explicit
 * team handling. All hit resolution is funnelled through callbacks so combat
 * rules live in one place (`src/game/combat.js`) instead of inside the bullets.
 */

import { TAU, clamp, dist2 } from '../core/math.js';

export const TEAM = {
  PLAYER: 'player',
  HOSTILE: 'hostile',
};

const MAX_PROJECTILES = 900;

class Projectile {
  constructor() {
    this.active = false;
    this.x = 0;
    this.y = 0;
    this.px = 0;
    this.py = 0;
    this.vx = 0;
    this.vy = 0;
    this.radius = 3;
    this.damage = 0;
    this.life = 0;
    this.maxLife = 1;
    this.team = TEAM.PLAYER;
    this.weaponId = null;
    this.color = '#fff';
    this.pierce = 0;
    this.hitIds = new Set();
    this.critical = false;
    this.trailLength = 0;
    this.width = 1.5;
    this.areaRadius = 0;
    this.areaDamage = 0;
    this.areaColor = '#ffb03a';
    this.knockback = 0;
    this.chain = 0;
    this.chainRange = 0;
    this.chainDamageMul = 0.6;
    this.isMelee = false;
    this.sourceTag = null;
    this.glow = 0;
  }
}

export class ProjectileSystem {
  constructor({ onError = null } = {}) {
    this.pool = [];
    for (let i = 0; i < MAX_PROJECTILES; i += 1) this.pool.push(new Projectile());
    this.cursor = 0;
    this.activeCount = 0;
    this.onError = onError;
    /** Visual-only tracer sparks emitted on wall hits, consumed by the renderer. */
    this.tracers = [];
  }

  reset() {
    for (const p of this.pool) {
      p.active = false;
      p.hitIds.clear();
    }
    this.activeCount = 0;
    this.tracers.length = 0;
  }

  _acquire() {
    for (let i = 0; i < MAX_PROJECTILES; i += 1) {
      const idx = (this.cursor + i) % MAX_PROJECTILES;
      if (!this.pool[idx].active) {
        this.cursor = (idx + 1) % MAX_PROJECTILES;
        const p = this.pool[idx];
        p.active = true;
        p.hitIds.clear();
        return p;
      }
    }
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % MAX_PROJECTILES;
    p.hitIds.clear();
    return p;
  }

  spawn(spec) {
    if (!Number.isFinite(spec.x) || !Number.isFinite(spec.y)) {
      throw new TypeError('Projectile spawn requires finite coordinates');
    }
    const p = this._acquire();
    p.x = spec.x;
    p.y = spec.y;
    p.px = spec.x;
    p.py = spec.y;
    p.vx = spec.vx ?? 0;
    p.vy = spec.vy ?? 0;
    p.radius = spec.radius ?? 3;
    p.damage = spec.damage ?? 0;
    p.maxLife = spec.life ?? 1;
    p.life = p.maxLife;
    p.team = spec.team ?? TEAM.PLAYER;
    p.weaponId = spec.weaponId ?? null;
    p.color = spec.color ?? '#ffffff';
    p.pierce = spec.pierce ?? 0;
    p.critical = Boolean(spec.critical);
    p.width = spec.width ?? 1.5;
    p.areaRadius = spec.areaRadius ?? 0;
    p.areaDamage = spec.areaDamage ?? 0;
    p.areaColor = spec.areaColor ?? '#ffb03a';
    p.knockback = spec.knockback ?? 0;
    p.chain = spec.chain ?? 0;
    p.chainRange = spec.chainRange ?? 0;
    p.chainDamageMul = spec.chainDamageMul ?? 0.6;
    p.glow = spec.glow ?? 1;
    p.sourceTag = spec.sourceTag ?? null;
    p.trailLength = clamp(p.maxLife, 0.05, 0.5);
    return p;
  }

  /**
   * @param {number} dt
   * @param {Object} ctx
   * @param {import('../world/tilemap.js').TileMap} ctx.map
   * @param {Array} ctx.enemies
   * @param {{x:number,y:number,radius:number,alive:boolean}} ctx.player
   * @param {import('../world/world.js').WorldRuntime} ctx.world
   * @param {(hit:Object)=>void} ctx.onHit
   * @param {(wall:Object)=>void} [ctx.onWall]
   * @param {(proj:Projectile)=>void} [ctx.onExpire]
   */
  update(dt, ctx) {
    const { map, enemies, player, world } = ctx;
    let active = 0;
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        if (ctx.onExpire) ctx.onExpire(p);
        continue;
      }
      p.px = p.x;
      p.py = p.y;
      const dx = p.vx * dt;
      const dy = p.vy * dt;
      const distance = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(distance / Math.max(6, p.radius)));
      let consumed = false;
      for (let step = 0; step < steps && !consumed; step += 1) {
        p.x += dx / steps;
        p.y += dy / steps;

        // 1. World geometry.
        if (map.isSolidAtWorld(p.x, p.y)) {
          this._resolveWallHit(p, ctx, map);
          consumed = true;
          break;
        }

        // 2. Destructible props.
        const props = world.queryProps(p.x, p.y, p.radius);
        if (props.length > 0) {
          const prop = props[0];
          if (ctx.onPropHit) ctx.onPropHit(p, prop);
          if (p.areaRadius > 0) {
            this._explode(p, ctx);
          }
          consumed = true;
          break;
        }

        // 3. Entities.
        if (p.team === TEAM.PLAYER) {
          for (const enemy of enemies) {
            if (!enemy.alive || p.hitIds.has(enemy.id)) continue;
            const rr = enemy.radius + p.radius;
            if (dist2(p.x, p.y, enemy.x, enemy.y) > rr * rr) continue;
            p.hitIds.add(enemy.id);
            if (ctx.onHit) ctx.onHit({ projectile: p, enemy, x: p.x, y: p.y });
            if (p.chain > 0) this._resolveChain(p, ctx, enemy);
            if (p.areaRadius > 0) this._explode(p, ctx);
            if (p.pierce > 0) {
              p.pierce -= 1;
              p.damage *= 0.86;
            } else {
              consumed = true;
            }
            break;
          }
        } else if (player && player.alive) {
          const rr = player.radius + p.radius;
          if (dist2(p.x, p.y, player.x, player.y) <= rr * rr) {
            if (ctx.onHit) ctx.onHit({ projectile: p, player, x: p.x, y: p.y });
            if (p.areaRadius > 0) this._explode(p, ctx);
            consumed = true;
          }
        }
      }
      if (consumed) {
        p.active = false;
        continue;
      }
      active += 1;
    }
    this.activeCount = active;

    // Decay tracer visuals.
    for (let i = this.tracers.length - 1; i >= 0; i -= 1) {
      const t = this.tracers[i];
      t.life -= dt;
      if (t.life <= 0) this.tracers.splice(i, 1);
    }
  }

  _resolveWallHit(p, ctx, map) {
    // Back the projectile out of the wall so impact sparks sit on the surface.
    const dirX = p.x - p.px;
    const dirY = p.y - p.py;
    const len = Math.hypot(dirX, dirY) || 1;
    const nx = dirX / len;
    const ny = dirY / len;
    const hit = map.raycast(p.px, p.py, nx, ny, map.tileSize * 2);
    if (ctx.onWall) ctx.onWall({ projectile: p, x: hit.x, y: hit.y, nx: -nx, ny: -ny });
    if (p.areaRadius > 0) this._explode(p, { ...ctx, x: hit.x, y: hit.y });
    this.tracers.push({ x1: p.px, y1: p.py, x2: hit.x, y2: hit.y, life: 0.06, maxLife: 0.06, color: p.color });
  }

  _explode(p, ctx) {
    if (p.areaRadius <= 0) return;
    if (ctx.onExplosion) {
      ctx.onExplosion({
        x: p.x,
        y: p.y,
        radius: p.areaRadius,
        damage: p.areaDamage || p.damage,
        color: p.areaColor,
        team: p.team,
        weaponId: p.weaponId,
      });
    }
  }

  _resolveChain(p, ctx, firstTarget) {
    if (!ctx.onChain) return;
    const already = new Set([firstTarget.id]);
    const links = [{ from: { x: firstTarget.x, y: firstTarget.y }, to: null }];
    let current = firstTarget;
    let damage = p.damage * p.chainDamageMul;
    for (let i = 0; i < p.chain; i += 1) {
      let best = null;
      let bestD = p.chainRange * p.chainRange;
      for (const enemy of ctx.enemies) {
        if (!enemy.alive || already.has(enemy.id)) continue;
        const d = dist2(current.x, current.y, enemy.x, enemy.y);
        if (d < bestD) {
          bestD = d;
          best = enemy;
        }
      }
      if (!best) break;
      already.add(best.id);
      links.push({ from: { x: current.x, y: current.y }, to: { x: best.x, y: best.y } });
      ctx.onChain({ enemy: best, damage, color: p.color, weaponId: p.weaponId });
      current = best;
      damage *= p.chainDamageMul;
    }
    p.chainLinks = links;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {{x:number,y:number,w:number,h:number}} view
   */
  draw(ctx, view) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const p of this.pool) {
      if (!p.active) continue;
      if (p.x < view.x || p.x > view.x + view.w || p.y < view.y || p.y > view.y + view.h) continue;
      const tailX = p.x - p.vx * 0.016;
      const tailY = p.y - p.vy * 0.016;
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.width * 2.6;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = p.width;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius * 0.9, 0, TAU);
      ctx.fill();
      if (p.chainLinks) {
        ctx.lineWidth = p.width * 1.4;
        ctx.globalAlpha = 0.8;
        for (const link of p.chainLinks) {
          if (!link.to) continue;
          ctx.beginPath();
          ctx.moveTo(link.from.x, link.from.y);
          const midX = (link.from.x + link.to.x) / 2 + ((link.from.y - link.to.y) / 22);
          const midY = (link.from.y + link.to.y) / 2 + ((link.to.x - link.from.x) / 22);
          ctx.quadraticCurveTo(midX, midY, link.to.x, link.to.y);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
    }
    ctx.globalAlpha = 1;
    for (const t of this.tracers) {
      const alpha = clamp(t.life / t.maxLife, 0, 1);
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(t.x1, t.y1);
      ctx.lineTo(t.x2, t.y2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

/** Area-of-effect query used by explosions, boss slams and barrel chain reactions. */
export function queryRadius(entities, x, y, radius, filter = null) {
  const out = [];
  const r2 = radius * radius;
  for (const e of entities) {
    if (filter && !filter(e)) continue;
    if (dist2(x, y, e.x, e.y) <= r2) out.push(e);
  }
  return out;
}
