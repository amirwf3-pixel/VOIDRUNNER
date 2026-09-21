/**
 * World runtime: destructible props, loot containers, hazard volumes and the
 * spatial query helpers the rest of the game uses for targeting.
 *
 * Everything is a plain object with an explicit `type`; there is no inheritance
 * chain to reason about and no hidden update ordering.
 */

import { clamp, dist2, TAU } from '../core/math.js';

export const PROP_KINDS = {
  CRATE: 'crate',
  BARREL: 'barrel',
  PIPE: 'pipe',
  CONSOLE: 'console',
  GIRDER: 'girder',
  VENT: 'vent',
  REACTOR: 'reactor',
};

const PROP_STATS = {
  crate: { size: 26, destructible: true, health: 24, solid: true, explosive: false },
  barrel: { size: 20, destructible: true, health: 18, solid: true, explosive: true, blastRadius: 96, blastDamage: 42 },
  pipe: { size: 34, destructible: false, solid: false, decorative: true },
  console: { size: 28, destructible: false, solid: true, interactive: true },
  girder: { size: 30, destructible: false, solid: true },
  vent: { size: 24, destructible: false, solid: false, decorative: true, hazard: 'steam' },
  reactor: { size: 44, destructible: true, health: 120, solid: true, objective: true },
};

export class Prop {
  constructor(spec) {
    const stats = PROP_STATS[spec.kind] ?? PROP_STATS.crate;
    this.id = spec.id ?? 0;
    this.x = spec.x;
    this.y = spec.y;
    this.kind = spec.kind;
    this.angle = spec.angle ?? 0;
    this.roomId = spec.roomId ?? -1;
    this.size = stats.size;
    this.solid = stats.solid;
    this.destructible = Boolean(spec.destructible ?? stats.destructible);
    this.maxHealth = spec.health ?? stats.health ?? 0;
    this.health = this.maxHealth;
    this.explosive = stats.explosive ?? false;
    this.blastRadius = stats.blastRadius ?? 0;
    this.blastDamage = stats.blastDamage ?? 0;
    this.objectiveId = spec.objectiveId ?? null;
    this.hazard = stats.hazard ?? null;
    this.alive = true;
    this.hitFlash = 0;
    this.hazardTick = 0;
  }

  get radius() {
    return this.size / 2;
  }

  damage(amount) {
    if (!this.destructible || !this.alive) return { destroyed: false, applied: 0 };
    const applied = Math.max(0, amount);
    this.health -= applied;
    this.hitFlash = 0.12;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      return { destroyed: true, applied };
    }
    return { destroyed: false, applied };
  }
}

export class WorldRuntime {
  /**
   * @param {ReturnType<import('../generation/zone.js').generateZone>} zone
   */
  constructor(zone) {
    this.zone = zone;
    this.props = zone.props.map((spec, index) => new Prop({ ...spec, id: index }));
    this.solidProps = this.props.filter((p) => p.solid);
    this.containers = this.props.filter((p) => p.kind === 'crate' || p.kind === 'console' || p.kind === 'reactor');
    this.hazards = this.props.filter((p) => p.hazard);
    this.time = 0;
    /** Broadphase grid for props/containers. Cell size in world units. */
    this.cellSize = 160;
    this.grid = new Map();
    this._rebuildGrid();
  }

  _rebuildGrid() {
    this.grid.clear();
    for (const prop of this.solidProps) {
      const key = this._cellKey(prop.x, prop.y);
      let bucket = this.grid.get(key);
      if (!bucket) {
        bucket = [];
        this.grid.set(key, bucket);
      }
      bucket.push(prop);
    }
  }

  _cellKey(x, y) {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }

  /**
   * Returns solid props overlapping a circle. Uses the grid, falling back to a
   * brute force scan only if the grid was invalidated.
   */
  queryProps(x, y, radius) {
    const results = [];
    const minCx = Math.floor((x - radius) / this.cellSize);
    const maxCx = Math.floor((x + radius) / this.cellSize);
    const minCy = Math.floor((y - radius) / this.cellSize);
    const maxCy = Math.floor((y + radius) / this.cellSize);
    for (let cy = minCy; cy <= maxCy; cy += 1) {
      for (let cx = minCx; cx <= maxCx; cx += 1) {
        const bucket = this.grid.get(`${cx},${cy}`);
        if (!bucket) continue;
        for (const prop of bucket) {
          if (!prop.alive) continue;
          const r = prop.radius + radius;
          if (dist2(x, y, prop.x, prop.y) <= r * r) results.push(prop);
        }
      }
    }
    return results;
  }

  /** Push a circle out of solid props, mutating `entity`. */
  resolveProps(entity) {
    const radius = entity.radius ?? 12;
    for (let pass = 0; pass < 2; pass += 1) {
      const overlapping = this.queryProps(entity.x, entity.y, radius);
      if (overlapping.length === 0) break;
      for (const prop of overlapping) {
        const dx = entity.x - prop.x;
        const dy = entity.y - prop.y;
        const minDist = prop.radius + radius;
        const d = Math.hypot(dx, dy);
        if (d >= minDist) continue;
        if (d < 1e-5) {
          entity.x += minDist;
          continue;
        }
        const push = (minDist - d) / d;
        entity.x += dx * push;
        entity.y += dy * push;
      }
    }
    return entity;
  }

  /** Damage a prop; returns the resulting event payload for the caller. */
  damageProp(prop, amount) {
    if (!prop || !prop.alive) return null;
    const result = prop.damage(amount);
    if (!result.destroyed) return { prop, destroyed: false, explosive: false };
    // Removing a solid prop must invalidate the broadphase bucket it lived in.
    this._rebuildGrid();
    return { prop, destroyed: true, explosive: prop.explosive };
  }

  update(dt, context) {
    this.time += dt;
    let gridDirty = false;
    for (const prop of this.props) {
      if (prop.hitFlash > 0) prop.hitFlash = Math.max(0, prop.hitFlash - dt);
      if (!prop.alive) continue;
      if (prop.hazard === 'steam') {
        prop.hazardTick -= dt;
        if (prop.hazardTick <= 0) {
          prop.hazardTick = 0.35;
          const radius = prop.radius + 10;
          if (context && context.onHazard) context.onHazard(prop, radius);
        }
      }
    }
    if (gridDirty) this._rebuildGrid();
  }

  /** Removes destroyed props from the broadphase once per frame. */
  postUpdate() {
    if (this.solidProps.some((p) => !p.alive)) {
      this.solidProps = this.solidProps.filter((p) => p.alive);
      this._rebuildGrid();
    }
  }

  getStats() {
    return {
      total: this.props.length,
      alive: this.props.filter((p) => p.alive).length,
      destroyable: this.props.filter((p) => p.destructible).length,
    };
  }
}

/**
 * Extraction / descent zone runtime. Channels when the player is inside and
 * confirms the channel while they stay; interrupts on exit or damage.
 */
export class ChannelZone {
  /**
   * @param {{x:number,y:number,radius:number,channelTime:number}} spec
   * @param {'extract'|'descend'} kind
   */
  constructor(spec, kind) {
    this.x = spec.x;
    this.y = spec.y;
    this.radius = spec.radius;
    this.channelTime = spec.channelTime;
    this.kind = kind;
    this.progress = 0;
    this.active = false;
    this.completed = false;
    this.pulse = 0;
    this.blockedReason = null;
  }

  contains(x, y) {
    return dist2(x, y, this.x, this.y) <= this.radius * this.radius;
  }

  isNear(x, y, pad = 0) {
    const r = this.radius + pad;
    return dist2(x, y, this.x, this.y) <= r * r;
  }

  /** @returns {{state:'idle'|'channelling'|'complete'|'blocked', progress:number, reason:string|null}} */
  update(dt, player, canUse) {
    this.pulse += dt;
    if (this.completed) return { state: 'complete', progress: 1, reason: null };
    const inside = this.contains(player.x, player.y);
    if (canUse !== true) {
      this.blockedReason = typeof canUse === 'string' ? canUse : 'LOCKED';
      this.active = false;
      this.progress = Math.max(0, this.progress - dt * 1.6);
      return { state: 'blocked', progress: this.progress / this.channelTime, reason: this.blockedReason };
    }
    if (!inside) {
      this.active = false;
      this.progress = Math.max(0, this.progress - dt * 1.6);
      return { state: 'idle', progress: this.progress / this.channelTime, reason: null };
    }
    if (!this.active) {
      this.active = true;
      this.progress = 0;
      this.blockedReason = null;
      return { state: 'channelling', progress: 0, reason: null, started: true };
    }
    this.progress += dt;
    if (this.progress >= this.channelTime) {
      this.progress = this.channelTime;
      this.completed = true;
      this.active = false;
      return { state: 'complete', progress: 1, reason: null };
    }
    return { state: 'channelling', progress: this.progress / this.channelTime, reason: null };
  }

  /** Damage interrupts the channel: the run keeps its loot but the timer resets. */
  interrupt() {
    if (this.completed) return false;
    const wasActive = this.active;
    this.active = false;
    this.progress = Math.max(0, this.progress - 0.6);
    return wasActive;
  }

  reset() {
    this.progress = 0;
    this.active = false;
    this.completed = false;
  }

  draw(ctx) {
    const t = this.pulse;
    const color = this.kind === 'extract' ? '#6fe3c4' : '#c084fc';
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, TAU);
    ctx.fill();

    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, TAU);
    ctx.stroke();

    // Rotating bracket marks so the zone reads as machinery, not a decal.
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 3;
    for (let i = 0; i < 4; i += 1) {
      const angle = t * 0.6 + (i / 4) * TAU;
      const inner = this.radius - 12;
      const outer = this.radius + 6;
      ctx.beginPath();
      ctx.moveTo(this.x + Math.cos(angle) * inner, this.y + Math.sin(angle) * inner);
      ctx.lineTo(this.x + Math.cos(angle) * outer, this.y + Math.sin(angle) * outer);
      ctx.stroke();
    }

    if (this.progress > 0) {
      const ratio = clamp(this.progress / this.channelTime, 0, 1);
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius + 14, -Math.PI / 2, -Math.PI / 2 + TAU * ratio);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}
