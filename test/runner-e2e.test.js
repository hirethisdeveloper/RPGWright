'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'rpgwright.js');

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    // Generous: the dogfood suites alone take ~20s, more on a loaded machine.
    timeout: 90000,
    ...options,
  });
}

test('rpgwright test: runs the minimal-ink-app dogfood suite as a real subprocess, exit code 0', () => {
  const result = runCli(['test', '--config', 'test/rpg/minimal/rpgwright.config.js'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\d+ passed/);
  assert.doesNotMatch(result.stdout, /✖/);
});

test('rpgwright test: runs the menu-nav-ink-app dogfood suite as a real subprocess, exit code 0', () => {
  const result = runCli(['test', '--config', 'test/rpg/menu-nav/rpgwright.config.js'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\d+ passed/);
  assert.doesNotMatch(result.stdout, /✖/);
});

test('rpgwright test: reporter: "dot" in config produces compact dot-style output instead of a per-test line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-e2e-dot-'));
  fs.writeFileSync(
    path.join(dir, 'rpgwright.config.js'),
    `module.exports = { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(
      path.join(REPO_ROOT, 'fixtures', 'minimal-ink-app', 'cli.js'),
    )}], cols: 40, rows: 10, reporter: 'dot' };`,
  );
  fs.writeFileSync(
    path.join(dir, 'smoke.rpg.test.js'),
    `const { test } = require(${JSON.stringify(path.join(REPO_ROOT, 'runner', 'test.js'))});
test('reaches the welcome screen', async ({ game }) => {
  await game.expectText('Press ENTER to continue');
});
`,
  );

  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // The dot reporter never prints a per-test name/checkmark line, only a
  // compact progress character followed later by the summary.
  assert.doesNotMatch(result.stdout, /✓ reaches the welcome screen/);
  assert.match(result.stdout.replace(/\x1b\[[0-9]*m/g, ''), /^\.\n1 passed/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: an unknown reporter name in config fails clearly instead of running silently with a default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-e2e-badreporter-'));
  fs.writeFileSync(
    path.join(dir, 'rpgwright.config.js'),
    `module.exports = { command: ${JSON.stringify(process.execPath)}, reporter: 'nonexistent' };`,
  );
  const result = runCli(['test'], { cwd: dir });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Unknown reporter "nonexistent"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: a failing test produces a nonzero exit code and prints the §9 block to stdout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-e2e-fail-'));
  fs.writeFileSync(
    path.join(dir, 'rpgwright.config.js'),
    `module.exports = { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(
      path.join(REPO_ROOT, 'fixtures', 'minimal-ink-app', 'cli.js'),
    )}], cols: 40, rows: 10 };`,
  );
  fs.writeFileSync(
    path.join(dir, 'broken.rpg.test.js'),
    `const { test } = require(${JSON.stringify(path.join(REPO_ROOT, 'runner', 'test.js'))});
test('never happens', async ({ game }) => {
  await game.expectText('this will never appear', { timeout: 300 });
});
`,
  );

  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /E2E TEST FAILED/);
  assert.match(result.stdout, /1 failed/);
  // The runner must wire the running test's name into launchGame's
  // scenarioName, not leave every failure report saying "unnamed scenario"
  // regardless of which test actually failed.
  assert.match(result.stdout, /Scenario: never happens/);
  assert.doesNotMatch(result.stdout, /Scenario: unnamed scenario/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: --config with no path errors clearly instead of silently falling back to default discovery', () => {
  const result = runCli(['test', '--config'], { cwd: REPO_ROOT });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /--config requires a path/);
});

test('rpgwright test: a missing config file produces a clear, actionable error and nonzero exit code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-e2e-noconfig-'));
  const result = runCli(['test'], { cwd: dir });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /rpgwright init/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright init then rpgwright test: the scaffolded example passes out of the box', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-e2e-init-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'consumer-app', version: '1.0.0' }));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(REPO_ROOT, path.join(dir, 'node_modules', 'rpgwright'), 'dir');

  const initResult = runCli(['init'], { cwd: dir });
  assert.equal(initResult.status, 0, initResult.stdout + initResult.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'rpgwright.config.js')));
  assert.ok(fs.existsSync(path.join(dir, 'example-app.js')));
  assert.ok(fs.existsSync(path.join(dir, 'example.rpg.test.js')));

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:e2e'], 'rpgwright test');

  const testResult = runCli(['test'], { cwd: dir });
  assert.equal(testResult.status, 0, testResult.stdout + testResult.stderr);
  assert.match(testResult.stdout, /1 passed/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright init: is safe to re-run and does not overwrite existing files without --force', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-e2e-reinit-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'consumer-app', version: '1.0.0' }));

  runCli(['init'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'rpgwright.config.js'), '// customized by the user\n');

  const second = runCli(['init'], { cwd: dir });
  assert.equal(second.status, 0);
  assert.match(second.stdout, /skipped rpgwright\.config\.js/);
  assert.equal(fs.readFileSync(path.join(dir, 'rpgwright.config.js'), 'utf8'), '// customized by the user\n');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright (no subcommand): prints usage and exits 0', () => {
  const result = runCli([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: rpgwright/);
});

test('rpgwright (unknown subcommand): prints usage and exits nonzero', () => {
  const result = runCli(['bogus']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Usage: rpgwright/);
});

const PROBE = path.join(REPO_ROOT, 'fixtures', 'term-probe', 'cli.js');
const TEST_API = JSON.stringify(path.join(REPO_ROOT, 'runner', 'test.js'));

// A throwaway project whose config launches the dependency-free probe
// fixture (fast to start), with the given test files.
function makeProject(files, configExtra = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-e2e-proj-'));
  fs.writeFileSync(
    path.join(dir, 'rpgwright.config.js'),
    `module.exports = { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(PROBE)}, 'echo'], cols: 40, rows: 8, ${configExtra} };`,
  );
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

const PASSING_PAIR = `const { test } = require(${TEST_API});
test('alpha @smoke', async ({ game }) => { await game.expectText('READY'); });
test('beta', async ({ game }) => { await game.expectText('READY'); });
`;

test('rpgwright test: hooks run in order around each test, scoped to their describe, with afterAll last', () => {
  const dir = makeProject({
    'hooks.rpg.test.js': `const fs = require('node:fs');
const { test, describe } = require(${TEST_API});
const log = [];
test.beforeAll(() => log.push('file:beforeAll'));
test.afterAll(() => fs.writeFileSync(${JSON.stringify('__LOG__')}, JSON.stringify(log.concat('file:afterAll'))));
test.beforeEach(({ game }) => log.push('file:beforeEach:' + Boolean(game)));
test.afterEach(() => log.push('file:afterEach'));
describe('group', () => {
  test.beforeAll(() => log.push('group:beforeAll'));
  test.afterAll(() => log.push('group:afterAll'));
  test.beforeEach(() => log.push('group:beforeEach'));
  test.afterEach(() => log.push('group:afterEach'));
  test('one', () => log.push('one'));
  test('two', () => log.push('two'));
});
test('three', () => log.push('three'));
`,
  });
  const logFile = path.join(dir, 'log.json');
  const testFile = path.join(dir, 'hooks.rpg.test.js');
  fs.writeFileSync(testFile, fs.readFileSync(testFile, 'utf8').replace('"__LOG__"', JSON.stringify(logFile)));

  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(logFile, 'utf8')), [
    'file:beforeAll',
    'group:beforeAll',
    'file:beforeEach:true', 'group:beforeEach', 'one', 'group:afterEach', 'file:afterEach',
    'file:beforeEach:true', 'group:beforeEach', 'two', 'group:afterEach', 'file:afterEach',
    'group:afterAll',
    'file:beforeEach:true', 'three', 'file:afterEach',
    'file:afterAll',
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: a failing beforeAll fails every test in its scope without running them', () => {
  const dir = makeProject({
    'setup.rpg.test.js': `const { test, describe } = require(${TEST_API});
describe('broken setup', () => {
  test.beforeAll(() => { throw new Error('seed failed'); });
  test('a', () => {});
  test('b', () => {});
});
test('unaffected', async ({ game }) => { await game.expectText('READY'); });
`,
  });
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /1 passed, 2 failed/);
  assert.match(result.stdout, /seed failed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: test.use options reach launchGame, scoped to their describe', () => {
  const dir = makeProject({
    'use.rpg.test.js': `const { test, describe } = require(${TEST_API});
describe('wide', () => {
  test.use({ cols: 77, args: [${JSON.stringify(PROBE)}, 'env'], env: { ...process.env, LANG: 'xx_YY.UTF-8' } });
  test('sees the scoped options', async ({ game }) => {
    await game.expectText('LANG=xx_YY.UTF-8');
    if (game.getScreenText().split('\\n')[0].length > 77) throw new Error('cols not applied');
  });
});
test('outside the describe keeps the config', async ({ game }) => { await game.expectText('READY'); });
`,
  });
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /2 passed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: test.fail passes when the body throws and fails when it passes; test.fixme is skipped', () => {
  const dir = makeProject({
    'fail.rpg.test.js': `const { test } = require(${TEST_API});
test.fail('known bug', async ({ game }) => { await game.expectText('never', { timeout: 200 }); });
test.fail('bug that got fixed', async ({ game }) => { await game.expectText('READY'); });
test.fixme('not ready yet', async () => { throw new Error('should not run'); });
`,
  });
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /1 passed, 1 failed, 1 skipped/);
  assert.match(result.stdout, /Expected this test to fail \(test\.fail\), but it passed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: test.only in one file limits the whole run to the focused tests', () => {
  const dir = makeProject({
    'a.rpg.test.js': PASSING_PAIR,
    'b.rpg.test.js': `const { test } = require(${TEST_API});
test.only('focused', async ({ game }) => { await game.expectText('READY'); });
`,
  });
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 passed/);
  assert.match(result.stdout, /✓ focused/);
  assert.doesNotMatch(result.stdout, /alpha/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: test.setTimeout inside a test shortens that test\'s timeout', () => {
  const dir = makeProject({
    'timeout.rpg.test.js': `const { test } = require(${TEST_API});
test('hangs', async () => { test.setTimeout(300); await new Promise(() => {}); });
`,
  });
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Test exceeded its 300ms timeout/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: a timed-out test runs its afterEach before the next test, and a game set up after the timeout is stopped', () => {
  const log = path.join(os.tmpdir(), `rpgwright-e2e-timeout-log-${process.pid}`);
  fs.rmSync(log, { force: true });
  const dir = makeProject(
    {
      'timeout.rpg.test.js': `const fs = require('node:fs');
const { test } = require(${TEST_API});
const log = (m) => fs.appendFileSync(${JSON.stringify(log)}, m + '\\n');
const t = test.extend({
  slow: async ({}, use) => { await new Promise((r) => setTimeout(r, 600)); await use(1); },
  late: async ({ slow, game }, use) => { await use(game); },
});
t.afterEach(() => log('afterEach ' + test.info().title));
t('body hangs', async ({ game }) => { await new Promise(() => {}); });
t('fixture finishes after the timeout', async ({ late }) => {});
t('next', async () => { log('next'); });
`,
    },
    'timeout: 300',
  );
  const started = Date.now();
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(Date.now() - started < 8000, 'the run ends instead of waiting on a game nobody stops');
  assert.match(result.stdout, /✖ body hangs/);
  assert.match(result.stdout, /✖ fixture finishes after the timeout/);
  assert.match(result.stdout, /✓ next/);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['afterEach body hangs', 'next', 'afterEach next']);
  fs.rmSync(log, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: hook errors: afterEach fails a passing test, the body\'s error wins over afterEach\'s, and a failing afterAll is reported', () => {
  const dir = makeProject({
    'hooks.rpg.test.js': `const { test, describe } = require(${TEST_API});
describe('after each', () => {
  test.afterEach(() => { throw new Error('afterEach broke'); });
  test('passes itself', async () => {});
  test('fails itself', async () => { throw new Error('body broke'); });
});
describe('after all', () => {
  test.afterAll(() => { throw new Error('afterAll broke'); });
  test('fine', async () => {});
});
`,
  });
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /✖ after each > passes itself/);
  assert.match(result.stdout, /afterEach broke/);
  assert.match(result.stdout, /✖ after each > fails itself/);
  assert.match(result.stdout, /body broke/);
  assert.match(result.stdout, /✓ after all > fine/);
  assert.match(result.stdout, /after all > afterAll/);
  assert.match(result.stdout, /afterAll broke/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: a beforeAll that never settles times out (and fails the run) instead of hanging or exiting 0', () => {
  const dir = makeProject(
    {
      'never.rpg.test.js': `const { test } = require(${TEST_API});
test.beforeAll(() => new Promise(() => {}));
test('never runs', async () => {});
`,
    },
    'timeout: 300',
  );
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /beforeAll hook exceeded its 300ms timeout/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: a test that throws a non-Error fails normally, with traces on, and the run continues', () => {
  const dir = makeProject(
    {
      'odd.rpg.test.js': `const { test } = require(${TEST_API});
test('throws a string', async ({ game }) => { throw 'oops'; });
test('still runs', async () => {});
`,
    },
    "trace: 'retain-on-failure'",
  );
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /✖ throws a string/);
  assert.match(result.stdout, /Thrown: oops/);
  assert.match(result.stdout, /Trace: /);
  assert.match(result.stdout, /✓ still runs/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: a rejection nothing awaits is reported and fails the run, but teardown and reports still happen', () => {
  const dir = makeProject(
    {
      'floating.rpg.test.js': `const { test } = require(${TEST_API});
test('forgets an await', async ({ game }) => { game.expectText('never', { timeout: 100 }); await new Promise((r) => setTimeout(r, 300)); });
test('still runs', async () => {});
`,
    },
    "reporter: ['list', 'json']",
  );
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Unhandled rejection \(is an `await` missing\?\)/);
  assert.match(result.stdout, /✓ still runs/);
  assert.ok(fs.existsSync(path.join(dir, 'test-results', 'results.json')), 'the json report was still written');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: processes started with launch() get traces too, and test.step groups their actions', () => {
  const dir = makeProject(
    {
      'multi.rpg.test.js': `const { test } = require(${TEST_API});
test('two processes', async ({ launch }) => {
  const first = await launch();
  const second = await launch();
  await test.step('check both', async () => {
    await first.expectText('READY');
    await second.expectText('never', { timeout: 200 });
  });
});
`,
    },
    "trace: 'retain-on-failure'",
  );
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'test-results')).filter((f) => f.endsWith('.trace.html')).sort(), [
    'multi-rpg-test--two-processes-process-2.trace.html',
    'multi-rpg-test--two-processes.trace.html',
  ]);
  assert.match(result.stdout, /step\("check both"\)\n\s+\d+\. expectText\("never"\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: --reporter takes a comma-separated list; --list counts repeats; a file that fails to load is named', () => {
  const dir = makeProject({ 'pair.rpg.test.js': PASSING_PAIR });
  const both = runCli(['test', '--reporter', 'dot,github'], { cwd: dir });
  assert.equal(both.status, 0, both.stdout + both.stderr);
  assert.match(both.stdout, /^\.\./m);
  const listed = runCli(['test', '--list', '--repeat-each', '3'], { cwd: dir });
  assert.match(listed.stdout, /Total: 6 tests in 1 file/);
  fs.writeFileSync(path.join(dir, 'broken.rpg.test.js'), 'notDefined();\n');
  const broken = runCli(['test'], { cwd: dir });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /Error loading broken\.rpg\.test\.js: notDefined is not defined/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: a retry gets fresh fixtures and its own testInfo.retry', () => {
  const dir = makeProject(
    {
      'retry.rpg.test.js': `const { test } = require(${TEST_API});
const seen = [];
test('flaky', async ({ game, testInfo }) => {
  seen.push(game);
  if (testInfo.retry === 0) throw new Error('first attempt fails');
  if (seen[0] === seen[1]) throw new Error('the retry reused the first game');
  await game.expectText('READY');
});
`,
    },
    'retries: 1',
  );
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 flaky/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: test.step groups the actions inside it in the failure report', () => {
  const dir = makeProject({
    'step.rpg.test.js': `const { test } = require(${TEST_API});
test('stepped', async ({ game }) => {
  await test.step('wait for the prompt', async () => {
    await game.expectText('READY');
    await game.expectText('never', { timeout: 200 });
  });
});
`,
  });
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /2\. step\("wait for the prompt"\)\n\s+3\. expectText\("READY"\)\n\s+4\. expectText\("never"\)  ← failed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test --grep / --grep-invert: filter by full test name', () => {
  const dir = makeProject({ 'pair.rpg.test.js': PASSING_PAIR });
  const grep = runCli(['test', '--grep', '@smoke'], { cwd: dir });
  assert.equal(grep.status, 0, grep.stdout + grep.stderr);
  assert.match(grep.stdout, /✓ alpha @smoke/);
  assert.doesNotMatch(grep.stdout, /beta/);

  const invert = runCli(['test', '--grep-invert', '@smoke'], { cwd: dir });
  assert.match(invert.stdout, /✓ beta/);
  assert.doesNotMatch(invert.stdout, /alpha/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test file:line runs only the test declared on that line', () => {
  const dir = makeProject({ 'pair.rpg.test.js': PASSING_PAIR, 'other.rpg.test.js': PASSING_PAIR });
  const result = runCli(['test', 'pair.rpg.test.js:3'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 passed/);
  assert.match(result.stdout, /✓ beta/);
  assert.doesNotMatch(result.stdout, /other\.rpg\.test\.js/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test --list: prints the selected tests with their locations and runs nothing', () => {
  const dir = makeProject({ 'pair.rpg.test.js': PASSING_PAIR });
  const result = runCli(['test', '--list', '--grep', 'beta'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /pair\.rpg\.test\.js:3 › beta/);
  assert.match(result.stdout, /Total: 1 test in 1 file/);
  assert.doesNotMatch(result.stdout, /passed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test --reporter overrides the config reporter', () => {
  const dir = makeProject({ 'pair.rpg.test.js': PASSING_PAIR });
  const result = runCli(['test', '--reporter', 'dot'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout.replace(/\x1b\[[0-9]*m/g, ''), /^\.\.\n2 passed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test --max-failures stops the run after that many failures', () => {
  const dir = makeProject({
    'fails.rpg.test.js': `const { test } = require(${TEST_API});
test('f1', () => { throw new Error('one'); });
test('f2', () => { throw new Error('two'); });
test('f3', () => { throw new Error('three'); });
`,
  });
  const result = runCli(['test', '--max-failures', '1'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /1 failed/);
  assert.match(result.stdout, /Stopped after 1 failure/);
  assert.doesNotMatch(result.stdout, /f2/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test --update-snapshots re-records a snapshot that no longer matches', () => {
  const dir = makeProject(
    {
      'snap.rpg.test.js': `const { test, expect } = require(${TEST_API});
test('snap', async ({ game }) => { await game.expectText('READY'); await expect(game).toMatchScreenSnapshot('probe', { timeout: 300 }); });
`,
    },
    "snapshotsDir: require('node:path').join(__dirname, 'snaps')",
  );
  fs.mkdirSync(path.join(dir, 'snaps'));
  fs.writeFileSync(path.join(dir, 'snaps', 'probe.snap'), 'stale content');

  const stale = runCli(['test'], { cwd: dir });
  assert.equal(stale.status, 1, 'the stale snapshot should fail without the flag');

  const updated = runCli(['test', '--update-snapshots'], { cwd: dir });
  assert.equal(updated.status, 0, updated.stdout + updated.stderr);
  assert.match(fs.readFileSync(path.join(dir, 'snaps', 'probe.snap'), 'utf8'), /READY/);

  const rerun = runCli(['test'], { cwd: dir });
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: an unknown option fails clearly', () => {
  const result = runCli(['test', '--bogus'], { cwd: REPO_ROOT });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Unknown option "--bogus"/);
});

test('rpgwright test --trace retain-on-failure: writes a trace only for the failing test and names it in the report', () => {
  const dir = makeProject({
    'mixed.rpg.test.js': `const { test } = require(${TEST_API});
test('passes', async ({ game }) => { await game.expectText('READY'); });
test('fails', async ({ game }) => { await game.expectText('never', { timeout: 200 }); });
`,
  });
  const result = runCli(['test', '--trace', 'retain-on-failure'], { cwd: dir });
  assert.equal(result.status, 1);
  const traceFile = path.join(fs.realpathSync(dir), 'test-results', 'mixed-rpg-test--fails.trace.html');
  assert.match(result.stdout, new RegExp(`Trace: ${traceFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'test-results')).sort(), ['mixed-rpg-test--fails.cast', 'mixed-rpg-test--fails.trace.html']);
  assert.match(result.stdout, /Recording: .*mixed-rpg-test--fails\.cast/);
  assert.match(fs.readFileSync(traceFile, 'utf8'), /E2E TEST FAILED/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: trace "on" in config writes a trace for passing tests too, into outputDir', () => {
  const dir = makeProject({ 'pair.rpg.test.js': PASSING_PAIR }, "trace: 'on', outputDir: 'traces'");
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'traces')).sort(), [
    'pair-rpg-test--alpha-smoke.cast',
    'pair-rpg-test--alpha-smoke.trace.html',
    'pair-rpg-test--beta.cast',
    'pair-rpg-test--beta.trace.html',
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test --trace with an unknown mode fails clearly', () => {
  const dir = makeProject({ 'pair.rpg.test.js': PASSING_PAIR });
  const result = runCli(['test', '--trace', 'sometimes'], { cwd: dir });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /"trace" must be one of off, on, retain-on-failure/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A test that fails on its first attempt and passes on the next, using a
// counter file so the state survives between attempts.
function flakyTest(counterFile) {
  return `const fs = require('node:fs');
const { test } = require(${TEST_API});
test('wobbly', async () => {
  const n = Number(fs.existsSync(${JSON.stringify(counterFile)}) ? fs.readFileSync(${JSON.stringify(counterFile)}, 'utf8') : 0) + 1;
  fs.writeFileSync(${JSON.stringify(counterFile)}, String(n));
  if (n === 1) throw new Error('first attempt fails');
});
`;
}

test('rpgwright test --retries: a test that passes on a retry passes, reported as flaky', () => {
  const dir = makeProject({});
  fs.writeFileSync(path.join(dir, 'flaky.rpg.test.js'), flakyTest(path.join(dir, 'count')));
  const result = runCli(['test', '--retries', '1'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /wobbly .*flaky: passed on retry 1/);
  assert.match(result.stdout, /1 passed, 1 flaky/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test --fail-on-flaky: a flaky pass fails the run', () => {
  const dir = makeProject({}, 'retries: 1');
  fs.writeFileSync(path.join(dir, 'flaky.rpg.test.js'), flakyTest(path.join(dir, 'count')));
  const result = runCli(['test', '--fail-on-flaky'], { cwd: dir });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /1 flaky test \(--fail-on-flaky\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: without retries the same test simply fails', () => {
  const dir = makeProject({});
  fs.writeFileSync(path.join(dir, 'flaky.rpg.test.js'), flakyTest(path.join(dir, 'count')));
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /first attempt fails/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test --repeat-each: runs each test that many times, each named', () => {
  const dir = makeProject({ 'pair.rpg.test.js': PASSING_PAIR });
  const result = runCli(['test', '--repeat-each', '3', '--grep', 'beta'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓ beta \[repeat 1\/3\][\s\S]*✓ beta \[repeat 3\/3\]/);
  assert.match(result.stdout, /3 passed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: fixtures are lazy, so a test that never asks for game never launches the app', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-e2e-lazy-'));
  const marker = path.join(dir, 'launched');
  // The "app" leaves a marker file whenever it is launched.
  fs.writeFileSync(
    path.join(dir, 'rpgwright.config.js'),
    `module.exports = { command: ${JSON.stringify(process.execPath)}, args: ['-e', ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); console.log('UP'); setTimeout(() => {}, 5000)`)}] };`,
  );
  fs.writeFileSync(
    path.join(dir, 'lazy.rpg.test.js'),
    `const { test } = require(${TEST_API});
test('needs no app', async ({ testInfo }) => { if (testInfo.title !== 'needs no app') throw new Error('bad info'); });
test('needs the app', async ({ game }) => { await game.expectText('UP'); });
`,
  );
  const withoutGame = runCli(['test', '--grep', 'no app'], { cwd: dir });
  assert.equal(withoutGame.status, 0, withoutGame.stdout + withoutGame.stderr);
  assert.equal(fs.existsSync(marker), false, 'the app was never launched');

  const withGame = runCli(['test', '--grep', 'the app'], { cwd: dir });
  assert.equal(withGame.status, 0, withGame.stdout + withGame.stderr);
  assert.equal(fs.existsSync(marker), true, 'asking for game launched it');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: test.extend fixtures are set up for the tests that use them and torn down in reverse', () => {
  const dir = makeProject({});
  const logFile = path.join(dir, 'log.json');
  fs.writeFileSync(
    path.join(dir, 'extend.rpg.test.js'),
    `const fs = require('node:fs');
const { test: base } = require(${TEST_API});
const log = [];
const test = base.extend({
  server: async ({}, use) => { log.push('server up'); await use('srv'); log.push('server down'); },
  client: async ({ server, game }, use) => { log.push('client up on ' + server); await game.expectText('READY'); await use('cli'); log.push('client down'); },
});
test.afterAll(() => fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify(log)));
test('uses client', async ({ client }) => { log.push('body ' + client); });
test('uses neither', async () => { log.push('plain body'); });
`,
  );
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(logFile, 'utf8')), [
    'server up', 'client up on srv', 'body cli', 'client down', 'server down',
    'plain body',
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: a .cast recording replays to the same final screen the test ended on', async () => {
  const dir = makeProject(
    {
      'cast.rpg.test.js': `const { test } = require(${TEST_API});
test('types', async ({ game }) => {
  await game.expectText('READY');
  await game.type('abc');
  await game.expectText('GOT "abc"');
  await game.resize(50, 9);
  require('node:fs').writeFileSync(require('node:path').join(__dirname, 'final.txt'), game.getScreenText());
});
`,
    },
    "trace: 'on'",
  );
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [header, ...events] = fs
    .readFileSync(path.join(dir, 'test-results', 'cast-rpg-test--types.cast'), 'utf8')
    .trimEnd()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(header.version, 2);
  assert.deepEqual([header.width, header.height], [40, 8]);
  assert.ok(events.every((e, i) => i === 0 || e[0] >= events[i - 1][0]), 'timestamps never go backwards');
  assert.ok(events.some((e) => e[1] === 'i' && e[2] === 'abc'));

  // Replay the output (and resizes) through a fresh emulator.
  const { createVirtualTerminal } = require('../src/terminal');
  const term = createVirtualTerminal({ cols: header.width, rows: header.height });
  for (const [, type, data] of events) {
    if (type === 'o') await term.write(data);
    if (type === 'r') term.resize(...data.split('x').map(Number));
  }
  assert.equal(term.getScreenText(), fs.readFileSync(path.join(dir, 'final.txt'), 'utf8'));
  term.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: json and junit reporters write machine-readable results; several reporters can run at once', () => {
  const dir = makeProject(
    {
      'mixed.rpg.test.js': `const { test } = require(${TEST_API});
test('passes', async ({ game }) => { await game.expectText('READY'); });
test('fails <badly>', async () => { throw new Error('boom & \\u001b[31mred\\u001b[0m'); });
test.skip('skipped', () => {});
`,
    },
    "reporter: ['list', 'json', ['junit', { outputFile: 'reports/junit.xml' }]]",
  );
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /✓ passes/, 'the list reporter still prints');
  assert.match(result.stdout, /JSON report written to .*results\.json/);

  const json = JSON.parse(fs.readFileSync(path.join(dir, 'test-results', 'results.json'), 'utf8'));
  assert.deepEqual({ ...json.stats, durationMs: 0 }, { passed: 1, failed: 1, skipped: 1, flaky: 0, durationMs: 0 });
  assert.deepEqual(json.tests.map((t) => [t.name, t.status, t.file, t.line]), [
    ['passes', 'passed', 'mixed.rpg.test.js', 2],
    ['fails <badly>', 'failed', 'mixed.rpg.test.js', 3],
    ['skipped', 'skipped', 'mixed.rpg.test.js', 4],
  ]);
  assert.match(json.tests[1].error, /boom/);

  const xml = fs.readFileSync(path.join(dir, 'reports', 'junit.xml'), 'utf8');
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites name="rpgwright" tests="3" failures="1" skipped="1"/);
  assert.match(xml, /<testsuite name="mixed.rpg.test.js" tests="3" failures="1" skipped="1"/);
  assert.match(xml, /<testcase name="fails &lt;badly&gt;" classname="mixed.rpg.test.js" time="[\d.]+"><failure message="boom &amp; \[31mred\[0m">/);
  assert.match(xml, /<testcase name="skipped"[^>]*><skipped\/><\/testcase>/);
  assert.doesNotMatch(xml, /\x1b/, 'no control characters, which XML forbids');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test --reporter github: failures become ::error annotations at the test\'s file and line', () => {
  const dir = makeProject({
    'gh.rpg.test.js': `const { test } = require(${TEST_API});
test('ok', () => {});
test('breaks', () => { throw new Error('line one\\nline two'); });
`,
  });
  const result = runCli(['test', '--reporter', 'github'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^::error file=gh\.rpg\.test\.js,line=3,title=breaks::line one%0Aline two/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test --workers: files run concurrently, with the same results and the same output order as a serial run', () => {
  const files = {};
  const log = path.join(os.tmpdir(), `rpgwright-e2e-workers-${process.pid}.log`);
  for (const name of ['a', 'b', 'c', 'd']) {
    // a1 records when it ran, and so does every other file's first test:
    // concurrency shows as overlapping intervals, not as a faster run
    // (which a loaded machine can't promise).
    files[`${name}.rpg.test.js`] = `const fs = require('node:fs');
const { test } = require(${TEST_API});
test('${name}1', async ({ game }) => {
  const start = Date.now();
  await game.expectText('READY');
  await new Promise((r) => setTimeout(r, ${name === 'a' ? 600 : 50}));
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: '${name}', start, end: Date.now() }) + '\\n');
});
test('${name}2', async ({ game }) => { await game.expectText('READY'); });
`;
  }
  const dir = makeProject(files);
  const strip = (out) => out.replace(/\x1b\[[0-9]*m/g, '').replace(/\(\d+ms\)/g, '').trim();
  const serial = runCli(['test'], { cwd: dir });
  fs.rmSync(log, { force: true });
  const parallel = runCli(['test', '--workers', '4'], { cwd: dir });
  assert.equal(serial.status, 0, serial.stdout + serial.stderr);
  assert.equal(parallel.status, 0, parallel.stdout + parallel.stderr);
  assert.equal(strip(parallel.stdout), strip(serial.stdout));
  const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const a = runs.find((r) => r.name === 'a');
  assert.ok(runs.some((r) => r.name !== 'a' && r.start < a.end && a.start < r.end), `another file ran while a1 did: ${JSON.stringify(runs)}`);
  fs.rmSync(log, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: test.step and test.info stay with their own test when files run in parallel', () => {
  const files = {};
  for (const name of ['x', 'y']) {
    files[`${name}.rpg.test.js`] = `const { test } = require(${TEST_API});
test('${name}', async ({ game }) => {
  await test.step('${name} step', async () => {
    await new Promise((r) => setTimeout(r, 100));
    if (test.info().title !== '${name}') throw new Error('saw ' + test.info().title);
    await game.expectText('never', { timeout: 200 });
  });
});
`;
  }
  const dir = makeProject(files);
  const result = runCli(['test', '--workers', '2'], { cwd: dir });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /1\) x[\s\S]*step\("x step"\)[\s\S]*2\) y[\s\S]*step\("y step"\)/);
  assert.doesNotMatch(result.stdout, /saw /);
  fs.rmSync(dir, { recursive: true, force: true });
});

// A port the OS says is free right now (a random pick can collide with
// another test's connections in the ephemeral range).
async function freePort() {
  const server = require('node:net').createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

test('rpgwright test: services start before the tests (ready by text or port) and globalSetup/teardown run around them', async () => {
  const dir = makeProject({}, '');
  const log = path.join(dir, 'log.txt');
  const port = await freePort();
  fs.writeFileSync(path.join(dir, 'setup.js'), `module.exports = async () => { require('fs').appendFileSync(${JSON.stringify(log)}, 'setup\\n'); return async () => require('fs').appendFileSync(${JSON.stringify(log)}, 'setup-returned-teardown\\n'); };`);
  fs.writeFileSync(path.join(dir, 'teardown.js'), `module.exports = async () => require('fs').appendFileSync(${JSON.stringify(log)}, 'globalTeardown\\n');`);
  fs.writeFileSync(
    path.join(dir, 'rpgwright.config.js'),
    `module.exports = {
  command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(PROBE)}, 'echo'], cols: 40, rows: 8,
  globalSetup: './setup.js',
  globalTeardown: './teardown.js',
  services: [
    { name: 'text', command: ${JSON.stringify(process.execPath)}, args: ['-e', "setTimeout(() => console.log('server listening'), 200); setInterval(() => {}, 1000)"], readyText: 'listening' },
    { name: 'port', command: ${JSON.stringify(process.execPath)}, args: ['-e', "setTimeout(() => require('net').createServer().listen(${port}), 200)"], readyPort: ${port} },
  ],
};`,
  );
  fs.writeFileSync(
    path.join(dir, 'svc.rpg.test.js'),
    `const { test } = require(${TEST_API});
test('the port service is up', async () => {
  require('fs').appendFileSync(${JSON.stringify(log)}, 'test\\n');
  await new Promise((resolve, reject) => { const s = require('net').connect(${port}, () => { s.destroy(); resolve(); }); s.on('error', reject); });
});
`,
  );
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['setup', 'test', 'setup-returned-teardown', 'globalTeardown']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: a service that exits before it is ready fails the run, showing its output', () => {
  const dir = makeProject({ 'pair.rpg.test.js': PASSING_PAIR }, `services: [{ name: 'broken', command: ${JSON.stringify(process.execPath)}, args: ['-e', "console.log('missing DATABASE_URL'); process.exit(3)"], readyText: 'ready' }]`);
  const result = runCli(['test'], { cwd: dir });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /Service "broken" exited \(code 3\) before it was ready\.\nIts last output:\nmissing DATABASE_URL/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Starts `rpgwright test --watch` in `dir`; waitFor(re) waits for its output.
function startWatch(dir) {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [CLI, 'test', '--watch'], { cwd: dir });
  const state = { output: '' };
  child.stdout.on('data', (d) => {
    state.output += d;
  });
  // Waits for `re` in the output, or only in what came after offset `from`.
  const waitFor = async (re, label, from = 0) => {
    const deadline = Date.now() + 15000;
    while (!re.test(state.output.slice(from))) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}:\n${state.output}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { child, state, waitFor };
}

test('rpgwright test --watch: reruns a changed test file alone, everything for a changed helper, and ignores what runs write', async () => {
  const dir = makeProject(
    {
      'helper.js': "module.exports = { label: 'beta' };\n",
      'pair.rpg.test.js': `const { test } = require(${TEST_API});
const { label } = require('./helper');
test('alpha', async ({ game }) => { await game.expectText('READY'); });
test(label, async ({ game }) => { await game.expectText('READY'); });
`,
    },
    // Traces into a custom outputDir: if the watcher saw its own writes,
    // every run would trigger another.
    "trace: 'on', outputDir: 'out'",
  );
  const { child, state, waitFor } = startWatch(dir);
  try {
    await waitFor(/2 passed[\s\S]*Waiting for file changes/, 'the first run');
    const testFile = path.join(dir, 'pair.rpg.test.js');
    fs.writeFileSync(testFile, fs.readFileSync(testFile, 'utf8').replace("'alpha'", "'gamma'"));
    await waitFor(/Changed: pair\.rpg\.test\.js[\s\S]*✓ gamma[\s\S]*2 passed[\s\S]*Waiting for file changes/, 'the rerun of the test file');
    fs.writeFileSync(path.join(dir, 'helper.js'), "module.exports = { label: 'delta' };\n");
    await waitFor(/Changed: helper\.js[\s\S]*✓ delta[\s\S]*2 passed[\s\S]*Waiting for file changes/, 'the full rerun with the edited helper');
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(state.output.match(/Changed:/g).length, 2, `no rerun triggered by the run's own output:\n${state.output}`);
    // A run that can't even load the file doesn't stop the watcher.
    const working = fs.readFileSync(testFile, 'utf8');
    let mark = state.output.length;
    fs.writeFileSync(testFile, `${working}\n)(`);
    await waitFor(/Changed: pair\.rpg\.test\.js[\s\S]*Waiting for file changes/, 'the failed load', mark);
    assert.doesNotMatch(state.output.slice(mark), /passed/);
    mark = state.output.length;
    fs.writeFileSync(testFile, working);
    await waitFor(/Changed: pair\.rpg\.test\.js[\s\S]*✓ gamma[\s\S]*2 passed[\s\S]*Waiting for file changes/, 'the run after the fix', mark);
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rpgwright test --watch: an ES-module (TypeScript) test file still registers its tests on a rerun', { skip: !process.features.typescript && 'this Node has no built-in TypeScript support' }, async () => {
  const source = `import { test } from 'rpgwright/test';
test('NAME', async ({ game }) => { await game.expectText('READY'); });
`;
  const dir = makeProject({ 'esm.rpg.test.ts': source.replace('NAME', 'first') });
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(REPO_ROOT, path.join(dir, 'node_modules', 'rpgwright'), 'dir');
  const { child, waitFor } = startWatch(dir);
  try {
    await waitFor(/✓ first[\s\S]*1 passed[\s\S]*Waiting for file changes/, 'the first run');
    fs.writeFileSync(path.join(dir, 'esm.rpg.test.ts'), source.replace('NAME', 'second'));
    await waitFor(/Changed: esm\.rpg\.test\.ts[\s\S]*✓ second[\s\S]*1 passed/, 'the rerun');
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rpgwright test: runs TypeScript test files (*.rpg.test.ts) with typed imports from rpgwright/test', { skip: !process.features.typescript && 'this Node has no built-in TypeScript support' }, () => {
  const dir = makeProject({
    'typed.rpg.test.ts': `import { test, expect } from 'rpgwright/test';
import type { Viewport } from 'rpgwright/test';

const ready: string = 'READY';

test('types are stripped and the test runs', async ({ game, viewport }) => {
  const size: Viewport = viewport;
  await game.expectText(ready);
  await expect(game.locator(ready)).toBeAt(0, 0);
  if (size.cols !== 40) throw new Error('wrong viewport');
});
`,
  });
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(REPO_ROOT, path.join(dir, 'node_modules', 'rpgwright'), 'dir');
  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /typed\.rpg\.test\.ts[\s\S]*✓ types are stripped and the test runs/);
  fs.rmSync(dir, { recursive: true, force: true });
});
