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

test('launchGame rejects an unknown colorDepth before spawning anything', async () => {
  await assert.rejects(
    launchGame({ command: process.execPath, args: [FIXTURE_MINIMAL], colorDepth: 'sepia' }),
    /Unknown colorDepth "sepia"\. Supported: 16, 256, none, truecolor/,
  );
});

test('observe() delivers screen, action, step and exit events; dispose stops delivery; a throwing listener is ignored', async () => {
  const game = await launchGame({ command: process.execPath, args: [FIXTURE_MINIMAL], cols: 40, rows: 10 });
  const events = [];
  const throwing = game.observe(() => {
    throw new Error('observer failure');
  });
  const sub = game.observe((event) => events.push({ ...event, ok: event.action?.ok }));

  await game.expectText('Press ENTER to continue');
  assert.ok(events.some((e) => e.type === 'screen'));

  await game.step('enter', async () => {
    await game.press('ENTER');
  });
  const stepEvents = events.filter((e) => e.type === 'action' && e.action.type === 'step');
  assert.equal(stepEvents.length, 2);
  assert.equal(stepEvents[0].ok, null);
  assert.equal(stepEvents[0].action, stepEvents[1].action);
  assert.equal(stepEvents[1].action.ok, true);
  assert.ok(game.actions.includes(stepEvents[0].action));
  assert.ok(events.some((e) => e.type === 'action' && e.action.type === 'press'));

  await game.expectText('You pressed ENTER');
  const stopped = game.stop();
  await stopped;
  await new Promise((resolve) => setImmediate(resolve));
  const exit = events.find((e) => e.type === 'exit');
  assert.ok(exit);
  assert.ok(exit.exitInfo);

  sub.dispose();
  sub.dispose();
  throwing.dispose();
  const count = events.length;
  await game.resize(30, 8).catch(() => {});
  assert.equal(events.length, count);
});

test('observe() reports resize as a screen event and typed input as an action', async () => {
  const game = await launchGame({ command: process.execPath, args: [FIXTURE_MINIMAL], cols: 40, rows: 10 });
  try {
    await game.expectText('Press ENTER to continue');
    const types = [];
    game.observe((event) => types.push(event.type === 'action' ? `action:${event.action.type}` : event.type));
    await game.resize(30, 8);
    await game.type('x');
    assert.ok(types.includes('screen'));
    assert.ok(types.includes('action:resize'));
    assert.ok(types.includes('action:type'));
  } finally {
    await game.stop();
  }
});

test('getScreenCells() returns the grid before stop() and the final grid after it', async () => {
  const game = await launchGame({ command: process.execPath, args: [FIXTURE_MINIMAL], cols: 40, rows: 10 });
  await game.expectText('Press ENTER to continue');
  const live = game.getScreenCells();
  assert.equal(live.length, 10);
  assert.equal(live[0].length, 40);
  await game.stop();
  const final = game.getScreenCells();
  assert.equal(final.length, 10);
  assert.equal(
    final.map((row) => row.map((c) => c.char ?? c.ch ?? '').join('')).join('\n').includes('Press ENTER'),
    true,
  );
});
