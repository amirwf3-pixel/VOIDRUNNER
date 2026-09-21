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
  const rows = [
    '#####',
    '#...##',
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
  const clear = map.raycast(TILE * 1.5, TILE * 1.5, 1, 0, 100);
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
  assertEqual(p1.profile.account.bossKills, 1, 'boss kill was not recorded');
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

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

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
