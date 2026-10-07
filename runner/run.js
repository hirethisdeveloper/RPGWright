'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadConfig, validateTrace, MIN } = require('./config');
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
  retries: ['--retries', MIN.retries],
  repeatEach: ['--repeat-each', 1],
  workers: ['--workers', MIN.workers],
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
function createDeadline(timeoutMs, label = 'Test') {
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
      () => {
        deadline.error = new Error(`${label} exceeded its ${ms}ms timeout.`);
        rejectFn(deadline.error);
      },
      Math.max(0, start + ms - Date.now()),
    );
  }

  const deadline = {
    timeout: timeoutMs,
    error: null,
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

// Tests can throw anything (`throw 'oops'`); everything downstream (the
// reporters, the trace, the appended Trace: line) needs an Error.
function toError(value) {
  return value instanceof Error ? value : new Error(`Thrown: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function runHooks(hooks, fixtures) {
  for (const hook of hooks) await hook(fixtures);
}

// Runs `work` against a deadline; a timed-out `work` is abandoned (its
// eventual rejection has nowhere to go).
function withinDeadline(work, deadline) {
  work.catch(() => {});
  return Promise.race([work, deadline.promise]);
}

// beforeAll/afterAll hooks get the same timeout a test in their scope would.
async function runScopeHooks(hooks, kind, timeout) {
  const deadline = createDeadline(timeout, `${kind} hook`);
  try {
    await withinDeadline(runHooks(hooks, {}), deadline);
  } catch (err) {
    throw toError(err);
  } finally {
    deadline.clear();
  }
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
  });
  holder.games = fixtureScope.games;
  const run = { games: fixtureScope.games, info };

  let fixtures = null;
  const body = testModule._runWith(run, async () => {
    fixtures = await fixtureScope.resolveAll(fixturesFor([...beforeEach, t.fn, ...afterEach]));
    await runHooks(beforeEach, fixtures);
    await t.fn(fixtures);
  });

  // If the deadline wins, the body is abandoned: it keeps running until
  // teardown stops its game, and anything it sets up after that is torn
  // down straight away (see createFixtureScope).
  let error = null;
  let timedOut = false;
  try {
    await withinDeadline(body, deadline);
  } catch (err) {
    error = err;
    timedOut = err === deadline.error;
  }
  // afterEach always runs once the fixtures exist, innermost scope first,
  // before teardown and before the next test starts; the test's own error
  // wins over a later afterEach error. After a timeout it gets a fresh
  // timeout of its own rather than none at all.
  if (fixtures && afterEach.length > 0) {
    const hooksDeadline = timedOut ? createDeadline(deadline.timeout, 'afterEach hook') : deadline;
    try {
      await withinDeadline(testModule._runWith(run, () => runHooks(afterEach, fixtures)), hooksDeadline);
    } catch (err) {
      if (!error) error = err;
    }
    hooksDeadline.clear();
  }
  deadline.clear();
  try {
    await fixtureScope.teardown();
  } catch (err) {
    if (!error) error = err;
  }
  if (error) throw toError(error);
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
        await runScopeHooks([...scope.hooks.afterAll].reverse(), 'afterAll', resolveTimeout(testModule._scopeChain(scope), config));
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
        await runScopeHooks(scope.hooks.beforeAll, 'beforeAll', resolveTimeout(testModule._scopeChain(scope), config));
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
      if (holder.games && holder.games.length > 0 && shouldWriteTrace(cliOptions.trace, Boolean(error))) {
        // One trace per launched process; the second and later are named
        // after their launch order.
        holder.games.forEach((game, index) => {
          const name = retry > 0 ? `${t.name} (retry ${retry})` : t.name;
          const written = writeTrace(config.outputDir, {
            testName: index === 0 ? name : `${name} (process ${index + 1})`,
            file: t.file,
            passed: !error,
            durationMs: Date.now() - testStart,
            error,
            trace: game.getTrace(),
          }, { testDir: config.testDir, taken: cliOptions.traceNames });
          if (error) {
            error.message += `${index === 0 ? '\n' : ''}\nTrace: ${written.trace}`;
            if (written.cast) error.message += `\nRecording: ${written.cast}`;
          }
        });
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
    try {
      require(file);
    } catch (err) {
      // Without the file's name, "x is not defined" could be from anywhere.
      err.message = `Error loading ${path.relative(process.cwd(), file)}: ${err.message}`;
      throw err;
    }
    return { file, tests: testModule._collect() };
  });
}

/**
 * Discovers every test file matching the resolved config, collects all of
 * their tests up front (so test.only and filters apply across files), then
 * runs them file by file. Each test gets the fixtures it asks for, set up
 * fresh (a test that asks for `game` gets its own newly launched
 * GameDriver) and torn down whatever happened — this is the runner's whole
 * reason to exist over hand-rolled launch/try/finally-stop boilerplate.
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
    const total = plan.reduce((n, { tests }) => n + tests.length, 0);
    console.log(`Total: ${total} test${total === 1 ? '' : 's'} in ${plan.length} file${plan.length === 1 ? '' : 's'}`);
    return { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  }

  // --reporter list,github runs several, like a list in the config.
  const reporters = reporter && reporter.includes(',') ? reporter.split(',') : reporter;
  const activeReporter = createReporter(reporters || config.reporter, { outputDir: config.outputDir, cwd });
  const start = Date.now();

  if (files.length === 0) {
    console.log(`No test files matched ${JSON.stringify(config.testMatch)} under ${config.testDir}`);
  } else if (plan.length === 0) {
    console.log('No tests matched the given filters.');
  }

  const budget = { failures: 0, max: maxFailures ?? Infinity };
  // A rejection nothing awaits (usually a missing `await` before an
  // expect*) would otherwise crash the process, skipping teardown, services
  // and the json/junit reports. Report it and fail the run instead.
  let unhandled = 0;
  const onUnhandled = (reason) => {
    unhandled += 1;
    console.error(`\nUnhandled rejection (is an \`await\` missing?):\n${toError(reason).message}`);
  };
  process.on('unhandledRejection', onUnhandled);
  // Services and globalSetup only start when there are tests to run.
  let teardownEnvironment = async () => {};
  try {
    if (plan.length > 0) teardownEnvironment = await startRunEnvironment(config);
    await runPlan(plan, {
      config,
      cliOptions: { updateSnapshots, trace: traceMode, retries: retries ?? config.retries, traceNames: new Set() },
      reporter: activeReporter,
      budget,
      workers: workers ?? config.workers,
    });
  } finally {
    await teardownEnvironment();
    process.off('unhandledRejection', onUnhandled);
  }
  if (budget.failures >= budget.max) {
    console.log(`\nStopped after ${budget.max} failure${budget.max === 1 ? '' : 's'} (--max-failures).`);
  }

  return { ...activeReporter.summary(Date.now() - start), unhandled };
}

const IGNORED_IN_WATCH = /(^|[\\/])(node_modules|\.git)([\\/]|$)/;
const CLI_PATH = path.join(__dirname, '..', 'bin', 'rpgwright.js');

/**
 * Runs the suite, then reruns on every file change under the test
 * directory, the config's directory and any `watchPaths`, ignoring what a
 * run writes itself (outputDir, snapshotsDir). A change only to test files
 * reruns just those files; any other change reruns everything selected.
 * Each run is a fresh `rpgwright test` process: a module cache can't be
 * reliably reset in place (an ES-module test file isn't re-evaluated after
 * being dropped from require.cache, so it registered no tests on reruns).
 * Runs until killed.
 */
async function watch(options, args) {
  const cwd = process.cwd();
  // The command line minus --watch and the filters; each run adds its own.
  const flags = [];
  for (let i = 0; i < args.length; i += 1) {
    if (VALUE_FLAGS[args[i]]) flags.push(args[i], args[(i += 1)]);
    else if (BOOLEAN_FLAGS[args[i]] && args[i] !== '--watch') flags.push(args[i]);
  }
  let current = null;
  // A run still going when the watcher is stopped (SIGTERM, not the
  // terminal's Ctrl+C, which reaches both) is stopped with it.
  process.on('exit', () => current && current.kill());
  const runOnce = (filters) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [...process.execArgv, CLI_PATH, 'test', ...flags, ...filters], { stdio: 'inherit' });
      current = child;
      child.on('close', () => {
        current = null;
        console.log('\nWaiting for file changes. Press Ctrl+C to exit.');
        resolve();
      });
    });
  await runOnce(options.filters);

  const config = loadConfig({ configPath: options.configPath, cwd });
  const configDir = path.dirname(config.configPath);
  const roots = [...new Set([config.testDir, configDir, ...(config.watchPaths || []).map((p) => path.resolve(configDir, p))])];
  const written = [config.outputDir, path.resolve(cwd, config.snapshotsDir || '__snapshots__')];
  const ignored = (file) => IGNORED_IN_WATCH.test(file) || written.some((dir) => file === dir || file.startsWith(dir + path.sep));
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
    const testFiles = new Set(discoverTestFiles({ testDir: config.testDir, testMatch: config.testMatch }));
    const onlyTests = files.every((f) => testFiles.has(f));
    console.log(`\nChanged: ${files.map((f) => path.relative(cwd, f)).join(', ')}`);
    await runOnce(onlyTests ? files.filter((f) => fs.existsSync(f)) : options.filters);
    running = false;
  }

  for (const root of roots) {
    fs.watch(root, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const file = path.join(root, filename);
      if (ignored(file)) return;
      changed.add(file);
      clearTimeout(timer);
      timer = setTimeout(rerun, 200);
    });
  }
  return new Promise(() => {});
}

async function runCli(args) {
  // Failed until the run reaches its summary: if it never does (a hook
  // awaiting a promise that never settles lets the event loop drain), the
  // process must not exit 0 as though everything passed.
  process.exitCode = 1;
  const options = parseArgs(args);
  if (options.watch) return watch(options, args);
  const totals = await runTests(options);
  if (options.failOnFlaky && totals.flaky > 0) {
    console.log(`\n${totals.flaky} flaky test${totals.flaky === 1 ? '' : 's'} (--fail-on-flaky).`);
  }
  process.exitCode = totals.failed > 0 || totals.unhandled > 0 || (options.failOnFlaky && totals.flaky > 0) ? 1 : 0;
}

module.exports = { runTests, runCli, parseArgs };
