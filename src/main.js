/**
 * VOIDRUNNER entry point.
 *
 * Boots the game into the provided canvas, wires global error handling and
 * exposes a small debug surface on `window.VOIDRUNNER` for QA tooling.
 */

import { Game } from './game/game.js';

function boot() {
  const canvas = document.getElementById('game-canvas');
  const container = document.getElementById('game-root');
  const bootOverlay = document.getElementById('boot-overlay');

  if (!canvas) {
    // The page itself is broken - surface it instead of failing silently.
    document.body.innerHTML = '<pre style="color:#ff4d6d;font:14px monospace;padding:24px">Fatal: #game-canvas element is missing from index.html</pre>';
    return;
  }

  const game = new Game({ canvas, container });
  window.VOIDRUNNER = {
    game,
    /** QA helper: jump straight into a run with a chosen seed. */
    startRunWithSeed(seed, tier = 1) {
      game.pendingSeed = seed;
      game.startRun(seed);
      if (tier > 1) game.run.tier = tier;
      return game.run;
    },
    /** QA helper: fast-forward a number of simulated frames. */
    simulate(seconds, step = 1 / 60) {
      const frames = Math.round(seconds / step);
      const noop = {
        pointer: { x: 640, y: 360 },
        axis: () => ({ x: 0, y: 0 }),
        isDown: () => false,
        wasPressed: () => false,
        keyDown: () => false,
        pointerDown: () => false,
        pointerClicked: () => false,
        codePressed: () => false,
      };
      for (let i = 0; i < frames; i += 1) game.run?.update(step, noop);
      return game.run?.debugSnapshot();
    },
    version: '1.0.0',
  };

  game.start();

  if (bootOverlay) {
    bootOverlay.classList.add('hidden');
    setTimeout(() => bootOverlay.remove(), 400);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

window.addEventListener('error', (event) => {
  console.error('[VOIDRUNNER] uncaught error:', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[VOIDRUNNER] unhandled rejection:', event.reason);
});
