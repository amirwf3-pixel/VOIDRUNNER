/**
 * Tile map: storage, collision queries, raycasting, flood fill and A* pathing.
 *
 * Representation is deliberately simple: `tiles[i] === 1` means walkable floor,
 * everything else is solid rock. Walls are *derived* at render time by looking
 * for solid tiles adjacent to floor, which removes an entire class of
 * wall/floor bookkeeping bugs and keeps the collision test to one lookup.
 */

import { clamp } from '../core/math.js';

export const TILE = 32;
export const SOLID = 0;
export const FLOOR = 1;

export class TileMap {
  constructor(width, height, tileSize = TILE) {
    if (width <= 0 || height <= 0) throw new RangeError('TileMap requires positive dimensions');
    this.width = width;
    this.height = height;
    this.tileSize = tileSize;
    this.tiles = new Uint8Array(width * height);
    /** Cached walkable count, useful for validation assertions. */
    this.floorCount = 0;
  }

  static fromArray(rows, tileSize = TILE) {
    if (!Array.isArray(rows) || rows.length === 0) throw new TypeError('rows must be a non-empty array');
    const h = rows.length;
    const w = rows[0].length;
    const map = new TileMap(w, h, tileSize);
    for (let y = 0; y < h; y += 1) {
      const row = rows[y];
      if (row.length !== w) throw new Error(`Row ${y} has length ${row.length}, expected ${w}`);
      for (let x = 0; x < w; x += 1) {
        map.set(x, y, row[x] ? FLOOR : SOLID);
      }
    }
    map.recount();
    return map;
  }

  get worldWidth() {
    return this.width * this.tileSize;
  }

  get worldHeight() {
    return this.height * this.tileSize;
  }

  index(tx, ty) {
    return ty * this.width + tx;
  }

  inBounds(tx, ty) {
    return tx >= 0 && ty >= 0 && tx < this.width && ty < this.height;
  }

  get(tx, ty) {
    if (!this.inBounds(tx, ty)) return SOLID;
    return this.tiles[ty * this.width + tx];
  }

  set(tx, ty, value) {
    if (!this.inBounds(tx, ty)) return;
    const idx = ty * this.width + tx;
    const prev = this.tiles[idx];
    if (prev === value) return;
    this.tiles[idx] = value;
    if (value === FLOOR) this.floorCount += 1;
    else if (prev === FLOOR) this.floorCount -= 1;
  }

  recount() {
    let count = 0;
    for (let i = 0; i < this.tiles.length; i += 1) if (this.tiles[i] === FLOOR) count += 1;
    this.floorCount = count;
    return count;
  }

  isSolid(tx, ty) {
    return this.get(tx, ty) === SOLID;
  }

  isFloor(tx, ty) {
    return this.get(tx, ty) === FLOOR;
  }

  /** True when the tile is floor and all 8 neighbours are in bounds. */
  isInteriorFloor(tx, ty) {
    if (!this.isFloor(tx, ty)) return false;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!this.inBounds(tx + dx, ty + dy)) return false;
      }
    }
    return true;
  }

  worldToTile(x, y) {
    return { tx: Math.floor(x / this.tileSize), ty: Math.floor(y / this.tileSize) };
  }

  tileToWorld(tx, ty) {
    return { x: tx * this.tileSize + this.tileSize / 2, y: ty * this.tileSize + this.tileSize / 2 };
  }

  isSolidAtWorld(x, y) {
    return this.isSolid(Math.floor(x / this.tileSize), Math.floor(y / this.tileSize));
  }

  /** Raymarch in tile space. Returns distance to the first solid tile, or `maxDist`. */
  raycast(x, y, dx, dy, maxDist) {
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return { hit: false, distance: 0, x, y };
    const nx = dx / len;
    const ny = dy / len;
    const step = this.tileSize * 0.5;
    let travelled = 0;
    while (travelled < maxDist) {
      travelled += step;
      const px = x + nx * travelled;
      const py = y + ny * travelled;
      if (this.isSolidAtWorld(px, py)) {
        return { hit: true, distance: Math.min(travelled, maxDist), x: px, y: py };
      }
    }
    return { hit: false, distance: maxDist, x: x + nx * maxDist, y: y + ny * maxDist };
  }

  /** Line of sight between two world points (excludes the endpoints' tiles). */
  hasLineOfSight(x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return true;
    const result = this.raycast(x0, y0, dx / len, dy / len, Math.max(0, len - this.tileSize * 0.6));
    return !result.hit;
  }

  /**
   * Resolve a circle against solid tiles. Mutates and returns `entity`
   * ({x, y, radius}). Uses up to 3 relaxation passes so corners behave.
   */
  resolveCircle(entity) {
    const r = entity.radius ?? 12;
    for (let pass = 0; pass < 3; pass += 1) {
      let moved = false;
      const minTx = Math.floor((entity.x - r) / this.tileSize);
      const maxTx = Math.floor((entity.x + r) / this.tileSize);
      const minTy = Math.floor((entity.y - r) / this.tileSize);
      const maxTy = Math.floor((entity.y + r) / this.tileSize);
      for (let ty = minTy; ty <= maxTy; ty += 1) {
        for (let tx = minTx; tx <= maxTx; tx += 1) {
          if (!this.inBounds(tx, ty)) {
            // Out-of-bounds is solid rock; push back toward the map.
            if (tx < 0) entity.x = r;
            if (ty < 0) entity.y = r;
            if (tx >= this.width) entity.x = this.worldWidth - r;
            if (ty >= this.height) entity.y = this.worldHeight - r;
            moved = true;
            continue;
          }
          if (!this.isSolid(tx, ty)) continue;
          const rx = tx * this.tileSize;
          const ry = ty * this.tileSize;
          const nx = clamp(entity.x, rx, rx + this.tileSize);
          const ny = clamp(entity.y, ry, ry + this.tileSize);
          let dx = entity.x - nx;
          let dy = entity.y - ny;
          let d2 = dx * dx + dy * dy;
          if (d2 >= r * r) continue;
          if (d2 < 1e-9) {
            // Centre is inside the tile: eject along the cheapest axis that
            // keeps the entity inside the map, preferring the map interior.
            const candidates = [
              { axis: 'x', value: rx - r, cost: Math.abs(entity.x - (rx - r)) },
              { axis: 'x', value: rx + this.tileSize + r, cost: Math.abs(entity.x - (rx + this.tileSize + r)) },
              { axis: 'y', value: ry - r, cost: Math.abs(entity.y - (ry - r)) },
              { axis: 'y', value: ry + this.tileSize + r, cost: Math.abs(entity.y - (ry + this.tileSize + r)) },
            ];
            const inBounds = candidates.filter((c) => {
              const px = c.axis === 'x' ? c.value : entity.x;
              const py = c.axis === 'y' ? c.value : entity.y;
              return px >= 0 && py >= 0 && px <= this.worldWidth && py <= this.worldHeight;
            });
            const pool = inBounds.length > 0 ? inBounds : candidates;
            let best = pool[0];
            for (const candidate of pool) {
              if (candidate.cost < best.cost) best = candidate;
            }
            if (best.axis === 'x') entity.x = best.value;
            else entity.y = best.value;
            moved = true;
            continue;
          }
          const d = Math.sqrt(d2);
          const push = r - d;
          entity.x += (dx / d) * push;
          entity.y += (dy / d) * push;
          moved = true;
        }
      }
      if (!moved) break;
    }
    return entity;
  }

  /** True when a circle at (x, y) with `radius` overlaps any solid tile. */
  circleCollides(x, y, radius) {
    const minTx = Math.floor((x - radius) / this.tileSize);
    const maxTx = Math.floor((x + radius) / this.tileSize);
    const minTy = Math.floor((y - radius) / this.tileSize);
    const maxTy = Math.floor((y + radius) / this.tileSize);
    for (let ty = minTy; ty <= maxTy; ty += 1) {
      for (let tx = minTx; tx <= maxTx; tx += 1) {
        if (!this.inBounds(tx, ty)) return true;
        if (!this.isSolid(tx, ty)) continue;
        const rx = tx * this.tileSize;
        const ry = ty * this.tileSize;
        const nx = clamp(x, rx, rx + this.tileSize);
        const ny = clamp(y, ry, ry + this.tileSize);
        const dx = x - nx;
        const dy = y - ny;
        if (dx * dx + dy * dy < radius * radius) return true;
      }
    }
    return false;
  }

  /**
   * Flood fill of walkable tiles from a world position.
   * @returns {{ tiles: Set<number>, count: number }} visited tile indices.
   */
  floodFillFromWorld(x, y, { diagonal = false } = {}) {
    const start = this.worldToTile(x, y);
    return this.floodFill(start.tx, start.ty, { diagonal });
  }

  floodFill(startTx, startTy, { diagonal = false } = {}) {
    const visited = new Set();
    if (!this.isFloor(startTx, startTy)) return { tiles: visited, count: 0 };
    const stack = [startTx, startTy];
    visited.add(this.index(startTx, startTy));
    const dirs = diagonal
      ? [
          [1, 0], [-1, 0], [0, 1], [0, -1],
          [1, 1], [1, -1], [-1, 1], [-1, -1],
        ]
      : [
          [1, 0], [-1, 0], [0, 1], [0, -1],
        ];
    while (stack.length > 0) {
      const ty = stack.pop();
      const tx = stack.pop();
      for (const [dx, dy] of dirs) {
        const nx = tx + dx;
        const ny = ty + dy;
        if (!this.inBounds(nx, ny)) continue;
        if (!this.isFloor(nx, ny)) continue;
        const idx = this.index(nx, ny);
        if (visited.has(idx)) continue;
        // Prevent diagonal corner cutting.
        if (dx !== 0 && dy !== 0) {
          if (this.isSolid(tx + dx, ty) || this.isSolid(tx, ty + dy)) continue;
        }
        visited.add(idx);
        stack.push(nx, ny);
      }
    }
    return { tiles: visited, count: visited.size };
  }

  /**
   * A* on the tile grid. Returns an array of world-space waypoints
   * (excluding the starting position) or an empty array when unreachable.
   */
  findPath(fromX, fromY, toX, toY, { maxNodes = 6000, diagonal = true } = {}) {
    const start = this.worldToTile(fromX, fromY);
    let goal = this.worldToTile(toX, toY);
    if (!this.inBounds(start.tx, start.ty) || !this.inBounds(goal.tx, goal.ty)) return [];
    if (this.isSolid(goal.tx, goal.ty)) {
      const near = this.nearestFloor(goal.tx, goal.ty, 6);
      if (!near) return [];
      goal = near;
    }
    if (this.isSolid(start.tx, start.ty)) {
      const near = this.nearestFloor(start.tx, start.ty, 4);
      if (!near) return [];
      start.tx = near.tx;
      start.ty = near.ty;
    }
    const startIdx = this.index(start.tx, start.ty);
    const goalIdx = this.index(goal.tx, goal.ty);
    if (startIdx === goalIdx) return [];

    const size = this.width * this.height;
    const gScore = new Float32Array(size).fill(Infinity);
    const cameFrom = new Int32Array(size).fill(-1);
    const closed = new Uint8Array(size);
    const open = new MinHeap();
    gScore[startIdx] = 0;
    open.push(startIdx, heuristic(start.tx, start.ty, goal.tx, goal.ty));

    const dirs = diagonal
      ? [
          [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
          [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
        ]
      : [
          [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
        ];

    let expanded = 0;
    while (open.size > 0) {
      const currentIdx = open.pop();
      if (closed[currentIdx]) continue;
      closed[currentIdx] = 1;
      if (currentIdx === goalIdx) return this._reconstruct(cameFrom, currentIdx);
      expanded += 1;
      if (expanded > maxNodes) break;

      const cx = currentIdx % this.width;
      const cy = (currentIdx - cx) / this.width;
      for (const [dx, dy, cost] of dirs) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.inBounds(nx, ny)) continue;
        if (this.isSolid(nx, ny)) continue;
        if (dx !== 0 && dy !== 0) {
          if (this.isSolid(cx + dx, cy) || this.isSolid(cx, cy + dy)) continue;
        }
        const nIdx = this.index(nx, ny);
        if (closed[nIdx]) continue;
        const tentative = gScore[currentIdx] + cost;
        if (tentative < gScore[nIdx]) {
          gScore[nIdx] = tentative;
          cameFrom[nIdx] = currentIdx;
          open.push(nIdx, tentative + heuristic(nx, ny, goal.tx, goal.ty));
        }
      }
    }
    return [];
  }

  _reconstruct(cameFrom, goalIdx) {
    const path = [];
    let current = goalIdx;
    let guard = 0;
    while (current !== -1 && guard < 20000) {
      const tx = current % this.width;
      const ty = (current - tx) / this.width;
      const world = this.tileToWorld(tx, ty);
      path.push(world);
      current = cameFrom[current];
      guard += 1;
    }
    path.reverse();
    if (path.length > 0) path.shift(); // drop the tile the agent already stands on

    // String-pull: greedily keep only waypoints that are required for line of
    // sight, which removes the stair-stepping A* produces on open floors.
    if (path.length <= 2) return path;
    const smoothed = [path[0]];
    let anchor = 0;
    for (let j = 2; j < path.length; j += 1) {
      const a = path[anchor];
      const candidate = path[j];
      if (!this.hasLineOfSight(a.x, a.y, candidate.x, candidate.y)) {
        smoothed.push(path[j - 1]);
        anchor = j - 1;
      }
    }
    const last = path[path.length - 1];
    if (smoothed[smoothed.length - 1] !== last) smoothed.push(last);
    return smoothed;
  }

  /** Breadth-limited search for the closest floor tile to a solid tile. */
  nearestFloor(tx, ty, maxRadius = 8) {
    if (this.isFloor(tx, ty)) return { tx, ty };
    for (let r = 1; r <= maxRadius; r += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = tx + dx;
          const ny = ty + dy;
          if (this.isFloor(nx, ny)) return { tx: nx, ty: ny };
        }
      }
    }
    return null;
  }

  /** Finds a random-ish walkable world position inside `rectWorld`. */
  randomFloorInRect(rectWorld, rng, tries = 40) {
    const x0 = Math.max(0, Math.floor(rectWorld.x / this.tileSize));
    const y0 = Math.max(0, Math.floor(rectWorld.y / this.tileSize));
    const x1 = Math.min(this.width - 1, Math.ceil((rectWorld.x + rectWorld.w) / this.tileSize) - 1);
    const y1 = Math.min(this.height - 1, Math.ceil((rectWorld.y + rectWorld.h) / this.tileSize) - 1);
    for (let attempt = 0; attempt < tries; attempt += 1) {
      const tx = rng.int(x0, Math.max(x0, x1));
      const ty = rng.int(y0, Math.max(y0, y1));
      if (!this.isFloor(tx, ty)) continue;
      const world = this.tileToWorld(tx, ty);
      if (this.circleCollides(world.x, world.y, 16)) continue;
      return world;
    }
    return null;
  }
}

function heuristic(ax, ay, bx, by) {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  // Octile distance: admissible for 8-way movement with sqrt(2) diagonals.
  return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
}

/** Binary min-heap keyed by a float priority. */
export class MinHeap {
  constructor() {
    this.items = [];
    this.priorities = [];
  }

  get size() {
    return this.items.length;
  }

  push(item, priority) {
    this.items.push(item);
    this.priorities.push(priority);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priorities[parent] <= this.priorities[i]) break;
      this._swap(i, parent);
      i = parent;
    }
  }

  pop() {
    const top = this.items[0];
    const lastItem = this.items.pop();
    const lastPriority = this.priorities.pop();
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.priorities[0] = lastPriority;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.items.length && this.priorities[left] < this.priorities[smallest]) smallest = left;
        if (right < this.items.length && this.priorities[right] < this.priorities[smallest]) smallest = right;
        if (smallest === i) break;
        this._swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  _swap(a, b) {
    const ti = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = ti;
    const tp = this.priorities[a];
    this.priorities[a] = this.priorities[b];
    this.priorities[b] = tp;
  }
}
