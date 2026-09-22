/**
 * Deterministic zone generation.
 *
 * Strategy: BSP partition -> carve one room per leaf -> connect sibling
 * subtrees with L-corridors. Because connectivity is established by
 * construction, the global flood-fill validation that runs afterwards is a
 * *guard*, not the mechanism: it catches obstacle/decoration mistakes and
 * triggers a deterministic regeneration attempt when something is wrong.
 *
 * Every random decision comes from the injected `Rng`, so a given seed plus
 * generation parameters always produces byte-identical output.
 */

import { Rng, hashString } from '../core/rng.js';
import { TileMap, TILE, FLOOR, SOLID } from '../world/tilemap.js';
import { clamp, dist2, rectCenter } from '../core/math.js';
import {
  BOSS,
  ENEMY_IDS,
  THREAT_PROFILES,
  ZONE_NAMES,
  difficultyAt,
} from '../config/enemies.js';
import {
  EXTRACTION,
  MAP_GEN_DEFAULTS,
  OBJECTIVE_TYPES,
  ROOM_RARITY_BOOST_CHANCE,
  VAULT_LOOT_QUALITY_MUL,
  VAULT_RARITY_BOOST_CHANCE,
} from '../config/balance.js';

const ROOM_PADDING = 2; // tiles of rock kept between a leaf and its room

/**
 * @typedef {Object} ZoneRoom
 * @property {number} id
 * @property {{x:number,y:number,w:number,h:number}} rect   world-space rect
 * @property {{x:number,y:number}} center                    world-space centre
 * @property {string} type
 * @property {number} depth
 * @property {Array<{x:number,y:number}>} enemySpots
 * @property {Array<{x:number,y:number}>} lootSpots
 */

class BspNode {
  constructor(x, y, w, h) {
    this.x = x;
    this.y = y;
    this.w = w;
    this.h = h;
    this.left = null;
    this.right = null;
    this.room = null;
    this.depth = 0;
  }

  get isLeaf() {
    return !this.left && !this.right;
  }
}

function splitNode(node, minSize, rng, depth) {
  if (depth > 24) return;
  const canSplitH = node.h >= minSize * 2;
  const canSplitV = node.w >= minSize * 2;
  if (!canSplitH && !canSplitV) return;
  const horizontal = canSplitH && canSplitV ? rng.bool(node.h > node.w ? 0.62 : 0.38) : canSplitH;
  if (horizontal) {
    const cut = rng.int(minSize, node.h - minSize);
    node.left = new BspNode(node.x, node.y, node.w, cut);
    node.right = new BspNode(node.x, node.y + cut, node.w, node.h - cut);
  } else {
    const cut = rng.int(minSize, node.w - minSize);
    node.left = new BspNode(node.x, node.y, cut, node.h);
    node.right = new BspNode(node.x + cut, node.y, node.w - cut, node.h);
  }
  node.left.depth = depth + 1;
  node.right.depth = depth + 1;
  splitNode(node.left, minSize, rng, depth + 1);
  splitNode(node.right, minSize, rng, depth + 1);
}

function collectLeaves(node, out = []) {
  if (!node) return out;
  if (node.isLeaf) out.push(node);
  else {
    collectLeaves(node.left, out);
    collectLeaves(node.right, out);
  }
  return out;
}

/** Recursively returns the room rect that represents a subtree. */
function representRoom(node) {
  if (node.isLeaf) return node.room;
  const left = representRoom(node.left);
  const right = representRoom(node.right);
  if (!left) return right;
  if (!right) return left;
  return left;
}

function carveRect(map, rect) {
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      if (map.inBounds(x, y)) map.set(x, y, FLOOR);
    }
  }
}

/**
 * Normalise a tile-space point. Callers pass either `{x, y}` (hand-built tile
 * coordinates) or the `{tx, ty}` shape returned by `TileMap.worldToTile`; both
 * are accepted so a mismatched key can never silently carve corridors at NaN.
 * @returns {{x:number,y:number}|null} `null` when the point is unusable.
 */
function tilePoint(point) {
  if (!point) return null;
  const x = point.tx ?? point.x;
  const y = point.ty ?? point.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.floor(x), y: Math.floor(y) };
}

/**
 * Carve an L-shaped corridor between two tile-space points.
 * @returns {{from:{x:number,y:number},to:{x:number,y:number}}|null} the
 *   normalised endpoints (for the minimap spine) or `null` when a point was
 *   not a valid tile coordinate.
 */
function carveCorridor(map, fromPoint, toPoint, halfWidth, rng) {
  const fromTile = tilePoint(fromPoint);
  const toTile = tilePoint(toPoint);
  if (!fromTile || !toTile) return null;
  const horizontalFirst = rng.bool();
  const x0 = Math.min(fromTile.x, toTile.x);
  const x1 = Math.max(fromTile.x, toTile.x);
  const y0 = Math.min(fromTile.y, toTile.y);
  const y1 = Math.max(fromTile.y, toTile.y);
  const carveH = (y) => {
    for (let x = x0; x <= x1; x += 1) {
      for (let o = -halfWidth; o <= halfWidth; o += 1) {
        if (map.inBounds(x, y + o)) map.set(x, y + o, FLOOR);
      }
    }
  };
  const carveV = (x) => {
    for (let y = y0; y <= y1; y += 1) {
      for (let o = -halfWidth; o <= halfWidth; o += 1) {
        if (map.inBounds(x + o, y)) map.set(x + o, y, FLOOR);
      }
    }
  };
  if (horizontalFirst) {
    carveH(fromTile.y);
    carveV(toTile.x);
  } else {
    carveV(fromTile.x);
    carveH(toTile.y);
  }
}

function connectTree(map, node, halfWidth, rng, corridors) {
  if (!node || node.isLeaf) return;
  connectTree(map, node.left, halfWidth, rng, corridors);
  connectTree(map, node.right, halfWidth, rng, corridors);
  const a = representRoom(node.left);
  const b = representRoom(node.right);
  if (!a || !b) return;
  const at = map.worldToTile(a.x + a.w / 2, a.y + a.h / 2);
  const bt = map.worldToTile(b.x + b.w / 2, b.y + b.h / 2);
  const corridor = carveCorridor(map, at, bt, halfWidth, rng);
  if (corridor) corridors.push(corridor);
}

/**
 * Place solid obstacle clusters inside a room rect (world space).
 * Returns the created solids so callers can avoid overlapping them.
 */
function placeObstacles(map, roomRect, rng, density, isCriticalRoom) {
  const created = [];
  if (isCriticalRoom) return created;
  const tilePad = 3;
  const x0 = Math.floor(roomRect.x / TILE) + tilePad;
  const y0 = Math.floor(roomRect.y / TILE) + tilePad;
  const x1 = Math.ceil((roomRect.x + roomRect.w) / TILE) - tilePad - 1;
  const y1 = Math.ceil((roomRect.y + roomRect.h) / TILE) - tilePad - 1;
  if (x1 <= x0 || y1 <= y0) return created;
  const area = (x1 - x0) * (y1 - y0);
  const clusters = Math.max(0, Math.round(area * density * 0.035));
  for (let i = 0; i < clusters; i += 1) {
    const cw = rng.int(1, 3);
    const ch = rng.int(1, 3);
    const cx = rng.int(x0, Math.max(x0, x1 - cw));
    const cy = rng.int(y0, Math.max(y0, y1 - ch));
    for (let y = cy; y < cy + ch; y += 1) {
      for (let x = cx; x < cx + cw; x += 1) map.set(x, y, SOLID);
    }
    created.push({
      x: cx * TILE,
      y: cy * TILE,
      w: cw * TILE,
      h: ch * TILE,
    });
  }
  return created;
}

function chooseRoomType(index, roomCount) {
  if (index === 0) return 'spawn';
  if (index === 1) return 'exit';
  if (index === 2) return 'objective';
  if (index === 3) return 'descend';
  return 'combat';
}

/**
 * Main entry point.
 *
 * @param {Object} options
 * @param {string|number} options.seed
 * @param {number} [options.tier]             sector depth, 1 based
 * @param {Object} [options.genParams]        overrides for MAP_GEN_DEFAULTS
 * @returns {Object} a fully validated zone descriptor
 */
export function generateZone({ seed, tier = 1, genParams = {} } = {}) {
  if (seed === undefined || seed === null) throw new TypeError('generateZone requires a seed');
  const params = { ...MAP_GEN_DEFAULTS, ...genParams };
  const difficulty = difficultyAt(tier);
  const baseRng = new Rng(seed);

  let lastIssues = [];
  const ATTEMPTS = 8;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const rng = new Rng(hashString(`${baseRng.seed}::attempt${attempt}`)());
    const relaxed = { ...params };
    // Later attempts smooth the layout so validation converges deterministically.
    relaxed.obstacleDensity = Math.max(0, params.obstacleDensity - attempt * 0.06);
    relaxed.roomAttempts = Math.max(40, params.roomAttempts - attempt * 12);
    const zone = buildZone({ rng, tier, difficulty, params: relaxed, seed, attempt });
    const validation = validateZone(zone);
    if (validation.ok) {
      zone.validation = validation;
      zone.attempts = attempt + 1;
      return zone;
    }
    lastIssues = validation.issues;
  }
  throw new Error(
    `Zone generation failed after ${ATTEMPTS} deterministic attempts for seed "${seed}" tier ${tier}: ${lastIssues.join('; ')}`,
  );
}

function buildZone({ rng, tier, difficulty, params, seed, attempt }) {
  const sizeScale = 1 + (tier - 1) * 0.09;
  const targetRooms = clamp(Math.round(13 + (tier - 1) * 1.6 + rng.int(-1, 2)), 10, 26);
  const tileSize = TILE;
  const estimated = Math.sqrt(targetRooms) * (params.maxRoomSize + params.corridorWidth + 120);
  const worldW = Math.round(clamp(Math.max(params.width * sizeScale, estimated), 2200, 5200) / tileSize) * tileSize;
  const worldH = Math.round(clamp(Math.max(params.height * sizeScale, estimated), 2200, 5200) / tileSize) * tileSize;
  const width = Math.floor(worldW / tileSize);
  const height = Math.floor(worldH / tileSize);

  const map = new TileMap(width, height, tileSize);
  const root = new BspNode(1, 1, width - 2, height - 2);
  const minLeaf = Math.round((params.minRoomSize + params.corridorWidth) / tileSize) + 1;
  splitNode(root, minLeaf, rng, 0);

  let leaves = collectLeaves(root);
  // Too many leaves would make rooms cramped; keep the deepest-safe subset.
  if (leaves.length > targetRooms) {
    leaves = rng.shuffle(leaves).slice(0, targetRooms);
    // Rebuild connectivity for the kept subset instead of the full tree.
    for (const leaf of leaves) {
      leaf.left = null;
      leaf.right = null;
    }
  }

  const rooms = [];
  for (const leaf of leaves) {
    const maxW = leaf.w - ROOM_PADDING * 2;
    const maxH = leaf.h - ROOM_PADDING * 2;
    if (maxW < 3 || maxH < 3) continue;
    const large = rng.bool(params.largeRoomChance);
    const roomW = clamp(
      rng.int(Math.max(3, Math.round((params.minRoomSize / tileSize) * 0.8)), maxW),
      Math.max(3, Math.round((params.minRoomSize / tileSize) * 0.8)),
      maxW,
    );
    const roomH = clamp(
      rng.int(Math.max(3, Math.round((params.minRoomSize / tileSize) * 0.8)), maxH),
      Math.max(3, Math.round((params.minRoomSize / tileSize) * 0.8)),
      maxH,
    );
    const w = large ? maxW : roomW;
    const h = large ? maxH : roomH;
    const ox = leaf.x + ROOM_PADDING + rng.int(0, Math.max(0, maxW - w));
    const oy = leaf.y + ROOM_PADDING + rng.int(0, Math.max(0, maxH - h));
    const room = { x: ox, y: oy, w, h };
    leaf.room = {
      x: ox * tileSize,
      y: oy * tileSize,
      w: w * tileSize,
      h: h * tileSize,
    };
    carveRect(map, room);
    rooms.push({ leaf, rect: leaf.room });
  }
  if (rooms.length < 6) {
    throw new Error(`Only ${rooms.length} rooms carved; layout too small`);
  }

  // Connect the retained rooms. Build a minimum spanning path over room centres
  // using a simple nearest-neighbour chain, then add a few extra loops so the
  // map is not a pure tree (extraction routes must not be single points of failure).
  const centers = rooms.map((r) => rectCenter(r.rect));
  const edges = [];
  const connected = [0];
  const remaining = rooms.map((_, i) => i).slice(1);
  while (remaining.length > 0) {
    let best = null;
    for (const a of connected) {
      for (const b of remaining) {
        const d = dist2(centers[a].x, centers[a].y, centers[b].x, centers[b].y);
        if (!best || d < best.d) best = { a, b, d };
      }
    }
    edges.push(best);
    connected.push(best.b);
    remaining.splice(remaining.indexOf(best.b), 1);
  }
  const halfWidth = Math.max(1, Math.floor(params.corridorWidth / tileSize / 2));
  const corridorList = [];
  for (const edge of edges) {
    const at = map.worldToTile(centers[edge.a].x, centers[edge.a].y);
    const bt = map.worldToTile(centers[edge.b].x, centers[edge.b].y);
    const corridor = carveCorridor(map, at, bt, halfWidth, rng);
    if (corridor) corridorList.push(corridor);
  }
  // Extra loops: connect a handful of random room pairs to remove dead ends.
  const extraLoops = clamp(Math.round(rooms.length * 0.22), 1, 5);
  for (let i = 0; i < extraLoops; i += 1) {
    const a = rng.int(0, rooms.length - 1);
    let b = rng.int(0, rooms.length - 1);
    if (b === a) b = (b + 1) % rooms.length;
    const at = map.worldToTile(centers[a].x, centers[a].y);
    const bt = map.worldToTile(centers[b].x, centers[b].y);
    const corridor = carveCorridor(map, at, bt, halfWidth, rng);
    if (corridor) corridorList.push({ ...corridor, loop: true });
  }

  // Classify rooms. Sort by distance from the spawn room so roles are spatial.
  const spawnRoomIndex = 0;
  const ranked = rooms
    .map((room, index) => ({ room, index, d: dist2(centers[0].x, centers[0].y, centers[index].x, centers[index].y) }))
    .sort((a, b) => b.d - a.d);
  const farIndex = ranked[0].index;
  const midIndex = ranked[Math.min(1, ranked.length - 1)].index;

  const isBossSector = tier % 3 === 0;

  const assigned = new Map();
  assigned.set(spawnRoomIndex, 'spawn');
  assigned.set(farIndex === spawnRoomIndex ? midIndex : farIndex, 'exit');
  assigned.set(midIndex === spawnRoomIndex || midIndex === farIndex ? ranked[2].index : midIndex, 'objective');
  const usedForDescend = rng.shuffle(
    rooms.map((_, i) => i).filter((i) => !assigned.has(i)),
  );
  const descendIndex = usedForDescend[0] ?? midIndex;
  if (!assigned.has(descendIndex)) assigned.set(descendIndex, 'descend');
  for (let i = 0; i < rooms.length; i += 1) {
    if (!assigned.has(i)) assigned.set(i, rng.bool(0.24) ? 'vault' : 'combat');
  }
  if (isBossSector) {
    // Boss arenas need space: promote the largest non-critical room.
    const candidates = rooms
      .map((room, index) => ({ room, index }))
      .filter(({ index }) => !['spawn', 'exit', 'objective'].includes(assigned.get(index)))
      .sort((a, b) => b.room.rect.w * b.room.rect.h - a.room.rect.w * a.room.rect.h);
    if (candidates.length > 0) assigned.set(candidates[0].index, 'boss');
  }

  const zoneRooms = [];
  for (let i = 0; i < rooms.length; i += 1) {
    const type = assigned.get(i);
    const critical = type === 'spawn' || type === 'exit' || type === 'descend';
    placeObstacles(map, rooms[i].rect, rng, params.obstacleDensity, critical);
    const center = rectCenter(rooms[i].rect);
    zoneRooms.push({
      id: i,
      rect: rooms[i].rect,
      center,
      type,
      depth: rooms[i].leaf.depth,
      enemySpots: [],
      lootSpots: [],
    });
  }

  map.recount();

  const spawnPoint = pickFloorNear(map, zoneRooms[spawnRoomIndex].center, rng, 26);
  if (!spawnPoint) throw new Error('Spawn room has no standable tile');

  const exitRoom = zoneRooms.find((r) => r.type === 'exit');
  const objectiveRoom = zoneRooms.find((r) => r.type === 'objective');
  const descendRoom = zoneRooms.find((r) => r.type === 'descend');
  const bossRoom = zoneRooms.find((r) => r.type === 'boss');

  const extractionPosition = pickFloorNear(map, exitRoom.center, rng, 30);
  if (!extractionPosition) throw new Error('Extraction room has no standable tile');
  const objectivePosition = pickFloorNear(map, objectiveRoom.center, rng, 30);
  if (!objectivePosition) throw new Error('Objective room has no standable tile');
  const descendPosition = descendRoom ? pickFloorNear(map, descendRoom.center, rng, 30) : null;

  // Populate per-room spawn spots.
  for (const room of zoneRooms) {
    const spots = sampleRoomSpots(map, room, rng, room === zoneRooms[spawnRoomIndex] ? 0 : 10, 26);
    room.enemySpots = spots;
    const lootCount = room.type === 'vault' ? rng.int(4, 6) : room.type === 'combat' ? rng.int(1, 3) : rng.int(0, 2);
    room.lootSpots = sampleRoomSpots(map, room, rng, lootCount, 20);
  }

  const objectives = buildObjectives({
    rng,
    tier,
    isBossSector,
    objectiveRoom,
    objectivePosition,
    bossRoom,
    map,
    zoneRooms,
    spawnPoint,
  });

  // Rolled here so the sector descriptor can name the garrison profile the HUD
  // shows on the sector banner; the draw happens where the spawn pass used to
  // take it, so generation stays deterministic per seed.
  const threatProfile = pickThreatProfile(rng, tier);
  // The commander's room is picked geometrically (the deepest room that is not
  // a critical one), so the spawn pass can garrison it like any other prize.
  const huntRoom = objectives.some((o) => o.type === OBJECTIVE_TYPES.HUNT)
    ? pickCommandRoom(zoneRooms, spawnPoint)
    : null;
  const enemySpawns = buildEnemySpawns({
    rng,
    tier,
    difficulty,
    zoneRooms,
    spawnRoomId: spawnRoomIndex,
    bossRoomId: bossRoom ? bossRoom.id : -1,
    isBossSector,
    spawnPoint,
    profile: threatProfile,
    map,
    objectives,
    huntRoom,
  });

  assignHuntTarget(objectives, enemySpawns, huntRoom);
  reconcileEliminateTarget(objectives, enemySpawns);

  const lootSpawns = buildLootSpawns({ rng, tier, difficulty, zoneRooms, objectives });

  const props = buildProps({ rng, map, zoneRooms, objectives });
  const lights = buildLights({ zoneRooms, map, spawnPoint, extractionPosition });
  const decor = buildDecor({ rng, map, zoneRooms });

  const nameIndex = Math.floor(hashString(`${seed}:${tier}:name`)() % ZONE_NAMES.length);

  return {
    seed,
    tier,
    attempt,
    name: ZONE_NAMES[nameIndex],
    genParams: params,
    map,
    tileSize,
    rooms: zoneRooms,
    spawnPoint,
    extraction: {
      x: extractionPosition.x,
      y: extractionPosition.y,
      radius: EXTRACTION.radius,
      channelTime: EXTRACTION.channelTime,
    },
    descend: descendPosition
      ? {
          x: descendPosition.x,
          y: descendPosition.y,
          radius: EXTRACTION.descendRadius,
          channelTime: EXTRACTION.descendChannelTime,
        }
      : null,
    objectives,
    enemySpawns,
    threatProfile: { id: threatProfile.id, name: threatProfile.name },
    lootSpawns,
    props,
    lights,
    decor,
    difficulty,
    isBossSector,
    corridors: corridorList,
    bounds: { x: 0, y: 0, w: map.worldWidth, h: map.worldHeight },
  };
}

function buildObjectives(ctx) {
  const {
    rng, tier, isBossSector, objectiveRoom, objectivePosition, bossRoom, map, zoneRooms, spawnPoint,
  } = ctx;

  if (isBossSector && bossRoom) {
    const arena = bossRoom.rect;
    const center = pickFloorNear(map, { x: arena.x + arena.w / 2, y: arena.y + arena.h / 2 }, rng, 30);
    return [
      {
        id: 'objective-boss',
        type: OBJECTIVE_TYPES.BOSS,
        title: 'NEUTRALISE THE FOREMAN',
        description: 'Locate and destroy the Foundry Overseer. Extraction unlocks afterwards.',
        target: 1,
        progress: 0,
        complete: false,
        roomId: bossRoom.id,
        position: center ?? objectivePosition,
        bossId: BOSS.id,
        requires: [],
      },
    ];
  }

  // Pool entries carry a `minTier` like the threat profiles do: tier 1 keeps its
  // curated three, and the commander hunt - a marked elite with a bodyguard -
  // opens once the player has kit to answer it with.
  const pool = [
    {
      type: OBJECTIVE_TYPES.ELIMINATE,
      title: 'PURGE HOSTILES',
      build: () => ({
        // Provisional only: the real target is derived from the hostiles the
        // sector actually spawns (see reconcileEliminateTarget), because the
        // spawn pass spends a threat budget at a per-archetype cost, so the
        // enemy count cannot be known while the objective pool is built.
        target: 1,
        description: 'Clear the zone of hostile signatures.',
      }),
    },
    {
      type: OBJECTIVE_TYPES.HUNT,
      minTier: 2,
      title: 'ASSASSINATE THE COMMANDER',
      build: () => ({
        // The commander is promoted from the sector's own garrison after the
        // spawn pass (see assignHuntTarget): one guaranteed elite with a
        // bodyguard, instead of the "clear everything" or "collect three
        // things" shape the other objectives use.
        target: 1,
        description: 'A sector commander leads this garrison. Cut it down.',
      }),
    },
    {
      type: OBJECTIVE_TYPES.RECOVER,
      title: 'RECOVER DATA',
      build: () => ({
        target: 3,
        description: 'Recover encrypted data shards scattered across the zone.',
      }),
    },
    {
      type: OBJECTIVE_TYPES.DESTROY,
      title: 'SABOTAGE REACTORS',
      build: () => ({
        target: 2,
        description: 'Destroy the coolant reactors to destabilise the sector.',
      }),
    },
  ];
  const chosen = rng.pick(pool.filter((entry) => (entry.minTier ?? 1) <= (tier ?? 1)));
  const spec = chosen.build();

  const objectiveListPosition = objectivePosition;
  const objectives = [
    {
      id: 'objective-main',
      type: chosen.type,
      title: chosen.title,
      description: spec.description,
      target: spec.target,
      progress: 0,
      complete: false,
      roomId: objectiveRoom.id,
      position: objectiveListPosition,
      requires: [],
      markers: [],
    },
  ];

  if (chosen.type === OBJECTIVE_TYPES.RECOVER) {
    const candidates = zoneRooms
      .filter((r) => r.type !== 'spawn')
      .flatMap((r) => r.lootSpots.map((s) => ({ ...s, roomId: r.id })));
    const chosenSpots = rng.shuffle(candidates).slice(0, spec.target);
    if (chosenSpots.length < spec.target) {
      throw new Error('Not enough rooms to place recovery objective markers');
    }
    objectives[0].markers = chosenSpots;
  }

  if (chosen.type === OBJECTIVE_TYPES.DESTROY) {
    const roomsAvailable = rng.shuffle(zoneRooms.filter((r) => r.type !== 'spawn'));
    const spots = [];
    for (const room of roomsAvailable) {
      if (spots.length >= spec.target) break;
      const pos = pickFloorNear(map, room.center, rng, 24);
      if (pos) spots.push({ ...pos, roomId: room.id });
    }
    if (spots.length < spec.target) throw new Error('Not enough rooms for reactor objective');
    objectives[0].markers = spots;
  }

  void spawnPoint;
  return objectives;
}

/**
 * Picks the sector's threat profile. Tier 1 always fields the curated opener so
 * the first sector reads as an introduction; from tier 2 the sector rolls one of
 * the garrison profiles, which is what makes two sectors at the same depth play
 * differently instead of fielding the same soup in a different shape.
 */
function pickThreatProfile(rng, tier) {
  if (tier <= 1) return THREAT_PROFILES.find((p) => p.id === 'patrol');
  // Late sectors draw from a wider pool: profiles carry a `minTier`, so a deep
  // sector can field garrisons the early ones never roll instead of the same
  // four with a bigger budget.
  const options = THREAT_PROFILES.filter((p) => p.id !== 'patrol' && (p.minTier ?? 1) <= tier);
  return rng.pick(options);
}

function weightedArchetype(rng, weights, fallback = 'husk') {
  const entries = Object.entries(weights).filter(([id]) => ENEMY_IDS.includes(id));
  if (entries.length === 0) return fallback;
  const total = entries.reduce((sum, [, w]) => sum + Math.max(0, w), 0);
  if (total <= 0) return fallback;
  let roll = rng.next() * total;
  for (const [id, w] of entries) {
    roll -= Math.max(0, w);
    if (roll <= 0) return id;
  }
  return entries[entries.length - 1][0];
}

/**
 * Places one encounter group: a hotspot inside `room` plus `size` members
 * scattered around it. Squads are what turn a sector from a field of lone
 * wanderers into fights with a front and a back — reinforced by the profile,
 * so a GUNLINE sector presents firing lines and a SWARM sector presents packs.
 * Returns how much threat budget it actually spent.
 */
function placeSquad({ rng, room, profile, size, difficulty, spawns, budgetLeft, costOf, map }) {
  const spots = room.enemySpots;
  if (!spots || spots.length === 0) return 0;
  // Anchor on a free spot: two squads landing on the same sampled point would
  // put enemies in the same tile, which reads as a single flickering unit.
  let hot = rng.pick(spots);
  let anchorTries = 0;
  while (hot && anchorTries < 5 && spawns.some((s) => dist2(s.x, s.y, hot.x, hot.y) < 34 * 34)) {
    anchorTries += 1;
    hot = rng.pick(spots);
  }
  if (!hot || spawns.some((s) => dist2(s.x, s.y, hot.x, hot.y) < 18 * 18)) return 0;
  let spent = 0;
  let placed = 0;
  let guard = 0;
  // How far members stand from the hotspot is part of the profile's identity:
  // a SWARM collapses into one burst, a GUNLINE spreads into a line that has to
  // be picked apart in order.
  const [spreadMin, spreadMax] = profile.spread ?? [24, 86];
  while (placed < size && spent < budgetLeft && guard < 24) {
    guard += 1;
    const index = spawns.length;
    // Draw order is fixed per attempt (angle, radius, archetype, elite roll) so
    // the same seed keeps producing the same garrison.
    const angle = rng.angle();
    const radius = placed === 0 ? 0 : rng.float(spreadMin, spreadMax);
    const x = hot.x + Math.cos(angle) * radius;
    const y = hot.y + Math.sin(angle) * radius;
    const typeId = weightedArchetype(rng, profile.weights);
    const cost = costOf(typeId);
    if (spent + cost > budgetLeft) break;
    // A squad member squeezed against a wall would be unreachable: fall back to
    // the room's own sampled spot rather than placing it in rock.
    let px = x, py = y;
    const blocked = map && !map.isFloor(map.worldToTile(px, py).tx, map.worldToTile(py, py).ty);
    if (blocked) {
      // Squads hug walls: walk the room's own sampled points for one that is both
      // standable and free, instead of stacking two enemies in the same tile.
      let found = null;
      for (let k = 0; k < spots.length; k += 1) {
        const candidate = spots[(index + placed + k) % spots.length];
        if (!candidate) continue;
        if (map && !map.isFloor(map.worldToTile(candidate.x, candidate.y).tx, map.worldToTile(candidate.y, candidate.y).ty)) continue;
        if (spawns.some((s) => dist2(s.x, s.y, candidate.x, candidate.y) < 24 * 24)) continue;
        found = candidate;
        break;
      }
      if (!found) continue;
      px = found.x;
      py = found.y;
    }
    // Two enemies in the same tile read as one flickering unit: keep members at
    // least a body-width apart, and the room from becoming a single blob.
    if (spawns.some((s) => dist2(s.x, s.y, px, py) < 18 * 18)) continue;
    const nearby = spawns.filter((s) => dist2(s.x, s.y, px, py) < 190 * 190);
    if (nearby.length > 6) continue;
    const wantsElite = profile.elites.includes(typeId);
    const elite = wantsElite && rng.next() < difficulty.eliteChance;
    spawns.push({
      x: px,
      y: py,
      typeId,
      elite: elite ? (rng.next() < 0.25 ? 'champion' : 'elite') : null,
      roomId: room.id,
      dormant: true,
      squadId: room.id * 100 + index,
    });
    spent += elite ? cost * 2 : cost;
    placed += 1;
  }
  return spent;
}

function buildEnemySpawns({
  rng, tier, difficulty, zoneRooms, spawnRoomId, bossRoomId, isBossSector, spawnPoint, profile, map,
  objectives, huntRoom,
}) {
  const spawns = [];
  const budget = difficulty.threatBudget;
  const costOf = (typeId) => ({ husk: 2, dart: 2, marksman: 3, brute: 6, spitter: 4 }[typeId] ?? 3);
  let spent = 0;

  const maxDist = Math.max(
    1,
    ...zoneRooms.map((room) => Math.hypot(room.center.x - spawnPoint.x, room.center.y - spawnPoint.y)),
  );
  const distanceFraction = (room) => (
    Math.hypot(room.center.x - spawnPoint.x, room.center.y - spawnPoint.y) / maxDist
  );

  // Guards first: a vault (4-6 loot spots) and the objective room are worth
  // defending, so their reward is earned rather than collected in passing. This
  // is what gives the sector a risk/reward gradient instead of flat danger.
  const guardTargets = zoneRooms
    .filter((room) => {
      if (room.id === spawnRoomId || room.id === bossRoomId) return false;
      if (room.type === 'vault') return true;
      if (huntRoom && room.id === huntRoom.id) return true;
      return !isBossSector && room.type === 'objective';
    })
    .sort((a, b) => distanceFraction(b) - distanceFraction(a) || a.id - b.id);
  // Every prize room gets a garrison: a vault that is sometimes free and
  // sometimes guarded would make the reward a coin flip instead of a decision.
  // The per-room size cap is what bounds the guard share of the budget, so the
  // rest of the sector still gets its own garrison.
  // The objective's own prizes are paid for first: they are mandatory content,
  // and a sector whose vaults are all fortified must still defend the shard the
  // objective sends the player to. Garrison spend is capped as a share of the
  // budget so the route garrison is never starved by its own prize rooms.
  // Markers are paid for first, from the same budget as everything else: a
  // sector whose vaults are all fortified must still defend the shard the
  // objective sends the player to. There is no separate prize cap - the
  // per-room garrison sizes are the bound, and the general pass below spends
  // whatever is left, which is what keeps the rest of the sector populated.
  const guardCap = budget;
  if (Array.isArray(objectives) && (profile.markerGuard ?? 0) > 0) {
    let markerIndex = 0;
    for (const objective of objectives) {
      if (objective.type !== OBJECTIVE_TYPES.RECOVER && objective.type !== OBJECTIVE_TYPES.DESTROY) continue;
      const size = Math.max(1, Math.min(profile.markerGuard, profile.squad[1]));
      for (const marker of objective.markers ?? []) {
        if (spent >= guardCap) break;
        markerIndex += 1;
        // Sample inside the marker's own room (padded a little) rather than a
        // fixed box: a marker near a room edge would otherwise sit in a box that
        // is mostly rock, the sampling would fail and the prize would go
        // undefended. The nearest spots win, so the garrison holds the prize
        // itself rather than the far corner of its room.
        const room = zoneRooms.find((r) => r.id === marker.roomId);
        const rect = room
          ? { x: room.rect.x - 48, y: room.rect.y - 48, w: room.rect.w + 96, h: room.rect.h + 96 }
          : { x: marker.x - 130, y: marker.y - 130, w: 260, h: 260 };
        const spots = sampleRoomSpots(map, { rect }, rng, 8, 26)
          .sort((a, b) => dist2(a.x, a.y, marker.x, marker.y) - dist2(b.x, b.y, marker.x, marker.y))
          .slice(0, 4);
        if (spots.length === 0) continue;
        spent += placeSquad({
          rng,
          // Negative ids keep marker garrisons out of the room id space.
          room: { id: -markerIndex, enemySpots: spots },
          profile,
          size,
          difficulty,
          spawns,
          budgetLeft: guardCap - spent,
          costOf,
          map,
        });
      }
    }
  }

  for (const room of guardTargets) {
    if (room.enemySpots.length === 0) continue;
    // The command room holds the objective's target, so it gets one body more
    // than a normal garrison; a vault keeps its ordinary guard and earns its
    // extra pressure from the richer cache it pays out.
    const isCommand = Boolean(huntRoom) && room.id === huntRoom.id;
    const wanted = isCommand ? profile.guard + 1 : profile.guard;
    const size = Math.min(wanted, profile.squad[1] + (isCommand ? 1 : 0));
    if (spent >= guardCap) break;
    spent += placeSquad({
      rng,
      room,
      profile,
      size,
      difficulty,
      spawns,
      budgetLeft: guardCap - spent,
      costOf,
      map,
    });
  }

  // Then the rest of the garrison, room by room. Group size is graded by depth:
  // the interior gets full squads, the middle of the sector gets pairs, and the
  // approach gets lone sentries. That keeps encounters as the unit of combat
  // without leaving the route the player actually walks through empty, and it
  // still escalates instead of front-loading the fight.
  const candidates = zoneRooms.filter((room) => (
    room.id !== spawnRoomId && room.id !== bossRoomId
    && room.enemySpots.length > 0
    && !(isBossSector && room.type === 'objective')
  ));
  const ordered = candidates
    .slice()
    .sort((a, b) => distanceFraction(b) - distanceFraction(a) || a.id - b.id);
  const groupSize = (fraction, pass) => {
    if (pass > 1) return rng.int(profile.squad[0], profile.squad[1]);
    if (fraction > 0.55) return rng.int(profile.squad[0], profile.squad[1]);
    if (fraction > 0.28) return rng.int(1, profile.squad[0]);
    return 1;
  };
  let pass = 0;
  let guard = 0;
  while (spent < budget && pass < 6 && guard < 400 && ordered.length > 0) {
    pass += 1;
    for (const room of ordered) {
      if (spent >= budget || guard >= 400) break;
      guard += 1;
      const fraction = distanceFraction(room);
      if (pass > 1 && fraction < 0.3) continue;
      if (pass > 2 && fraction < 0.6) continue;
      const size = groupSize(fraction, pass);
      spent += placeSquad({
        rng, room, profile, size, difficulty, spawns, budgetLeft: budget - spent, costOf, map,
      });
    }
  }

  if (isBossSector && bossRoomId >= 0) {
    const bossRoom = zoneRooms.find((r) => r.id === bossRoomId);
    if (bossRoom) {
      spawns.push({
        x: bossRoom.center.x,
        y: bossRoom.center.y,
        typeId: 'boss',
        elite: null,
        roomId: bossRoomId,
        dormant: true,
        isBoss: true,
      });
    }
  }
  return spawns;
}

/**
 * The room the commander objective is built around: the deepest room that is
 * not a critical route room (spawn / exit / descent). It draws no random
 * numbers, so adding the objective does not shift the generation stream.
 */
function pickCommandRoom(zoneRooms, spawnPoint) {
  const nonCritical = zoneRooms.filter((r) => !['spawn', 'exit', 'descend'].includes(r.type));
  const pool = nonCritical.length > 0 ? nonCritical : zoneRooms.filter((r) => r.type !== 'spawn');
  let best = null;
  let bestDistance = -1;
  for (const room of pool) {
    const d = dist2(room.center.x, room.center.y, spawnPoint.x, spawnPoint.y);
    if (d > bestDistance || (d === bestDistance && best && room.id < best.id)) {
      bestDistance = d;
      best = room;
    }
  }
  return best;
}

/**
 * Picks the commander: the sector's own elite closest to the command room,
 * promoted to an elite if this sector rolled none (the objective's target is
 * content, not a lucky spawn). Runs after the spawn pass and draws no random
 * numbers, so generation order and every other seed's output are untouched.
 */
function assignHuntTarget(objectives, enemySpawns, huntRoom) {
  const objective = objectives.find((o) => o.type === OBJECTIVE_TYPES.HUNT);
  if (!objective) return;
  const anchor = huntRoom ? huntRoom.center : null;
  let best = null;
  let bestScore = Infinity;
  for (let index = 0; index < enemySpawns.length; index += 1) {
    const spawn = enemySpawns[index];
    if (spawn.isBoss) continue;
    const distance = anchor ? dist2(spawn.x, spawn.y, anchor.x, anchor.y) : index;
    // An existing elite wins over proximity: the commander should be the
    // toughest thing on the map, not the nearest thing to a room.
    const score = (spawn.elite ? 0 : 1) * 1e9 + distance;
    if (score < bestScore) {
      bestScore = score;
      best = { spawn, index };
    }
  }
  if (!best) return;
  if (!best.spawn.elite) {
    // Promoted after the budget was spent, so this one elite is threat beyond
    // the sector's budget - deliberate, and the smallest possible correction
    // that keeps the objective solvable.
    best.spawn.elite = 'elite';
  }
  best.spawn.isCommander = true;
  objective.targetSpawnIndex = best.index;
  objective.targetPosition = { x: best.spawn.x, y: best.spawn.y };
}

/**
 * A purge objective must always be satisfiable. The spawn pass spends a threat
 * budget at a per-archetype cost, so the number of hostiles it yields varies
 * with the archetypes it rolls; a target computed independently from the budget
 * could therefore exceed what the sector can ever contain and leave the
 * extraction gate locked for the whole run. Deriving the target from the spawns
 * that actually exist keeps the objective honest, and a small margin means a
 * single hostile that ends up unreachable cannot dead-end the sector.
 *
 * Runs after the spawn pass on purpose: generation order (and therefore the RNG
 * stream, zone layout and fingerprints) is unchanged.
 */
function reconcileEliminateTarget(objectives, enemySpawns) {
  let hostiles = 0;
  for (const spawn of enemySpawns) {
    if (!spawn.isBoss) hostiles += 1;
  }
  const target = Math.max(0, Math.min(hostiles, Math.round(hostiles * 0.8)));
  for (const objective of objectives) {
    if (objective.type === OBJECTIVE_TYPES.ELIMINATE && !objective.complete) objective.target = target;
  }
}

function buildLootSpawns({ rng, tier, difficulty, zoneRooms, objectives }) {
  const spawns = [];
  for (const room of zoneRooms) {
    // A vault pays better per drop, not just more drops: its garrison is the
    // price, and a room you have to fight through should not hand back the same
    // cache an empty corridor does.
    const vault = room.type === 'vault';
    const quality = clamp01Safe(difficulty.lootMul * (vault ? VAULT_LOOT_QUALITY_MUL : 1));
    const boostChance = vault ? VAULT_RARITY_BOOST_CHANCE : ROOM_RARITY_BOOST_CHANCE;
    for (const spot of room.lootSpots) {
      spawns.push({
        x: spot.x,
        y: spot.y,
        roomId: room.id,
        tier,
        quality,
        rarityBoost: rng.next() < boostChance ? 1 : 0,
      });
    }
  }
  for (const objective of objectives) {
    if (objective.type === OBJECTIVE_TYPES.RECOVER) continue;
    spawns.push({
      x: objective.position.x,
      y: objective.position.y,
      roomId: objective.roomId,
      tier,
      quality: 1.6,
      rarityBoost: 2,
      guaranteed: true,
    });
  }
  return spawns;
}

function clamp01Safe(v) {
  return clamp(v, 0.1, 6);
}

function buildProps({ rng, map, zoneRooms, objectives }) {
  const props = [];
  for (const room of zoneRooms) {
    const count = rng.int(1, 4);
    for (let i = 0; i < count; i += 1) {
      const spot = map.randomFloorInRect(room.rect, rng, 12);
      if (!spot) continue;
      const kind = rng.weighted([
        { kind: 'crate', weight: 4 },
        { kind: 'barrel', weight: 3 },
        { kind: 'pipe', weight: 3 },
        { kind: 'console', weight: 2 },
        { kind: 'girder', weight: 2 },
        { kind: 'vent', weight: 2 },
      ]).kind;
      props.push({ x: spot.x, y: spot.y, kind, angle: rng.angle(), roomId: room.id, destructible: kind === 'crate' });
    }
  }
  for (const objective of objectives) {
    if (objective.type !== OBJECTIVE_TYPES.DESTROY) continue;
    for (const marker of objective.markers) {
      props.push({
        x: marker.x,
        y: marker.y,
        kind: 'reactor',
        angle: 0,
        roomId: marker.roomId,
        destructible: true,
        objectiveId: objective.id,
        health: 120,
      });
    }
  }
  return props;
}

function buildLights({ zoneRooms, map, spawnPoint, extractionPosition }) {
  const lights = [];
  for (const room of zoneRooms) {
    const radius = clamp(Math.max(room.rect.w, room.rect.h) * 0.72, 220, 620);
    const color =
      room.type === 'exit' ? '#6fe3c4' : room.type === 'objective' ? '#ffd166' : room.type === 'vault' ? '#c084fc' : '#7fe6ff';
    lights.push({ x: room.center.x, y: room.center.y, radius, color, intensity: 0.5, pulse: 0.0 });
  }
  lights.push({ x: spawnPoint.x, y: spawnPoint.y, radius: 200, color: '#7fe6ff', intensity: 0.35, pulse: 0 });
  lights.push({ x: extractionPosition.x, y: extractionPosition.y, radius: 260, color: '#6fe3c4', intensity: 0.45, pulse: 1.2 });
  return lights;
}

function buildDecor({ rng, map, zoneRooms }) {
  const decor = [];
  const total = clamp(Math.round(map.floorCount * 0.012), 24, 260);
  for (let i = 0; i < total; i += 1) {
    const room = rng.pick(zoneRooms);
    const spot = map.randomFloorInRect(room.rect, rng, 8);
    if (!spot) continue;
    decor.push({
      x: spot.x,
      y: spot.y,
      kind: rng.weighted([
        { kind: 'grate', weight: 4 },
        { kind: 'stain', weight: 4 },
        { kind: 'cable', weight: 3 },
        { kind: 'marking', weight: 2 },
        { kind: 'rubble', weight: 3 },
      ]).kind,
      angle: rng.angle(),
      scale: rng.float(0.7, 1.5),
      seed: rng.int(0, 9999),
    });
  }
  return decor;
}

/** Finds a standable world point close to `center` inside the room. */
function pickFloorNear(map, center, rng, radiusTiles) {
  const base = map.worldToTile(center.x, center.y);
  for (let r = 0; r <= radiusTiles; r += 1) {
    const candidates = [];
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = base.tx + dx;
        const ty = base.ty + dy;
        if (!map.isFloor(tx, ty)) continue;
        const world = map.tileToWorld(tx, ty);
        if (map.circleCollides(world.x, world.y, 18)) continue;
        candidates.push(world);
      }
    }
    if (candidates.length > 0) return rng.pick(candidates);
  }
  return null;
}

/** Samples up to `count` well-spaced standable points inside a room. */
function sampleRoomSpots(map, room, rng, count, clearance) {
  const spots = [];
  if (count <= 0) return spots;
  const tries = count * 14;
  for (let i = 0; i < tries && spots.length < count; i += 1) {
    const spot = map.randomFloorInRect(room.rect, rng, 6);
    if (!spot) continue;
    if (map.circleCollides(spot.x, spot.y, clearance)) continue;
    if (spots.some((s) => dist2(s.x, s.y, spot.x, spot.y) < 90 * 90)) continue;
    spots.push(spot);
  }
  // Relax spacing if we could not fill the request.
  for (let i = 0; i < tries && spots.length < count; i += 1) {
    const spot = map.randomFloorInRect(room.rect, rng, 4);
    if (!spot) continue;
    if (spots.some((s) => dist2(s.x, s.y, spot.x, spot.y) < 40 * 40)) continue;
    spots.push(spot);
  }
  return spots;
}

/**
 * Post-generation validation. This is a hard gate: `generateZone` refuses to
 * return an invalid zone and regenerates deterministically instead.
 */
export function validateZone(zone) {
  const issues = [];
  const { map } = zone;

  if (!map || !(map instanceof TileMap)) issues.push('missing tile map');

  const startFlood = map.floodFillFromWorld(zone.spawnPoint.x, zone.spawnPoint.y);
  if (startFlood.count < 200) issues.push(`walkable area too small from spawn (${startFlood.count} tiles)`);

  const reachable = startFlood.tiles;

  const checkPoint = (label, point, clearance = 16) => {
    if (!point) {
      issues.push(`${label} is missing`);
      return false;
    }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      issues.push(`${label} has non-finite coordinates`);
      return false;
    }
    const t = map.worldToTile(point.x, point.y);
    if (!map.isFloor(t.tx, t.ty)) {
      issues.push(`${label} sits inside solid rock at tile ${t.tx},${t.ty}`);
      return false;
    }
    if (!reachable.has(map.index(t.tx, t.ty))) {
      issues.push(`${label} is not reachable from the spawn point`);
      return false;
    }
    if (map.circleCollides(point.x, point.y, clearance)) {
      issues.push(`${label} is blocked for a circle of radius ${clearance}`);
      return false;
    }
    return true;
  };

  checkPoint('spawn point', zone.spawnPoint, 14);
  checkPoint('extraction point', zone.extraction, zone.extraction.radius * 0.35);
  if (zone.descend) checkPoint('descent point', zone.descend, zone.descend.radius * 0.3);

  if (!zone.objectives || zone.objectives.length === 0) {
    issues.push('zone has no objectives');
  } else {
    const ids = new Set();
    for (const objective of zone.objectives) {
      if (ids.has(objective.id)) issues.push(`duplicate objective id ${objective.id}`);
      ids.add(objective.id);
      if (!Number.isFinite(objective.target) || objective.target <= 0) {
        issues.push(`objective ${objective.id} has invalid target`);
      }
      checkPoint(`objective ${objective.id}`, objective.position, 20);
      for (const marker of objective.markers ?? []) {
        checkPoint(`objective marker for ${objective.id}`, marker, 18);
      }
    }
  }

  // Enemy spawns must not be embedded in geometry and must be reachable.
  let unreachableSpawns = 0;
  let embeddedSpawns = 0;
  const spawnPoints = new Set();
  for (const spawn of zone.enemySpawns ?? []) {
    const t = map.worldToTile(spawn.x, spawn.y);
    if (!map.isFloor(t.tx, t.ty)) {
      embeddedSpawns += 1;
      continue;
    }
    if (!reachable.has(map.index(t.tx, t.ty))) unreachableSpawns += 1;
    spawnPoints.add(`${t.tx},${t.ty}`);
  }
  if (embeddedSpawns > 0) issues.push(`${embeddedSpawns} enemy spawns are embedded in solid rock`);
  if (unreachableSpawns > 0) issues.push(`${unreachableSpawns} enemy spawns are unreachable from the spawn point`);

  // Spawn room must be free of hostiles at run start.
  const spawnRoom = zone.rooms.find((r) => r.type === 'spawn');
  if (spawnRoom) {
    const nearby = (zone.enemySpawns ?? []).filter(
      (s) => dist2(s.x, s.y, zone.spawnPoint.x, zone.spawnPoint.y) < 260 * 260,
    );
    if (nearby.length > 3) issues.push(`too many enemies (${nearby.length}) inside the spawn safe zone`);
  } else {
    issues.push('zone has no spawn room');
  }

  // Every room must be reachable from the spawn room.
  for (const room of zone.rooms) {
    const t = map.worldToTile(room.center.x, room.center.y);
    let found = false;
    for (let r = 0; r <= 8 && !found; r += 1) {
      for (let dy = -r; dy <= r && !found; dy += 1) {
        for (let dx = -r; dx <= r && !found; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = t.tx + dx;
          const ty = t.ty + dy;
          if (map.isFloor(tx, ty) && reachable.has(map.index(tx, ty))) found = true;
        }
      }
    }
    if (!found) issues.push(`room ${room.id} (${room.type}) is not reachable from spawn`);
  }

  // Loot must not be inside rock.
  let badLoot = 0;
  for (const loot of zone.lootSpawns ?? []) {
    const t = map.worldToTile(loot.x, loot.y);
    if (!map.isFloor(t.tx, t.ty)) badLoot += 1;
  }
  if (badLoot > 0) issues.push(`${badLoot} loot spawns are embedded in solid rock`);

  const objectiveRoom = zone.rooms.find((r) => r.type === 'objective');
  const exitRoom = zone.rooms.find((r) => r.type === 'exit');
  if (!objectiveRoom) issues.push('zone has no objective room');
  if (!exitRoom) issues.push('zone has no extraction room');

  return { ok: issues.length === 0, issues, floodCount: startFlood.count };
}

/** Convenience for tests and the pause menu seed readout. */
export function zoneFingerprint(zone) {
  let hash = 2166136261;
  const data = zone.map.tiles;
  for (let i = 0; i < data.length; i += 1) {
    hash ^= data[i];
    hash = Math.imul(hash, 16777619);
  }
  hash ^= zone.extraction ? Math.round(zone.extraction.x) : 0;
  hash = Math.imul(hash, 16777619);
  hash ^= zone.extraction ? Math.round(zone.extraction.y) : 0;
  hash = Math.imul(hash, 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
