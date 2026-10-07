'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { expect } = require('./expect');
const { validateTimeout, normalizeViewports } = require('./config');

// Set by run.js before require()-ing each test file, and read back after —
// registration (this module) and execution (run.js) are deliberately
// separate: test files run synchronously top-to-bottom to populate this
// registry, then run.js executes what was collected, setting up and tearing
// down each test's fixtures around it.
let suite = null;

// The running test, so test.step/test.info/test.setTimeout can reach it.
// run.js runs each test inside _runWith(), and the async context carries it
// through every await; with several workers, each test sees its own.
// _setCurrentRun sets a fallback outside any such context (unit tests).
const runContext = new AsyncLocalStorage();
let fallbackRun = null;

function currentRun() {
  return runContext.getStore() || fallbackRun;
}

function _runWith(run, fn) {
  return runContext.run(run, fn);
}

// The resolved config's viewports, set by run.js before collecting files.
let configViewports;

function _setConfig(config) {
  configViewports = config ? config.viewports : undefined;
}

const HOOK_NAMES = ['beforeAll', 'afterAll', 'beforeEach', 'afterEach'];

// A scope is the file itself (the root) or one describe() block. Tests keep a
// reference to the scope they were declared in; run.js walks the chain from
// the root to resolve options, hooks, skip/only and timeouts.
function createScope(name, parent, line) {
  return {
    name,
    parent,
    line,
    use: {},
    hooks: { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] },
    mode: null,
    timeout: undefined,
    slow: false,
  };
}

function _beginFile(file = null) {
  const root = createScope(null, null, null);
  suite = { file, root, current: root, tests: [] };
}

function _collect() {
  const collected = suite ? suite.tests : [];
  suite = null;
  return collected;
}

function _setCurrentRun(run) {
  fallbackRun = run;
}

function _scopeChain(scope) {
  const chain = [];
  for (let s = scope; s; s = s.parent) chain.unshift(s);
  return chain;
}

function assertInSuite(fnName) {
  if (!suite) {
    throw new Error(`${fnName}() was called outside of a running test file — run test files through "rpgwright test", not directly with node.`);
  }
}

function assertInTest(fnName) {
  if (!currentRun()) throw new Error(`${fnName}() can only be called while a test is running.`);
}

// The 1-based line in the test file that called test()/describe(), read off
// the stack. Used for `rpgwright test file.rpg.test.js:12` filtering.
function callerLine() {
  if (!suite.file) return null;
  for (const frame of new Error().stack.split('\n')) {
    const index = frame.indexOf(suite.file);
    if (index === -1) continue;
    const match = /:(\d+):\d+\)?$/.exec(frame.slice(index + suite.file.length));
    if (match) return Number(match[1]);
  }
  return null;
}

function register(name, fn, flags) {
  const titlePath = _scopeChain(suite.current)
    .filter((s) => s.name !== null)
    .map((s) => s.name)
    .concat(name);
  suite.tests.push({
    name: titlePath.join(' > '),
    titlePath,
    fn,
    file: suite.file,
    line: callerLine(),
    scope: suite.current,
    skip: false,
    only: false,
    fail: false,
    ...flags,
  });
}

const { BUILTIN_FIXTURES } = require('./fixtures');

/**
 * Builds a test() function, with its skip/only/fixme/fail/eachViewport
 * variants, that registers tests carrying `fixtureDefs`. The exported
 * `test` has none; test.extend() returns a new one with more.
 */
function createTestApi(fixtureDefs) {
  const reg = (name, fn, flags) => register(name, fn, { ...flags, fixtureDefs });

  function api(name, fn) {
    assertInSuite('test');
    reg(name, fn, {});
  }

  api.skip = function skip(name, fn) {
    assertInSuite('test.skip');
    reg(name, fn, { skip: true });
  };

  api.fixme = function fixme(name, fn) {
    assertInSuite('test.fixme');
    reg(name, fn, { skip: true });
  };

  api.only = function only(name, fn) {
    assertInSuite('test.only');
    reg(name, fn, { only: true });
  };

  // Expected to fail: passes when the body throws, fails when it passes.
  api.fail = function fail(name, fn) {
    assertInSuite('test.fail');
    reg(name, fn, { fail: true });
  };

  /**
   * Registers one test per viewport ("name [80x24]"), each launched at that
   * size. Uses the config's `viewports` unless a list is passed first:
   * test.eachViewport([{ cols: 40, rows: 12 }], name, fn). The test receives
   * the viewport as a fixture: async ({ game, viewport }) => ...
   */
  api.eachViewport = function eachViewport(...args) {
    assertInSuite('test.eachViewport');
    const [list, name, fn] = Array.isArray(args[0]) ? args : [configViewports, ...args];
    if (!list || list.length === 0) {
      throw new Error(`test.eachViewport("${name}") needs viewports: set "viewports" in rpgwright.config.js or pass a list as the first argument.`);
    }
    // The config's list is already validated; one passed here is checked the same way.
    const viewports = list === configViewports ? list : normalizeViewports(list, `test.eachViewport("${name}")`);
    for (const viewport of viewports) {
      reg(`${name} [${viewport.name}]`, fn, { use: { cols: viewport.cols, rows: viewport.rows }, viewport });
    }
  };

  /**
   * A new test() whose tests can also request these fixtures. Each
   * definition is a value, or
   *   async ({ ...otherFixtures }, use, testInfo) => { setup; await use(value); cleanup }
   * Fixtures are created only for tests (and hooks) that destructure them.
   */
  api.extend = function extend(defs) {
    for (const name of Object.keys(defs)) {
      if (BUILTIN_FIXTURES.includes(name)) throw new Error(`test.extend: "${name}" is a built-in fixture and can't be redefined.`);
    }
    return createTestApi({ ...fixtureDefs, ...defs });
  };

  Object.assign(api, shared);
  return api;
}

// Methods that don't register tests, identical on every test() variant.
const shared = {};

// Options merged over the config for every test in the current scope —
// any launchGame option (cols, rows, args, env, term, colorDepth, ...).
shared.use = function use(options) {
  assertInSuite('test.use');
  suite.current.use = { ...suite.current.use, ...options };
};

for (const hookName of HOOK_NAMES) {
  shared[hookName] = function addHook(fn) {
    assertInSuite(`test.${hookName}`);
    suite.current.hooks[hookName].push(fn);
  };
}

// At collection time, sets the timeout for the current scope; inside a
// running test, changes that test's own timeout. 0 disables it.
shared.setTimeout = function setTimeout(ms) {
  validateTimeout(ms, 'test.setTimeout()');
  if (currentRun()) {
    currentRun().info.setTimeout(ms);
    return;
  }
  assertInSuite('test.setTimeout');
  suite.current.timeout = ms;
};

// Triples the timeout, for the current scope or the running test.
shared.slow = function slow() {
  if (currentRun()) {
    currentRun().info.slow();
    return;
  }
  assertInSuite('test.slow');
  suite.current.slow = true;
};

// Groups actions in the running test's game; a test that never launched
// one still runs `fn`.
// Recorded as a step on every process the test has launched, so each one's
// failure report and trace groups the actions inside it.
shared.step = function step(name, fn) {
  assertInTest('test.step');
  const { games } = currentRun();
  return games.reduceRight((inner, game) => () => game.step(name, inner), fn)();
};

shared.info = function info() {
  assertInTest('test.info');
  return currentRun().info;
};

function describeWith(mode, name, fn) {
  const scope = createScope(name, suite.current, callerLine());
  scope.mode = mode;
  suite.current = scope;
  try {
    fn();
  } finally {
    suite.current = scope.parent;
  }
}

function describe(name, fn) {
  assertInSuite('describe');
  describeWith(null, name, fn);
}

describe.skip = function describeSkip(name, fn) {
  assertInSuite('describe.skip');
  describeWith('skip', name, fn);
};

describe.only = function describeOnly(name, fn) {
  assertInSuite('describe.only');
  describeWith('only', name, fn);
};

// test.describe is an alias; both forms work.
shared.describe = describe;

const test = createTestApi({});

module.exports = { test, describe, expect, _beginFile, _collect, _setCurrentRun, _runWith, _setConfig, _scopeChain };
