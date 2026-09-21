/**
 * Small, dependency free math helpers shared by every system.
 * Everything here must be pure so that it is trivially testable.
 */

export const TAU = Math.PI * 2;

export function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value) {
  return clamp(value, 0, 1);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function invLerp(a, b, value) {
  if (b === a) return 0;
  return (value - a) / (b - a);
}

export function smoothstep(t) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/** Frame-rate independent exponential smoothing. */
export function damp(current, target, smoothing, dt) {
  const t = 1 - Math.pow(smoothing, dt);
  return current + (target - current) * t;
}

export function approach(current, target, delta) {
  if (current < target) return Math.min(current + delta, target);
  return Math.max(current - delta, target);
}

export function dist2(ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

export function dist(ax, ay, bx, by) {
  return Math.sqrt(dist2(ax, ay, bx, by));
}

export function angleTo(ax, ay, bx, by) {
  return Math.atan2(by - ay, bx - ax);
}

/** Shortest signed angular delta from a to b, in radians. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function rotateToward(current, target, maxStep) {
  const d = angleDelta(current, target);
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}

export function normalizeAngle(a) {
  let x = a % TAU;
  if (x < 0) x += TAU;
  return x;
}

/** Normal-distributed sample using Box-Muller, driven by a random function. */
export function gaussian(random) {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

export function aabbOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function pointInRect(px, py, r) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

export function rectCenter(r) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function rectContainsRect(outer, inner) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/** Returns true when a rotated rect centred in `r` can circle sample points. */
export function circleRectOverlap(cx, cy, radius, r) {
  const nx = clamp(cx, r.x, r.x + r.w);
  const ny = clamp(cy, r.y, r.y + r.h);
  return dist2(cx, cy, nx, ny) <= radius * radius;
}

export function formatNumber(value, digits = 0) {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(digits);
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export function formatPercent01(value) {
  return `${Math.round(clamp01(value) * 100)}%`;
}

export function pick(array, random) {
  if (!array.length) return undefined;
  return array[Math.floor(clamp(random(), 0, 0.999999) * array.length)];
}

export function weightedPick(entries, random) {
  let total = 0;
  for (const entry of entries) total += Math.max(0, entry.weight ?? 1);
  if (total <= 0) return undefined;
  let roll = random() * total;
  for (const entry of entries) {
    roll -= Math.max(0, entry.weight ?? 1);
    if (roll <= 0) return entry;
  }
  return entries[entries.length - 1];
}

export function shuffle(array, random) {
  const out = array.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(clamp(random(), 0, 0.999999) * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

export function sum(array) {
  let total = 0;
  for (const v of array) total += v;
  return total;
}

export function uniqueBy(array, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of array) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
