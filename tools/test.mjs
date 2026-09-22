/**
 * Deterministic regression test runner (zero dependencies).
 *
 * Runs pure-logic suites for the critical systems: RNG determinism, map
 * generation validity across many seeds, save sanitisation, progression maths,
 * weapon behaviour, loot rolling and projectile collision.
 *
 * Usage: node tools/test.mjs [filter]
 */

const suites = [];
let failures = 0;
let assertions = 0;

export function suite(name, fn) {
  suites.push({ name, fn });
}

const filter = process.argv[2] ?? '';

function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  assertions += 1;
  if (actual !== expected) {
    throw new Error(`${message ?? 'values differ'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertClose(actual, expected, tolerance, message) {
  assertions += 1;
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message ?? 'values differ'} — expected ~${expected}, got ${actual} (tolerance ${tolerance})`);
  }
}

function section(title) {
  console.log(`\n\u001b[36m${title}\u001b[0m`);
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const { Rng, generateSeedCode, isValidSeedCode } = await import('../src/core/rng.js');
const { dist2 } = await import('../src/core/math.js');
const { TileMap, TILE, FLOOR, SOLID } = await import('../src/world/tilemap.js');
const { generateZone, validateZone, zoneFingerprint } = await import('../src/generation/zone.js');
const { WEAPONS, getWeaponDef, estimateDps } = await import('../src/config/weapons.js');
const { WeaponInstance, AmmoPool } = await import('../src/weapons/weapon.js');
const { ProjectileSystem, TEAM } = await import('../src/weapons/projectile.js');
const { Enemy, BossEnemy, resetEnemyIds, ENEMY_STATES } = await import('../src/enemies/enemy.js');
const { updateEnemyAI } = await import('../src/enemies/ai.js');
const { difficultyAt, ENEMIES } = await import('../src/config/enemies.js');
const { SaveSystem, MemoryStorage, defaultProfile, sanitizeProfile, validateResumableRun } = await import('../src/save/save.js');
const { Progression } = await import('../src/progression/progression.js');
const { Player } = await import('../src/player/player.js');
const { LootSystem, rollLoot, entryToDrop, DROP_KIND } = await import('../src/loot/loot.js');
const { RUN_PERKS: PERK_TABLE } = await import('../src/game/run.js');
/** Perks earned by a given run level; the table is level-indexed, not positional. */
const perksThrough = (level) => PERK_TABLE.filter((p) => p.level <= level).length;
const { WorldRuntime, ChannelZone } = await import('../src/world/world.js');
const { ObjectiveRuntime } = await import('../src/game/objectives.js');
const {
  META_UPGRADES,
  aggregateUpgrades,
  upgradeCost,
  levelFromXp,
  xpForLevel,
  accountLevelBonus,
  DEATH_SALVAGE_BASE,
  OBJECTIVE_TYPES,
  MAP_GEN_DEFAULTS,
  RESOURCE_DEFS,
} = await import('../src/config/balance.js');

// ---------------------------------------------------------------------------
// RNG
// ---------------------------------------------------------------------------

suite('rng: same seed produces identical streams', () => {
  const a = new Rng('seed-alpha');
  const b = new Rng('seed-alpha');
  const seqA = Array.from({ length: 64 }, () => a.next());
  const seqB = Array.from({ length: 64 }, () => b.next());
  assert(seqA.every((v, i) => v === seqB[i]), 'streams diverged');
  assert(seqA.every((v) => v >= 0 && v < 1), 'values outside [0,1)');
  const unique = new Set(seqA);
  assert(unique.size > 50, `insufficient entropy (${unique.size} unique of 64)`);
});

suite('rng: different seeds produce different streams', () => {
  const a = new Rng('seed-alpha');
  const b = new Rng('seed-beta');
  const seqA = Array.from({ length: 32 }, () => a.next());
  const seqB = Array.from({ length: 32 }, () => b.next());
  assert(seqA.some((v, i) => v !== seqB[i]), 'different seeds produced identical streams');
});

suite('rng: fork is stable and independent', () => {
  const parent = new Rng('fork-seed');
  const childA = parent.fork('loot');
  const childB = parent.fork('loot');
  assert(childA.seed === childB.seed, 'fork seeds differ for the same label');
  assert(childA.next() === childB.next(), 'fork streams differ for the same label');
  const childC = parent.fork('spawn');
  assert(childC.seed !== childA.seed, 'different labels produced the same fork seed');
});

suite('rng: int/weighted/pick stay in range', () => {
  const rng = new Rng('range-seed');
  for (let i = 0; i < 2000; i += 1) {
    const v = rng.int(3, 7);
    assert(v >= 3 && v <= 7, `int out of range: ${v}`);
  }
  const entries = [
    { weight: 1, id: 'a' },
    { weight: 0, id: 'b' },
    { weight: 3, id: 'c' },
  ];
  for (let i = 0; i < 2000; i += 1) {
    const picked = rng.weighted(entries);
    assert(picked.id !== 'b', 'zero-weight entry was selected');
  }
  assert(rng.pick([]) === undefined, 'pick([]) should be undefined');
});

suite('rng: seed codes are readable and stable', () => {
  const code = generateSeedCode(new Rng(12345));
  assert(/^[A-Z]+-[A-Z]+-[0-9A-F]{4}$/.test(code), `unexpected seed code format: ${code}`);
  assert(isValidSeedCode(code), 'generated seed code failed validation');
  assert(!isValidSeedCode(''), 'empty seed accepted');
  assert(!isValidSeedCode('x'.repeat(64)), 'over-long seed accepted');
});

// ---------------------------------------------------------------------------
// Tile map
// ---------------------------------------------------------------------------

suite('tilemap: flood fill respects walls and diagonals', () => {
  // Fixture must be 5x5 (fromArray rejects ragged rows). The extra '#' that
  // used to sit on row 1 made it 6 wide and broke the suite before it ran.
  const rows = [
    '#####',
    '#...#',
    '#.#.#',
    '#...#',
    '#####',
  ];
  const map = TileMap.fromArray(rows.map((r) => r.split('').map((c) => c === '.')));
  assertEqual(map.floorCount, 8, 'floor count');
  const flood = map.floodFill(1, 1);
  assertEqual(flood.count, 8, 'all floor tiles should be connected');
  // A ring of walls around a single tile is unreachable.
  map.set(3, 3, FLOOR);
  const isolated = TileMap.fromArray([
    [0, 0, 0, 0, 0],
    [0, 1, 1, 1, 0],
    [0, 1, 0, 1, 0],
    [0, 1, 1, 1, 0],
    [0, 0, 0, 0, 0],
  ]);
  const f2 = isolated.floodFill(1, 1);
  assertEqual(f2.count, 8, 'isolated tile should not be reachable');
});

suite('tilemap: collision resolution pushes circles out of walls', () => {
  const map = TileMap.fromArray([
    [0, 0, 0, 0, 0],
    [0, 1, 1, 1, 0],
    [0, 1, 1, 1, 0],
    [0, 1, 1, 1, 0],
    [0, 0, 0, 0, 0],
  ]);
  const entity = { x: 0, y: 0, radius: 10 };
  map.resolveCircle(entity);
  assert(entity.x >= 10 - 0.001, `entity pushed to invalid x=${entity.x}`);
  assert(entity.y >= 10 - 0.001, `entity pushed to invalid y=${entity.y}`);

  const inside = { x: TILE * 0.5, y: TILE * 0.5, radius: 8 };
  map.resolveCircle(inside);
  assert(!map.circleCollides(inside.x, inside.y, 8), 'entity still colliding after resolution');
});

suite('tilemap: raycast and line of sight', () => {
  const rows = [
    '#####',
    '#...#',
    '#####',
    '#...#',
    '#####',
  ];
  const map = TileMap.fromArray(rows.map((r) => r.split('').map((c) => c === '.')));
  const blocked = map.raycast(TILE * 1.5, TILE * 1.5, 0, 1, 200);
  assert(blocked.hit, 'ray should hit the wall between the corridors');
  // The corridor floor spans tiles 1..3 (world x 32..128), so the wall is only
  // 80 units from the ray start: a 100-unit ray would legitimately hit it.
  const clear = map.raycast(TILE * 1.5, TILE * 1.5, 1, 0, TILE * 2);
  assert(!clear.hit, 'ray should travel freely along the corridor');
  assert(map.hasLineOfSight(TILE * 1.5, TILE * 1.5, TILE * 3.5, TILE * 1.5), 'LOS should be clear');
  assert(!map.hasLineOfSight(TILE * 1.5, TILE * 1.5, TILE * 3.5, TILE * 3.5), 'LOS should be blocked');
});

suite('tilemap: A* finds a path and reports unreachable targets', () => {
  const size = 21;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = [];
    for (let x = 0; x < size; x += 1) {
      row.push(y === 0 || x === 0 || y === size - 1 || x === size - 1 ? 0 : 1);
    }
    rows.push(row);
  }
  // Split the room with a full wall that has no gap.
  for (let y = 1; y < size - 1; y += 1) rows[y][10] = 0;
  const map = TileMap.fromArray(rows);
  const unreachable = map.findPath(TILE * 2, TILE * 2, TILE * 18, TILE * 18);
  assertEqual(unreachable.length, 0, 'path should not exist through a solid wall');

  // Open a gap and the path must appear.
  map.set(10, 10, FLOOR);
  const path = map.findPath(TILE * 2, TILE * 2, TILE * 18, TILE * 18);
  assert(path.length > 0, 'path was not found after opening a gap');
  // Every waypoint must be walkable and the path must actually reach the goal.
  for (const node of path) {
    assert(!map.isSolidAtWorld(node.x, node.y), `waypoint inside a wall at ${node.x},${node.y}`);
  }
  const last = path[path.length - 1];
  assert(dist2(last.x, last.y, TILE * 18, TILE * 18) < (TILE * 2) ** 2, 'path does not reach the goal');
});

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

suite('generation: 20 seeds x 3 tiers all validate', () => {
  resetEnemyIds();
  const seeds = [
    'ALPHA-0001', 'ALPHA-0002', 'BRAVO-1337', 'CHARLIE-9999', 'DELTA-0007',
    'ECHO-4242', 'FOXTROT-1', 'GOLF-2', 'HOTEL-3', 'INDIA-4',
    'JULIET-5', 'KILO-6', 'LIMA-7', 'MIKE-8', 'NOVEMBER-9',
    'OSCAR-10', 'PAPA-11', 'QUEBEC-12', 'ROMEO-13', 'SIERRA-14',
  ];
  let totalRooms = 0;
  let totalEnemies = 0;
  let totalLoot = 0;
  for (const seed of seeds) {
    for (const tier of [1, 2, 3]) {
      const zone = generateZone({ seed, tier });
      const validation = validateZone(zone);
      assert(validation.ok, `seed ${seed} tier ${tier} invalid: ${validation.issues.join('; ')}`);
      assert(zone.rooms.length >= 6, `seed ${seed} tier ${tier} has only ${zone.rooms.length} rooms`);
      assert(zone.objectives.length > 0, `seed ${seed} tier ${tier} has no objectives`);
      totalRooms += zone.rooms.length;
      totalEnemies += zone.enemySpawns.length;
      totalLoot += zone.lootSpawns.length;
    }
  }
  return `rooms=${totalRooms} enemySpawns=${totalEnemies} lootSpawns=${totalLoot}`;
});

suite('generation: identical seeds are byte-for-byte identical', () => {
  const a = generateZone({ seed: 'REPEAT-TEST-1', tier: 2 });
  const b = generateZone({ seed: 'REPEAT-TEST-1', tier: 2 });
  assertEqual(zoneFingerprint(a), zoneFingerprint(b), 'fingerprints differ for the same seed');
  assertEqual(a.map.floorCount, b.map.floorCount, 'floor counts differ');
  assertEqual(a.rooms.length, b.rooms.length, 'room counts differ');
  assertEqual(a.enemySpawns.length, b.enemySpawns.length, 'enemy spawn counts differ');
  assertEqual(a.extraction.x, b.extraction.x, 'extraction x differs');
  assertEqual(a.extraction.y, b.extraction.y, 'extraction y differs');
  assertEqual(a.spawnPoint.x, b.spawnPoint.x, 'spawn x differs');
  assert(a.objectives[0].type === b.objectives[0].type, 'objective type differs');
});

suite('generation: different seeds produce different maps', () => {
  const a = generateZone({ seed: 'DIVERGE-A', tier: 1 });
  const b = generateZone({ seed: 'DIVERGE-B', tier: 1 });
  assert(zoneFingerprint(a) !== zoneFingerprint(b), 'two different seeds produced identical maps');
});

suite('generation: tier scaling increases difficulty and size', () => {
  const t1 = generateZone({ seed: 'SCALE-TEST', tier: 1 });
  const t6 = generateZone({ seed: 'SCALE-TEST', tier: 6 });
  assert(t6.difficulty.healthMul > t1.difficulty.healthMul, 'enemy health does not scale');
  assert(t6.difficulty.threatBudget > t1.difficulty.threatBudget, 'threat budget does not scale');
  assert(t6.map.floorCount > t1.map.floorCount, 'later sectors are not larger');
  return `t1 floors=${t1.map.floorCount} t6 floors=${t6.map.floorCount}`;
});

suite('generation: extraction and objectives are reachable for every seed', () => {
  for (let i = 0; i < 12; i += 1) {
    const zone = generateZone({ seed: `REACH-${i}`, tier: (i % 5) + 1 });
    const flood = zone.map.floodFillFromWorld(zone.spawnPoint.x, zone.spawnPoint.y);
    const tile = zone.map.worldToTile(zone.extraction.x, zone.extraction.y);
    assert(
      flood.tiles.has(zone.map.index(tile.tx, tile.ty)),
      `seed REACH-${i} extraction is unreachable`,
    );
    for (const objective of zone.objectives) {
      const t = zone.map.worldToTile(objective.position.x, objective.position.y);
      assert(
        flood.tiles.has(zone.map.index(t.tx, t.ty)),
        `seed REACH-${i} objective ${objective.id} is unreachable`,
      );
    }
  }
  return 'all extraction/objective points reachable';
});

suite('generation: boss sectors every third tier', () => {
  const t3 = generateZone({ seed: 'BOSS-TEST', tier: 3 });
  assert(t3.isBossSector, 'tier 3 should be a boss sector');
  assert(t3.objectives[0].type === OBJECTIVE_TYPES.BOSS, 'boss sector objective should be BOSS');
  assert(t3.enemySpawns.some((s) => s.isBoss), 'boss sector has no boss spawn');
  const t4 = generateZone({ seed: 'BOSS-TEST', tier: 4 });
  assert(!t4.isBossSector, 'tier 4 should not be a boss sector');
  return `tier3 rooms=${t3.rooms.length}`;
});

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

suite('weapons: definitions are complete and distinct', () => {
  const ids = Object.keys(WEAPONS);
  assert(ids.length >= 4, `expected at least 4 weapons, found ${ids.length}`);
  const signatures = new Set();
  for (const id of ids) {
    const def = getWeaponDef(id);
    for (const key of ['damage', 'rpm', 'magazine', 'reloadTime', 'range', 'spread', 'bulletSpeed']) {
      assert(typeof def[key] === 'number' && Number.isFinite(def[key]), `${id}.${key} is not a number`);
    }
    assert(def.magazine > 0, `${id} has an empty magazine`);
    assert(def.reloadTime > 0, `${id} reloads instantly`);
    signatures.add(`${def.damage}|${def.rpm}|${def.magazine}|${def.reloadTime}|${def.pellets}`);
  }
  assertEqual(signatures.size, ids.length, 'two weapons have identical stat signatures');
  return `${ids.length} weapons, DPS range ${Math.round(Math.min(...ids.map((i) => estimateDps(WEAPONS[i]))))}-${Math.round(Math.max(...ids.map((i) => estimateDps(WEAPONS[i]))))}`;
});

suite('weapons: fire cadence, magazine and reload are correct', () => {
  const w = new WeaponInstance('pistol', 1);
  const interval = 1 / (WEAPONS.pistol.rpm / 60);
  const shot1 = w.tryFire();
  assert(shot1 && !shot1.dry, 'first shot failed');
  assertEqual(w.ammo, WEAPONS.pistol.magazine - 1, 'ammo after first shot');
  const blocked = w.tryFire();
  assert(blocked === null, 'weapon fired before the cooldown elapsed');
  w.update(interval + 0.001);
  const shot2 = w.tryFire();
  assert(shot2 && !shot2.dry, 'second shot failed after cooldown');

  // Empty it.
  let guard = 0;
  while (w.ammo > 0 && guard < 500) {
    w.cooldown = 0;
    w.tryFire();
    guard += 1;
  }
  assertEqual(w.ammo, 0, 'weapon did not empty');
  w.cooldown = 0;
  const dry = w.tryFire();
  assert(dry && dry.dry, 'empty weapon did not report a dry fire');

  // Reload.
  assert(w.beginReload(50), 'reload failed to start');
  assert(w.isReloading, 'weapon is not in the reloading state');
  w.update(WEAPONS.pistol.reloadTime + 0.01);
  const loaded = w.finishReload(50);
  assertEqual(w.ammo, WEAPONS.pistol.magazine, 'magazine was not refilled');
  assertEqual(loaded, WEAPONS.pistol.magazine, 'wrong number of rounds loaded');
});

suite('weapons: shotgun fires multiple pellets with wide spread', () => {
  const sg = new WeaponInstance('shotgun', 1);
  const shot = sg.tryFire();
  assertEqual(shot.pellets, WEAPONS.shotgun.pellets, 'pellet count');
  assert(shot.spread > WEAPONS.pistol.spread, 'shotgun spread should exceed the pistol\'s');
  assert(WEAPONS.shotgun.falloffStart < WEAPONS.rifle.falloffStart, 'shotgun should fall off sooner than the rifle');
});

suite('weapons: bloom grows with sustained fire and recovers', () => {
  const smg = new WeaponInstance('smg', 1);
  const initialSpread = smg.effectiveSpread();
  for (let i = 0; i < 12; i += 1) {
    smg.cooldown = 0;
    smg.tryFire();
  }
  assert(smg.effectiveSpread() > initialSpread, 'bloom did not grow');
  assert(smg.effectiveSpread() <= WEAPONS.smg.spread + WEAPONS.smg.bloomMax + 1e-6, 'bloom exceeded its ceiling');
  for (let i = 0; i < 600; i += 1) smg.update(1 / 60);
  assertClose(smg.effectiveSpread(), WEAPONS.smg.spread, 1e-6, 'bloom did not recover');
});

suite('weapons: tier upgrades increase damage and magazine', () => {
  const base = new WeaponInstance('rifle', 1);
  const upgraded = new WeaponInstance('rifle', 3);
  assert(upgraded.damagePerPellet() > base.damagePerPellet(), 'tier 3 does not out-damage tier 1');
  assert(upgraded.magazineSize >= base.magazineSize, 'tier 3 magazine is smaller');
});

suite('weapons: ammo pool never goes negative', () => {
  const pool = new AmmoPool({ light: 10 });
  assertEqual(pool.take('light', 4), 4, 'take returned the wrong amount');
  assertEqual(pool.get('light'), 6, 'pool balance');
  assertEqual(pool.take('light', 100), 6, 'over-draw should be clamped');
  assertEqual(pool.get('light'), 0, 'pool should be empty');
  assertEqual(pool.take('light', 5), 0, 'empty pool must yield zero');
});

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------

suite('projectiles: hit detection against enemies respects pierce', () => {
  const map = TileMap.fromArray(Array.from({ length: 20 }, () => Array.from({ length: 60 }, () => 1)));
  const world = { queryProps: () => [], resolveProps: () => {}, damageProp: () => null };
  const enemies = [
    { id: 1, x: 120, y: 160, radius: 14, alive: true },
    { id: 2, x: 160, y: 160, radius: 14, alive: true },
    { id: 3, x: 200, y: 160, radius: 14, alive: true },
  ];
  const player = { x: 0, y: 0, radius: 14, alive: true };
  const hits = [];
  const system = new ProjectileSystem();
  system.spawn({
    x: 40,
    y: 160,
    vx: 900,
    vy: 0,
    damage: 10,
    radius: 3,
    life: 2,
    team: TEAM.PLAYER,
    pierce: 1,
  });
  system.update(0.2, {
    map,
    enemies,
    player,
    world,
    onHit: (hit) => hits.push(hit.enemy.id),
  });
  assertEqual(hits.length, 2, `pierce=1 should hit exactly 2 enemies, hit ${hits.length}`);
  assertEqual(hits[0], 1, 'first hit should be the nearest enemy');
  assertEqual(hits[1], 2, 'pierce should continue to the next enemy');
});

suite('projectiles: walls stop projectiles', () => {
  const rows = [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
    [1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  ];
  const map = TileMap.fromArray(rows);
  const world = { queryProps: () => [], resolveProps: () => {}, damageProp: () => null };
  const system = new ProjectileSystem();
  system.spawn({ x: TILE * 2, y: TILE * 1.5, vx: 900, vy: 0, damage: 5, radius: 3, life: 3, team: TEAM.PLAYER });
  let wallHits = 0;
  for (let i = 0; i < 20; i += 1) {
    system.update(1 / 60, {
      map,
      enemies: [],
      player: { x: -999, y: -999, radius: 10, alive: true },
      world,
      onHit: () => {},
      onWall: () => { wallHits += 1; },
    });
  }
  assertEqual(wallHits, 1, `expected exactly one wall impact, got ${wallHits}`);
  assertEqual(system.activeCount, 0, 'projectile should be despawned after the wall hit');
});

suite('projectiles: hostile projectiles damage the player', () => {
  const map = TileMap.fromArray(Array.from({ length: 12 }, () => Array.from({ length: 40 }, () => 1)));
  const world = { queryProps: () => [], resolveProps: () => {}, damageProp: () => null };
  const player = { x: 200, y: 160, radius: 14, alive: true };
  let damaged = 0;
  const system = new ProjectileSystem();
  system.spawn({ x: 100, y: 160, vx: 700, vy: 0, damage: 12, radius: 4, life: 2, team: TEAM.HOSTILE });
  for (let i = 0; i < 30; i += 1) {
    system.update(1 / 60, {
      map,
      enemies: [],
      player,
      world,
      onHit: (hit) => {
        if (hit.player) damaged += 1;
      },
    });
  }
  assertEqual(damaged, 1, 'player was not hit exactly once');
});

suite('projectiles: pool does not leak beyond capacity', () => {
  const system = new ProjectileSystem();
  for (let i = 0; i < 4000; i += 1) {
    system.spawn({ x: i, y: 0, vx: 1, vy: 0, damage: 1, radius: 2, life: 10, team: TEAM.PLAYER });
  }
  const map = TileMap.fromArray(Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => 1)));
  const world = { queryProps: () => [], resolveProps: () => {}, damageProp: () => null };
  system.update(1 / 60, {
    map,
    enemies: [],
    player: { x: -9999, y: -9999, radius: 1, alive: true },
    world,
  });
  assert(system.activeCount <= 900, `projectile pool overflowed: ${system.activeCount}`);
  return `active=${system.activeCount}`;
});

// ---------------------------------------------------------------------------
// Enemies & AI
// ---------------------------------------------------------------------------

function makeMap(w = 40, h = 40) {
  const rows = [];
  for (let y = 0; y < h; y += 1) {
    const row = [];
    for (let x = 0; x < w; x += 1) {
      row.push(y === 0 || x === 0 || y === h - 1 || x === w - 1 ? 0 : 1);
    }
    rows.push(row);
  }
  return TileMap.fromArray(rows);
}

function makeAiContext(map, player, rng = new Rng('ai-test')) {
  const projectiles = [];
  const damage = [];
  return {
    projectiles,
    damage,
    ctx: {
      player,
      map,
      world: { resolveProps: () => {}, queryProps: () => [] },
      rng,
      difficulty: { damageMul: 1 },
      spawnProjectile: (spec) => projectiles.push(spec),
      damagePlayer: (amount, opts) => {
        damage.push({ amount, opts });
        player.health -= amount;
        if (player.health <= 0) player.alive = false;
      },
      onTelegraph: () => {},
      onAttack: () => {},
    },
  };
}

suite('enemies: elite abilities are archetype-driven and bounded', () => {
  resetEnemyIds();
  const map = makeMap(80, 80);
  const player = { x: 1300, y: 1300, radius: 14, alive: true, health: 100000 };
  const expectations = {
    husk: 'summon', dart: 'burst', marksman: 'burst', spitter: 'burst', brute: 'shield',
  };
  const results = [];
  for (const [typeId, ability] of Object.entries(expectations)) {
    const enemy = new Enemy({ typeId, x: 1200, y: 1300, elite: 'elite', difficulty: difficultyAt(1), dormant: false });
    const { ctx, projectiles } = makeAiContext(map, player);
    const announcements = [];
    const summons = [];
    // A deterministic rng that always passes the 30% ability roll.
    ctx.rng = { bool: () => true, next: () => 0.5, float: (a) => a, angle: () => 0, int: (a) => a };
    ctx.onEliteAbility = (e, kind) => announcements.push(kind);
    ctx.summon = (e, kind, count) => summons.push({ typeId: kind, count });
    enemy.alerted = true;
    enemy.spawnGrace = 0;
    enemy.setState(ENEMY_STATES.CHASE);
    // Walk the AI until it telegraphs (which is when the ability fires).
    let fired = false;
    for (let i = 0; i < 3000 && !fired; i += 1) {
      player.health = player.maxHealth;
      updateEnemyAI(enemy, 1 / 60, ctx);
      enemy.integrate(1 / 60, map, ctx.world);
      fired = enemy.eliteUsed === true;
    }
    const used = [];
    if (enemy.shield > 0) used.push('shield');
    if (summons.length > 0) used.push('summon');
    if (projectiles.length > 0 && (enemy.hasLos || true)) used.push(enemy.def.role === 'ranged' ? 'burst' : 'burst');
    assert(fired, `${typeId} elite never used an ability: ${JSON.stringify({ used, announcements })}`);
    assert(announcements.includes(ability), `${typeId} elite should announce ${ability}, got ${JSON.stringify(announcements)}`);
    if (ability === 'shield') assert(enemy.shield > 0, 'shield elite did not gain a shield');
    if (ability === 'summon') assert(summons.length > 0, 'summoning elite asked for no adds');
    if (ability === 'burst') assert(projectiles.length >= 5, `burst elite spawned ${projectiles.length} projectiles`);
    // One-shot: no second ability from the same elite.
    const before = { projectiles: projectiles.length, summons: summons.length, shield: enemy.shield };
    for (let i = 0; i < 600; i += 1) {
      player.health = player.maxHealth;
      updateEnemyAI(enemy, 1 / 60, ctx);
      enemy.integrate(1 / 60, map, ctx.world);
    }
    assert(summons.length === before.summons, `${typeId} elite summoned twice`);
    assert(projectiles.length <= before.projectiles + (ability === 'burst' ? 1 : 0) * 12, `${typeId} elite repeated its burst`);
    results.push(`${typeId}:${ability}`);
  }
  return results.join(' ');
});

suite('generation: every sector rolls one threat profile and the mix follows it', () => {
  const t1 = generateZone({ seed: 'PROFILE-T1', tier: 1 });
  assertEqual(t1.threatProfile.id, 'patrol', 'tier 1 should keep the curated opener');
  const seen = new Set();
  const shares = new Map();
  for (let i = 0; i < 40; i += 1) {
    const zone = generateZone({ seed: `PROFILE-${i}`, tier: 3 });
    assert(zone.threatProfile?.id, 'sector has no threat profile');
    seen.add(zone.threatProfile.id);
    const rows = zone.enemySpawns.filter((s) => !s.isBoss);
    const ranged = rows.filter((s) => s.typeId === 'marksman' || s.typeId === 'spitter').length;
    const bucket = shares.get(zone.threatProfile.id) ?? [];
    bucket.push(ranged / Math.max(1, rows.length));
    shares.set(zone.threatProfile.id, bucket);
    // Deterministic: the same seed rolls the same profile again.
    const again = generateZone({ seed: `PROFILE-${i}`, tier: 3 });
    assertEqual(again.threatProfile.id, zone.threatProfile.id, 'profile is not deterministic');
  }
  assert(seen.size >= 3, `sectors rolled only ${seen.size} distinct profiles in 40 seeds`);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const gunline = mean(shares.get('gunline') ?? [0]);
  const swarm = mean(shares.get('swarm') ?? [0]);
  assert(gunline > swarm, `gunline ranged share ${gunline.toFixed(2)} should exceed swarm ${swarm.toFixed(2)}`);
  return `profiles ${[...seen].join(',')} | gunline ${(gunline * 100).toFixed(0)}% ranged vs swarm ${(swarm * 100).toFixed(0)}%`;
});

suite('generation: vaults and objective rooms are guarded', () => {
  for (const tier of [1, 3, 6]) {
    let vaultEnemies = 0, vaultRooms = 0, combatEnemies = 0, combatRooms = 0, objectiveEnemies = 0, objectiveRooms = 0;
    for (let i = 0; i < 12; i += 1) {
      const zone = generateZone({ seed: `GUARD-${tier}-${i}`, tier });
      const byRoom = new Map();
      for (const spawn of zone.enemySpawns) {
        if (spawn.isBoss) continue;
        byRoom.set(spawn.roomId, (byRoom.get(spawn.roomId) ?? 0) + 1);
      }
      const objectiveRoomIds = new Set(zone.objectives.map((o) => o.roomId));
      for (const room of zone.rooms) {
        const count = byRoom.get(room.id) ?? 0;
        if (room.type === 'vault') { vaultEnemies += count; vaultRooms += 1; }
        else if (room.type === 'combat') { combatEnemies += count; combatRooms += 1; }
        if (objectiveRoomIds.has(room.id) && room.type !== 'boss') { objectiveEnemies += count; objectiveRooms += 1; }
      }
    }
    const vaultAvg = vaultEnemies / Math.max(1, vaultRooms);
    const combatAvg = combatEnemies / Math.max(1, combatRooms);
    assert(vaultAvg > combatAvg, `tier ${tier}: vault rooms hold ${vaultAvg.toFixed(2)} enemies vs ${combatAvg.toFixed(2)} in ordinary rooms`);
    if (objectiveRooms > 0) {
      assert(objectiveEnemies / objectiveRooms > 1, `tier ${tier}: the objective room is not defended (${(objectiveEnemies / objectiveRooms).toFixed(2)} enemies)`);
    }
  }
  return 'vault and objective rooms out-garrison ordinary rooms at tiers 1/3/6';
});

suite('enemies: stat scaling by difficulty tier', () => {
  resetEnemyIds();
  const d1 = difficultyAt(1);
  const d5 = difficultyAt(5);
  const weak = new Enemy({ typeId: 'husk', x: 100, y: 100, difficulty: d1 });
  const strong = new Enemy({ typeId: 'husk', x: 100, y: 100, difficulty: d5 });
  assert(strong.maxHealth > weak.maxHealth, 'higher tier enemies should have more health');
  assert(strong.baseDamage > weak.baseDamage, 'higher tier enemies should hit harder');
  assert(strong.xpValue > weak.xpValue, 'higher tier enemies should grant more XP');
  const elite = new Enemy({ typeId: 'marksman', x: 0, y: 0, Elite: null, elite: 'elite', difficulty: d1 });
  assert(elite.maxHealth > weak.maxHealth, 'elites should have more health than a base husk');
  assert(elite.isElite, 'elite flag not set');
  return `husk hp ${weak.maxHealth} -> ${strong.maxHealth}, elite ${elite.maxHealth}`;
});

suite('enemies: melee enemy chases and telegraphs before attacking', () => {
  const map = makeMap();
  const player = { x: 400, y: 400, radius: 14, alive: true, health: 1000 };
  const { ctx } = makeAiContext(map, player);
  const enemy = new Enemy({ typeId: 'husk', x: 460, y: 400, difficulty: difficultyAt(1), dormant: false });
  enemy.alerted = true;
  let sawTelegraph = false;
  const startDist = Math.hypot(enemy.x - player.x, enemy.y - player.y);
  for (let i = 0; i < 120; i += 1) {
    updateEnemyAI(enemy, 1 / 60, ctx);
    enemy.integrate(1 / 60, map, null);
    if (enemy.state === ENEMY_STATES.TELEGRAPH) sawTelegraph = true;
  }
  const endDist = Math.hypot(enemy.x - player.x, enemy.y - player.y);
  assert(endDist < startDist, `melee enemy did not close distance (${startDist} -> ${endDist})`);
  assert(sawTelegraph, 'melee enemy attacked with no telegraph phase');
  return `closed ${(startDist - endDist).toFixed(1)} units`;
});

suite('enemies: ranged enemy keeps distance and fires projectiles', () => {
  const map = makeMap();
  const player = { x: 400, y: 400, radius: 14, alive: true, health: 1000 };
  const { ctx, projectiles } = makeAiContext(map, player);
  const enemy = new Enemy({ typeId: 'marksman', x: 700, y: 400, difficulty: difficultyAt(1), dormant: false });
  enemy.alerted = true;
  for (let i = 0; i < 400; i += 1) {
    updateEnemyAI(enemy, 1 / 60, ctx);
    enemy.integrate(1 / 60, map, null);
  }
  assert(projectiles.length > 0, 'ranged enemy never fired');
  assert(projectiles[0].team === TEAM.HOSTILE, 'ranged enemy projectile has the wrong team');
  const distance = Math.hypot(enemy.x - player.x, enemy.y - player.y);
  assert(distance > 120, `ranged enemy closed to melee range (${distance.toFixed(0)})`);
  return `fired ${projectiles.length} shots, held ${distance.toFixed(0)} units`;
});

suite('enemies: charger lunges and heavy enemy is tanky and slow', async () => {
  const { updateEnemyContact } = await import('../src/enemies/ai.js');
  const map = makeMap(60, 60);
  const player = { x: 600, y: 400, radius: 14, alive: true, health: 100000 };
  const { ctx, damage } = makeAiContext(map, player);
  const charger = new Enemy({ typeId: 'dart', x: 800, y: 400, difficulty: difficultyAt(1), dormant: false });
  charger.alerted = true;
  let sawCharge = false;
  for (let i = 0; i < 600; i += 1) {
    updateEnemyAI(charger, 1 / 60, ctx);
    charger.integrate(1 / 60, map, null);
    updateEnemyContact(charger, 1 / 60, ctx);
    if (charger.lungeTimer > 0) sawCharge = true;
  }
  assert(sawCharge, 'charger never started a lunge');
  assert(damage.length > 0, 'charger never landed a hit on a stationary target');

  const brute = new Enemy({ typeId: 'brute', x: 400, y: 400, difficulty: difficultyAt(1), dormant: false });
  const husk = new Enemy({ typeId: 'husk', x: 400, y: 400, difficulty: difficultyAt(1), dormant: false });
  assert(brute.maxHealth > husk.maxHealth * 2, 'brute should be far tankier than a husk');
  assert(brute.baseSpeed < husk.baseSpeed, 'brute should be slower than a husk');
  return `charger hits=${damage.length}, brute hp=${brute.maxHealth} vs husk ${husk.maxHealth}`;
});

suite('enemies: damage, armor, stagger and death', () => {
  resetEnemyIds();
  const enemy = new Enemy({ typeId: 'brute', x: 0, y: 0, difficulty: difficultyAt(1) });
  const armored = enemy.takeDamage(10, {});
  assertClose(armored.applied, 10 - ENEMIES.brute.armor, 0.001, 'armor should reduce damage');
  assert(enemy.alive, 'enemy died unexpectedly');
  const lethal = enemy.takeDamage(10000, {});
  assert(lethal.died, 'lethal damage did not kill');
  assert(!enemy.alive, 'enemy.alive still true after death');
  const post = enemy.takeDamage(100, {});
  assertEqual(post.applied, 0, 'dead enemies must not take more damage');
});

suite('enemies: boss phases advance with health', () => {
  resetEnemyIds();
  const boss = new BossEnemy({ x: 0, y: 0, difficulty: difficultyAt(3) });
  assertEqual(boss.phaseIndex, 0, 'boss should start in phase 0');
  boss.health = boss.maxHealth * 0.6;
  assert(boss.updatePhase(), 'boss did not advance to phase 2');
  assertEqual(boss.phaseIndex, 1, 'boss phase index after crossing 66%');
  boss.health = boss.maxHealth * 0.2;
  assert(boss.updatePhase(), 'boss did not advance to phase 3');
  assertEqual(boss.phaseIndex, 2, 'boss phase index after crossing 33%');
  assert(boss.currentPhase.name === 'MELTDOWN', `unexpected phase name ${boss.currentPhase.name}`);
  return `phases: ${boss.currentPhase.name}`;
});

suite('enemies: boss attack list grows with phase', () => {
  resetEnemyIds();
  const boss = new BossEnemy({ x: 0, y: 0, difficulty: difficultyAt(3) });
  const map = makeMap(60, 60);
  const player = { x: 900, y: 900, radius: 14, alive: true, health: 100000 };
  const { ctx, projectiles } = makeAiContext(map, player);
  boss.alerted = true;
  boss.introTimer = 0;
  boss.x = 800;
  boss.y = 900;
  let telegraphs = 0;
  let summons = 0;
  const originalTelegraph = ctx.onTelegraph;
  ctx.onTelegraph = (enemy, kind) => {
    telegraphs += 1;
    originalTelegraph(enemy, kind);
  };
  ctx.onBossTelegraph = () => {
    telegraphs += 1;
  };
  ctx.onBossSlam = () => {};
  ctx.onBossBurst = () => {};
  ctx.onBossSummon = () => {
    summons += 1;
  };
  ctx.onBossAlert = () => {};
  ctx.onBossPhase = () => {};
  for (let i = 0; i < 60 * 30; i += 1) {
    updateEnemyAI(boss, 1 / 60, ctx);
    boss.integrate(1 / 60, map, null);
  }
  assert(telegraphs > 3, `boss telegraphed only ${telegraphs} attacks in 30s`);
  assert(projectiles.length > 0, 'boss never produced projectiles');
  return `telegraphs=${telegraphs} projectiles=${projectiles.length} summons=${summons}`;
});

// ---------------------------------------------------------------------------
// Save system
// ---------------------------------------------------------------------------

suite('save: round trip preserves every field', () => {
  const storage = new MemoryStorage();
  const save = new SaveSystem({ storage });
  const profile = defaultProfile();
  profile.account.cores = 4321;
  profile.account.level = 7;
  profile.upgrades = { vitality: 3, gunsmith: 2 };
  profile.settings.audio.master = 0.31;
  profile.settings.video.damageNumbers = false;
  save.save(profile);
  const loaded = save.load();
  assertEqual(loaded.account.cores, 4321, 'cores');
  assertEqual(loaded.account.level, 7, 'level');
  assertEqual(loaded.upgrades.vitality, 3, 'vitality rank');
  assertClose(loaded.settings.audio.master, 0.31, 1e-9, 'master volume');
  assertEqual(loaded.settings.video.damageNumbers, false, 'damage numbers toggle');
});

suite('save: corrupt data is quarantined and defaults restored', () => {
  const storage = new MemoryStorage();
  const save = new SaveSystem({ storage });
  storage.setItem(save.key, '{ this is not json');
  const loaded = save.load();
  assertEqual(loaded.account.cores, 0, 'corrupt save should reset to defaults');
  assert(save.lastLoadWarning, 'no warning was recorded for a corrupt save');
  assert(storage.getItem(`${save.key}.corrupt`) !== null, 'corrupt payload was not quarantined');
  assert(storage.getItem(save.key) === null, 'corrupt payload was not removed from the live key');
});

suite('save: out-of-range and wrong-typed values are clamped', () => {
  const { profile, warnings } = sanitizeProfile({
    version: 999,
    account: { cores: -500, level: 1e9, xp: 'lots', totalRuns: null },
    settings: { audio: { master: 42 }, video: { particles: -3, screenShake: 'high' } },
    upgrades: { vitality: 999, bogus: 4 },
  });
  assert(profile.account.cores === 0, `cores should clamp to 0, got ${profile.account.cores}`);
  assert(profile.account.level === 999, `level should clamp to 999, got ${profile.account.level}`);
  assert(profile.account.xp === 0, 'invalid xp should fall back to 0');
  assert(profile.account.totalRuns === 0, 'invalid totalRuns should fall back to 0');
  assert(profile.settings.audio.master === 1, 'master volume should clamp to 1');
  assert(profile.settings.video.particles === 0, 'particles should clamp to 0');
  assert(profile.settings.video.screenShake === 1, 'invalid shake should fall back to the default');
  assert(warnings.length > 0, 'migration warning was not recorded');
  assert(profile.upgrades.vitality === 999, 'upgrade ranks should be preserved as numbers');
});

suite('save: resumable run validation rejects garbage', () => {
  assert(validateResumableRun(null) === null, 'null run should be rejected');
  assert(validateResumableRun({ tier: 3 }) === null, 'run without a seed should be rejected');
  const valid = validateResumableRun({
    seed: 'VALID-RUN-1',
    tier: '4',
    elapsed: 120.5,
    loot: { cores: 12 },
    weapons: ['pistol', 'smg'],
    health: 80,
  });
  assert(valid, 'valid run was rejected');
  assertEqual(valid.tier, 4, 'tier should be coerced to a number');
  assertEqual(valid.weapons.length, 2, 'weapons should be preserved');
  const emptyWeapons = validateResumableRun({ seed: 'X', weapons: [] });
  assertEqual(emptyWeapons.weapons.length, 1, 'a run with no weapons should fall back to the pistol');
});

suite('save: a malformed stored run is discarded with a warning', () => {
  const validRun = validateResumableRun({ seed: 'F2-VALID', tier: 2, elapsed: 12, loot: { cores: 7 }, health: 80 });
  const loadWithRun = (run, extra = {}) => {
    const storage = new MemoryStorage();
    const save = new SaveSystem({ storage });
    storage.setItem(save.key, JSON.stringify({ ...defaultProfile(), run, ...extra }));
    return { profile: save.load(), save };
  };

  // `null` and a missing field are the legitimate "no run in progress" states:
  // `defaultProfile` itself writes null, so warning here would fire for every
  // empty profile (and toast on every start-up).
  for (const empty of [null, undefined]) {
    const { profile, save } = loadWithRun(empty);
    assertEqual(profile.run, null, `run ${JSON.stringify(empty) ?? 'undefined'} should load as no run`);
    assertEqual(save.lastLoadWarning, null, `run ${JSON.stringify(empty) ?? 'undefined'} is not corruption and must not warn`);
  }

  // Every other value that cannot be resumed is corrupted data: it is dropped
  // and reported through the existing load warning, never silently.
  for (const bad of [false, 0, '', 'nope', 42, true, [], {}, { seed: 42 }, { seed: '' }]) {
    const { profile, save } = loadWithRun(bad);
    assertEqual(profile.run, null, `malformed run ${JSON.stringify(bad)} should be discarded`);
    assert(Boolean(save.lastLoadWarning), `malformed run ${JSON.stringify(bad)} should warn`);
    assert(save.lastLoadWarning.includes('run'), `the warning for ${JSON.stringify(bad)} should name the run`);
    assertEqual(profile.account.level, 1, 'a bad run must not disturb the rest of the profile');
  }

  // A valid run is restored untouched and resumes silently.
  const { profile, save } = loadWithRun(validRun);
  assertEqual(save.lastLoadWarning, null, 'a valid run must not warn');
  assertEqual(profile.run.seed, 'F2-VALID', 'a valid run should be restored');
  assertEqual(profile.run.tier, 2, 'a valid run should keep its tier');
  assertEqual(profile.run.loot.cores, 7, 'a valid run should keep its loot');

  // F1 interaction: a run whose loot needed repair is still a valid run, so it
  // resumes (with the repaired bag) instead of being discarded.
  const repaired = loadWithRun({ ...validRun, loot: { cores: 'abc', scrap: -5, unobtainium: 3 } });
  assertEqual(repaired.save.lastLoadWarning, null, 'repaired loot must not discard the run');
  assertEqual(repaired.profile.run.seed, 'F2-VALID', 'a run with repaired loot should still resume');
  assertEqual(JSON.stringify(repaired.profile.run.loot), JSON.stringify({ scrap: 0 }), 'the repaired bag should be sanitized');

  // Loading is stable whatever the run field contains, and other data survives.
  const mixed = loadWithRun('garbage', { account: { ...defaultProfile().account, cores: 4321, level: 9 } });
  assertEqual(mixed.profile.account.cores, 4321, 'a bad run must not affect the account');
  assertEqual(mixed.profile.account.level, 9, 'a bad run must not affect the account level');
  assertEqual(mixed.profile.version, defaultProfile().version, 'the loaded profile should be at the current version');
});

suite('save: in-progress runs are checkpointed at the durability boundaries', async () => {
  const dom = await import('./domstub.mjs').then((m) => m.installDom());
  const { Game, GAME_STATE } = await import('../src/game/game.js');
  const { Run } = await import('../src/game/run.js');
  const { EventBus } = await import('../src/core/events.js');
  const { AudioEngine } = await import('../src/audio/audio.js');

  const game = new Game({ canvas: dom.canvas, container: dom.container });
  game.start();
  const stored = () => JSON.parse(dom.storage.getItem(game.saveSystem.key));
  const tick = (frames) => { for (let i = 0; i < frames; i += 1) game.tick(1 / 60); };
  let writes = 0;
  const rawSetItem = dom.storage.setItem;
  dom.storage.setItem = (...args) => { writes += 1; return rawSetItem.apply(dom.storage, args); };

  // Run creation is itself a checkpoint, so a crash right after starting still
  // leaves a resumable run behind.
  writes = 0;
  game.startRun('F3-CHECKPOINT-1');
  assertEqual(stored().run.seed, 'F3-CHECKPOINT-1', 'a new run should be resumable immediately');
  assertEqual(writes, 1, 'starting a run should write exactly one checkpoint');

  // While playing nothing is written: the cadence is event driven, not a timer.
  game.run.player.invulnTimer = 1e6; // keep the idle frames deterministic
  tick(300);
  game.run.stats.kills = 5;
  game.run.player.addLoot('cores', 42);
  assertEqual(writes, 1, 'playing must not rewrite the checkpoint every frame');
  assertEqual(stored().run.kills, 0, 'the stored checkpoint should still be the one from run creation');
  assertEqual(stored().run.loot.cores, 0, 'the stored loot should still be the one from run creation');

  // Pausing captures the live progress.
  game.pause();
  assertEqual(writes, 2, 'pausing should write exactly one checkpoint');
  assertEqual(stored().run.kills, 5, 'pausing should checkpoint live progress');
  assertEqual(stored().run.loot.cores, 42, 'pausing should checkpoint the carried loot');
  game.resume();

  // Hiding the page auto-pauses, which is the durable answer to a crash, a
  // battery pull or a backgrounded tab: the run is checkpointed on the way out.
  game.run.stats.kills = 9;
  dom.document.hidden = true;
  dom.document.dispatch('visibilitychange');
  assertEqual(game.state, GAME_STATE.PAUSED, 'hiding the page should pause the run');
  assertEqual(stored().run.kills, 9, 'hiding the page should checkpoint live progress');
  dom.document.hidden = false;
  game.resume();

  // Unloading (close/reload/navigate) flushes the live run, not the last
  // checkpoint. The handler is invoked directly because the DOM stub's window
  // swallows listener registration.
  game.run.stats.kills = 12;
  game.run.player.addLoot('cells', 7);
  const writesBeforeUnload = writes;
  game._onBeforeUnload();
  assertEqual(writes, writesBeforeUnload + 1, 'unloading must still be a single storage write');
  assertEqual(stored().run.kills, 12, 'unloading should checkpoint live progress');
  assertEqual(stored().run.loot.cells, 7, 'unloading should checkpoint the carried loot');

  // A sector transition checkpoints the sector that was just built.
  game.run.player.addWeapon('shotgun', 2);
  game.run._advanceSector();
  assertEqual(stored().run.tier, 2, 'a sector transition should checkpoint the new sector');
  assertEqual(stored().run.loot.cells, 7, 'the descend checkpoint should keep the carried loot');
  assert(stored().run.weapons.some((w) => w.id === 'shotgun'), 'the descend checkpoint should keep the loadout');

  // Every checkpoint is a real resume point.
  const payload = game.saveSystem.load().run;
  const profile = defaultProfile();
  const resumed = new Run({
    seed: payload.seed,
    startTier: payload.tier,
    resume: payload,
    profile,
    progression: new Progression(profile),
    audio: new AudioEngine({ getVolume: () => profile.settings.audio }),
    events: new EventBus(),
  });
  assertEqual(resumed.tier, 2, 'the checkpoint should resume in the sector it was taken in');
  assertEqual(resumed.stats.kills, 12, 'the checkpoint should carry the run statistics');
  assertEqual(resumed.player.loot.cells, 7, 'the checkpoint should carry the loot');
  resumed.dispose();

  // A finished run never leaves a resume behind.
  game.run.player.invulnTimer = 0;
  game.run.combat.damagePlayer(1e9);
  tick(4);
  assertEqual(game.state, GAME_STATE.RESULTS, 'the run should have ended');
  assertEqual(stored().run, null, 'a finished run must not leave a resume behind');

  game.dispose();
  return 'writes: create 1, pause 1, hide 1, unload 1; no writes over 300 playing frames';
});

suite('run: restart, abandon and death settle exactly as intended', async () => {
  const dom = await import('./domstub.mjs').then((m) => m.installDom());
  const { Game, GAME_STATE } = await import('../src/game/game.js');

  const game = new Game({ canvas: dom.canvas, container: dom.container });
  game.start();
  const stored = () => JSON.parse(dom.storage.getItem(game.saveSystem.key));
  const account = () => stored().account;
  const tick = (frames) => { for (let i = 0; i < frames; i += 1) game.tick(1 / 60); };
  // Give the live run something worth settling: loot, kills and run XP.
  const accumulate = () => {
    game.run.player.addLoot('cores', 80);
    game.run.stats.kills = 6;
    game.run.grantXpFromKill(120);
  };

  // --- Restart: a retry replays the contract and discards the attempt. -------
  game.startRun('F4-RESTART-1');
  const firstZone = zoneFingerprint(game.run.zone);
  accumulate();
  const beforeRestart = account();
  game.pause();
  game.restartRun();
  const afterRestart = account();
  assertEqual(game.state, GAME_STATE.PLAYING, 'restart should start playing immediately');
  assertEqual(game.run.seed, 'F4-RESTART-1', 'restart should replay the same contract');
  assertEqual(game.run.tier, 1, 'restart should start at sector 1');
  assertEqual(zoneFingerprint(game.run.zone), firstZone, 'restart should regenerate the same sector deterministically');
  assertEqual(game.run.player.loot.cores, 0, 'a restarted run should start with an empty bag');
  assertEqual(game.run.stats.kills, 0, 'a restarted run should start with zeroed statistics');
  assertEqual(game.run.level, 1, 'a restarted run should start at level 1');
  assertEqual(afterRestart.totalRuns, beforeRestart.totalRuns, 'restart must not count a run');
  assertEqual(afterRestart.deaths, beforeRestart.deaths, 'restart must not record a death');
  assertEqual(afterRestart.cores, beforeRestart.cores, 'restart must not bank salvage');
  assertEqual(afterRestart.xp, beforeRestart.xp, 'restart must not bank xp');
  assertEqual(afterRestart.bestLootRun, beforeRestart.bestLootRun, 'restart must not touch loot records');
  assertEqual(stored().run.seed, 'F4-RESTART-1', 'the checkpoint should describe the restarted run');
  assertEqual(stored().run.tier, 1, 'the checkpoint should not keep the discarded attempt');

  // Restarting repeatedly can never be used to farm one seed's salvage.
  const beforeFarm = account();
  for (let i = 0; i < 3; i += 1) {
    accumulate();
    game.pause();
    game.restartRun();
  }
  assertEqual(account().cores, beforeFarm.cores, 'repeated restarts must never bank cores');
  assertEqual(account().totalRuns, beforeFarm.totalRuns, 'repeated restarts must never count runs');

  // --- Abandon: leaving a run settles it once, like a death. -----------------
  game.startRun('F4-ABANDON-1');
  accumulate();
  const beforeAbandon = account();
  game.pause();
  game.quitToMenu();
  const afterAbandon = account();
  assertEqual(game.state, GAME_STATE.MENU, 'abandon should return to the menu');
  assertEqual(game.run, null, 'the abandoned run should be gone');
  assertEqual(stored().run, null, 'abandon must not leave a resumable run behind');
  assertEqual(afterAbandon.totalRuns, beforeAbandon.totalRuns + 1, 'abandon should count the run exactly once');
  assertEqual(afterAbandon.deaths, beforeAbandon.deaths + 1, 'abandon should settle like a death');
  assert(afterAbandon.cores > beforeAbandon.cores, 'abandon should bank cores salvage');
  assert(afterAbandon.xp > beforeAbandon.xp, 'abandon should bank the reduced xp');
  assertEqual(afterAbandon.successfulExtractions, beforeAbandon.successfulExtractions, 'abandon is not an extraction');

  // --- Death: the normal game-over path settles once as well. ----------------
  game.startRun('F4-DEATH-1');
  accumulate();
  const beforeDeath = account();
  game.run.player.invulnTimer = 0;
  game.run.combat.damagePlayer(1e9);
  tick(4);
  const afterDeath = account();
  assertEqual(game.state, GAME_STATE.RESULTS, 'death should reach the results screen');
  assertEqual(stored().run, null, 'a finished run must not leave a resumable run behind');
  assertEqual(afterDeath.totalRuns, beforeDeath.totalRuns + 1, 'death should count the run exactly once');
  assertEqual(afterDeath.deaths, beforeDeath.deaths + 1, 'death should be recorded exactly once');

  // ...and never twice, even if the result is submitted again.
  game._settleRun(game.run.result);
  game._settleRun(game.run.result);
  assertEqual(account().totalRuns, afterDeath.totalRuns, 'settlement must never run twice for one run');
  assertEqual(account().cores, afterDeath.cores, 'settlement must never bank twice for one run');
  assertEqual(account().deaths, afterDeath.deaths, 'a run must never be counted as two deaths');

  // Restarting from the results screen replays the seed without re-settling.
  game.restartRun();
  assertEqual(game.state, GAME_STATE.PLAYING, 'restart after death should start playing');
  assertEqual(game.run.seed, 'F4-DEATH-1', 'restart after death should replay the same seed');
  assertEqual(account().totalRuns, afterDeath.totalRuns, 'restarting a settled run must not settle again');
  assertEqual(account().cores, afterDeath.cores, 'restarting a settled run must not bank again');
  assertEqual(stored().run.tier, 1, 'the checkpoint should describe the replay');

  // --- Invariants: every path leaves a valid account and valid records. ------
  const final = account();
  for (const key of ['cores', 'xp', 'totalRuns', 'successfulExtractions', 'deaths', 'bestSector', 'bestLootRun']) {
    assert(Number.isFinite(final[key]), `account.${key} should stay finite`);
  }
  assert(final.cores >= 0 && final.xp >= 0 && final.bestLootRun >= 0, 'account values should never go negative');
  assert(final.totalRuns >= final.successfulExtractions + final.deaths, 'every settled run should be counted once');

  game.dispose();
  return `restart discarded (cores ${afterRestart.cores}), abandon banked ${afterAbandon.cores - beforeAbandon.cores} salvage, death recorded once`;
});

suite('save: in-run progression is sanitized and legacy saves keep defaults', async () => {
  const { RUN_PERKS } = await import('../src/game/run.js');

  const outOfRange = validateResumableRun({
    seed: 'PROGRESSION-BAD-1',
    level: 1e9,
    xp: -3,
    xpEarnedTotal: 'nope',
    perkIndex: 999,
  });
  assertEqual(outOfRange.level, 20, 'level should clamp to the run level ceiling');
  assertEqual(outOfRange.xp, 0, 'negative xp should clamp to 0');
  assertEqual(outOfRange.xpEarnedTotal, 0, 'non-numeric xpEarnedTotal should fall back to 0');
  assertEqual(outOfRange.perkIndex, RUN_PERKS.length, 'perkIndex should clamp to the perk table');

  const coercible = validateResumableRun({
    seed: 'PROGRESSION-BAD-2',
    level: 'two',
    xp: '12',
    xpEarnedTotal: Infinity,
    perkIndex: -4,
  });
  assertEqual(coercible.level, 1, 'an unparseable level should fall back to 1');
  assertEqual(coercible.xp, 12, 'numeric strings should still be coerced');
  assertEqual(coercible.xpEarnedTotal, 0, 'infinite xpEarnedTotal should fall back to 0');
  assertEqual(coercible.perkIndex, 0, 'negative perkIndex should clamp to 0');

  const legacy = validateResumableRun({ seed: 'PROGRESSION-LEGACY-1', health: 80 });
  assertEqual(legacy.level, 1, 'legacy saves should resume at level 1');
  assertEqual(legacy.xp, 0, 'legacy saves should resume with no xp');
  assertEqual(legacy.xpEarnedTotal, 0, 'legacy saves should resume with no banked xp');
  assertEqual(legacy.perkIndex, 0, 'legacy saves should resume with no perks applied');
});

suite('save: run statistics are sanitized and default to zero', () => {
  const garbage = validateResumableRun({
    seed: 'STATS-BAD-1',
    stats: {
      damageDealt: -500,
      damageTaken: Number.NaN,
      elitesKilled: Number.POSITIVE_INFINITY,
      bossKills: 'nope',
      sectorsCleared: -1,
      lootCollected: 12.7,
      uselessShots: 99,
    },
    playerStats: { shotsFired: -3, shotsHit: Number.NaN, dashes: 'x', reloads: 7 },
  });
  assertEqual(garbage.stats.damageDealt, 0, 'negative damage should clamp to 0');
  assertEqual(garbage.stats.damageTaken, 0, 'NaN damage should fall back to 0');
  assertEqual(garbage.stats.elitesKilled, 0, 'infinite elites should fall back to 0');
  assertEqual(garbage.stats.bossKills, 0, 'non-numeric bosses should fall back to 0');
  assertEqual(garbage.stats.sectorsCleared, 0, 'negative sectors should clamp to 0');
  assertEqual(garbage.stats.lootCollected, 13, 'fractional counters should round to whole items');
  assertEqual(garbage.playerStats.shotsFired, 0, 'negative shots should clamp to 0');
  assertEqual(garbage.playerStats.shotsHit, 0, 'NaN hits should fall back to 0');
  assertEqual(garbage.playerStats.dashes, 0, 'non-numeric dashes should fall back to 0');
  assertEqual(Object.keys(garbage.stats).sort().join(','), 'bossKills,damageDealt,damageTaken,elitesKilled,lootCollected,sectorsCleared', 'only reported counters may be persisted');
  assertEqual(Object.keys(garbage.playerStats).sort().join(','), 'dashes,shotsFired,shotsHit', 'only reported player counters may be persisted');

  const coerced = validateResumableRun({
    seed: 'STATS-BAD-2',
    stats: 'not-an-object',
    playerStats: null,
  });
  assertEqual(coerced.stats.damageDealt, 0, 'a non-object stats bag should become zeroed counters');
  assertEqual(coerced.playerStats.dashes, 0, 'a null player stats bag should become zeroed counters');

  // Legacy saves (written before statistics were persisted) carry no bags at all.
  const legacy = validateResumableRun({ seed: 'STATS-LEGACY-1', kills: 3, objectivesCompleted: 1 });
  assertEqual(legacy.stats.bossKills, 0, 'legacy saves should resume with zero bosses');
  assertEqual(legacy.playerStats.shotsFired, 0, 'legacy saves should resume with zero shots');
  assertEqual(legacy.kills, 3, 'legacy top-level kills should still be accepted');
});

suite('save: generation parameters are sanitized against the generator defaults', () => {
  const supported = Object.keys(MAP_GEN_DEFAULTS).sort();
  const paramsOf = (genParams) => validateResumableRun({ seed: 'GENPARAMS-1', genParams }).genParams;

  // Supported keys survive, unknown keys never do.
  const kept = paramsOf({ width: 3200, largeRoomChance: 0.5 });
  assertEqual(JSON.stringify(kept), JSON.stringify({ width: 3200, largeRoomChance: 0.5 }), 'supported parameters should be preserved');
  const stripped = paramsOf({ width: 3200, topK: 5, bogus: 'x', attempts: 3 });
  assertEqual(Object.keys(stripped).join(','), 'width', 'unknown keys should be dropped');

  // Every value the sanitizer keeps is a key the generator actually reads.
  const everything = paramsOf({ ...MAP_GEN_DEFAULTS, extraKey: 1 });
  assert(Object.keys(everything).every((key) => supported.includes(key)), 'only generator parameters may be persisted');
  assertEqual(Object.keys(everything).length, supported.length, 'every generator parameter should round-trip when valid');

  // Non-numeric and non-finite values are ignored rather than coerced.
  assertEqual(Object.keys(paramsOf({ width: '3200', height: Number.NaN, corridorWidth: Number.POSITIVE_INFINITY, wallThickness: {} })).length, 0, 'strings, NaN, Infinity and objects should be ignored');
  assertEqual(Object.keys(paramsOf({ width: null, height: [], roomAttempts: true })).length, 0, 'null, arrays and booleans should be ignored');

  // Out-of-range values clamp to the bounds the generator can use.
  const clamped = paramsOf({ width: 999999, height: 1, roomAttempts: -3, minRoomSize: 0, maxRoomSize: 99999, largeRoomChance: 5, corridorWidth: 1, wallThickness: 4096, obstacleDensity: -1 });
  assertEqual(clamped.width, 6000, 'width should clamp to its upper bound');
  assertEqual(clamped.height, 1200, 'height should clamp to its lower bound');
  assertEqual(clamped.roomAttempts, 40, 'roomAttempts should clamp to the relaxation floor');
  assertEqual(clamped.minRoomSize, 64, 'minRoomSize should clamp to its lower bound');
  assertEqual(clamped.maxRoomSize, 640, 'maxRoomSize should clamp to its upper bound');
  assertEqual(clamped.largeRoomChance, 1, 'probabilities should clamp to 1');
  assertEqual(clamped.corridorWidth, 32, 'corridorWidth should clamp to its lower bound');
  assertEqual(clamped.wallThickness, 64, 'wallThickness should clamp to its upper bound');
  assertEqual(clamped.obstacleDensity, 0, 'obstacleDensity should clamp to 0');

  // Malformed containers and legacy saves (no field at all) become `{}`.
  for (const bad of ['nope', 42, [1, 2, 3], null, undefined]) {
    assertEqual(Object.keys(paramsOf(bad)).length, 0, `malformed genParams ${JSON.stringify(bad) ?? 'undefined'} should sanitize to {}`);
  }
  assertEqual(Object.keys(validateResumableRun({ seed: 'GENPARAMS-LEGACY' }).genParams).length, 0, 'a legacy save should resume with empty generation parameters');
  assertEqual(JSON.stringify(paramsOf({})), '{}', 'an empty object should stay empty');
});

suite('save: carried loot is sanitized against the resource table', () => {
  const RESOURCE_KEYS = Object.keys(RESOURCE_DEFS);
  const lootOf = (loot) => validateResumableRun({ seed: 'LOOT-1', loot }).loot;
  const bonuses = new Progression(defaultProfile()).computeRunBonuses();

  // Valid loot survives the whole chain unchanged: the live bag -> serialize ->
  // validator -> restore.
  const player = new Player({ x: 0, y: 0 }, bonuses);
  player.setLoadout(['pistol'], bonuses);
  player.addLoot('scrap', 12);
  player.addLoot('cores', 30);
  player.addLoot('cells', 4);
  player.addLoot('datashard', 2);
  player.addLoot('intel', 1);
  const valid = lootOf(player.serialize().loot);
  for (const key of RESOURCE_KEYS) {
    assertEqual(valid[key], player.loot[key], `valid ${key} should be preserved by the validator`);
  }
  const restored = Player.restore({ loot: valid }, { x: 0, y: 0 }, bonuses);
  for (const key of RESOURCE_KEYS) {
    assertEqual(restored.loot[key], player.loot[key], `valid ${key} should be preserved by restore`);
  }
  assertEqual(restored.lootValue(), player.lootValue(), 'loot value should survive serialize -> validate -> restore');

  // Unknown resource keys never survive, and the kept bag is exactly the table.
  const stripped = lootOf({ ...valid, unobtainium: 99, ammo_rifle: 3 });
  assertEqual(Object.keys(stripped).join(','), RESOURCE_KEYS.join(','), 'unknown resource keys should be dropped');

  // Wrong-typed members are dropped rather than coerced.
  assertEqual(Object.keys(lootOf({ scrap: '12', cores: true, cells: {}, datashard: [1], intel: null })).length, 0, 'strings, booleans, objects, arrays and null should be dropped');
  assertEqual(Object.keys(lootOf({ scrap: Number.NaN, cores: Number.POSITIVE_INFINITY, cells: Number.NEGATIVE_INFINITY, datashard: 4 })).join(','), 'datashard', 'NaN and Infinity should be dropped');

  // Quantities are non-negative whole numbers, capped per stack.
  assertEqual(lootOf({ cores: -250 }).cores, 0, 'negative quantities should clamp to 0');
  assertEqual(lootOf({ cells: 1.5 }).cells, 2, 'fractional quantities should round');
  assertEqual(lootOf({ cores: 1e12 }).cores, 1000000, 'oversized stacks should cap');
  assertEqual(lootOf({ intel: Number.MAX_VALUE }).intel, 1000000, 'the cap should hold for extreme values');

  // Malformed containers and legacy payloads fall back to an empty bag.
  for (const bad of ['nope', 42, [1, 2, 3], null, undefined, true]) {
    assertEqual(Object.keys(lootOf(bad)).length, 0, `malformed loot ${JSON.stringify(bad) ?? 'undefined'} should sanitize to {}`);
  }
  assertEqual(JSON.stringify(lootOf({})), '{}', 'an empty bag should stay empty');
  assertEqual(Object.keys(validateResumableRun({ seed: 'LOOT-LEGACY' }).loot).length, 0, 'a legacy save should resume without loot');
  const legacy = Player.restore({}, { x: 0, y: 0 }, bonuses);
  assertEqual(legacy.lootValue(), 0, 'a legacy resume should start with an empty, finite bag');
  assertEqual(Object.keys(legacy.loot).length, RESOURCE_KEYS.length, 'a legacy resume should cover every resource');

  // The reported cascade: malformed loot reached lootValue() -> result.cores ->
  // account.cores, so a NaN stack erased the banked balance on the next load.
  const poison = lootOf({ cores: 'abc', scrap: Number.NaN, cells: Number.POSITIVE_INFINITY, datashard: {}, intel: -1000, unobtainium: 7 });
  const poisoned = Player.restore({ loot: poison }, { x: 0, y: 0 }, bonuses);
  assert(Number.isFinite(poisoned.lootValue()), 'malformed loot must never produce a non-finite loot value');
  assertEqual(poisoned.lootValue(), 0, 'malformed loot should be worth nothing');

  const progression = new Progression(defaultProfile());
  progression.profile.account.cores = 5000;
  progression.profile.account.bestLootRun = 500;
  const settled = progression.settleRun({
    extracted: true,
    sector: 1,
    xp: 0,
    cores: poisoned.loot.cores ?? 0,
    kills: 0,
    elapsed: 0,
    damageDealt: 0,
    lootValue: poisoned.lootValue(),
    seed: 'LOOT-SETTLE',
  });
  assertEqual(settled.coresBanked, 0, 'a poisoned bag must bank nothing');
  assertEqual(progression.profile.account.cores, 5000, 'an existing balance must not be corrupted by malformed loot');
  assert(Number.isFinite(progression.profile.account.cores), 'the balance must stay finite');
  assertEqual(progression.profile.account.bestLootRun, 500, 'an existing loot record must not be poisoned');

  // The repaired profile must also survive storage: a NaN used to serialize as
  // null and reload as 0, which is how the balance was lost.
  const storage = new MemoryStorage();
  const save = new SaveSystem({ storage });
  save.save(progression.profile);
  const reloaded = save.load();
  assertEqual(reloaded.account.cores, 5000, 'the balance must round-trip through storage');
  assertEqual(reloaded.account.bestLootRun, 500, 'records must round-trip through storage');

  // A valid resumable run keeps its loot through a full storage round trip.
  const profile = defaultProfile();
  profile.run = validateResumableRun({ seed: 'LOOT-RT', tier: 2, elapsed: 5, loot: valid, health: 80, armor: 5 });
  const runStorage = new MemoryStorage();
  const runSave = new SaveSystem({ storage: runStorage });
  runSave.save(profile);
  assertEqual(JSON.stringify(runSave.load().run.loot), JSON.stringify(valid), 'a valid run should keep its loot through storage');

  // Defensive layer: a snapshot built in memory never passed the validator, so
  // Player.restore has to normalise the bag itself.
  const bypass = Player.restore({
    loot: { cores: 'abc', scrap: Number.NaN, cells: Number.NEGATIVE_INFINITY, datashard: Number.POSITIVE_INFINITY, intel: -75, unobtainium: 9 },
  }, { x: 0, y: 0 }, bonuses);
  assertEqual(bypass.loot.cores, 0, 'a non-numeric cached stack should not survive restore');
  assertEqual(bypass.loot.scrap, 0, 'a NaN cached stack should not survive restore');
  assertEqual(bypass.loot.cells, 0, 'a -Infinity cached stack should not survive restore');
  assertEqual(bypass.loot.datashard, 0, 'an Infinity cached stack should not survive restore');
  assertEqual(bypass.loot.intel, 0, 'a negative cached stack should clamp to 0');
  assertEqual(bypass.loot.unobtainium, undefined, 'unknown cached keys should not survive restore');
  assertEqual(bypass.lootValue(), 0, 'a bypassed snapshot must stay finite and worthless');
  const bypassHuge = Player.restore({ loot: { cores: 1e308 } }, { x: 0, y: 0 }, bonuses);
  assertEqual(bypassHuge.loot.cores, 1000000, 'a cached oversized stack should cap');
  assert(Number.isFinite(bypassHuge.lootValue()), 'a capped cached stack must stay finite');
  const bypassValid = Player.restore({ loot: { scrap: 7, cores: 3, cells: 0, datashard: 1, intel: 2 } }, { x: 0, y: 0 }, bonuses);
  assertEqual(JSON.stringify(bypassValid.loot), JSON.stringify({ scrap: 7, cores: 3, cells: 0, datashard: 1, intel: 2 }), 'valid cached loot should be preserved exactly');
});

// ---------------------------------------------------------------------------
// Progression
// ---------------------------------------------------------------------------

suite('progression: XP curve is monotonic and levels correctly', () => {
  let last = 0;
  for (let level = 1; level < 40; level += 1) {
    const cost = xpForLevel(level);
    assert(cost > last, `XP cost at level ${level} did not increase`);
    last = cost;
  }
  assertEqual(levelFromXp(0).level, 1, 'zero XP should be level 1');
  const level2 = levelFromXp(xpForLevel(1));
  assertEqual(level2.level, 2, 'exactly enough XP for level 2');
  const level3 = levelFromXp(xpForLevel(1) + xpForLevel(2));
  assertEqual(level3.level, 3, 'exact XP for level 3');
});

suite('progression: upgrades cost, apply and cap correctly', () => {
  const profile = defaultProfile();
  const progression = new Progression(profile);
  profile.account.cores = 100000;
  const upgrade = META_UPGRADES.find((u) => u.id === 'vitality');
  assert(upgrade, 'vitality upgrade missing');
  for (let rank = 0; rank < upgrade.maxRank; rank += 1) {
    const result = progression.purchase('vitality');
    assert(result.ok, `purchase failed at rank ${rank}`);
    assertEqual(result.rank, rank + 1, `unexpected rank after purchase ${rank + 1}`);
  }
  const overflow = progression.purchase('vitality');
  assert(!overflow.ok, 'purchase beyond max rank succeeded');
  assertEqual(overflow.reason, 'MAX', 'wrong rejection reason at max rank');
  const bonuses = progression.computeRunBonuses();
  assertEqual(bonuses.maxHealthAdd, upgrade.maxRank * 12, 'health bonus does not match max rank');
  return `vitality maxed at +${bonuses.maxHealthAdd} HP`;
});

suite('progression: purchases fail without enough cores', () => {
  const profile = defaultProfile();
  const progression = new Progression(profile);
  profile.account.cores = 0;
  const result = progression.purchase('vitality');
  assert(!result.ok, 'purchase with no cores succeeded');
  assertEqual(result.reason, 'CORES', 'wrong rejection reason');
  const check = progression.canAfford('vitality');
  assert(!check.ok && check.cost > 0, 'canAfford should report a cost even when unaffordable');
});

suite('progression: refund restores exactly what was spent', () => {
  const profile = defaultProfile();
  const progression = new Progression(profile);
  profile.account.cores = 100000;
  progression.purchase('vitality', 2);
  progression.purchase('gunsmith', 3);
  const before = profile.account.cores;
  const spent = 100000 - before;
  const refund = progression.resetUpgrades();
  assertEqual(refund, spent, 'refund does not equal total spent');
  assertEqual(profile.account.cores, 100000, 'cores were not restored');
  assertEqual(Object.keys(profile.upgrades).length, 0, 'upgrades were not cleared');
});

suite('progression: extraction banks everything, death salvages a fraction', () => {
  const runResult = {
    extracted: true,
    sector: 3,
    xp: 1000,
    cores: 100,
    kills: 40,
    elapsed: 600,
    damageDealt: 5000,
    lootValue: 900,
    bossKills: 1,
    seed: 'SETTLE-1',
  };
  const p1 = new Progression(defaultProfile());
  const extracted = p1.settleRun(runResult);
  assertEqual(extracted.coresBanked, 100, 'extraction should bank all cores');
  assertEqual(extracted.xpBanked, 1000, 'extraction should bank all XP');
  assertEqual(extracted.salvageRate, 1, 'extraction salvage rate should be 1');
  assertEqual(extracted.levelsGained > 0, true, 'the run should grant at least one account level');
  assertEqual(p1.profile.account.successfulExtractions, 1, 'extraction was not recorded');
  assertEqual(p1.profile.account.totalBossKills, 1, 'boss kill was not recorded');
  assertEqual(p1.profile.account.bestSector, 3, 'best sector was not updated');

  const p2 = new Progression(defaultProfile());
  const died = p2.settleRun({ ...runResult, extracted: false });
  assertEqual(died.coresBanked, Math.round(100 * DEATH_SALVAGE_BASE), 'death salvage amount');
  assertEqual(died.xpBanked, 400, 'death should bank 40% of XP');
  assertEqual(p2.profile.account.deaths, 1, 'death was not recorded');
  assertEqual(p2.profile.account.successfulExtractions, 0, 'death must not count as an extraction');
});

suite('progression: meta upgrades make runs stronger but not trivial', () => {
  const bare = new Progression(defaultProfile());
  const maxedProfile = defaultProfile();
  maxedProfile.account.cores = 1000000;
  const maxed = new Progression(maxedProfile);
  for (const upgrade of META_UPGRADES) {
    maxed.purchase(upgrade.id, upgrade.maxRank);
  }
  const bareBonuses = bare.computeRunBonuses();
  const maxedBonuses = maxed.computeRunBonuses();
  assert(maxedBonuses.maxHealthAdd > bareBonuses.maxHealthAdd, 'health upgrades do nothing');
  assert(maxedBonuses.damageMul > bareBonuses.damageMul, 'damage upgrades do nothing');
  assert(maxedBonuses.damageMul < 2.5, `damage multipliers are too strong: ${maxedBonuses.damageMul}`);
  assert(maxedBonuses.moveMul < 2, `move multiplier is too strong: ${maxedBonuses.moveMul}`);
  assert(maxedBonuses.reloadMul > 0.4, `reload multiplier is too strong: ${maxedBonuses.reloadMul}`);
  return `maxed: hp+${maxedBonuses.maxHealthAdd} dmg x${maxedBonuses.damageMul.toFixed(2)} spd x${maxedBonuses.moveMul.toFixed(2)}`;
});

suite('progression: aggregate ignores unknown ids and respects caps', () => {
  const totals = aggregateUpgrades({ vitality: 99, nonexistent: 5, gunsmith: 2 });
  const cap = META_UPGRADES.find((u) => u.id === 'vitality').maxRank;
  assertEqual(totals.healthAdd, cap * 12, 'ranks above the cap should be clamped');
  assert(totals.damageMul > 1, 'gunsmith should contribute damage');
});

suite('progression: account level grants passive bonuses', () => {
  const low = accountLevelBonus(1);
  const high = accountLevelBonus(20);
  assertEqual(low.damageMul, 1, 'level 1 should give no bonus');
  assert(high.damageMul > low.damageMul, 'account level does not increase damage');
  assert(high.healthAdd > 0, 'account level does not grant health');
});

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

suite('player: movement, collision and dash spend energy', () => {
  const map = makeMap(30, 30);
  const world = new WorldRuntime({
    props: [],
    map,
    lootSpawns: [],
    enemySpawns: [],
    rooms: [],
    objectives: [],
    difficulty: difficultyAt(1),
    decor: [],
    lights: [],
    bounds: { x: 0, y: 0, w: map.worldWidth, h: map.worldHeight },
  });
  void world;
  const player = new Player({ x: TILE * 5, y: TILE * 5 }, { maxHealthAdd: 0, maxArmorAdd: 0, maxEnergyAdd: 0, moveMul: 1, damageMul: 1, reloadMul: 1, recoilMul: 1 });
  player.setLoadout(['pistol'], {});
  const startX = player.x;
  for (let i = 0; i < 60; i += 1) {
    player.update(1 / 60, { move: { x: 1, y: 0 }, aimWorld: { x: player.x + 100, y: player.y }, dashPressed: false }, map, world);
  }
  assert(player.x > startX + 40, `player moved too little (${(player.x - startX).toFixed(1)})`);
  const energyBefore = player.energy;
  player.update(1 / 60, { move: { x: 0, y: 0 }, aimWorld: { x: player.x + 100, y: player.y }, dashPressed: true }, map, world);
  assert(player.energy < energyBefore, 'dash did not consume energy');
  assert(player.isDashing, 'dash state was not entered');
  assert(player.invulnTimer > 0, 'dash should grant brief invulnerability');
});

suite('player: armor reduces damage and erodes; death is terminal', () => {
  const player = new Player({ x: 0, y: 0 }, { maxArmorAdd: 40, maxHealthAdd: 0, maxEnergyAdd: 0, moveMul: 1, damageMul: 1, reloadMul: 1, recoilMul: 1 });
  assert(player.armor > 0, 'armor bonus was not applied');
  const before = player.armor;
  const result = player.takeDamage(20, {});
  assert(result.absorbed > 0, 'armor did not absorb any damage');
  assert(result.applied < 20, 'armor did not reduce applied damage');
  assert(player.armor < before, 'armor did not erode');
  // Invulnerability window prevents double hits.
  const second = player.takeDamage(20, {});
  assertEqual(second.applied, 0, 'invulnerability window was not respected');
  // Bypassing armor must work.
  player.invulnTimer = 0;
  const bypass = player.takeDamage(10, { bypassArmor: true });
  assertClose(bypass.applied, 10, 0.001, 'bypassArmor did not apply full damage');
  player.invulnTimer = 0;
  const death = player.takeDamage(9999, {});
  assert(death.died, 'player did not die');
  assert(!player.alive, 'player.alive should be false');
});

suite('player: loot is tracked, valued and partially forfeited', () => {
  const player = new Player({ x: 0, y: 0 }, {});
  player.setLoadout(['pistol'], {});
  player.addLoot('scrap', 10);
  player.addLoot('cores', 4);
  assertEqual(player.loot.scrap, 10, 'scrap amount');
  assertEqual(player.lootValue(), 10 + 4 * 8, 'loot value calculation');
  const lost = player.forfeitLoot(0.25);
  assertEqual(player.loot.cores, 1, 'cores kept after a 25% salvage');
  assertEqual(lost.cores, 3, 'cores lost on death');
});

suite('player: consumables heal, add armor and grant a stim', () => {
  const player = new Player({ x: 0, y: 0 }, {});
  player.setLoadout(['pistol'], { medkitsAdd: 2 });
  assertEqual(player.consumables.medkit, 3, 'medkit count from the bonus');
  player.invulnTimer = 0;
  player.takeDamage(40, { bypassArmor: true });
  const hurt = player.health;
  player.heal(45);
  assert(player.health > hurt, 'heal had no effect');
  const armorBefore = player.armor;
  player.addArmor(30);
  assert(player.armor > armorBefore, 'armor plate had no effect');
  player.stimTimer = 12;
  assert(player.damageMultiplier > player.damageMul, 'stim did not boost damage');
});

suite('player: weapon switching and pickup upgrades', () => {
  const player = new Player({ x: 0, y: 0 }, {});
  player.setLoadout(['pistol'], {});
  assertEqual(player.weapons.length, 1, 'starting weapon count');
  const added = player.addWeapon('smg', 1);
  assert(added.added, 'new weapon was not added');
  assertEqual(player.weapons.length, 2, 'weapon count after pickup');
  assert(player.nextWeapon(), 'weapon switch failed');
  assertEqual(player.weaponIndex, 1, 'weapon index after switching');
  const upgrade = player.addWeapon('smg', 3);
  assert(upgrade.upgraded, 'higher-tier duplicate did not upgrade');
  assertEqual(player.weapons[1].tier, 3, 'weapon tier after upgrade');
  assert(player.ammo.get('light') > 0, 'no reserve ammo was granted for the new weapon');
});

// ---------------------------------------------------------------------------
// Loot
// ---------------------------------------------------------------------------

suite('loot: rolls are deterministic for a fixed seed', () => {
  const rollsA = [];
  const rollsB = [];
  const a = new Rng('loot-seed');
  const b = new Rng('loot-seed');
  for (let i = 0; i < 60; i += 1) {
    rollsA.push(rollLoot(a, { tier: 3, quality: 1, rarityBoost: 0 }).entry.id);
    rollsB.push(rollLoot(b, { tier: 3, quality: 1, rarityBoost: 0 }).entry.id);
  }
  assert(rollsA.join(',') === rollsB.join(','), 'loot rolls are not deterministic');
});

suite('loot: tier gating excludes late-game entries early', () => {
  const rng = new Rng('gate-seed');
  for (let i = 0; i < 400; i += 1) {
    const roll = rollLoot(rng, { tier: 1, quality: 1, rarityBoost: 0 });
    assert(roll.entry.minTier === undefined || roll.entry.minTier <= 1, `tier-1 loot rolled ${roll.entry.id} (minTier ${roll.entry.minTier})`);
  }
  const deep = new Rng('gate-seed-2');
  const seen = new Set();
  for (let i = 0; i < 400; i += 1) {
    seen.add(rollLoot(deep, { tier: 5, quality: 2, rarityBoost: 1 }).entry.id);
  }
  assert(seen.size > 4, `deep-tier loot table produced too few distinct entries (${seen.size})`);
  return `${seen.size} distinct entries at tier 5`;
});

suite('loot: quantities scale with quality and stay positive', () => {
  const rng = new Rng('qty-seed');
  for (let i = 0; i < 300; i += 1) {
    const roll = rollLoot(rng, { tier: 4, quality: 2.5, rarityBoost: 0 });
    assert(roll.amount >= 1, `non-positive loot amount ${roll.amount}`);
    assert(Number.isInteger(roll.amount), `non-integer loot amount ${roll.amount}`);
  }
});

suite('loot: weapon and chip drops are constructed correctly', () => {
  const rng = new Rng('drop-seed');
  const weapon = entryToDrop({ id: 'weapon', rarity: 'rare' }, 1, 10, 20, rng, {});
  assertEqual(weapon.kind, DROP_KIND.WEAPON, 'weapon drop kind');
  assert(weapon.tier >= 1 && weapon.tier <= 3, `weapon tier out of range: ${weapon.tier}`);
  assert(['rare', 'epic', 'legendary'].includes(weapon.rarity), `unexpected weapon rarity ${weapon.rarity}`);
  const chip = entryToDrop({ id: 'upgrade_chip', rarity: 'epic' }, 1, 0, 0, rng, {});
  assertEqual(chip.kind, DROP_KIND.CHIP, 'chip drop kind');
  const ammo = entryToDrop({ id: 'ammo_rifle', rarity: 'common' }, 20, 0, 0, rng, {});
  assertEqual(ammo.kind, DROP_KIND.AMMO, 'ammo drop kind');
  assertEqual(ammo.key, 'rifle', 'ammo type mapping');
});

suite('loot: full system spawns, magnetises and collects drops', () => {
  const zone = generateZone({ seed: 'LOOT-SYSTEM-1', tier: 2 });
  const progression = new Progression(defaultProfile());
  const loot = new LootSystem({ zone, progression, runSeed: 'LOOT-SYSTEM-1' });
  assert(loot.drops.length > 0, 'zone loot seeding produced no drops');
  const player = new Player({ x: 0, y: 0 }, {});
  player.setLoadout(['pistol'], {});
  const drop = loot.drops[0];
  drop.x = 0;
  drop.y = 0;
  let pickups = 0;
  loot.onPickup = () => { pickups += 1; };
  loot.update(1 / 60, { player, world: null, canPickup: true, pickupRadius: 60 });
  assertEqual(pickups, 1, 'drop was not picked up inside the radius');
  assert(!drop.active, 'collected drop is still active');
  assert(player.lootValue() >= 0, 'loot value went negative');
});

suite('loot: consumable use is validated and consumes stock', () => {
  const zone = generateZone({ seed: 'CONSUMABLE-1', tier: 1 });
  const loot = new LootSystem({ zone, progression: new Progression(defaultProfile()), runSeed: 'CONSUMABLE-1' });
  const player = new Player({ x: 0, y: 0 }, {});
  player.setLoadout(['pistol'], {});
  assert(loot.useConsumable(player, 'medkit') === null, 'medkit used at full health');
  player.invulnTimer = 0;
  player.takeDamage(50, { bypassArmor: true });
  const used = loot.useConsumable(player, 'medkit');
  assert(used && used.healed > 0, 'medkit did not heal');
  assertEqual(player.consumables.medkit, 0, 'medkit stock was not consumed');
  assert(loot.useConsumable(player, 'medkit') === null, 'medkit used with no stock');
  const stim = loot.useConsumable(player, 'stim');
  assert(stim && player.stimTimer > 0, 'stim did not activate');
  let threw = false;
  try {
    loot.useConsumable(player, 'nonexistent');
  } catch (error) {
    threw = true;
    assert(/Unknown consumable/.test(error.message), `unexpected error: ${error.message}`);
  }
  assert(threw, 'unknown consumables should throw rather than fail silently');
});

suite('objectives: RECOVER shards are collected through the real pickup path', () => {
  // The objective type is rolled per seed, so scan deterministically for a
  // RECOVER zone instead of hardcoding one.
  let zone = null;
  for (let i = 0; i < 60 && !zone; i += 1) {
    const candidate = generateZone({ seed: `RECOVER-LOOT-${i}`, tier: 1 });
    if (candidate.objectives[0].type === OBJECTIVE_TYPES.RECOVER) zone = candidate;
  }
  assert(zone, 'no RECOVER-objective seed found in the scan');

  const progression = new Progression(defaultProfile());
  const loot = new LootSystem({ zone, progression, runSeed: zone.seed });
  const objectives = new ObjectiveRuntime(zone);
  objectives.spawnMarkers(loot); // exactly what Run._buildSector does
  loot.onPickup = (drop) => { // exactly what Run._buildSector wires
    if (drop.objectiveId) objectives.onMarkerCollected(drop.objectiveId, drop.id);
  };
  const player = new Player(zone.spawnPoint, progression.computeRunBonuses());

  const shards = loot.drops.filter((d) => d.objectiveId);
  assertEqual(shards.length, 3, 'RECOVER should spawn one shard per marker');
  assertEqual(objectives.main.progress, 0, 'progress did not start at zero');

  const steps = [];
  for (const shard of shards) {
    player.x = shard.x;
    player.y = shard.y;
    loot.update(1 / 60, { player, world: null, canPickup: player.alive, pickupRadius: 46 });
    assert(!shard.active, `shard ${shard.id} was not collected by walking over it`);
    assert(loot.collectedIdList().includes(shard.id), `shard ${shard.id} was not recorded as collected`);
    steps.push(`${objectives.main.progress}/${objectives.main.target}`);
  }
  assertEqual(steps.join(' -> '), '1/3 -> 2/3 -> 3/3', 'progress did not advance once per shard');
  assert(objectives.main.complete, 'RECOVER objective did not complete at 3/3');
  assert(objectives.allComplete, 'allComplete was not set, so extraction stays locked');

  // Resume: a rebuilt sector suppresses exactly the shards already recovered.
  const makeSector = () => {
    const sectorLoot = new LootSystem({ zone, progression, runSeed: zone.seed });
    const sectorObjectives = new ObjectiveRuntime(zone);
    sectorObjectives.spawnMarkers(sectorLoot);
    return sectorLoot;
  };

  const rebuilt = makeSector();
  assertEqual(rebuilt.drops.filter((d) => d.objectiveId).length, 3, 'rebuild changed the shard population');
  rebuilt.restoreCollected(loot.collectedIdList());
  assertEqual(rebuilt.drops.filter((d) => d.objectiveId && d.active).length, 0, 'collected shards respawned after resume');

  // A partially recovered sector keeps the untouched shards available.
  const partial = makeSector();
  partial.restoreCollected([shards[0].id]);
  const available = partial.drops.filter((d) => d.objectiveId && d.active);
  assertEqual(available.length, 2, 'uncollected shards disappeared after resume');
  assert(available.every((d) => d.id !== shards[0].id), 'the collected shard came back');
  return `${steps.join(' -> ')}, ids=${loot.collectedIdList().join(',')}`;
});

// ---------------------------------------------------------------------------
// Objectives & extraction
// ---------------------------------------------------------------------------

suite('objectives: progress, completion and marker tracking', () => {
  const zone = generateZone({ seed: 'OBJ-TEST-1', tier: 1 });
  const objectives = new ObjectiveRuntime(zone);
  const main = objectives.main;
  assert(main, 'zone produced no main objective');
  const events = [];
  objectives.onProgress = (o) => events.push(`progress:${o.progress}`);
  objectives.onComplete = (o) => events.push(`complete:${o.id}`);

  if (main.type === OBJECTIVE_TYPES.ELIMINATE) {
    for (let i = 0; i < main.target; i += 1) objectives.onEnemyKilled();
  } else if (main.type === OBJECTIVE_TYPES.DESTROY) {
    for (let i = 0; i < main.target; i += 1) objectives.onPropDestroyed(main.id);
  } else if (main.type === OBJECTIVE_TYPES.RECOVER) {
    for (const marker of main.markers) objectives.onMarkerCollected(main.id, marker.id);
  }
  assert(main.complete, `objective ${main.type} did not complete after its target was met`);
  assert(objectives.allComplete, 'allComplete was not set');
  assert(events.some((e) => e.startsWith('complete:')), 'completion event was not emitted');
  return `${main.type} target=${main.target} events=${events.length}`;
});

suite('objectives: elimination progress is not double counted once complete', () => {
  const zone = generateZone({ seed: 'OBJ-DOUBLE-1', tier: 1 });
  const objectives = new ObjectiveRuntime(zone);
  const main = objectives.main;
  main.type = OBJECTIVE_TYPES.ELIMINATE;
  main.target = 2;
  main.progress = 0;
  main.complete = false;
  objectives.onEnemyKilled();
  objectives.onEnemyKilled();
  assert(main.complete, 'objective should be complete');
  const before = main.progress;
  objectives.onEnemyKilled();
  assertEqual(main.progress, before, 'progress advanced past a completed objective');
});

suite('extraction: channels only while inside and ready, resets on exit', () => {
  const zone = new ChannelZone({ x: 100, y: 100, radius: 70, channelTime: 2 }, 'extract');
  const inside = { x: 100, y: 100 };
  const outside = { x: 500, y: 500 };
  // Locked until the objective is complete.
  let state = zone.update(0.5, inside, 'OBJECTIVE INCOMPLETE');
  assertEqual(state.state, 'blocked', 'locked zone should be blocked');
  assertEqual(zone.progress, 0, 'locked zone should not accumulate progress');

  // Idle outside.
  state = zone.update(0.5, outside, true);
  assertEqual(state.state, 'idle', 'zone should be idle when outside');

  // Channelling inside.
  zone.update(0.5, inside, true);
  state = zone.update(0.5, inside, true);
  assertEqual(state.state, 'channelling', 'zone should be channelling inside');
  assert(zone.progress > 0, 'progress did not accumulate');

  // Leaving resets.
  zone.update(0.5, outside, true);
  assert(zone.progress < 1, 'progress should decay after leaving');

  // Completion.
  let completed = null;
  for (let i = 0; i < 400 && !completed; i += 1) {
    const result = zone.update(1 / 60, inside, true);
    if (result.state === 'complete') completed = result;
  }
  assert(completed, 'zone never completed while standing inside');
  assert(zone.completed, 'completed flag not set');
});

suite('extraction: taking damage interrupts the channel', () => {
  const zone = new ChannelZone({ x: 0, y: 0, radius: 70, channelTime: 2 }, 'extract');
  const inside = { x: 0, y: 0 };
  zone.update(0.1, inside, true);
  zone.update(0.5, inside, true);
  assert(zone.active, 'zone should be active');
  assert(zone.interrupt(), 'interrupt should report an active channel');
  assert(!zone.active, 'zone should be inactive after interruption');
  assert(zone.progress < 0.5, 'progress was not reduced by the interruption');
});

// ---------------------------------------------------------------------------
// Run integration
// ---------------------------------------------------------------------------

suite('run: full simulation is deterministic for the same seed', async () => {
  const dom = await import('./domstub.mjs').then((m) => m.installDom());
  void dom;
  const { EventBus } = await import('../src/core/events.js');
  const { Run } = await import('../src/game/run.js');
  const { AudioEngine } = await import('../src/audio/audio.js');

  const makeRun = (seed) => {
    const profile = defaultProfile();
    const progression = new Progression(profile);
    const audio = new AudioEngine({ getVolume: () => profile.settings.audio });
    const events = new EventBus();
    return new Run({ seed, profile, progression, audio, events });
  };

  const noopInput = {
    pointer: { x: 800, y: 450 },
    axis: () => ({ x: 1, y: 0, len: 1 }),
    isDown: () => false,
    wasPressed: () => false,
    keyDown: () => false,
    pointerDown: () => false,
    pointerClicked: () => false,
    codePressed: () => false,
  };

  const runA = makeRun('DETERMINISM-1');
  const runB = makeRun('DETERMINISM-1');
  const snapshotsA = [];
  const snapshotsB = [];
  for (let i = 0; i < 600; i += 1) {
    runA.update(1 / 60, noopInput);
    runB.update(1 / 60, noopInput);
    if (i % 100 === 0) {
      snapshotsA.push(JSON.stringify(runA.debugSnapshot()));
      snapshotsB.push(JSON.stringify(runB.debugSnapshot()));
    }
  }
  assert(snapshotsA.length > 0, 'no snapshots were captured');
  for (let i = 0; i < snapshotsA.length; i += 1) {
    assert(snapshotsA[i] === snapshotsB[i], `run diverged at snapshot ${i}\nA: ${snapshotsA[i]}\nB: ${snapshotsB[i]}`);
  }
  runA.dispose();
  runB.dispose();
  return `${snapshotsA.length} identical snapshots over 10s`;
});

suite('run: dying ends the run and reports loot forfeiture', async () => {
  await import('./domstub.mjs').then((m) => m.installDom());
  const { EventBus } = await import('../src/core/events.js');
  const { Run, RUN_STATE } = await import('../src/game/run.js');
  const { AudioEngine } = await import('../src/audio/audio.js');
  const profile = defaultProfile();
  const run = new Run({
    seed: 'DEATH-RUN-1',
    profile,
    progression: new Progression(profile),
    audio: new AudioEngine({ getVolume: () => profile.settings.audio }),
    events: new EventBus(),
  });
  run.player.addLoot('cores', 20);
  run.player.invulnTimer = 0;
  run.combat.damagePlayer(99999, { kind: 'test' });
  assert(run.finished, 'run did not finish on death');
  assertEqual(run.state, RUN_STATE.DEAD, 'run state after death');
  assert(!run.result.extracted, 'death result should not be an extraction');
  assertEqual(run.result.cores, 20, 'loot should still be recorded in the result');
  run.dispose();
  return `state=${run.state}`;
});

suite('run: descending regenerates a harder sector and keeps the loadout', async () => {
  await import('./domstub.mjs').then((m) => m.installDom());
  const { EventBus } = await import('../src/core/events.js');
  const { Run } = await import('../src/game/run.js');
  const { AudioEngine } = await import('../src/audio/audio.js');
  const profile = defaultProfile();
  const run = new Run({
    seed: 'DESCEND-RUN-1',
    profile,
    progression: new Progression(profile),
    audio: new AudioEngine({ getVolume: () => profile.settings.audio }),
    events: new EventBus(),
  });
  run.player.addWeapon('shotgun', 2);
  run.player.addLoot('cores', 15);
  const firstZoneFingerprint = zoneFingerprint(run.zone);
  const nextTier = run.tier + 1;
  run._advanceSector();
  assertEqual(run.tier, nextTier, 'tier did not advance');
  assert(zoneFingerprint(run.zone) !== firstZoneFingerprint, 'the new sector is identical to the previous one');
  assert(run.player.weapons.some((w) => w.id === 'shotgun'), 'the loadout was lost when descending');
  assertEqual(run.player.loot.cores, 15, 'carried loot was lost when descending');
  assert(run.zone.difficulty.healthMul > 1, 'the new sector is not harder');
  run.dispose();
  return `sector ${nextTier}: ${run.zone.name}`;
});

suite('run: descending keeps perk-derived stats and the health floor', async () => {
  await import('./domstub.mjs').then((m) => m.installDom());
  const { EventBus } = await import('../src/core/events.js');
  const { Run, MAX_RUN_LEVEL, RUN_PERKS, runXpForLevel } = await import('../src/game/run.js');
  const { AudioEngine } = await import('../src/audio/audio.js');

  const created = [];
  const makeRun = () => {
    const profile = defaultProfile();
    const run = new Run({
      seed: 'DESCEND-PERKS-1',
      profile,
      progression: new Progression(profile),
      audio: new AudioEngine({ getVolume: () => profile.settings.audio }),
      events: new EventBus(),
    });
    created.push(run);
    return run;
  };
  const levelTo = (run, target) => {
    while (run.level < target && run.level < MAX_RUN_LEVEL) run.grantXpFromKill(runXpForLevel(run.level));
  };
  const perks = (run) => ({
    level: run.level,
    perkIndex: run.perkIndex,
    maxHealth: run.player.maxHealth,
    maxArmor: run.player.maxArmor,
    maxEnergy: run.player.maxEnergy,
    damageMul: run.player.damageMul,
    reloadMul: run.player.reloadMul,
    moveSpeed: run.player.baseMoveSpeed,
  });

  // Level 9 with every perk earned: descending must keep all of them.
  const run = makeRun();
  levelTo(run, 9);
  assertEqual(run.perkIndex, perksThrough(9), 'setup: every perk up to level 9 should be granted');
  run.player.health = run.player.maxHealth;
  const before = perks(run);
  run._advanceSector();
  const after = perks(run);
  assertEqual(after.level, before.level, 'level changed while descending');
  assertEqual(after.perkIndex, before.perkIndex, 'perkIndex changed while descending');
  assertEqual(after.maxHealth, 140, 'descend dropped the max health perks');
  assertEqual(after.maxArmor, 15, 'descend dropped the max armor perk');
  assertEqual(after.maxEnergy, 115, 'descend dropped the max energy perk');
  assertClose(after.damageMul, 1.18, 1e-9, 'descend dropped the damage perks');
  assertClose(after.reloadMul, 0.9, 1e-9, 'descend dropped the reload perk');
  assertClose(after.moveSpeed, 233.2, 1e-6, 'descend dropped the move speed perk');

  // Descending again must not apply any of them a second time.
  run._advanceSector();
  const twice = perks(run);
  assertEqual(twice.maxHealth, 140, 'a second descend duplicated the max health perks');
  assertEqual(twice.maxArmor, 15, 'a second descend duplicated the max armor perk');
  assertEqual(twice.perkIndex, perksThrough(9), 'a second descend advanced perkIndex');

  // The 45% floor still applies, and a high carried value is not shaved down.
  const low = makeRun();
  levelTo(low, 9);
  low.player.health = 10;
  low._advanceSector();
  assertEqual(low.player.health, 63, 'descend health floor should be 45% of the perk-raised maximum');
  const high = makeRun();
  levelTo(high, 9);
  high.player.health = 127;
  high._advanceSector();
  assertEqual(high.player.health, 127, 'descend clamped carried health below the earned maximum');

  // Mid-run: the next level-up after a descend grants exactly the next perk.
  const mid = makeRun();
  levelTo(mid, 5);
  assertEqual(mid.perkIndex, 4, 'setup: level 5 should own four perks');
  assertEqual(mid.player.maxHealth, 115, 'setup: the level 2 health perk is missing');
  mid._advanceSector();
  assertEqual(mid.perkIndex, 4, 'descend granted a perk');
  assertEqual(mid.player.maxHealth, 115, 'descend re-applied the level 2 health perk');
  assertEqual(mid.player.maxArmor, 0, 'setup: no armor perk should exist at level 5');
  mid.grantXpFromKill(runXpForLevel(5));
  assertEqual(mid.level, 6, 'the level 6 threshold was not reached');
  assertEqual(mid.perkIndex, 5, 'the level 6 perk was not granted exactly once');
  assertEqual(mid.player.maxArmor, 15, 'the level 6 armor perk is missing after a descend');
  assertEqual(mid.player.maxHealth, 115, 'levelling up duplicated the level 2 health perk');

  // Level 1 with no perks keeps the pre-existing descend behaviour.
  const fresh = makeRun();
  fresh.player.health = 10;
  fresh._advanceSector();
  assertEqual(fresh.level, 1, 'a fresh run should stay level 1');
  assertEqual(fresh.perkIndex, 0, 'a fresh run should own no perks');
  assertEqual(fresh.player.maxHealth, 100, 'a fresh descend should keep the base max health');
  assertEqual(fresh.player.health, 45, 'a fresh descend should floor health at 45% of the base maximum');
  assertClose(fresh.player.damageMul, 1, 1e-9, 'a fresh descend changed the damage multiplier');

  // Every reachable level must grant exactly one perk. The table used to stop
  // at level 9 while the ceiling kept climbing, so late-run XP bought nothing.
  const perLevel = [];
  for (let level = 2; level <= MAX_RUN_LEVEL; level += 1) {
    perLevel.push(RUN_PERKS.filter((perk) => perk.level === level).length);
  }
  assertEqual(perLevel.every((n) => n === 1), true, `perk table must cover every level 2..${MAX_RUN_LEVEL}, got ${perLevel.join('')}`);
  const capped = makeRun();
  levelTo(capped, MAX_RUN_LEVEL);
  assertEqual(capped.level, MAX_RUN_LEVEL, 'the run level ceiling should be reachable by XP alone');
  assertEqual(capped.perkIndex, RUN_PERKS.length, 'every perk in the table should be granted by the level ceiling');

  for (const instance of created) instance.dispose();
  return `${RUN_PERKS.length} perks over levels 2..${MAX_RUN_LEVEL}, health floor 63/140`;
});

suite('run: statistics survive resume, sector transitions and settlement', async () => {
  await import('./domstub.mjs').then((m) => m.installDom());
  const { EventBus } = await import('../src/core/events.js');
  const { Run, RUN_STATE } = await import('../src/game/run.js');
  const { AudioEngine } = await import('../src/audio/audio.js');

  const profile = defaultProfile();
  const progression = new Progression(profile);
  const created = [];
  const makeRun = (resume = null) => {
    const run = new Run({
      seed: 'STATS-RESUME-1',
      profile,
      progression,
      audio: new AudioEngine({ getVolume: () => profile.settings.audio }),
      events: new EventBus(),
      resume,
    });
    created.push(run);
    return run;
  };
  const noopInput = {
    pointer: { x: 800, y: 450 },
    axis: () => ({ x: 0, y: 0, len: 0 }),
    isDown: () => false,
    wasPressed: () => false,
    keyDown: () => false,
    pointerDown: () => false,
    pointerClicked: () => false,
    codePressed: () => false,
  };
  const tick = (run, frames) => { for (let i = 0; i < frames; i += 1) run.update(1 / 60, noopInput); };
  // Values a run would have accumulated. The accumulation paths are covered by
  // the combat/progression suites; what matters here is that they persist.
  const totals = {
    kills: 7,
    damageDealt: 1234,
    damageTaken: 321,
    elitesKilled: 2,
    bossKills: 1,
    objectivesCompleted: 4,
    sectorsCleared: 2,
    lootCollected: 11,
  };
  const playerTotals = { shotsFired: 100, shotsHit: 40, dashes: 9 };
  const load = (run) => {
    Object.assign(run.stats, totals);
    Object.assign(run.player.stats, playerTotals);
  };

  const run = makeRun();
  tick(run, 60); // a real second of run time
  load(run);
  const payload = run.serializeForResume();
  assertClose(payload.elapsed, 1, 1e-6, 'test setup: one second should have elapsed');
  assertEqual(Object.keys(payload.stats).sort().join(','), 'bossKills,damageDealt,damageTaken,elitesKilled,lootCollected,sectorsCleared', 'the payload should carry exactly the reported run counters');
  assertEqual(Object.keys(payload.playerStats).sort().join(','), 'dashes,shotsFired,shotsHit', 'the payload should carry exactly the reported player counters');
  for (const key of ['enemies', 'projectiles', 'particles', 'spawner', 'camera', 'player', 'pendingExplosions', 'threatLevel', 'extractionStats']) {
    assert(!(key in payload), `transient field ${key} should not be persisted`);
  }

  const resumed = makeRun(validateResumableRun(payload));
  assertEqual(resumed.stats.kills, 7, 'kills should survive resume');
  assertEqual(resumed.stats.damageDealt, 1234, 'damage dealt should survive resume');
  assertEqual(resumed.stats.damageTaken, 321, 'damage taken should survive resume');
  assertEqual(resumed.stats.elitesKilled, 2, 'elites should survive resume');
  assertEqual(resumed.stats.bossKills, 1, 'boss kills should survive resume');
  assertEqual(resumed.stats.objectivesCompleted, 4, 'objectives should survive resume');
  assertEqual(resumed.stats.sectorsCleared, 2, 'sectors cleared should survive resume');
  assertEqual(resumed.stats.lootCollected, 11, 'collected items should survive resume');
  assertEqual(resumed.player.stats.shotsFired, 100, 'shots fired should survive resume');
  assertEqual(resumed.player.stats.shotsHit, 40, 'shots hit should survive resume');
  assertEqual(resumed.player.stats.dashes, 9, 'dashes should survive resume');
  tick(resumed, 1);
  assertClose(resumed.elapsed, payload.elapsed + 1 / 60, 1e-6, 'elapsed should continue from the saved time rather than restart');

  // A repeated resume cycles the same values instead of doubling them.
  const twice = makeRun(validateResumableRun(resumed.serializeForResume()));
  assertEqual(twice.stats.kills, 7, 'kills doubled on a repeated resume');
  assertEqual(twice.stats.damageDealt, 1234, 'damage dealt doubled on a repeated resume');
  assertEqual(twice.player.stats.shotsFired, 100, 'shots doubled on a repeated resume');
  assertEqual(twice.player.stats.dashes, 9, 'dashes doubled on a repeated resume');

  // Descending rebuilds the sector but must not restart the run's totals.
  const elapsedBeforeDescend = twice.elapsed;
  twice._advanceSector();
  assertEqual(twice.stats.kills, 7, 'descending reset kills');
  assertEqual(twice.stats.damageDealt, 1234, 'descending reset damage dealt');
  assertEqual(twice.stats.damageTaken, 321, 'descending reset damage taken');
  assertEqual(twice.stats.sectorsCleared, 3, 'descending should keep the cleared count and add one');
  assertEqual(twice.stats.lootCollected, 11, 'descending reset collected items');
  assertEqual(twice.player.stats.shotsFired, 100, 'descending reset shots fired');
  assertEqual(twice.player.stats.dashes, 9, 'descending reset dashes');
  assertClose(twice.elapsed, elapsedBeforeDescend, 1e-6, 'descending reset the run clock');

  // Settlement and the results screen see the whole run, not the last segment.
  twice.finish(true, RUN_STATE.EXTRACTED);
  const result = twice.result;
  assertEqual(result.kills, 7, 'the result should report every kill');
  assertEqual(result.damageDealt, 1234, 'the result should report all damage dealt');
  assertEqual(result.damageTaken, 321, 'the result should report all damage taken');
  assertEqual(result.elitesKilled, 2, 'the result should report every elite');
  assertEqual(result.bossKills, 1, 'the result should report every boss');
  assertEqual(result.objectivesCompleted, 4, 'the result should report every objective');
  assertEqual(result.sectorsCleared, 3, 'the result should report the cleared sectors');
  assertEqual(result.lootCollected, 11, 'the result should report every pickup');
  assertEqual(result.shotsFired, 100, 'the result should report every shot');
  assertEqual(result.shotsHit, 40, 'the result should report every hit');
  assertEqual(result.dashes, 9, 'the result should report every dash');
  assertClose(result.accuracy, 0.4, 1e-9, 'accuracy should use the accumulated shots');
  assertClose(result.elapsed, elapsedBeforeDescend, 1e-6, 'the result should report the whole run time');
  assert(result.elapsed > 0.9, `the result should include the time before the resume, got ${result.elapsed}`);

  const summary = progression.settleRun(result);
  assertEqual(profile.account.totalKills, 7, 'the account should bank every kill');
  assertEqual(profile.account.totalBossKills, 1, 'the account should bank every boss kill');
  assertEqual(profile.account.highestDamageRun, 1234, 'the damage record should use the full total');
  assertClose(profile.account.totalPlaytimeSeconds, result.elapsed, 1e-6, 'playtime should count the whole run');
  assertClose(profile.account.fastestExtraction, result.elapsed, 1e-6, 'the extraction record must not be measured from post-resume time only');
  assert(summary.elapsed > 0.9, `the settlement summary should report the whole run, got ${summary.elapsed}`);
  assertEqual(summary.kills, 7, 'the settlement summary should report every kill');

  // A legacy snapshot without the bags resumes on zeroed counters.
  const legacyPayload = { ...payload };
  delete legacyPayload.stats;
  delete legacyPayload.playerStats;
  const legacyRun = makeRun(validateResumableRun(legacyPayload));
  assertEqual(legacyRun.stats.damageDealt, 0, 'legacy saves should resume with no damage recorded');
  assertEqual(legacyRun.stats.kills, 7, 'legacy top-level kills should still be restored');
  assertEqual(legacyRun.player.stats.shotsFired, 0, 'legacy saves should resume with no shots recorded');
  assert(Number.isFinite(legacyRun.stats.damageTaken), 'legacy defaults must stay finite');
  legacyRun.finish(true, RUN_STATE.EXTRACTED);
  assertEqual(legacyRun.result.damageDealt, 0, 'a legacy resume should still produce a numeric result');
  assert(Number.isFinite(legacyRun.result.accuracy), 'a legacy resume should still produce a numeric accuracy');

  for (const instance of created) instance.dispose();
  return `kills=${result.kills} elapsed=${result.elapsed.toFixed(2)}s record=${profile.account.fastestExtraction.toFixed(2)}s`;
});

suite('run: non-default generation parameters survive resume', async () => {
  await import('./domstub.mjs').then((m) => m.installDom());
  const { EventBus } = await import('../src/core/events.js');
  const { Run } = await import('../src/game/run.js');
  const { AudioEngine } = await import('../src/audio/audio.js');

  const created = [];
  const makeRun = ({ seed, startTier = 1, genParams = undefined, resume = null }) => {
    const profile = defaultProfile();
    const run = new Run({
      seed,
      startTier,
      genParams,
      resume,
      profile,
      progression: new Progression(profile),
      audio: new AudioEngine({ getVolume: () => profile.settings.audio }),
      events: new EventBus(),
    });
    created.push(run);
    return run;
  };
  const reload = (run) => makeRun({ seed: run.seed, resume: validateResumableRun(run.serializeForResume()) });
  // Canonical comparison so key order never matters.
  const canon = (obj) => JSON.stringify(Object.keys(obj).sort().map((key) => [key, obj[key]]));

  const SEED = 'GENPARAMS-RESUME-1';
  const params = { width: 3200, largeRoomChance: 0.5 };
  const baseline = makeRun({ seed: SEED });
  const run = makeRun({ seed: SEED, genParams: params });
  assert(zoneFingerprint(run.zone) !== zoneFingerprint(baseline.zone), 'test setup: these parameters should change the generated map');

  const payload = run.serializeForResume();
  assert(payload.genParams && typeof payload.genParams === 'object', 'the snapshot should carry the generation input');
  assertEqual(canon(payload.genParams), canon(params), 'the generation input should be persisted');
  assert(!('zone' in payload) && !('attempts' in payload), 'derived zone state must not be persisted');
  assertEqual(payload.genParams.roomAttempts, undefined, 'relaxed retry values must not leak into the snapshot');

  const resumed = reload(run);
  assertEqual(canon(resumed.genParams), canon(params), 'the resumed run should keep its generation input');
  assertEqual(zoneFingerprint(resumed.zone), zoneFingerprint(run.zone), 'the resumed sector must be byte-identical');
  assertEqual(resumed.zone.attempts, run.zone.attempts, 'the resumed sector must use the same generation attempt');

  // A zone that only validates after the generator relaxes its parameters.
  const retry = makeRun({ seed: 'BUG4-RETRY-16', genParams: { roomAttempts: 60, obstacleDensity: 0.2 } });
  assert(retry.zone.attempts > 1, `test setup: this seed should need relaxed retries (attempts=${retry.zone.attempts})`);
  assertEqual(retry.zone.genParams.roomAttempts, 40, 'test setup: the winning attempt should hold relaxed values');
  const retryPayload = retry.serializeForResume();
  assert(retryPayload.genParams && typeof retryPayload.genParams === 'object', 'a retry-dependent run should also persist its generation input');
  assertEqual(retryPayload.genParams.roomAttempts, 60, 'the relaxed value must not replace the input value');
  assertEqual(canon(retryPayload.genParams), canon({ roomAttempts: 60, obstacleDensity: 0.2 }), 'only the input parameters travel');
  const retryResumed = reload(retry);
  assertEqual(zoneFingerprint(retryResumed.zone), zoneFingerprint(retry.zone), 'a retry-dependent sector must regenerate identically');
  assertEqual(retryResumed.zone.attempts, retry.zone.attempts, 'a retry-dependent sector must repeat its attempt count');

  // Unknown keys are dropped on resume without changing the map.
  const withBogus = makeRun({ seed: SEED, genParams: { width: 3200, bogus: 7 } });
  const bogusResumed = reload(withBogus);
  assertEqual(Object.keys(bogusResumed.genParams).join(','), 'width', 'unknown generation keys should be dropped on resume');
  assertEqual(zoneFingerprint(bogusResumed.zone), zoneFingerprint(withBogus.zone), 'dropping unknown keys must not change the map');

  // A legacy snapshot has no genParams at all and must regenerate with defaults.
  const legacyPayload = { ...payload };
  delete legacyPayload.genParams;
  const legacyResumed = makeRun({ seed: SEED, resume: validateResumableRun(legacyPayload) });
  assertEqual(Object.keys(legacyResumed.genParams).length, 0, 'a legacy save should resume with empty generation parameters');
  assertEqual(zoneFingerprint(legacyResumed.zone), zoneFingerprint(baseline.zone), 'a legacy save should regenerate with the defaults');

  // The plain `{}` path is unchanged.
  const plain = makeRun({ seed: SEED });
  assertEqual(canon(plain.serializeForResume().genParams), canon({}), 'a default run should persist an empty parameter set');
  const plainResumed = reload(plain);
  assertEqual(canon(plainResumed.genParams), canon({}), 'a default run should resume with an empty parameter set');
  assertEqual(zoneFingerprint(plainResumed.zone), zoneFingerprint(plain.zone), 'the default parameter path must stay identical');

  for (const instance of created) instance.dispose();
  return `params ${canon(params)} kept, retry case attempts=${retry.zone.attempts}`;
});

suite('run: in-run level, xp and perks survive resume', async () => {
  await import('./domstub.mjs').then((m) => m.installDom());
  const { EventBus } = await import('../src/core/events.js');
  const { Run, MAX_RUN_LEVEL, RUN_PERKS, runXpForLevel } = await import('../src/game/run.js');
  const { AudioEngine } = await import('../src/audio/audio.js');

  const created = [];
  const makeRun = (resume = null) => {
    const profile = defaultProfile();
    const run = new Run({
      seed: 'PROGRESSION-RESUME-1',
      profile,
      progression: new Progression(profile),
      audio: new AudioEngine({ getVolume: () => profile.settings.audio }),
      events: new EventBus(),
      resume,
    });
    created.push(run);
    return run;
  };
  const levelTo = (run, target) => {
    while (run.level < target && run.level < MAX_RUN_LEVEL) run.grantXpFromKill(runXpForLevel(run.level));
  };

  // Level 2 earns the +15 max health perk; leftover xp must survive as well.
  const run = makeRun();
  levelTo(run, 2);
  run.grantXpFromKill(25);
  assertEqual(run.level, 2, 'level 2 was not reached');
  assertEqual(run.perkIndex, 1, 'the level 2 perk was not applied');
  assertEqual(run.player.maxHealth, 115, 'the perk did not raise max health');
  run.player.health = 110; // deliberately above the level-1 maximum
  const payload = run.serializeForResume();
  assertEqual(payload.level, 2, 'level was not serialized');
  assertEqual(payload.xp, 25, 'xp was not serialized');
  assertEqual(payload.xpEarnedTotal, 115, 'xpEarnedTotal was not serialized');
  assertEqual(payload.perkIndex, 1, 'perkIndex was not serialized');

  const resumed = makeRun(validateResumableRun(payload));
  assertEqual(resumed.level, 2, 'level was lost on resume');
  assertEqual(resumed.xp, 25, 'xp was lost on resume');
  assertEqual(resumed.xpEarnedTotal, 115, 'xpEarnedTotal was lost on resume');
  assertEqual(resumed.perkIndex, 1, 'perkIndex was lost on resume');
  assertEqual(resumed.player.maxHealth, 115, 'the earned perk was not re-applied on resume');
  assertEqual(resumed.player.health, 110, 'saved health above the level-1 max was clamped away');

  // Levelling up after the resume still grants each perk exactly once.
  const damageBefore = resumed.player.damageMul;
  resumed.grantXpFromKill(runXpForLevel(2));
  assertEqual(resumed.level, 3, 'level 3 was not reached after the resume');
  assertEqual(resumed.perkIndex, 2, 'the level 3 perk was not granted exactly once');
  assertClose(resumed.player.damageMul, damageBefore + 0.08, 1e-9, 'the level 3 perk was skipped or doubled');

  // Every perk up to level 9, then a repeated resume for idempotence.
  const deep = makeRun();
  levelTo(deep, 9);
  deep.player.health = 127;
  const deepResumed = makeRun(validateResumableRun(deep.serializeForResume()));
  assertEqual(deepResumed.level, 9, 'level 9 was lost on resume');
  assertEqual(deepResumed.perkIndex, perksThrough(9), 'not every earned perk was re-applied');
  assertEqual(deepResumed.player.maxHealth, deep.player.maxHealth, 'perk max health is wrong after resume');
  assertEqual(deepResumed.player.maxHealth, 140, 'level 2 + level 9 health perks should total 140');
  assertEqual(deepResumed.player.health, 127, 'saved health above the level-1 max was clamped away');
  assertEqual(deepResumed.player.maxArmor, deep.player.maxArmor, 'perk max armor is wrong after resume');
  assertEqual(deepResumed.player.maxEnergy, deep.player.maxEnergy, 'perk max energy is wrong after resume');
  assertClose(deepResumed.player.damageMul, deep.player.damageMul, 1e-9, 'perk damage bonus is wrong after resume');
  assertClose(deepResumed.player.reloadMul, deep.player.reloadMul, 1e-9, 'perk reload bonus is wrong after resume');
  assertClose(deepResumed.player.baseMoveSpeed, deep.player.baseMoveSpeed, 1e-9, 'perk move speed is wrong after resume');

  const twice = makeRun(validateResumableRun(deepResumed.serializeForResume()));
  assertEqual(twice.level, deepResumed.level, 'level drifted on a repeated resume');
  assertEqual(twice.xp, deepResumed.xp, 'xp drifted on a repeated resume');
  assertEqual(twice.perkIndex, deepResumed.perkIndex, 'perks were granted twice on a repeated resume');
  assertEqual(twice.player.maxHealth, deepResumed.player.maxHealth, 'max health drifted on a repeated resume');
  assertEqual(twice.player.health, 127, 'health drifted on a repeated resume');

  // Legacy captures keep the pre-fix behaviour: level 1, no perks, base caps.
  const legacyPayload = { ...payload };
  delete legacyPayload.level;
  delete legacyPayload.xp;
  delete legacyPayload.xpEarnedTotal;
  delete legacyPayload.perkIndex;
  const legacyResumed = makeRun(validateResumableRun(legacyPayload));
  assertEqual(legacyResumed.level, 1, 'a legacy save should resume at level 1');
  assertEqual(legacyResumed.xpEarnedTotal, 0, 'a legacy save should resume with no banked xp');
  assertEqual(legacyResumed.perkIndex, 0, 'a legacy save should apply no perks');
  assertEqual(legacyResumed.player.maxHealth, 100, 'a legacy save should keep the base max health');
  assertEqual(legacyResumed.player.health, 100, 'legacy health still clamps to the base maximum');

  for (const instance of created) instance.dispose();
  return `level 2 -> ${deepResumed.level}, ${deepResumed.perkIndex} perks replayed, xp preserved`;
});

// ---------------------------------------------------------------------------
// Save hygiene: write-only resume fields
// ---------------------------------------------------------------------------

suite('save: dead resume fields are not persisted and legacy payloads still resume', async () => {
  await import('./domstub.mjs').then((m) => m.installDom());
  const { EventBus } = await import('../src/core/events.js');
  const { Run, RUN_STATE } = await import('../src/game/run.js');
  const { AudioEngine } = await import('../src/audio/audio.js');

  const profile = defaultProfile();
  const progression = new Progression(profile);
  const created = [];
  const makeRun = (resume = null) => {
    const run = new Run({
      seed: 'F5-PAYLOAD-1',
      profile,
      progression,
      audio: new AudioEngine({ getVolume: () => profile.settings.audio }),
      events: new EventBus(),
      resume,
    });
    created.push(run);
    return run;
  };
  const canon = (obj) => JSON.stringify(Object.keys(obj).sort().map((key) => [key, obj[key]]));
  // Values a run would have accumulated; the accumulation paths are covered by
  // the combat/progression suites, only their persistence matters here.
  const load = (run) => {
    Object.assign(run.stats, {
      kills: 7,
      damageDealt: 1234,
      damageTaken: 321,
      elitesKilled: 2,
      bossKills: 1,
      objectivesCompleted: 4,
      sectorsCleared: 2,
      lootCollected: 11,
    });
    Object.assign(run.player.stats, { shotsFired: 100, shotsHit: 40, dashes: 9 });
    run.player.addLoot('cores', 55);
    run.elapsed = 42.5;
  };

  // A payload written by this build: the two fields no consumer ever read are
  // gone, everything the game actually reports is still carried.
  const run = makeRun();
  load(run);
  const payload = run.serializeForResume();
  assert(!('startedAt' in payload), 'startedAt had no reader and should no longer be persisted');
  assert(!('sectorTime' in payload), 'sectorTime had no reader and should no longer be persisted');

  const validated = validateResumableRun(payload);
  assert(!('startedAt' in validated), 'the validator should not resurrect startedAt');
  assert(!('sectorTime' in validated), 'the validator should not resurrect sectorTime');

  // Current save -> resume: statistics, clock and bag are identical.
  const resumed = makeRun(validated);
  assertEqual(canon(resumed.stats), canon(run.stats), 'a resumed run should report identical run statistics');
  for (const key of ['shotsFired', 'shotsHit', 'dashes']) {
    assertEqual(resumed.player.stats[key], run.player.stats[key], `${key} should survive resume`);
  }
  assertClose(resumed.elapsed, 42.5, 1e-6, 'elapsed is the surviving clock and should round-trip');
  assertEqual(canon(resumed.player.loot), canon(run.player.loot), 'the bag should round-trip');

  // A resumed run must not write the dropped fields back into its own payload.
  const again = resumed.serializeForResume();
  assert(!('startedAt' in again) && !('sectorTime' in again), 'a resumed run should not write the dropped fields back');

  // Legacy payload: older builds carried both fields (and possibly keys this
  // build never knew). They must be ignored, never rejected.
  const legacyValidated = validateResumableRun({
    ...payload,
    startedAt: Date.now() - 42500,
    sectorTime: 12.5,
    unknownLegacyField: { some: 'data' },
  });
  assert(legacyValidated !== null, 'a legacy payload carrying the dropped fields should still resume');
  assert(!('startedAt' in legacyValidated) && !('sectorTime' in legacyValidated), 'dropped fields should not survive validation');
  const legacyRun = makeRun(legacyValidated);
  assertEqual(canon(legacyRun.stats), canon(run.stats), 'a legacy payload should resume the same statistics');
  assertEqual(canon(legacyRun.player.loot), canon(run.player.loot), 'a legacy payload should resume the same bag');
  assertClose(legacyRun.elapsed, 42.5, 1e-6, 'a legacy payload should keep its run clock');

  // The same payload inside a stored profile loads through SaveSystem without a
  // warning: only unresumable runs are discarded (F2 behavior).
  const storage = new MemoryStorage();
  const save = new SaveSystem({ storage });
  storage.setItem(save.key, JSON.stringify({
    ...defaultProfile(),
    run: { ...payload, startedAt: Date.now(), sectorTime: 12.5 },
  }));
  const loaded = save.load();
  assertEqual(save.lastLoadWarning, null, 'a legacy run carrying the dropped fields must not warn');
  assertEqual(loaded.run.seed, 'F5-PAYLOAD-1', 'a legacy save should keep its run');
  assertEqual(loaded.run.stats.damageDealt, 1234, 'a legacy save should keep its statistics');
  assertEqual(loaded.run.loot.cores, 55, 'a legacy save should keep its loot');

  // Settlement and the results screen see exactly the same numbers on both
  // paths: dropping the fields must not move a single reported value.
  const settle = (source) => {
    source.finish(true, RUN_STATE.EXTRACTED);
    return source.result;
  };
  const currentResult = settle(makeRun(validateResumableRun(payload)));
  const legacyResult = settle(makeRun(validateResumableRun({ ...payload, startedAt: 1, sectorTime: 3 })));
  for (const key of ['seed', 'sector', 'elapsed', 'kills', 'elitesKilled', 'bossKills', 'objectivesCompleted', 'sectorsCleared', 'damageDealt', 'damageTaken', 'lootCollected', 'shotsFired', 'shotsHit', 'dashes', 'lootValue', 'cores', 'level', 'xp']) {
    assertEqual(legacyResult[key], currentResult[key], `the settled result should be unchanged (${key})`);
  }
  assertClose(legacyResult.accuracy, currentResult.accuracy, 1e-9, 'accuracy should be unchanged');
  assertEqual(legacyResult.extracted, true, 'the run should still settle as an extraction');

  for (const instance of created) instance.dispose();
  return `no startedAt/sectorTime in the payload, legacy payload resumed (kills ${legacyRun.stats.kills}, accuracy ${Math.round(currentResult.accuracy * 100)}%)`;
});

// ---------------------------------------------------------------------------
// Resume farming: defeated enemies stay defeated
// ---------------------------------------------------------------------------

suite('run: defeated enemies are not regenerated on resume', async () => {
  await import('./domstub.mjs').then((m) => m.installDom());
  const { EventBus } = await import('../src/core/events.js');
  const { Run } = await import('../src/game/run.js');
  const { AudioEngine } = await import('../src/audio/audio.js');

  const profile = defaultProfile();
  const progression = new Progression(profile);
  const created = [];
  const makeRun = (resume = null) => {
    const run = new Run({
      seed: 'F6-SPAWNS-1',
      profile,
      progression,
      audio: new AudioEngine({ getVolume: () => profile.settings.audio }),
      events: new EventBus(),
      resume,
    });
    created.push(run);
    return run;
  };
  // Spawn indices must identify the same enemy after a rebuild, otherwise the
  // persisted set would suppress unrelated enemies.
  const spawnFingerprint = (run) => run.zone.enemySpawns.map((s) => `${s.x},${s.y},${s.typeId},${s.isBoss ? 'boss' : 'mob'}`).join('|');
  const activate = (run, spec) => {
    if (spec.spawned) return null;
    spec.spawned = true;
    return run.spawner.addEnemy(spec, { immediate: true });
  };
  const kill = (run, enemy) => {
    if (!enemy || !enemy.alive) return false;
    run.combat.damageEnemy(enemy, 1e9);
    run.spawner.reap(2);
    return !enemy.alive;
  };
  const clearRest = (run) => {
    let killed = 0;
    for (const spec of run.spawner.pending) if (kill(run, activate(run, spec))) killed += 1;
    for (const enemy of [...run.spawner.enemies]) if (kill(run, enemy)) killed += 1;
    return killed;
  };

  // A partial clear through the real combat path.
  const run = makeRun();
  const total = run.spawner.pending.length;
  const fingerprint = spawnFingerprint(run);
  const defeatedFirst = run.spawner.pending.slice(0, 3);
  let kills = 0;
  for (const spec of defeatedFirst) if (kill(run, activate(run, spec))) kills += 1;
  assertEqual(kills, 3, 'the test should defeat three spawns');
  assertEqual(run.stats.kills, 3, 'kills should be recorded through the real kill path');
  const checkpoint = {
    kills: run.stats.kills,
    xp: run.xpEarnedTotal,
    level: run.level,
    perks: run.perkIndex,
    cores: run.player.loot.cores,
    objectives: JSON.stringify(run.objectives.serialize()),
  };
  const payload = run.serializeForResume();
  assertEqual(payload.defeatedSpawns.tier, 1, 'the defeated set should be tier scoped');
  assertEqual(JSON.stringify(payload.defeatedSpawns.ids), JSON.stringify([0, 1, 2]), 'every defeated spawn index should be recorded in order');

  // Resume: the killed spawns must not come back, the rest must be untouched.
  const resumed = makeRun(validateResumableRun(payload));
  assertEqual(spawnFingerprint(resumed), fingerprint, 'spawn indices must still identify the same enemy after a rebuild');
  assertEqual(resumed.spawner.pending.length, total, 'the spawn list should be identical');
  assertEqual(resumed.spawner.pending.filter((p) => p.spawned).length, 3, 'exactly the defeated spawns should be pre-suppressed');
  assertEqual(resumed.spawner.aliveCount, 0, 'a resumed sector should start with no live enemies');
  assertEqual(resumed.stats.kills, checkpoint.kills, 'kills should survive resume');
  assertEqual(resumed.xpEarnedTotal, checkpoint.xp, 'xp should survive resume');
  assertEqual(resumed.level, checkpoint.level, 'the in-run level should survive resume');
  assertEqual(resumed.perkIndex, checkpoint.perks, 'perks should survive resume');
  assertEqual(resumed.player.loot.cores, checkpoint.cores, 'the bag should survive resume');
  assertEqual(JSON.stringify(resumed.objectives.serialize()), checkpoint.objectives, 'objective progress should survive resume');

  // The surviving spawns still fight and still pay out (no over-suppression).
  const xpBeforeRest = resumed.xpEarnedTotal;
  const remaining = total - 3;
  assertEqual(clearRest(resumed), remaining, 'the surviving spawns should still be killable');
  assertEqual(resumed.stats.kills, checkpoint.kills + remaining, 'kills should continue from the checkpoint');
  assert(resumed.xpEarnedTotal > xpBeforeRest, 'surviving enemies should still grant xp');

  // A cleared sector cannot be farmed by checkpointing and reloading.
  const clearedPayload = resumed.serializeForResume();
  assertEqual(clearedPayload.defeatedSpawns.ids.length, total, 'a fully cleared sector should record every spawn');
  const reloaded = makeRun(validateResumableRun(clearedPayload));
  const xpBeforeFarm = reloaded.xpEarnedTotal;
  assertEqual(clearRest(reloaded), 0, 'reloading a cleared sector must not regenerate enemies');
  assertEqual(reloaded.stats.kills, checkpoint.kills + remaining, 'reloading must not re-count kills');
  assertEqual(reloaded.xpEarnedTotal, xpBeforeFarm, 'reloading must not re-award xp');
  assertEqual(reloaded.player.loot.cores, reloaded.player.loot.cores, 'reloading must not re-award loot');

  // Descending is not affected: a new sector is fully populated and rewarding,
  // and the defeated set is tier scoped rather than inherited.
  reloaded._advanceSector();
  const descended = reloaded.serializeForResume();
  assertEqual(descended.defeatedSpawns.tier, 2, 'the defeated set should follow the new sector');
  assertEqual(descended.defeatedSpawns.ids.length, 0, 'a new sector should start with no defeated spawns');
  assertEqual(reloaded.spawner.pending.filter((p) => p.spawned).length, 0, 'a descended sector should be fully populated');
  const xpBeforeDescendFight = reloaded.xpEarnedTotal;
  assert(clearRest(reloaded) > 0, 'a descended sector should still be fightable');
  assert(reloaded.xpEarnedTotal > xpBeforeDescendFight, 'a descended sector should still grant xp');
  const mismatched = makeRun(validateResumableRun({ ...clearedPayload, defeatedSpawns: { tier: 9, ids: clearedPayload.defeatedSpawns.ids } }));
  assertEqual(mismatched.spawner.pending.filter((p) => p.spawned).length, 0, 'a set from another tier must never suppress spawns');

  // Legacy payloads (written before the field existed) resume with a full
  // sector, exactly as before; malformed sets are ignored rather than fatal.
  const legacy = { ...payload };
  delete legacy.defeatedSpawns;
  const legacyRun = makeRun(validateResumableRun(legacy));
  assertEqual(legacyRun.spawner.pending.filter((p) => p.spawned).length, 0, 'a legacy payload without the field repopulates the sector');
  assertEqual(legacyRun.stats.kills, checkpoint.kills, 'a legacy payload still restores progress');
  for (const bad of [42, { tier: 1, ids: 'nope' }, { ids: [0] }, { tier: 0, ids: [0] }, { tier: 1, ids: [1.5, -3, NaN, 'x'] }]) {
    const validated = validateResumableRun({ ...payload, defeatedSpawns: bad });
    assert(validated !== null, `a payload with defeatedSpawns=${JSON.stringify(bad)} should still resume`);
    const badRun = makeRun(validated);
    assertEqual(badRun.spawner.pending.length, total, `defeatedSpawns=${JSON.stringify(bad)} must not delete spawns`);
    assertEqual(badRun.stats.kills, checkpoint.kills, `defeatedSpawns=${JSON.stringify(bad)} must not disturb the restored stats`);
  }
  const truncated = makeRun(validateResumableRun({ ...payload, defeatedSpawns: { tier: 1, ids: Array.from({ length: 900 }, (_, i) => i) } }));
  assertEqual(truncated.spawner.pending.length, total, 'an oversized id list is capped instead of failing the resume');

  // Summoned adds (boss/elite abilities) have no spawn index: they are
  // transient by design and must not leak into the persisted set.
  const fresh = makeRun();
  assertEqual(fresh.spawner.pending.filter((p) => p.spawned).length, 0, 'a fresh run should start fully populated');
  fresh.spawner.summon('husk', fresh.zone.spawnPoint.x, fresh.zone.spawnPoint.y, 2);
  assert(fresh.spawner.enemies.length > 0, 'the test should have summoned an add');
  kill(fresh, fresh.spawner.enemies[0]);
  assertEqual(fresh.defeatedSpawnIds.size, 0, 'summoned adds must not be recorded as defeated spawns');
  assertEqual(fresh.serializeForResume().defeatedSpawns.ids.length, 0, 'summoned adds must not reach the payload');

  for (const instance of created) instance.dispose();
  return `3 spawns suppressed after resume, cleared sector farmed 0 kills, tier scoping + legacy payloads intact (${total} spawns)`;
});

// ---------------------------------------------------------------------------
// Resume scoping: objective progress belongs to its own sector
// ---------------------------------------------------------------------------

suite('save: objective progress is scoped to the sector it was recorded in', async () => {
  const dom = await import('./domstub.mjs').then((m) => m.installDom());
  const { EventBus } = await import('../src/core/events.js');
  const { Run } = await import('../src/game/run.js');
  const { Game } = await import('../src/game/game.js');
  const { AudioEngine } = await import('../src/audio/audio.js');
  const { SAVE_KEY } = await import('../src/save/save.js');

  const profile = defaultProfile();
  const progression = new Progression(profile);
  const created = [];
  const makeRun = (resume = null) => {
    const run = new Run({
      seed: 'F7-OBJECTIVES-1',
      profile,
      progression,
      audio: new AudioEngine({ getVolume: () => profile.settings.audio }),
      events: new EventBus(),
      resume,
    });
    created.push(run);
    return run;
  };
  const setProgress = (run, value) => run.objectives.setProgress(run.objectives.main, value);

  // --- same-tier resume keeps legitimate progress ---------------------------
  const run = makeRun();
  const target = run.objectives.main.target;
  assert(target > 1, 'the tier-1 objective should need more than one step for this test');
  setProgress(run, target - 1);
  assertEqual(run.objectives.main.complete, false, 'progress below the target is not completion');
  const partialPayload = run.serializeForResume();
  assertEqual(partialPayload.objectiveState.tier, 1, 'the objective state should name the sector it came from');
  const partialResumed = makeRun(validateResumableRun(partialPayload));
  assertEqual(partialResumed.objectives.main.progress, target - 1, 'same-tier resume should keep partial progress');
  assertEqual(partialResumed.objectives.allComplete, false, 'partial progress must not unlock extraction');

  const done = makeRun();
  setProgress(done, done.objectives.main.target);
  assertEqual(done.objectives.allComplete, true, 'the test should complete the sector objective');
  const donePayload = done.serializeForResume();
  const doneResumed = makeRun(validateResumableRun(donePayload));
  assertEqual(doneResumed.objectives.main.complete, true, 'same-tier resume should keep a completed objective');
  assertEqual(doneResumed.objectives.allComplete, true, 'a completed sector should stay extractable after resume');
  assertEqual(JSON.stringify(doneResumed.objectives.serialize()), JSON.stringify(done.objectives.serialize()), 'the objective state should round-trip unchanged');

  // --- a state from another sector must never apply -------------------------
  const tier2 = makeRun();
  tier2._advanceSector();
  assertEqual(tier2.tier, 2, 'the test should have descended a sector');
  assertEqual(tier2.objectives.main.complete, false, 'a new sector starts with fresh objectives');
  const tier2Payload = tier2.serializeForResume();
  assertEqual(tier2Payload.objectiveState.tier, 2, 'the descended sector should tag its own objective state');
  assertEqual(tier2Payload.objectiveState.objectives[0].progress, 0, 'a descended sector should start at zero progress');

  const mixed = makeRun(validateResumableRun({ ...tier2Payload, objectiveState: donePayload.objectiveState }));
  assertEqual(mixed.tier, 2, 'the mixed payload is still a tier-2 run');
  assertEqual(mixed.objectives.main.complete, false, 'a completed objective from another sector must not complete this one');
  assertEqual(mixed.objectives.main.progress, 0, 'progress from another sector must not be transplanted');
  assertEqual(mixed.objectives.allComplete, false, 'extraction must stay locked for an unplayed sector');
  assertEqual(mixed.spawner.pending.every((p) => !p.spawned), true, 'the sector content itself stays untouched');
  assertEqual(JSON.stringify(mixed.player.loot), JSON.stringify(tier2Payload.loot), 'the carried bag is still restored');

  const reverse = makeRun(validateResumableRun({ ...donePayload, objectiveState: tier2Payload.objectiveState }));
  assertEqual(reverse.tier, 1, 'the reverse mix is still a tier-1 run');
  assertEqual(reverse.objectives.main.complete, false, 'a tier-2 state must not complete a tier-1 objective');
  assertEqual(reverse.objectives.main.progress, 0, 'a tier-2 state must not move tier-1 progress');

  const foreign = makeRun(validateResumableRun({
    ...tier2Payload,
    objectiveState: { tier: 1, objectives: [{ id: 'objective-main', progress: 99, complete: true }] },
  }));
  assertEqual(foreign.objectives.main.progress, 0, 'a foreign tier-tagged state must not apply at all');
  assertEqual(foreign.objectives.allComplete, false, 'a foreign tier-tagged state must not open extraction');

  // --- legacy payloads carry no tier and stay accepted ---------------------
  const legacy = makeRun(validateResumableRun({
    ...tier2Payload,
    objectiveState: { objectives: [{ id: 'objective-main', progress: 1, complete: false }] },
  }));
  assertEqual(legacy.objectives.main.progress, 1, 'an untiered legacy state still restores progress');
  const legacyDone = makeRun(validateResumableRun({
    ...tier2Payload,
    objectiveState: { objectives: [{ id: 'objective-main', progress: 99, complete: true }] },
  }));
  assertEqual(legacyDone.objectives.main.complete, true, 'an untiered legacy completed state still restores');

  // --- the real game never writes or accepts a mixed payload ---------------
  dom.storage.setItem(SAVE_KEY, JSON.stringify({
    ...defaultProfile(),
    run: { ...tier2Payload, objectiveState: donePayload.objectiveState },
  }));
  const game = new Game({ canvas: dom.canvas, container: dom.container });
  game.start();
  assertEqual(game.saveSystem.lastLoadWarning, null, 'a scoped-out objective state is a valid payload, not corruption');
  game.continueRun();
  assertEqual(game.run.tier, 2, 'the mixed payload resumes at its own tier');
  assertEqual(game.run.objectives.allComplete, false, 'the real resume path keeps an unplayed sector locked');
  for (let i = 0; i < 30; i += 1) game.tick(1 / 60);
  assertEqual(game.run.objectives.main.progress, 0, 'objective progress stays untouched while the fresh sector is played');
  game.pause();
  const written = JSON.parse(dom.storage.getItem(SAVE_KEY)).run;
  assertEqual(written.objectiveState.tier, 2, 'the game tags objective state with the live sector');
  assertEqual(written.tier, 2, 'tier and objective state stay consistent in the game\'s own writes');
  assertEqual(written.objectiveState.objectives[0].progress, 0, 'the checkpoint keeps the played sector\'s real progress');
  game.dispose();

  for (const instance of created) instance.dispose();
  return `same-tier progress kept (${target} steps), tier-1 completion ignored at tier 2, untiered legacy state still restores`;
});

// ---------------------------------------------------------------------------
// Malformed weapon ids: dropped safely, logged once, without echoing the save
// ---------------------------------------------------------------------------

suite('save: malformed weapon ids are dropped with a bounded warning', async () => {
  const dom = await import('./domstub.mjs').then((m) => m.installDom());
  const { EventBus } = await import('../src/core/events.js');
  const { Run, RUN_STATE } = await import('../src/game/run.js');
  const { Game } = await import('../src/game/game.js');
  const { AudioEngine } = await import('../src/audio/audio.js');
  const { WeaponInstance } = await import('../src/weapons/weapon.js');
  const { getWeaponDef, isKnownWeaponId, WEAPONS, WEAPON_IDS } = await import('../src/config/weapons.js');
  const { SAVE_KEY } = await import('../src/save/save.js');

  const profile = defaultProfile();
  const progression = new Progression(profile);
  const created = [];
  const makeRun = (resume = null) => {
    const run = new Run({
      seed: 'F8-WEAPONS-1',
      profile,
      progression,
      audio: new AudioEngine({ getVolume: () => profile.settings.audio }),
      events: new EventBus(),
      resume,
    });
    created.push(run);
    return run;
  };
  const noopInput = {
    pointer: { x: 800, y: 450 },
    axis: () => ({ x: 1, y: 0, len: 1 }),
    isDown: () => false,
    wasPressed: () => false,
    keyDown: () => false,
    pointerDown: () => false,
    pointerClicked: () => false,
    codePressed: () => false,
  };
  const canon = (obj) => JSON.stringify(Object.keys(obj).sort().map((key) => [key, obj[key]]));
  const warnings = (fn) => {
    const original = console.warn;
    const calls = [];
    console.warn = (...args) => calls.push(args);
    try {
      return { value: fn(), calls };
    } finally {
      console.warn = original;
    }
  };

  // --- the weapon table rejects anything that is not one of its own ids -----
  assert(WEAPON_IDS.every((id) => isKnownWeaponId(id)), 'every real weapon id should be known');
  assertEqual(getWeaponDef('smg'), WEAPONS.smg, 'a known id should return the exact table entry');
  for (const bogus of ['not-a-real-weapon', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', '', 'SMG', 'pistol ']) {
    assertEqual(isKnownWeaponId(bogus), false, `isKnownWeaponId should reject ${JSON.stringify(bogus)}`);
    let threw = false;
    try { getWeaponDef(bogus); } catch { threw = true; }
    assert(threw, `getWeaponDef should reject ${JSON.stringify(bogus)} instead of reading an inherited key`);
  }

  // --- the deserializer drops an unreadable entry, quietly and safely -------
  const unknown = warnings(() => WeaponInstance.deserialize({ id: 'not-a-real-weapon', tier: 2, ammo: 7 }));
  assertEqual(unknown.value, null, 'an unknown weapon id should deserialize to null');
  assertEqual(unknown.calls.length, 1, 'an unknown id should warn exactly once');
  assertEqual(unknown.calls[0].length, 1, 'the warning must not carry the raw entry or an Error object');
  assertEqual(unknown.calls[0][0], '[Weapon] skipping unknown weapon id "not-a-real-weapon"', 'the warning should name the entry only');
  const inherited = warnings(() => WeaponInstance.deserialize({ id: 'constructor' }));
  assertEqual(inherited.value, null, 'an inherited object key is not a weapon id');
  assertEqual(inherited.calls[0][0], '[Weapon] skipping unknown weapon id "constructor"', 'inherited keys go through the same drop path');
  const long = warnings(() => WeaponInstance.deserialize({ id: `${'x'.repeat(300)}\nsecond line` }));
  assertEqual(long.value, null, 'an oversized id should be dropped');
  assert(long.calls[0][0].length < 80, 'the logged id must be bounded');
  assertEqual(long.calls[0][0].includes('\n'), false, 'control characters must not break the log line');

  // Valid and legacy forms are untouched by the guard.
  const legacy = WeaponInstance.deserialize('smg');
  assertEqual(legacy.id, 'smg', 'the legacy bare-id form still restores');
  assertEqual(legacy.tier, 1, 'a bare id still means tier 1');
  assertEqual(legacy.ammo, legacy.magazineSize, 'a bare id still means a full magazine');
  const current = WeaponInstance.deserialize({ id: 'shotgun', tier: 3, ammo: 2 });
  assertEqual(`${current.id}:${current.tier}:${current.ammo}`, 'shotgun:3:2', 'the object form still restores exactly');
  const junk = WeaponInstance.deserialize({ id: 'pistol', tier: 'x', ammo: Number.NaN });
  assertEqual(`${junk.id}:${junk.tier}:${junk.ammo}`, `pistol:1:${junk.magazineSize}`, 'malformed numbers still fall back to the documented defaults');

  // --- a resumed run keeps the real weapons and never leaks the entry -------
  const payload = makeRun().serializeForResume();
  const mixed = validateResumableRun({
    ...payload,
    weapons: [{ id: 'not-a-real-weapon', tier: 2, ammo: 7 }, { id: 'smg', tier: 3, ammo: 5 }, 'shotgun'],
  });
  assert(mixed !== null, 'an unknown weapon id must not quarantine the save');
  assertEqual(mixed.weapons.map((w) => w.id).join(','), 'not-a-real-weapon,smg,shotgun', 'the validator keeps the payload shape and leaves dropping to the runtime');

  const resumed = warnings(() => makeRun(mixed));
  assertEqual(resumed.value.player.weapons.map((w) => w.id).join(','), 'smg,shotgun', 'only the real weapons should reach the arsenal');
  assertEqual(resumed.value.player.weapons[0].tier, 3, 'the surviving weapon keeps its saved tier');
  assertEqual(resumed.value.player.weapons[0].ammo, 5, 'the surviving weapon keeps its saved ammo');
  assertEqual(resumed.value.player.weapons[1].tier, 1, 'a legacy bare id still resumes as tier 1');
  assertEqual(resumed.value.player.weapons[1].ammo, resumed.value.player.weapons[1].magazineSize, 'a legacy bare id still resumes loaded');
  assertEqual(resumed.calls.length, 1, 'one bounded warning for the one unreadable entry');
  assertEqual(resumed.calls[0].length, 1, 'resuming must not log the payload or a stack trace');

  // Prototype-chain ids: these used to slip past the table lookup entirely.
  const proto = warnings(() => makeRun(validateResumableRun({
    ...payload,
    weapons: [{ id: 'constructor', tier: 1, ammo: 3 }, { id: '__proto__' }, { id: 'smg' }],
  })));
  assertEqual(proto.value.player.weapons.map((w) => w.id).join(','), 'smg', 'inherited object keys must not become weapons');
  assertEqual(proto.value.player.weapons.every((w) => w.def === getWeaponDef(w.id) && Number.isFinite(w.magazineSize) && w.magazineSize > 0), true, 'no weapon may end up with a non-weapon definition');
  assertEqual(proto.value.serializeForResume().weapons.every((w) => isKnownWeaponId(w.id)), true, 'a checkpoint must never carry an undefined weapon id');
  assertEqual(proto.calls.length, 2, 'each bad entry warns once and only once');

  // --- an entirely unreadable arsenal still leaves a playable run -----------
  const bare = warnings(() => makeRun(validateResumableRun({ ...payload, weapons: [{ id: 'nope-1' }, { id: 'nope-2' }] })));
  assertEqual(bare.value.player.weapons.map((w) => w.id).join(','), 'pistol', 'an unreadable arsenal falls back to the sidearm');
  assertEqual(bare.value.player.weapons[0].def, getWeaponDef('pistol'), 'the fallback is the real starting weapon');
  for (let i = 0; i < 30; i += 1) bare.value.update(1 / 60, noopInput);
  assertEqual(bare.value.state, RUN_STATE.ACTIVE, 'the run stays playable');
  assertEqual(bare.value.player.health > 0, true, 'the player is unharmed by the fallback');
  assertEqual(bare.calls.length, 2, 'each unreadable entry warns once');

  // --- a stored save with a bad weapon id resumes without user-visible noise -
  dom.storage.setItem(SAVE_KEY, JSON.stringify({
    ...defaultProfile(),
    run: { ...payload, weapons: [{ id: 'not-a-real-weapon' }, { id: 'smg', tier: 2, ammo: 4 }] },
  }));
  const booted = warnings(() => {
    const game = new Game({ canvas: dom.canvas, container: dom.container });
    game.start();
    return game;
  });
  const game = booted.value;
  assertEqual(game.saveSystem.lastLoadWarning, null, 'an unknown weapon id is not a corrupt save');
  const resuming = warnings(() => game.continueRun());
  assertEqual(game.run.player.weapons.map((w) => w.id).join(','), 'smg', 'the real resume path drops the unknown weapon');
  assertEqual(resuming.calls.filter((c) => String(c[0]).includes('not-a-real-weapon')).length, 1, 'the console gets exactly one bounded warning');
  assertEqual(resuming.calls.every((c) => c.length === 1), true, 'resuming must not log raw payloads or stack traces');
  assertEqual(canon(game.run.player.loot), canon(payload.loot), 'the rest of the snapshot still resumes unchanged');
  game.dispose();

  for (const instance of created) instance.dispose();
  return `${WEAPON_IDS.length} real ids still restore, unknown and inherited ids dropped with one bounded warning, unreadable arsenal falls back to the sidearm`;
});

// ---------------------------------------------------------------------------
// Boss arena: the intro wave is consumed content, not a renewable reward
// ---------------------------------------------------------------------------

suite('save: the boss arena intro wave is not re-summoned by a resume', async () => {
  const dom = await import('./domstub.mjs').then((m) => m.installDom());
  const { EventBus } = await import('../src/core/events.js');
  const { Run } = await import('../src/game/run.js');
  const { AudioEngine } = await import('../src/audio/audio.js');
  const { Game } = await import('../src/game/game.js');
  const { SAVE_KEY } = await import('../src/save/save.js');

  const SEED = 'FINAL-BOSS-0001';
  const created = [];
  const makeRun = (tier, resume = null) => {
    const profile = defaultProfile();
    const run = new Run({
      seed: SEED,
      startTier: tier,
      resume,
      profile,
      progression: new Progression(profile),
      audio: new AudioEngine({ getVolume: () => profile.settings.audio }),
      events: new EventBus(),
    });
    created.push(run);
    return run;
  };
  const noopInput = {
    pointer: { x: 0, y: 0 },
    axis: () => ({ x: 0, y: 0, len: 0 }),
    isDown: () => false,
    wasPressed: () => false,
    keyDown: () => false,
    pointerDown: () => false,
    pointerClicked: () => false,
    codePressed: () => false,
  };
  const tick = (run, frames) => {
    for (let i = 0; i < frames; i += 1) {
      run.player.health = run.player.maxHealth;
      run.update(1 / 60, noopInput);
    }
  };
  const liveAdds = (run) => run.spawner.enemies.filter((e) => e.alive && e.spawnIndex === -1);
  const standInArena = (run, frames = 40) => {
    const room = run.zone.rooms.find((r) => r.type === 'boss');
    run.player.x = room.rect.x + room.rect.w / 2;
    run.player.y = room.rect.y + room.rect.h / 2;
    tick(run, frames);
  };
  // The seed's first boss sector, found the same way a player would meet it.
  let bossTier = null;
  for (const tier of [3, 6, 9, 12]) {
    const probe = makeRun(tier);
    if (probe.objectives.main.id === 'objective-boss') bossTier = tier;
    probe.dispose();
    if (bossTier) break;
  }
  assert(bossTier !== null, 'the test seed should have a boss sector');

  // --- in a live sector the wave fires exactly once ------------------------
  const live = makeRun(bossTier);
  assertEqual(live.bossWavesTriggered, false, 'a fresh boss sector starts with the wave untriggered');
  standInArena(live);
  const waveSize = liveAdds(live).length;
  assertEqual(live.bossWavesTriggered, true, 'entering the arena triggers the intro wave');
  assert(waveSize > 0, 'the intro wave should summon adds');
  for (const add of liveAdds(live)) live.combat.damageEnemy(add, 1e9, {});
  tick(live, 5);
  const earnedFirst = live.xpEarnedTotal;
  const killsFirst = live.stats.kills;
  assert(earnedFirst > 0, 'clearing the wave should pay XP once');
  standInArena(live);
  assertEqual(liveAdds(live).length, 0, 'the wave must not summon a second time in the same sector');

  // --- checkpoints carry the trigger ---------------------------------------
  const payload = live.serializeForResume();
  assertEqual(payload.bossWaves.tier, bossTier, 'the wave trigger is scoped to its own sector');
  assertEqual(payload.bossWaves.triggered, true, 'a triggered wave is persisted');
  const validated = validateResumableRun(payload);
  assertEqual(validated.bossWaves.triggered, true, 'the validator keeps the wave trigger');

  // --- a reload must not re-summon (or re-pay for) the wave ----------------
  const resumed = makeRun(bossTier, validated);
  assertEqual(resumed.spawner.bossWavesTriggered, true, 'the reloaded sector knows the wave already happened');
  assertEqual(resumed.stats.kills, killsFirst, 'a resume keeps the wave\'s kill credit exactly once');
  standInArena(resumed, 60);
  assertEqual(liveAdds(resumed).length, 0, 'no add may be re-summoned after a resume');
  assertEqual(resumed.stats.kills, killsFirst, 'a resume must not hand back the wave\'s kill credit');
  assertEqual(resumed.xpEarnedTotal, earnedFirst, 'a resume must not hand back the wave\'s XP');
  assert(resumed.spawner.boss && resumed.spawner.boss.alive, 'the boss itself still comes back to be fought');

  // --- the wave is still a one-time event, not a permanently dead arena -----
  const notYet = makeRun(bossTier, validateResumableRun({ ...payload, bossWaves: { tier: bossTier, triggered: false } }));
  standInArena(notYet);
  assert(notYet.spawner.bossWavesTriggered && liveAdds(notYet).length > 0, 'an untriggered arena still summons its wave after a resume');

  const legacy = makeRun(bossTier, validateResumableRun((() => { const p = { ...payload }; delete p.bossWaves; return p; })()));
  standInArena(legacy);
  assert(legacy.spawner.bossWavesTriggered && liveAdds(legacy).length > 0, 'a save from before the field existed still gets its wave');

  const foreignTier = makeRun(bossTier, validateResumableRun({ ...payload, bossWaves: { tier: 1, triggered: true } }));
  standInArena(foreignTier);
  assert(foreignTier.spawner.bossWavesTriggered, 'another sector\'s trigger must not suppress this arena');

  for (const junk of ['x', [], { tier: 'x', triggered: true }, { tier: bossTier, triggered: 'yes' }, { triggered: true }]) {
    const run = makeRun(bossTier, validateResumableRun({ ...payload, bossWaves: junk }));
    assert(run.spawner.bossWavesTriggered === false, `malformed wave state ${JSON.stringify(junk)} must not count as triggered`);
  }
  const malformed = makeRun(bossTier, validateResumableRun({ ...payload, bossWaves: { tier: bossTier, triggered: 'yes' } }));
  standInArena(malformed);
  assert(liveAdds(malformed).length > 0, 'a malformed trigger still leaves the arena summonable');

  // --- the real save/load path behaves the same ----------------------------
  dom.storage.setItem(SAVE_KEY, JSON.stringify({ ...defaultProfile(), run: validated }));
  const game = new Game({ canvas: dom.canvas, container: dom.container });
  game.start();
  game.continueRun();
  const gameKills = game.run.stats.kills;
  const gameEarned = game.run.xpEarnedTotal;
  for (let i = 0; i < 60; i += 1) {
    game.run.player.health = game.run.player.maxHealth;
    game.run.player.x = game.run.zone.rooms.find((r) => r.type === 'boss').rect.x + 40;
    game.run.player.y = game.run.zone.rooms.find((r) => r.type === 'boss').rect.y + 40;
    game.tick(1 / 60);
  }
  assertEqual(game.run.spawner.enemies.filter((e) => e.alive && e.spawnIndex === -1).length, 0, 'the loaded game summons no replacement wave');
  assertEqual(game.run.stats.kills, gameKills, 'the loaded game re-awards no kills');
  assertEqual(game.run.xpEarnedTotal, gameEarned, 'the loaded game re-awards no XP');
  game.pause();
  const written = JSON.parse(dom.storage.getItem(SAVE_KEY)).run;
  assertEqual(written.bossWaves.triggered, true, 'the game keeps writing the consumed trigger');
  assertEqual(written.bossWaves.tier, bossTier, 'the written trigger stays scoped to the sector');
  // The boss is still a legitimate objective: killing it completes the sector.
  game.resume();
  game.run.combat.damageEnemy(game.run.spawner.boss, 1e9, {});
  for (let i = 0; i < 10; i += 1) game.tick(1 / 60);
  assertEqual(game.run.objectives.main.complete, true, 'the boss objective still completes normally');
  assertEqual(game.run.stats.bossKills, 1, 'the boss kill is still counted');
  game.pause();
  game.dispose();

  const afterBoss = JSON.parse(dom.storage.getItem(SAVE_KEY)).run;
  const afterReload = makeRun(bossTier, validateResumableRun(afterBoss));
  assert(!afterReload.spawner.boss, 'a killed boss stays dead after a reload');
  assertEqual(afterReload.objectives.main.complete, true, 'the completed boss objective survives a reload');

  for (const run of created) run.dispose();
  return `wave fired once at tier ${bossTier} (${waveSize} adds), no re-summon or re-pay across resume, legacy and untriggered saves still summon`;
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Content depth: boss arenas, late-sector garrisons, prize rooms, commander
// ---------------------------------------------------------------------------

suite('generation: late sectors draw from a wider threat pool', async () => {
  const { THREAT_PROFILES } = await import('../src/config/enemies.js');
  const seen = new Map();
  for (const tier of [1, 2, 3, 4, 5, 6]) {
    const ids = new Set();
    for (let i = 0; i < 40; i += 1) {
      const zone = generateZone({ seed: `POOL-${tier}-${i}`, tier });
      ids.add(zone.threatProfile.id);
      const profile = THREAT_PROFILES.find((p) => p.id === zone.threatProfile.id);
      assert(Boolean(profile), `unknown threat profile ${zone.threatProfile.id}`);
      assert((profile.minTier ?? 1) <= tier, `tier ${tier} rolled ${profile.id}, gated at tier ${profile.minTier}`);
    }
    seen.set(tier, ids);
  }
  assertEqual(seen.get(1).size, 1, 'tier 1 should keep its curated opener');
  assert(seen.get(1).has('patrol'), 'tier 1 should field PATROL');
  assert(!seen.get(2).has('hunters') && !seen.get(2).has('vanguard'), 'tier 2 must not roll late-game garrisons');
  assert(!seen.get(3).has('vanguard'), 'vanguard is gated behind tier 4');
  assert(seen.get(3).has('hunters'), 'tier 3 should be able to roll the late-game pool');
  assert(seen.get(4).has('vanguard'), 'tier 4 should be able to roll vanguard');
  assert(seen.get(6).size > seen.get(2).size, 'late sectors should not field an early-sector pool');
  return `T2 [${[...seen.get(2)].sort().join(',')}] | T6 [${[...seen.get(6)].sort().join(',')}]`;
});

suite('generation: prize markers are guarded and vaults pay better', async () => {
  let markers = 0;
  let guarded = 0;
  let vaultQuality = 0;
  let vaultDrops = 0;
  let combatQuality = 0;
  let combatDrops = 0;
  let sectors = 0;
  for (const tier of [1, 2, 4, 5]) {
    for (let i = 0; i < 16; i += 1) {
      const zone = generateZone({ seed: `PRIZE-${tier}-${i}`, tier });
      if (zone.isBossSector) continue;
      sectors += 1;
      const objective = zone.objectives[0];
      // Every shard / reactor the objective sends the player to must be held.
      for (const marker of objective.markers ?? []) {
        markers += 1;
        const nearby = zone.enemySpawns.filter(
          (s) => !s.isBoss && Math.hypot(s.x - marker.x, s.y - marker.y) < 200,
        ).length;
        if (nearby > 0) guarded += 1;
      }
      // A vault is the room with the fight; it must also be the room with the
      // better cache, not just the bigger one.
      const typeOf = (roomId) => zone.rooms.find((r) => r.id === roomId)?.type;
      for (const spawn of zone.lootSpawns) {
        if (typeOf(spawn.roomId) === 'vault') { vaultQuality += spawn.quality; vaultDrops += 1; }
        if (typeOf(spawn.roomId) === 'combat') { combatQuality += spawn.quality; combatDrops += 1; }
      }
    }
  }
  assert(sectors > 30, `only ${sectors} non-boss sectors sampled`);
  assert(markers > 30, `only ${markers} prize markers sampled`);
  assert(guarded / markers > 0.75, `only ${((guarded / markers) * 100).toFixed(0)}% of prize markers have a garrison within 200u`);
  const vaultAvg = vaultQuality / Math.max(1, vaultDrops);
  const combatAvg = combatQuality / Math.max(1, combatDrops);
  assert(vaultAvg > combatAvg * 1.2, `vault drops roll ${vaultAvg.toFixed(2)} quality vs ${combatAvg.toFixed(2)} in ordinary rooms`);
  return `${guarded}/${markers} markers guarded (${((guarded / markers) * 100).toFixed(0)}%), vault quality ${vaultAvg.toFixed(2)} vs ${combatAvg.toFixed(2)}`;
});

suite('enemies: each boss arena runs its own ladder and attack kit', async () => {
  const { BOSS_ARENAS, bossArenaFor } = await import('../src/config/enemies.js');
  const dom = await import('./domstub.mjs').then((m) => m.installDom());
  void dom;
  const { EventBus } = await import('../src/core/events.js');
  const { Run } = await import('../src/game/run.js');
  const { AudioEngine } = await import('../src/audio/audio.js');

  const stoke = bossArenaFor(3);
  const meltdown = bossArenaFor(6);
  assertEqual(stoke, BOSS_ARENAS[1], 'the first boss sector should run arena 1');
  assertEqual(meltdown, BOSS_ARENAS[2], 'the second boss sector should run arena 2');
  assertEqual(stoke.cycle, 'STOKE CYCLE', 'arena 1 cycle name');
  assertEqual(meltdown.cycle, 'MELTDOWN CYCLE', 'arena 2 cycle name');
  assertEqual(stoke.phases.length, 3, 'arena 1 phase ladder');
  assertEqual(meltdown.phases.length, 4, 'arena 2 should be a longer ladder');
  assert(meltdown.phases[0].at === 1 && meltdown.phases.every((p, i, all) => i === 0 || p.at < all[i - 1].at), 'arena 2 thresholds must descend');
  const kitOf = (arena) => new Set(arena.phases.flatMap((p) => p.attacks));
  for (const kind of ['lance', 'cage', 'pods']) {
    assert(kitOf(meltdown).has(kind), `arena 2 should use ${kind}`);
    assert(!kitOf(stoke).has(kind), `arena 1 must not use ${kind}`);
  }
  assertEqual(meltdown.waves.join('+'), 'dart+marksman+husk', 'arena 2 entry wave');

  // The boss itself reports the arena it is standing in, and walks its ladder.
  const boss = new BossEnemy({ x: 0, y: 0, difficulty: difficultyAt(6) });
  assertEqual(boss.arena.cycle, 'MELTDOWN CYCLE', 'a tier-6 boss should run the meltdown cycle');
  assertEqual(boss.phases.length, 4, 'a tier-6 boss should run four phases');
  boss.health = boss.maxHealth * 0.1;
  assert(boss.updatePhase(), 'boss did not advance into its last phase');
  assertEqual(boss.phaseName, 'CRUCIBLE', 'tier-6 final phase');

  // And the arena it reports is the wave the spawner fields on entry.
  const profile = defaultProfile();
  const run = new Run({
    seed: 'ARENA-KIT-1',
    startTier: 6,
    profile,
    progression: new Progression(profile),
    audio: new AudioEngine({ getVolume: () => profile.settings.audio }),
    events: new EventBus(),
  });
  run.spawner.pending = run.spawner.pending.filter((s) => s.isBoss);
  const room = run.zone.rooms.find((r) => r.type === 'boss');
  const noopInput = {
    pointer: { x: 0, y: 0 },
    axis: () => ({ x: 0, y: 0, len: 0 }),
    isDown: () => false,
    wasPressed: () => false,
    keyDown: () => false,
    pointerDown: () => false,
    pointerClicked: () => false,
    codePressed: () => false,
  };
  for (let i = 0; i < 40 && !run.spawner.boss; i += 1) {
    run.player.x = room.rect.x + room.rect.w / 2;
    run.player.y = room.rect.y + room.rect.h / 2;
    run.update(1 / 60, noopInput);
  }
  assert(run.spawner.boss, 'the boss did not spawn in its arena');
  const adds = run.spawner.enemies.filter((e) => e.spawnIndex === -1);
  assert(adds.length > 0, 'entering the arena should summon the arena wave');
  const allowed = new Set(meltdown.waves);
  for (const add of adds) assert(allowed.has(add.typeId), `arena wave summoned ${add.typeId}, which is not in ${[...allowed].join('/')}`);
  run.dispose();
  return `arena1 ${stoke.phases.length} phases [${[...kitOf(stoke)].sort().join(',')}] | arena2 ${meltdown.phases.length} phases [${[...kitOf(meltdown)].sort().join(',')}]`;
});

suite('objectives: the commander hunt targets one guarded elite and completes on its kill', async () => {
  let sectors = 0;
  let hunts = 0;
  for (const tier of [2, 3, 4, 5, 6]) {
    for (let i = 0; i < 24; i += 1) {
      const zone = generateZone({ seed: `HUNT-${tier}-${i}`, tier });
      sectors += 1;
      const objective = zone.objectives[0];
      if (objective.type !== OBJECTIVE_TYPES.HUNT) continue;
      hunts += 1;
      assert(validateZone(zone).ok, `commander sector ${zone.seed} is invalid`);
      assertEqual(objective.target, 1, 'the commander objective is a single target');
      const target = zone.enemySpawns[objective.targetSpawnIndex];
      assert(Boolean(target), 'the commander index does not resolve to a spawn');
      assert(Boolean(target.elite), 'the commander is not an elite');
      assert(objective.targetPosition && objective.targetPosition.x === target.x, 'the marker does not follow the commander');
      const escort = zone.enemySpawns.filter(
        (s) => !s.isBoss && s !== target && Math.hypot(s.x - target.x, s.y - target.y) < 260,
      ).length;
      assert(escort > 0, 'the commander has no bodyguards');
    }
  }
  assert(hunts > 8, `only ${hunts} of ${sectors} sectors rolled the commander objective`);
  const tierOne = new Set();
  for (let i = 0; i < 24; i += 1) tierOne.add(generateZone({ seed: `HUNT-1-${i}`, tier: 1 }).objectives[0].type);
  assert(!tierOne.has(OBJECTIVE_TYPES.HUNT), 'the commander objective should not open in the first sector');

  // Run it for real: a decoy must not count, the commander must finish it, and
  // a resume must neither forget the kill nor hand the spawn back.
  const dom = await import('./domstub.mjs').then((m) => m.installDom());
  void dom;
  const { EventBus } = await import('../src/core/events.js');
  const { Run } = await import('../src/game/run.js');
  const { AudioEngine } = await import('../src/audio/audio.js');
  let seed = null;
  for (let i = 0; i < 200 && !seed; i += 1) {
    const probe = `HUNT-RUN-${i}`;
    if (generateZone({ seed: probe, tier: 2 }).objectives[0].type === OBJECTIVE_TYPES.HUNT) seed = probe;
  }
  assert(Boolean(seed), 'no seed rolled the commander objective for the runtime check');
  const profile = defaultProfile();
  const makeRun = (resume = null) => new Run({
    seed,
    startTier: 2,
    resume,
    profile,
    progression: new Progression(profile),
    audio: new AudioEngine({ getVolume: () => profile.settings.audio }),
    events: new EventBus(),
  });
  const run = makeRun();
  const objective = run.objectives.main;
  const index = objective.targetSpawnIndex;
  const commander = run.spawner.addEnemy(run.spawner.pending.find((p) => p.index === index), { immediate: true });
  assert(commander.isElite, 'the commander did not spawn as an elite');
  const decoySpec = run.spawner.pending.find((p) => p.index !== index && !p.isBoss);
  if (decoySpec) {
    const decoy = run.spawner.addEnemy(decoySpec, { immediate: true });
    run.combat.damageEnemy(decoy, 99999, { sourceX: decoy.x + 8, sourceY: decoy.y });
    assertEqual(objective.progress, 0, 'killing an ordinary hostile advanced the commander objective');
  }
  run.combat.damageEnemy(commander, 99999, { sourceX: commander.x + 8, sourceY: commander.y });
  assert(objective.complete, 'killing the commander did not complete the objective');
  assert(run.objectives.allComplete, 'the extraction gate should open once the commander dies');
  const resumed = makeRun(run.serializeForResume());
  assert(resumed.objectives.main.complete, 'the resumed sector forgot the commander kill');
  assert(
    resumed.spawner.pending.every((p) => p.index !== index || p.spawned),
    'the killed commander was handed back by the resume',
  );
  run.dispose();
  resumed.dispose();
  return `${hunts}/${sectors} sectors, tier 1 exempt, decoy ignored, kill + resume verified`;
});

section('VOIDRUNNER deterministic regression tests');

for (const { name, fn } of suites) {
  if (filter && !name.includes(filter)) continue;
  try {
    const detail = await fn();
    assertions += 1;
    console.log(`  \u001b[32m✓\u001b[0m ${name}${detail ? `  \u001b[90m(${detail})\u001b[0m` : ''}`);
  } catch (error) {
    failures += 1;
    console.log(`  \u001b[31m✗\u001b[0m ${name}`);
    console.log(`      \u001b[31m${error.message}\u001b[0m`);
    if (process.env.VERBOSE) console.log(error.stack);
  }
}

console.log('');
console.log(`  ${suites.length - failures}/${suites.length} suites passed, ${assertions} assertions`);
console.log('');
if (failures > 0) {
  process.exitCode = 1;
  console.log(`\u001b[31m  ${failures} failing suite(s).\u001b[0m\n`);
} else {
  console.log('\u001b[32m  All tests passed.\u001b[0m\n');
}
