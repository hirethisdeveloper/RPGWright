'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, validateTrace } = require('./config');
const { shouldWriteTrace, writeTrace } = require('./trace');
const { discoverTestFiles } = require('./discover');
const { createReporter } = require('./reporter');
const testModule = require('./test');
const { createFixtureScope, requestedFixtures } = require('./fixtures');
const { startRunEnvironment } = require('./services');

const VALUE_FLAGS = {
  '--config': 'configPath',
  '--grep': 'grep',
  '--grep-invert': 'grepInvert',
  '--reporter': 'reporter',
  '--max-failures': 'maxFailures',
  '--trace': 'trace',
  '--retries': 'retries',
  '--repeat-each': 'repeatEach',
  '--workers': 'workers',
};
const BOOLEAN_FLAGS = {
  '--list': 'list',
  '--update-snapshots': 'updateSnapshots',
  '--fail-on-flaky': 'failOnFlaky',
  '--watch': 'watch',
};
// Value flags that must be integers, and the smallest value each allows.
const INTEGER_FLAGS = {
  maxFailures: ['--max-failures', 1],
  retries: ['--retries', 0],
  repeatEach: ['--repeat-each', 1],
  workers: ['--workers', 1],
};

function parseArgs(args) {
  const opts = { configPath: null, filters: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (VALUE_FLAGS[arg]) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(
          arg === '--config'
            ? '--config requires a path, e.g. --config ./rpgwright.config.js'
            : `${arg} requires a value.`,
        );
      }
      opts[VALUE_FLAGS[arg]] = value;
      i += 1;
    } else if (BOOLEAN_FLAGS[arg]) {
      opts[BOOLEAN_FLAGS[arg]] = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option "${arg}". Run "rpgwright" with no arguments for usage.`);
    } else {
      opts.filters.push(arg);
    }
  }
  for (const [key, [flag, min]] of Object.entries(INTEGER_FLAGS)) {
    if (opts[key] === undefined) continue;
    const n = Number(opts[key]);
    if (!Number.isInteger(n) || n < min) {
      throw new Error(`${flag} requires ${min === 0 ? 'a non-negative' : 'a positive'} integer.`);
    }
    opts[key] = n;
  }
  return opts;
}

// "path/to/file.rpg.test.js:12" -> { pathPart, line }. A filter matches a
// file when the path part is a substring of its absolute path or its path
// relative to cwd; a line, when given, must be the test's own declaration
// line or one of its enclosing describe() lines.
function parseFilter(filter) {
  const match = /^(.*):(\d+)$/.exec(filter);
  return match ? { pathPart: match[1], line: Number(match[2]) } : { pathPart: filter, line: null };
}

function fileMatches(file, filter, cwd) {
  const wanted = path.normalize(filter.pathPart);
  return file.includes(wanted) || path.relative(cwd, file).includes(wanted);
}

function selectTests(collected, { filters, grep, grepInvert, cwd }) {
  const parsed = filters.map(parseFilter);
  const grepRe = grep ? new RegExp(grep) : null;
  const grepInvertRe = grepInvert ? new RegExp(grepInvert) : null;

  let selected = collected.filter((t) => {
    if (parsed.length > 0) {
      const lines = [t.line, ...testModule._scopeChain(t.scope).map((s) => s.line)];
      const hit = parsed.some((f) => fileMatches(t.file, f, cwd) && (f.line === null || lines.includes(f.line)));
      if (!hit) return false;
    }
    if (grepRe && !grepRe.test(t.name)) return false;
    if (grepInvertRe && grepInvertRe.test(t.name)) return false;
    return true;
  });

  const isOnly = (t) => t.only || testModule._scopeChain(t.scope).some((s) => s.mode === 'only');
  if (selected.some(isOnly)) selected = selected.filter(isOnly);
  return selected;
}

function isSkipped(t) {
  return t.skip || testModule._scopeChain(t.scope).some((s) => s.mode === 'skip');
}

/**
 * The running test's timeout, adjustable while it runs (test.setTimeout /
 * test.slow inside the body restart the timer from the test's start).
 * `promise` rejects when the deadline passes; 0 means no timeout.
 */
function createDeadline(timeoutMs) {
  const start = Date.now();
  let timer = null;
  let rejectFn;
  const promise = new Promise((_, reject) => {
    rejectFn = reject;
  });
  promise.catch(() => {});

  function arm(ms) {
    clearTimeout(timer);
    deadline.timeout = ms;
    if (ms === 0) return;
    timer = setTimeout(
      () => rejectFn(new Error(`Test exceeded its ${ms}ms timeout.`)),
      Math.max(0, start + ms - Date.now()),
    );
  }

  const deadline = {
    timeout: timeoutMs,
    promise,
    setTimeout: arm,
    slow: () => arm(deadline.timeout * 3),
    clear: () => clearTimeout(timer),
  };
  arm(timeoutMs);
  return deadline;
}

function resolveTimeout(chain, config) {
  let timeout = config.timeout;
  let slow = false;
  for (const scope of chain) {
    if (scope.timeout !== undefined) timeout = scope.timeout;
    if (scope.slow) slow = true;
  }
  return slow ? timeout * 3 : timeout;
}

async function runHooks(hooks, fixtures) {
  for (const hook of hooks) await hook(fixtures);
}

// The fixtures a test needs: whatever it and its beforeEach/afterEach hooks
// destructure, or everything if any of them can't be read.
function fixturesFor(fns) {
  const names = new Set();
  for (const fn of fns) {
    const requested = requestedFixtures(fn);
    if (requested === null) return null;
    requested.forEach((name) => names.add(name));
  }
  return [...names];
}

/**
 * One attempt at one test: set up the fixtures it asks for, run the
 * beforeEach hooks, the body and the afterEach hooks under a deadline, then
 * tear the fixtures down (stopping any launched game) whatever happened.
 */
async function runTest(t, chain, config, cliOptions, holder, attempt) {
  const options = Object.assign({}, ...chain.map((s) => s.use), t.use);
  const launchOptions = { ...config, ...options, scenarioName: t.name };
  if (cliOptions.updateSnapshots) launchOptions.updateSnapshots = true;
  // Record the session for a .cast file whenever a trace may be written.
  if (cliOptions.trace !== 'off') launchOptions.record = true;
  const beforeEach = chain.flatMap((s) => s.hooks.beforeEach);
  const afterEach = [...chain].reverse().flatMap((s) => s.hooks.afterEach);

  const deadline = createDeadline(resolveTimeout(chain, config));
  const info = {
    title: t.titlePath[t.titlePath.length - 1],
    titlePath: t.titlePath,
    file: t.file,
    line: t.line,
    retry: attempt.retry,
    repeatEachIndex: attempt.repeatEachIndex,
    workerIndex: cliOptions.workerIndex,
    viewport: t.viewport,
    outputDir: config.outputDir,
    get timeout() {
      return deadline.timeout;
    },
    setTimeout: deadline.setTimeout,
    slow: deadline.slow,
  };
  const fixtureScope = createFixtureScope({
    defs: t.fixtureDefs,
    launchOptions,
    testInfo: info,
    onGame: (game) => {
      holder.game = game;
    },
  });
  const run = {
    get game() {
      return fixtureScope.get('game');
    },
    info,
  };

  const body = testModule._runWith(run, async () => {
    const fixtures = await fixtureScope.resolveAll(fixturesFor([...beforeEach, t.fn, ...afterEach]));
    let bodyError = null;
    try {
      await runHooks(beforeEach, fixtures);
      await t.fn(fixtures);
    } catch (err) {
      bodyError = err;
    }
    // afterEach always runs, innermost scope first; the test's own error
    // wins over a later afterEach error.
    try {
      await runHooks(afterEach, fixtures);
    } catch (err) {
      if (!bodyError) bodyError = err;
    }
    if (bodyError) throw bodyError;
  });
  // If the deadline wins, the body keeps running until teardown stops its
  // game; its eventual rejection has nowhere to go.
  body.catch(() => {});

  let error = null;
  try {
    await Promise.race([body, deadline.promise]);
  } catch (err) {
    error = err;
  }
  deadline.clear();
  try {
    await fixtureScope.teardown();
  } catch (err) {
    if (!error) error = err;
  }
  if (error) throw error;
}

/**
 * Runs one file's selected tests in order, opening a describe scope (its
 * beforeAll hooks) just before its first runnable test and closing it (its
 * afterAll hooks) once the next test is outside it. A failing beforeAll
 * fails every test in its scope without launching them. A failed test is
 * retried up to `retries` times; one that passes on a retry is flaky.
 */
async function runFile(tests, config, cliOptions, reporter, budget) {
  const open = [];

  async function closeScopesBeyond(depth) {
    while (open.length > depth) {
      const scope = open.pop();
      if (scope.beforeAllError) continue;
      try {
        await runHooks([...scope.hooks.afterAll].reverse(), {});
      } catch (err) {
        reporter.testFailed(`${scope.name || 'file'} > afterAll`, 0, err);
        budget.failures += 1;
      }
    }
  }

  for (const t of tests) {
    if (budget.failures >= budget.max) break;
    const meta = { file: t.file, line: t.line };
    if (isSkipped(t)) {
      reporter.testSkipped(t.name, meta);
      continue;
    }

    const chain = testModule._scopeChain(t.scope);
    let shared = 0;
    while (shared < open.length && open[shared] === chain[shared]) shared += 1;
    await closeScopesBeyond(shared);
    for (const scope of chain.slice(shared)) {
      open.push(scope);
      scope.beforeAllError = null;
      if (open.some((s) => s.beforeAllError)) continue;
      try {
        await runHooks(scope.hooks.beforeAll, {});
      } catch (err) {
        scope.beforeAllError = err;
      }
    }

    const failedSetup = chain.find((s) => s.beforeAllError);
    for (let retry = 0; ; retry += 1) {
      const testStart = Date.now();
      const holder = {};
      let error = null;
      if (failedSetup) {
        error = failedSetup.beforeAllError;
      } else {
        try {
          await runTest(t, chain, config, cliOptions, holder, { retry, repeatEachIndex: t.repeatEachIndex || 0 });
        } catch (err) {
          error = err;
        }
      }

      if (t.fail && !failedSetup) {
        error = error ? null : new Error('Expected this test to fail (test.fail), but it passed.');
      }
      if (holder.game && shouldWriteTrace(cliOptions.trace, Boolean(error))) {
        const written = writeTrace(config.outputDir, {
          testName: retry > 0 ? `${t.name} (retry ${retry})` : t.name,
          file: t.file,
          passed: !error,
          durationMs: Date.now() - testStart,
          error,
          trace: holder.game.getTrace(),
        });
        if (error) {
          error.message += `\n\nTrace: ${written.trace}`;
          if (written.cast) error.message += `\nRecording: ${written.cast}`;
        }
      }

      const duration = Date.now() - testStart;
      if (!error) {
        reporter.testPassed(t.name, duration, { retry }, meta);
        break;
      }
      if (failedSetup || retry >= cliOptions.retries) {
        reporter.testFailed(t.name, duration, error, { retry }, meta);
        budget.failures += 1;
        break;
      }
    }
  }

  await closeScopesBeyond(0);
}

// Records a file's reporter events so a parallel run can replay them in
// file order, keeping the output identical to a serial run's.
function bufferedReporter() {
  const events = [];
  const buffer = { flushTo: (reporter) => events.forEach(([method, args]) => reporter[method](...args)) };
  for (const method of ['fileStarted', 'testPassed', 'testFailed', 'testSkipped']) {
    buffer[method] = (...args) => events.push([method, args]);
  }
  return buffer;
}

/**
 * Runs the plan's files on up to `workers` concurrent workers in this
 * process (each test still gets its own app process; the workers only
 * interleave waiting). Tests within a file stay in order. With one worker,
 * events stream straight to the reporter; with more, each file's events are
 * buffered and flushed in file order as soon as every earlier file is done.
 */
async function runPlan(plan, { config, cliOptions, reporter, budget, workers }) {
  const relative = (file) => path.relative(config.testDir, file);
  if (workers <= 1) {
    for (const { file, tests } of plan) {
      if (budget.failures >= budget.max) break;
      reporter.fileStarted(relative(file));
      await runFile(tests, config, { ...cliOptions, workerIndex: 0 }, reporter, budget);
    }
    return;
  }

  const buffers = plan.map(() => bufferedReporter());
  const finished = plan.map(() => false);
  let nextToStart = 0;
  let nextToFlush = 0;
  async function worker(workerIndex) {
    while (nextToStart < plan.length && budget.failures < budget.max) {
      const index = nextToStart;
      nextToStart += 1;
      const { file, tests } = plan[index];
      buffers[index].fileStarted(relative(file));
      await runFile(tests, config, { ...cliOptions, workerIndex }, buffers[index], budget);
      finished[index] = true;
      while (nextToFlush < plan.length && finished[nextToFlush]) {
        buffers[nextToFlush].flushTo(reporter);
        nextToFlush += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, plan.length) }, (_, i) => worker(i)));
}

/**
 * Makes sure .ts test files can be required. Node 22.18+ strips types
 * itself (process.features.typescript); on older versions, a project that
 * has `tsx` installed gets it registered. RPGWright depends on neither.
 */
let typeScriptReady = false;
function ensureTypeScript(cwd) {
  if (typeScriptReady || process.features.typescript) return;
  let tsxEntry;
  try {
    tsxEntry = require.resolve('tsx/cjs', { paths: [cwd] });
  } catch {
    throw new Error(
      `Node ${process.versions.node} can't load TypeScript test files on its own. Use Node 22.18 or later, or install tsx in your project (npm install -D tsx).`,
    );
  }
  require(tsxEntry);
  typeScriptReady = true;
}

function collectFiles(files) {
  if (files.some((file) => file.endsWith('.ts'))) ensureTypeScript(process.cwd());
  return files.map((file) => {
    testModule._beginFile(file);
    delete require.cache[require.resolve(file)];
    require(file);
    return { file, tests: testModule._collect() };
  });
}

/**
 * Discovers every test file matching the resolved config, collects all of
 * their tests up front (so test.only and filters apply across files), then
 * runs them file by file. Each test gets its own freshly launched
 * GameDriver (the `game` fixture), auto-stopped in a finally block
 * regardless of pass/fail — this is the runner's whole reason to exist over
 * hand-rolled launch/try/finally-stop boilerplate per test file.
 */
async function runTests({
  cwd = process.cwd(),
  configPath,
  filters = [],
  grep,
  grepInvert,
  list,
  reporter,
  updateSnapshots,
  maxFailures,
  trace,
  retries,
  repeatEach = 1,
  workers,
} = {}) {
  const config = loadConfig({ configPath, cwd });
  const traceMode = trace === undefined ? config.trace : validateTrace(trace, '--trace');
  const files = discoverTestFiles({ testDir: config.testDir, testMatch: config.testMatch });
  testModule._setConfig(config);
  const collected = collectFiles(files);
  const selected = new Set(selectTests(collected.flatMap((f) => f.tests), { filters, grep, grepInvert, cwd }));
  // --repeat-each runs every selected test that many times, back to back.
  const repeated = (t) =>
    repeatEach === 1
      ? [t]
      : Array.from({ length: repeatEach }, (_, i) => ({ ...t, name: `${t.name} [repeat ${i + 1}/${repeatEach}]`, repeatEachIndex: i }));
  const plan = collected
    .map(({ file, tests }) => ({ file, tests: tests.filter((t) => selected.has(t)).flatMap(repeated) }))
    .filter(({ tests }) => tests.length > 0);

  if (list) {
    for (const { file, tests } of plan) {
      for (const t of tests) console.log(`  ${path.relative(config.testDir, file)}:${t.line} › ${t.name}`);
    }
    console.log(`Total: ${selected.size} test${selected.size === 1 ? '' : 's'} in ${plan.length} file${plan.length === 1 ? '' : 's'}`);
    return { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  }

  const activeReporter = createReporter(reporter || config.reporter, { outputDir: config.outputDir, cwd });
  const start = Date.now();

  if (files.length === 0) {
    console.log(`No test files matched ${JSON.stringify(config.testMatch)} under ${config.testDir}`);
  } else if (plan.length === 0) {
    console.log('No tests matched the given filters.');
  }

  const budget = { failures: 0, max: maxFailures ?? Infinity };
  // Services and globalSetup only start when there are tests to run.
  const teardownEnvironment = plan.length > 0 ? await startRunEnvironment(config) : async () => {};
  try {
    await runPlan(plan, {
      config,
      cliOptions: { updateSnapshots, trace: traceMode, retries: retries ?? config.retries },
      reporter: activeReporter,
      budget,
      workers: workers ?? config.workers,
    });
  } finally {
    await teardownEnvironment();
  }
  if (budget.failures >= budget.max) {
    console.log(`\nStopped after ${budget.max} failure${budget.max === 1 ? '' : 's'} (--max-failures).`);
  }

  return activeReporter.summary(Date.now() - start);
}

const IGNORED_IN_WATCH = /(^|[\\/])(node_modules|\.git|__snapshots__|test-results)([\\/]|$)/;

/**
 * Runs the suite, then reruns on every file change under the test
 * directory, the config's directory and any `watchPaths`. A change only to
 * test files reruns just those files; any other change reruns everything
 * selected. Modules loaded from those directories are dropped from the
 * require cache first, so edited helpers are picked up. Runs until killed.
 */
async function watch(options) {
  const cwd = process.cwd();
  const runOnce = async (filters) => {
    try {
      await runTests({ ...options, filters });
    } catch (err) {
      console.error(err.message);
    }
    console.log('\nWaiting for file changes. Press Ctrl+C to exit.');
  };
  await runOnce(options.filters);

  const config = loadConfig({ configPath: options.configPath, cwd });
  const roots = [...new Set([config.testDir, path.dirname(config.configPath), ...(config.watchPaths || []).map((p) => path.resolve(path.dirname(config.configPath), p))])];
  const changed = new Set();
  let timer = null;
  let running = false;

  async function rerun() {
    if (running) {
      timer = setTimeout(rerun, 200);
      return;
    }
    running = true;
    const files = [...changed];
    changed.clear();
    for (const key of Object.keys(require.cache)) {
      if (roots.some((root) => key.startsWith(root)) && !IGNORED_IN_WATCH.test(key)) delete require.cache[key];
    }
    const testFiles = new Set(discoverTestFiles({ testDir: config.testDir, testMatch: config.testMatch }));
    const onlyTests = files.every((f) => testFiles.has(f));
    console.log(`\nChanged: ${files.map((f) => path.relative(cwd, f)).join(', ')}`);
    await runOnce(onlyTests ? files.filter((f) => fs.existsSync(f)) : options.filters);
    running = false;
  }

  for (const root of roots) {
    fs.watch(root, { recursive: true }, (event, filename) => {
      if (!filename || IGNORED_IN_WATCH.test(filename)) return;
      changed.add(path.join(root, filename));
      clearTimeout(timer);
      timer = setTimeout(rerun, 200);
    });
  }
  return new Promise(() => {});
}

async function runCli(args) {
  const options = parseArgs(args);
  if (options.watch) return watch(options);
  const totals = await runTests(options);
  if (options.failOnFlaky && totals.flaky > 0) {
    console.log(`\n${totals.flaky} flaky test${totals.flaky === 1 ? '' : 's'} (--fail-on-flaky).`);
  }
  process.exitCode = totals.failed > 0 || (options.failOnFlaky && totals.flaky > 0) ? 1 : 0;
}

module.exports = { runTests, runCli, parseArgs };
