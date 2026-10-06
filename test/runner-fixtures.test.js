'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { requestedFixtures, splitTopLevel, createFixtureScope, BUILTIN_FIXTURES } = require('../runner/fixtures');

const PROBE = path.join(__dirname, '..', 'fixtures', 'term-probe', 'cli.js');

test('splitTopLevel: ignores separators nested in brackets and quotes', () => {
  assert.deepEqual(splitTopLevel('a, b = { x: 1, y: 2 }, c = "d,e"', ','), ['a', ' b = { x: 1, y: 2 }', ' c = "d,e"']);
});

test('requestedFixtures: reads destructured names from arrows, async functions and methods', () => {
  assert.deepEqual(requestedFixtures(async ({ game, tmpHome }) => {}), ['game', 'tmpHome']);
  assert.deepEqual(requestedFixtures(({ game: g, viewport = { cols: 1 } }) => {}), ['game', 'viewport']);
  assert.deepEqual(requestedFixtures(async function named({ launch }) {}), ['launch']);
  assert.deepEqual(requestedFixtures({ m({ testInfo }) {} }.m), ['testInfo']);
  assert.deepEqual(requestedFixtures(() => {}), []);
  assert.deepEqual(requestedFixtures(async () => {}), []);
  assert.deepEqual(requestedFixtures(({}) => {}), []);
  assert.deepEqual(requestedFixtures(({ game /* the app */, url = 'http://localhost' }) => {}), ['game', 'url']);
});

test('requestedFixtures: null (meaning "everything") when the first parameter is not destructured', () => {
  assert.equal(requestedFixtures((fixtures) => fixtures.game), null);
  assert.equal(requestedFixtures(async (fixtures) => fixtures.game), null);
  assert.equal(requestedFixtures(({ game, ...rest }) => rest), null);
  assert.equal(requestedFixtures((fixtures) => fixtures), null, 'a bare arrow parameter');
});

function scope(defs = {}, launchOptions = {}) {
  return createFixtureScope({ defs, launchOptions, testInfo: { title: 't' } });
}

test('createFixtureScope: user fixtures get their dependencies, are created once, and tear down in reverse', async () => {
  const log = [];
  const s = scope({
    base: async ({}, use) => {
      log.push('base up');
      await use('B');
      log.push('base down');
    },
    derived: async ({ base }, use, testInfo) => {
      log.push(`derived up with ${base} for ${testInfo.title}`);
      await use(`${base}+D`);
      log.push('derived down');
    },
    constant: 42,
  });
  const values = await s.resolveAll(['derived', 'base', 'constant']);
  assert.deepEqual(values, { derived: 'B+D', base: 'B', constant: 42 });
  await s.teardown();
  assert.deepEqual(log, ['base up', 'derived up with B for t', 'derived down', 'base down']);
});

test('createFixtureScope: clear errors for a fixture that never calls use(), a cycle, and an unknown name', async () => {
  await assert.rejects(scope({ lazy: async () => {} }).resolveAll(['lazy']), /Fixture "lazy" finished without calling use\(value\)/);
  await assert.rejects(
    Promise.resolve().then(() => scope({ a: async ({ b }, use) => use(1), b: async ({ a }, use) => use(2) }).resolveAll(['a'])),
    /Fixture cycle: a -> b -> a/,
  );
  await assert.rejects(scope().resolveAll(['nope']), /Unknown fixture "nope"/);
});

test('createFixtureScope: teardown runs every cleanup and reports the first error', async () => {
  const cleaned = [];
  const s = scope({
    first: async ({}, use) => {
      await use(1);
      cleaned.push('first');
    },
    second: async ({}, use) => {
      await use(2);
      throw new Error('cleanup failed');
    },
  });
  await s.resolveAll(['first', 'second']);
  await assert.rejects(s.teardown(), /cleanup failed/);
  assert.deepEqual(cleaned, ['first']);
});

test('createFixtureScope: tmpHome is a fresh directory seeded with homeFiles, removed at teardown', async () => {
  const s = scope({}, { homeFiles: { '.config/app/settings.json': '{"sound":false}' } });
  const { tmpHome } = await s.resolveAll(['tmpHome']);
  assert.equal(fs.readFileSync(path.join(tmpHome, '.config/app/settings.json'), 'utf8'), '{"sound":false}');
  await s.teardown();
  assert.equal(fs.existsSync(tmpHome), false);
});

test('createFixtureScope: game launches with HOME set to tmpHome whichever is destructured first; launch() makes more', async () => {
  // Wide enough that the temp directory's path doesn't wrap.
  const launchOptions = { command: process.execPath, args: [PROBE, 'env'], cols: 200, rows: 12, expectTimeout: 3000 };
  const s = scope({}, launchOptions);
  let game;
  let second;
  try {
    let tmpHome;
    let launch;
    ({ game, tmpHome, launch } = await s.resolveAll(['game', 'tmpHome', 'launch']));
    await game.expectText(`HOME=${tmpHome}`);
    second = await launch({ args: [PROBE, 'echo'] });
    await second.expectText('READY');
  } finally {
    // Always stop the processes, or a failure leaves this test file hanging.
    await s.teardown();
  }
  assert.notEqual(game.getTrace().exitInfo, null, 'teardown stopped the game');
  assert.notEqual(second.getTrace().exitInfo, null, 'teardown stopped the launched process too');
});

test('createFixtureScope: a test that does not destructure gets every fixture but tmpHome, so HOME is left alone', async () => {
  const launchOptions = { command: process.execPath, args: [PROBE, 'env'], cols: 200, rows: 12, expectTimeout: 3000 };
  const s = scope({}, launchOptions);
  try {
    const fixtures = await s.resolveAll(null);
    assert.deepEqual(Object.keys(fixtures).sort(), ['game', 'launch', 'testInfo', 'viewport']);
    await fixtures.game.expectText(`HOME=${process.env.HOME}`);
  } finally {
    await s.teardown();
  }
});

test('createFixtureScope: anything set up after teardown started is torn down at once, and the caller fails', async () => {
  const removed = [];
  const s = scope({
    late: async ({}, use) => {
      await use('value');
      removed.push('late');
    },
  });
  await s.teardown();
  await assert.rejects(s.resolveAll(['late']), /already finished/);
  assert.deepEqual(removed, ['late']);
});

test('BUILTIN_FIXTURES lists what every test can request', () => {
  assert.deepEqual(BUILTIN_FIXTURES, ['game', 'viewport', 'launch', 'tmpHome', 'testInfo']);
});
