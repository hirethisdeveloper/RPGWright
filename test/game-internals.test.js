'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { launchGame } = require('../src/game');
const { FIXTURE_MINIMAL } = require('./helpers');

// Internal cleanup-correctness tests for game.js's own resource lifecycle —
// not "using RPGWright to test an app" scenarios, so these stay on
// node:test rather than rpgwright test's app-launching fixture (see
// agent_docs/testing-strategy.md).

test('stop() does not leak an unhandled promise rejection across repeated launch/press/stop cycles', async () => {
  const rejections = [];
  const onUnhandledRejection = (reason) => rejections.push(reason);
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    for (let i = 0; i < 5; i += 1) {
      const game = await launchGame({ command: process.execPath, args: [FIXTURE_MINIMAL], cols: 40, rows: 10 });
      await game.expectText('Press ENTER to continue');
      await game.press('ENTER');
      await game.expectText('You pressed ENTER');
      await game.stop();
    }
    // Let any rejection queued on a microtask around the last stop() surface.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }

  assert.deepEqual(rejections, []);
});
