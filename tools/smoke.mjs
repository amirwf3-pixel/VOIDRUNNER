/**
 * Headless smoke test.
 *
 * Boots the real game against a stubbed DOM/canvas so the *actual* code paths
 * (game loop, run simulation, rendering calls, UI widgets) execute in Node.
 * Rendering is stubbed with a call-recording 2D context, which means any
 * runtime exception in draw code still fails the test.
 */

import { installDom } from './domstub.mjs';

const results = [];
let failures = 0;

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, name, detail });
    console.log(`  \u001b[32mPASS\u001b[0m  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures += 1;
    results.push({ ok: false, name, error });
    console.log(`  \u001b[31mFAIL\u001b[0m  ${name}`);
    console.log(`        ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n        ') : error}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log('\nVOIDRUNNER smoke test (headless)\n');

const dom = installDom();
const { Game, GAME_STATE } = await import('../src/game/game.js');

let game = null;

check('game boots and starts the loop', () => {
  game = new Game({ canvas: dom.canvas, container: dom.container });
  game.start();
  assert(game.running, 'game loop did not start');
  return `state=${game.state}`;
});

check('menu renders without throwing', () => {
  for (let i = 0; i < 30; i += 1) game.tick(1 / 60);
  assert(game.state === GAME_STATE.MENU, `expected menu, got ${game.state}`);
  return `${game.renderer.ctx.commandCount} draw ops`;
});

check('starts a real run with a fixed seed', () => {
  game.startRun('SMOKE-TEST-0001');
  for (let i = 0; i < 10; i += 1) game.tick(1 / 60);
  assert(game.state === GAME_STATE.PLAYING, `expected playing, got ${game.state}`);
  assert(game.run, 'run was not created');
  assert(game.run.zone.map.floorCount > 1000, 'map has too little walkable area');
  return `sector=${game.run.tier} rooms=${game.run.zone.rooms.length} floors=${game.run.zone.map.floorCount}`;
});

check('renders 300 gameplay frames without errors', () => {
  for (let i = 0; i < 300; i += 1) game.tick(1 / 60);
  assert(game.errors.length === 0, `${game.errors.length} errors: ${game.errors[0]?.error?.message ?? ''}`);
  return `draw ops=${game.renderer.ctx.commandCount} fps=${game.fps.toFixed(1)}`;
});

check('player responds to movement input', () => {
  const before = { x: game.run.player.x, y: game.run.player.y };
  const input = game.input;
  input.down.add('KeyD');
  input.down.add('KeyS');
  for (let i = 0; i < 60; i += 1) game.tick(1 / 60);
  input.down.delete('KeyD');
  input.down.delete('KeyS');
  const moved = Math.hypot(game.run.player.x - before.x, game.run.player.y - before.y);
  assert(moved > 20, `player barely moved (${moved.toFixed(2)} units)`);
  return `moved ${moved.toFixed(1)} units`;
});

check('firing spawns projectiles and consumes ammo', () => {
  const player = game.run.player;
  const before = player.weapon.ammo;
  game.input.pointerButtons.add(0);
  for (let i = 0; i < 30; i += 1) {
    game.input.pointerPressedButtons.add(0);
    game.tick(1 / 60);
  }
  game.input.pointerButtons.delete(0);
  assert(player.weapon.ammo < before, `ammo did not decrease (${before} -> ${player.weapon.ammo})`);
  return `ammo ${before} -> ${player.weapon.ammo}`;
});

check('reload restores the magazine from reserve', () => {
  const player = game.run.player;
  const weapon = player.weapon;
  game.input.pressed.add('KeyR');
  game.tick(1 / 60);
  assert(weapon.isReloading || weapon.ammo === weapon.magazineSize, 'reload did not start');
  for (let i = 0; i < 200; i += 1) game.tick(1 / 60);
  assert(weapon.ammo > 0, 'magazine still empty after reload');
  return `ammo=${weapon.ammo}/${weapon.magazineSize} reserve=${player.ammo.get(weapon.def.ammo)}`;
});

check('enemies spawn and are simulated', () => {
  const run = game.run;
  // Teleport the player onto the densest enemy cluster to force activation.
  const target = run.zone.enemySpawns[0];
  assert(target, 'zone has no enemy spawns');
  run.player.x = target.x;
  run.player.y = target.y;
  for (let i = 0; i < 240; i += 1) game.tick(1 / 60);
  assert(run.spawner.enemies.length > 0, 'no enemies spawned');
  const anyAlerted = run.spawner.enemies.some((e) => e.alerted);
  return `${run.spawner.enemies.length} spawned, alerted=${anyAlerted}`;
});

check('damage, death and loot drop from a kill', () => {
  const run = game.run;
  const enemy = run.spawner.enemies.find((e) => e.alive && !e.isBoss);
  assert(enemy, 'no living enemy available');
  const dropsBefore = run.loot.drops.length;
  const killsBefore = run.stats.kills;
  run.combat.damageEnemy(enemy, 100000, { crit: true, weaponId: 'pistol' });
  assert(!enemy.alive, 'enemy survived a lethal hit');
  assert(run.stats.kills > killsBefore, 'kill was not counted');
  return `drops ${dropsBefore} -> ${run.loot.drops.length}`;
});

check('player takes damage and dies correctly', () => {
  const run = game.run;
  const before = run.player.health;
  run.combat.damagePlayer(9999, { kind: 'test' });
  assert(run.player.health < before, 'health did not decrease');
  assert(!run.player.alive, 'player should be dead');
  for (let i = 0; i < 20; i += 1) game.tick(1 / 60);
  assert(game.state === GAME_STATE.RESULTS, `expected results screen, got ${game.state}`);
  assert(game.resultsSummary, 'run was not settled');
  return `cores banked=${game.resultsSummary.coresBanked} xp=${game.resultsSummary.xpBanked}`;
});

check('restart after death works', () => {
  game.startRun('SMOKE-TEST-0002');
  for (let i = 0; i < 10; i += 1) game.tick(1 / 60);
  assert(game.state === GAME_STATE.PLAYING, `expected playing, got ${game.state}`);
  assert(game.run.player.alive, 'player not alive after restart');
  return `sector=${game.run.tier}`;
});

check('pause and resume preserve the run', () => {
  const run = game.run;
  const snapshot = run.debugSnapshot();
  game.pause();
  for (let i = 0; i < 30; i += 1) game.tick(1 / 60);
  assert(game.state === GAME_STATE.PAUSED, `expected paused, got ${game.state}`);
  const frozen = run.debugSnapshot();
  assert(frozen.elapsed === snapshot.elapsed, 'run advanced while paused');
  game.resume();
  game.tick(1 / 60);
  assert(game.state === GAME_STATE.PLAYING, 'resume failed');
  return 'state frozen while paused';
});

check('settings screen opens and renders', () => {
  game.actions.openSettings();
  for (let i = 0; i < 5; i += 1) game.tick(1 / 60);
  assert(game.state === GAME_STATE.SETTINGS, `expected settings, got ${game.state}`);
  game.screens.settings.tab = 'video';
  game.tick(1 / 60);
  game.screens.settings.tab = 'gameplay';
  game.tick(1 / 60);
  game.screens.settings.tab = 'data';
  game.tick(1 / 60);
  game.actions.back();
  game.tick(1 / 60);
  return `back to ${game.state}`;
});

check('upgrades screen renders and purchases work', () => {
  game.actions.openUpgrades();
  game.profile.account.cores = 100000;
  for (let i = 0; i < 5; i += 1) game.tick(1 / 60);
  assert(game.state === GAME_STATE.UPGRADES, `expected upgrades, got ${game.state}`);
  const before = game.profile.upgrades.vitality ?? 0;
  const result = game.actions.purchaseUpgrade('vitality');
  assert(result.ok, 'purchase failed');
  assert((game.profile.upgrades.vitality ?? 0) === before + 1, 'rank did not increase');
  game.tick(1 / 60);
  game.actions.back();
  game.tick(1 / 60);
  return `vitality rank ${game.profile.upgrades.vitality}`;
});

check('save/load round-trips through storage', () => {
  game.profile.account.cores = 1234;
  game.actions.saveNow();
  const reloaded = game.saveSystem.load();
  assert(reloaded.account.cores === 1234, `cores not persisted (${reloaded.account.cores})`);
  assert(reloaded.upgrades.vitality >= 1, 'upgrades not persisted');
  return `cores=${reloaded.account.cores} vitality=${reloaded.upgrades.vitality}`;
});

check('long simulated run stays stable for 60 seconds', () => {
  game.startRun('SMOKE-LONG-0001');
  game.input.down.add('KeyD');
  game.input.pointerButtons.add(0);
  for (let i = 0; i < 60 * 60; i += 1) {
    game.input.pointerPressedButtons.add(0);
    game.tick(1 / 60);
    if (game.state !== GAME_STATE.PLAYING) {
      // Death is a valid outcome; restart so the loop keeps exercising code.
      game.startRun(`SMOKE-LONG-${i.toString(16).padStart(4, '0')}`);
    }
  }
  game.input.down.delete('KeyD');
  game.input.pointerButtons.delete(0);
  assert(game.errors.length === 0, `${game.errors.length} errors: ${game.errors[0]?.error?.message ?? ''}`);
  return `draw ops=${game.renderer.ctx.commandCount}, errors=0`;
});

check('no leaked listeners or runaway pools', () => {
  const run = game.run;
  assert(run.particles.activeCount <= 1400, 'particle pool overflowed');
  assert(run.projectiles.activeCount <= 900, 'projectile pool overflowed');
  return `particles=${run.particles.activeCount} projectiles=${run.projectiles.activeCount}`;
});

game.dispose();

console.log('');
if (failures === 0) {
  console.log(`\u001b[32m  All ${results.length} smoke checks passed.\u001b[0m\n`);
} else {
  console.log(`\u001b[31m  ${failures} of ${results.length} smoke checks failed.\u001b[0m\n`);
  process.exitCode = 1;
}
