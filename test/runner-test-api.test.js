'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rpgTest = require('../runner/test');

test('test()/_collect: registers tests in call order under their given names', () => {
  rpgTest._beginFile();
  rpgTest.test('first', () => {});
  rpgTest.test('second', () => {});
  const collected = rpgTest._collect();
  assert.deepEqual(collected.map((t) => t.name), ['first', 'second']);
  assert.equal(collected[0].skip, false);
});

test('test.skip: marks a test as skip without needing the runner to inspect the fn', () => {
  rpgTest._beginFile();
  rpgTest.test.skip('skipped one', () => {
    throw new Error('should never run');
  });
  const [collected] = rpgTest._collect();
  assert.equal(collected.skip, true);
});

test('describe(): prefixes nested test names with the describe path, and restores it after', () => {
  rpgTest._beginFile();
  rpgTest.describe('Group A', () => {
    rpgTest.test('does a thing', () => {});
    rpgTest.describe('Nested', () => {
      rpgTest.test('does a nested thing', () => {});
    });
  });
  rpgTest.test('top level after group', () => {});

  const names = rpgTest._collect().map((t) => t.name);
  assert.deepEqual(names, ['Group A > does a thing', 'Group A > Nested > does a nested thing', 'top level after group']);
});

test('_collect: returns an empty array and resets state when no tests were registered', () => {
  rpgTest._beginFile();
  assert.deepEqual(rpgTest._collect(), []);
});

test('_collect: clears the registry so a second file cannot see the first file\'s tests', () => {
  rpgTest._beginFile();
  rpgTest.test('from file one', () => {});
  rpgTest._collect();

  rpgTest._beginFile();
  const collected = rpgTest._collect();
  assert.deepEqual(collected, []);
});

test('test(): throws a clear error when called before _beginFile (i.e. outside a running test file)', () => {
  rpgTest._beginFile();
  rpgTest._collect();
  assert.throws(() => rpgTest.test('orphaned', () => {}), /outside of a running test file/);
});

test('test.only / test.fixme / test.fail: set the matching flags on the collected test', () => {
  rpgTest._beginFile();
  rpgTest.test.only('focused', () => {});
  rpgTest.test.fixme('broken', () => {});
  rpgTest.test.fail('expected to fail', () => {});
  const [focused, broken, failing] = rpgTest._collect();
  assert.equal(focused.only, true);
  assert.equal(broken.skip, true);
  assert.equal(failing.fail, true);
  assert.equal(failing.skip, false);
});

test('describe.skip / describe.only: mark the scope, not each test', () => {
  rpgTest._beginFile();
  rpgTest.describe.skip('skipped group', () => rpgTest.test('a', () => {}));
  rpgTest.describe.only('focused group', () => rpgTest.test('b', () => {}));
  const [a, b] = rpgTest._collect();
  assert.equal(a.scope.mode, 'skip');
  assert.equal(b.scope.mode, 'only');
  assert.equal(a.skip, false);
});

test('test.describe is the same function as describe (alternate spelling)', () => {
  assert.equal(rpgTest.test.describe, rpgTest.describe);
});

test('test.use: merges options into the current scope only, later calls overriding earlier keys', () => {
  rpgTest._beginFile();
  rpgTest.test.use({ cols: 80, rows: 24 });
  rpgTest.describe('narrow', () => {
    rpgTest.test.use({ cols: 40 });
    rpgTest.test('inner', () => {});
  });
  rpgTest.test('outer', () => {});
  const [inner, outer] = rpgTest._collect();
  const merged = Object.assign({}, ...rpgTest._scopeChain(inner.scope).map((s) => s.use));
  assert.deepEqual(merged, { cols: 40, rows: 24 });
  assert.deepEqual(outer.scope.use, { cols: 80, rows: 24 });
});

test('hooks: register on the scope where they are declared', () => {
  rpgTest._beginFile();
  const fileHook = () => {};
  const groupHook = () => {};
  rpgTest.test.beforeEach(fileHook);
  rpgTest.describe('group', () => {
    rpgTest.test.afterAll(groupHook);
    rpgTest.test('t', () => {});
  });
  const [t] = rpgTest._collect();
  const [root, group] = rpgTest._scopeChain(t.scope);
  assert.deepEqual(root.hooks.beforeEach, [fileHook]);
  assert.deepEqual(group.hooks.afterAll, [groupHook]);
  assert.deepEqual(group.hooks.beforeEach, []);
});

test('test.setTimeout / test.slow at collection time configure the current scope', () => {
  rpgTest._beginFile();
  rpgTest.describe('slow group', () => {
    rpgTest.test.setTimeout(5000);
    rpgTest.test.slow();
    rpgTest.test('t', () => {});
  });
  const [t] = rpgTest._collect();
  assert.equal(t.scope.timeout, 5000);
  assert.equal(t.scope.slow, true);
  assert.throws(() => rpgTest.test.setTimeout('5s'), /test\.setTimeout\(\): "timeout" must be a non-negative number/);
});

test('test.eachViewport validates a list passed to it, and names viewports "<cols>x<rows>" by default', () => {
  rpgTest._beginFile();
  rpgTest.test.eachViewport([{ cols: 40, rows: 12 }, { cols: 80, rows: 24, name: 'wide' }], 'fits', () => {});
  assert.deepEqual(rpgTest._collect().map((t) => t.name), ['fits [40x12]', 'fits [wide]']);
  rpgTest._beginFile();
  assert.throws(() => rpgTest.test.eachViewport([{ cols: 0, rows: 5 }], 'bad', () => {}), /test\.eachViewport\("bad"\): viewports\[0\] must have positive integer/);
  rpgTest._collect();
});

test('test.setTimeout / test.slow inside a running test go to the running test\'s info', () => {
  const calls = [];
  rpgTest._setCurrentRun({ games: [], info: { setTimeout: (ms) => calls.push(['setTimeout', ms]), slow: () => calls.push(['slow']) } });
  try {
    rpgTest.test.setTimeout(1234);
    rpgTest.test.slow();
  } finally {
    rpgTest._setCurrentRun(null);
  }
  assert.deepEqual(calls, [['setTimeout', 1234], ['slow']]);
});

test('test.step delegates to every running game\'s step(); step/info throw outside a running test', async () => {
  const game = (label) => ({ step: async (name, fn) => `${label}(${name}:${await fn()})` });
  rpgTest._setCurrentRun({ games: [game('a'), game('b')], info: { title: 'x' } });
  try {
    assert.equal(await rpgTest.test.step('open', async () => 'done'), 'a(open:b(open:done))');
    assert.deepEqual(rpgTest.test.info(), { title: 'x' });
  } finally {
    rpgTest._setCurrentRun(null);
  }
  assert.throws(() => rpgTest.test.step('x', () => {}), /only be called while a test is running/);
  assert.throws(() => rpgTest.test.info(), /only be called while a test is running/);
});

test('collected tests carry their titlePath, file and declaration line', () => {
  rpgTest._beginFile(__filename);
  rpgTest.describe('group', () => {
    rpgTest.test('t', () => {});
  });
  const [t] = rpgTest._collect();
  assert.deepEqual(t.titlePath, ['group', 't']);
  assert.equal(t.file, __filename);
  assert.equal(t.line, t.scope.line + 1, 'the test is declared on the line after its describe()');
});

test('test.eachViewport: one test per config viewport, named and sized for it', () => {
  rpgTest._setConfig({ viewports: [{ name: '80x24', cols: 80, rows: 24 }, { name: 'tiny', cols: 20, rows: 5 }] });
  try {
    rpgTest._beginFile();
    const fn = () => {};
    rpgTest.test.eachViewport('fits', fn);
    const [wide, tiny] = rpgTest._collect();
    assert.equal(wide.name, 'fits [80x24]');
    assert.deepEqual(wide.use, { cols: 80, rows: 24 });
    assert.deepEqual(tiny.viewport, { name: 'tiny', cols: 20, rows: 5 });
    assert.equal(tiny.fn, fn);
  } finally {
    rpgTest._setConfig(null);
  }
});

test('test.eachViewport: an explicit list overrides the config; no viewports at all is a clear error', () => {
  rpgTest._beginFile();
  rpgTest.test.eachViewport([{ cols: 30, rows: 10 }], 'explicit', () => {});
  const [t] = rpgTest._collect();
  assert.equal(t.name, 'explicit [30x10]');

  rpgTest._beginFile();
  assert.throws(() => rpgTest.test.eachViewport('none', () => {}), /needs viewports/);
  rpgTest._collect();
});

test('test.extend: returns a test() whose tests carry the merged fixture definitions, with every method', () => {
  const withDb = rpgTest.test.extend({ db: async ({}, use) => use('db') });
  const withBoth = withDb.extend({ cache: 1 });
  rpgTest._beginFile();
  withBoth('uses both', () => {});
  withBoth.skip('skipped', () => {});
  rpgTest.test('plain', () => {});
  const [both, skipped, plain] = rpgTest._collect();
  assert.deepEqual(Object.keys(both.fixtureDefs), ['db', 'cache']);
  assert.equal(skipped.skip, true);
  assert.deepEqual(Object.keys(skipped.fixtureDefs), ['db', 'cache']);
  assert.deepEqual(plain.fixtureDefs, {});
  for (const method of ['describe', 'beforeEach', 'use', 'step', 'info', 'eachViewport', 'extend']) {
    assert.equal(typeof withBoth[method], 'function', method);
  }
});

test('test.extend: refuses to redefine a built-in fixture', () => {
  assert.throws(() => rpgTest.test.extend({ game: 1 }), /"game" is a built-in fixture/);
});

test('test.step runs fn directly when the running test never launched a game', async () => {
  rpgTest._setCurrentRun({ games: [], info: {} });
  try {
    assert.equal(await rpgTest.test.step('no game', async () => 'ran'), 'ran');
  } finally {
    rpgTest._setCurrentRun(null);
  }
});
