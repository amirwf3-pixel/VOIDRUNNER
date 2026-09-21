/**
 * Particle + effect layer. One pooled array, one update, one draw.
 *
 * Emitters are data-driven so gameplay code only calls `spawnBurst(kind, ...)`
 * and never allocates. Particles are naturally degraded by the `density`
 * setting rather than branching at each call site.
 */

import { TAU, clamp, damp, lerp } from '../core/math.js';

const MAX_PARTICLES = 1400;

export const PARTICLE_KINDS = {
  spark: { drag: 2.6, gravity: 0, fade: 1.5, additive: true, size: 2.1, glow: 1 },
  blood: { drag: 3.4, gravity: 90, fade: 1.3, additive: false, size: 2.6, glow: 0 },
  smoke: { drag: 1.1, gravity: -12, fade: 0.9, additive: false, size: 7, glow: 0 },
  debris: { drag: 4.2, gravity: 260, fade: 1.7, additive: false, size: 2.4, glow: 0 },
  ember: { drag: 1.6, gravity: -30, fade: 1.1, additive: true, size: 1.8, glow: 1 },
  ring: { drag: 0, gravity: 0, fade: 3.2, additive: true, size: 4, glow: 1 },
  muzzle: { drag: 8, gravity: 0, fade: 0.28, additive: true, size: 3.2, glow: 1 },
};

export class Particle {
  constructor() {
    this.active = false;
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.life = 0;
    this.maxLife = 1;
    this.size = 2;
    this.color = '#fff';
    this.kind = 'spark';
    this.rotation = 0;
    this.spin = 0;
    this.alpha = 1;
    this.additive = true;
    this.glow = 0;
    this.shape = 'circle';
  }
}

export class ParticleSystem {
  constructor() {
    this.pool = [];
    for (let i = 0; i < MAX_PARTICLES; i += 1) this.pool.push(new Particle());
    this.cursor = 0;
    this.activeCount = 0;
    this.density = 1;
    this.softBudget = MAX_PARTICLES;
  }

  reset() {
    for (const p of this.pool) p.active = false;
    this.activeCount = 0;
  }

  _acquire() {
    for (let i = 0; i < MAX_PARTICLES; i += 1) {
      const idx = (this.cursor + i) % MAX_PARTICLES;
      if (!this.pool[idx].active) {
        this.cursor = (idx + 1) % MAX_PARTICLES;
        const p = this.pool[idx];
        p.active = true;
        return p;
      }
    }
    // Pool exhausted: steal the oldest slot rather than dropping the effect.
    const p = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    return p;
  }

  spawn(kind, x, y, options = {}) {
    if (this.activeCount > this.softBudget * this.density) return null;
    const preset = PARTICLE_KINDS[kind] ?? PARTICLE_KINDS.spark;
    const p = this._acquire();
    p.x = x;
    p.y = y;
    p.vx = options.vx ?? 0;
    p.vy = options.vy ?? 0;
    p.maxLife = options.life ?? 0.5;
    p.life = p.maxLife;
    p.size = options.size ?? preset.size;
    p.color = options.color ?? '#ffffff';
    p.kind = kind;
    p.additive = options.additive ?? preset.additive;
    p.glow = options.glow ?? preset.glow;
    p.rotation = options.rotation ?? 0;
    p.spin = options.spin ?? 0;
    p.shape = options.shape ?? 'circle';
    p.alpha = options.alpha ?? 1;
    p.drag = options.drag ?? preset.drag;
    p.gravity = options.gravity ?? preset.gravity;
    p.fade = options.fade ?? preset.fade;
    p.stretch = options.stretch ?? 1;
    return p;
  }

  spawnBurst(kind, x, y, count, options = {}) {
    const rngLike = options.rng ?? Math.random;
    const scaled = Math.max(1, Math.round(count * clamp(this.density, 0.1, 2)));
    for (let i = 0; i < scaled; i += 1) {
      const angle = options.angle !== undefined
        ? options.angle + (rngLike() - 0.5) * (options.spread ?? TAU)
        : rngLike() * TAU;
      const baseSpeed = options.speed ?? 120;
      const speed = baseSpeed * (0.5 + rngLike() * 1.1);
      this.spawn(kind, x, y, {
        ...options,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: (options.life ?? 0.5) * (0.65 + rngLike() * 0.7),
        size: (options.size ?? PARTICLE_KINDS[kind]?.size ?? 2) * (0.7 + rngLike() * 0.7),
        spin: (rngLike() - 0.5) * 12,
      });
    }
  }

  /** Expanding ring used for explosions, slams and extraction pulses. */
  spawnRing(x, y, radius, color, options = {}) {
    this.spawn('ring', x, y, {
      life: options.life ?? 0.42,
      size: radius,
      color,
      additive: true,
      alpha: options.alpha ?? 0.85,
      fade: options.fade ?? 3.2,
      stretch: options.stretch ?? 1,
    });
  }

  update(dt) {
    let active = 0;
    for (const p of this.pool) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      const dragFactor = Math.exp(-p.drag * dt);
      p.vx *= dragFactor;
      p.vy *= dragFactor;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.spin * dt;
      active += 1;
    }
    this.activeCount = active;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {{x:number,y:number,w:number,h:number}} view cull rect in world space
   */
  draw(ctx, view) {
    // Pass 1: additive (glow) particles.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.pool) {
      if (!p.active || !p.additive) continue;
      if (p.x < view.x || p.x > view.x + view.w || p.y < view.y || p.y > view.y + view.h) continue;
      const t = clamp(p.life / p.maxLife, 0, 1);
      const alpha = p.alpha * Math.pow(t, p.fade / 2);
      if (p.shape === 'ring') {
        const progress = 1 - t;
        const radius = p.size * (0.35 + progress * 1.05);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(0.6, 3.2 * t);
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, TAU);
        ctx.stroke();
        continue;
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      const size = p.size * (0.4 + t * 0.6);
      if (p.glow > 0) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, size * 2.1, 0, TAU);
        ctx.globalAlpha = alpha * 0.22;
        ctx.fill();
        ctx.globalAlpha = alpha;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // Pass 2: normal blending particles.
    ctx.save();
    for (const p of this.pool) {
      if (!p.active || p.additive) continue;
      if (p.x < view.x || p.x > view.x + view.w || p.y < view.y || p.y > view.y + view.h) continue;
      const t = clamp(p.life / p.maxLife, 0, 1);
      const alpha = p.alpha * Math.pow(t, p.fade / 2);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      const size = p.size * (0.45 + t * 0.55);
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

/** Floating damage / status numbers. Pooled, camera aware, world anchored. */
export class FloatingText {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.life = 0;
    this.maxLife = 0.85;
    this.text = '';
    this.color = '#fff';
    this.size = 14;
    this.critical = false;
    this.active = false;
    this.drift = 0;
  }
}

export class FloatingTextSystem {
  constructor(capacity = 120) {
    this.pool = [];
    for (let i = 0; i < capacity; i += 1) this.pool.push(new FloatingText());
    this.cursor = 0;
    this.enabled = true;
  }

  reset() {
    for (const t of this.pool) t.active = false;
    this.cursor = 0;
  }

  push(x, y, text, { color = '#fff', size = 14, critical = false, life = 0.85, vx = 0, vy = -46 } = {}) {
    if (!this.enabled) return;
    let slot = null;
    for (let i = 0; i < this.pool.length; i += 1) {
      const idx = (this.cursor + i) % this.pool.length;
      if (!this.pool[idx].active) {
        slot = this.pool[idx];
        this.cursor = (idx + 1) % this.pool.length;
        break;
      }
    }
    if (!slot) {
      slot = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % this.pool.length;
    }
    slot.active = true;
    slot.x = x + (Math.random() - 0.5) * 12;
    slot.y = y;
    slot.vx = vx;
    slot.vy = vy;
    slot.text = text;
    slot.color = color;
    slot.size = critical ? size * 1.35 : size;
    slot.critical = critical;
    slot.maxLife = life;
    slot.life = life;
    slot.drift = (Math.random() - 0.5) * 0.6;
  }

  update(dt) {
    for (const t of this.pool) {
      if (!t.active) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.active = false;
        continue;
      }
      t.x += t.vx * dt;
      t.y += t.vy * dt;
      t.vy = damp(t.vy, -8, 0.0015, dt);
      t.vx = damp(t.vx, t.drift * 20, 0.02, dt);
    }
  }

  draw(ctx, camera, view) {
    if (!this.enabled) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of this.pool) {
      if (!t.active) continue;
      if (t.x < view.x - 40 || t.x > view.x + view.w + 40) continue;
      if (t.y < view.y - 40 || t.y > view.y + view.h + 40) continue;
      const p = clamp(t.life / t.maxLife, 0, 1);
      const alpha = p > 0.7 ? (1 - p) / 0.3 : p / 0.7;
      const scale = t.critical ? lerp(1.35, 1, 1 - p) : lerp(1.1, 0.9, 1 - p);
      ctx.globalAlpha = clamp(alpha, 0, 1);
      ctx.font = `${t.critical ? 800 : 700} ${Math.round(t.size * scale)}px "Rajdhani", "Bahnschrift", system-ui, sans-serif`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    void camera;
  }
}

/**
 * Short hit-stop used on impactful hits. Keeps the sim honest by scaling `dt`
 * rather than skipping updates.
 */
export class HitStop {
  constructor() {
    this.remaining = 0;
  }

  trigger(seconds) {
    this.remaining = Math.max(this.remaining, seconds);
  }

  /** Returns the effective dt for this frame and consumes the timer. */
  consume(dt) {
    if (this.remaining <= 0) return dt;
    this.remaining = Math.max(0, this.remaining - dt);
    return dt * 0.18;
  }

  get active() {
    return this.remaining > 0;
  }

  reset() {
    this.remaining = 0;
  }
}
