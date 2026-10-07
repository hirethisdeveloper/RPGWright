'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPlan, runOptions, createRunSession } = require('../runner/run');

const REPO_ROOT = path.join(__dirname, '..');
const PROBE = path.join(REPO_ROOT, 'fixtures', 'term-probe', 'cli.js');
const TEST_API = JSON.stringify(path.join(REPO_ROOT, 'runner', 'test.js'));
// Test files (run in this process) log here.
const HEADER = `const { test, describe } = require(${TEST_API});\nconst log = (globalThis.__sessionLog ||= []);\n`;

/**
 * A throwaway project (the probe fixture in echo mode) with one test file,
 * opened as a session the way `rpgwright test --ui` opens one, with a
 * reporter that records every event.
 */
function openSession(t, body, { retries = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-session-'));
  fs.writeFileSync(
    path.join(dir, 'rpgwright.config.js'),
    `module.exports = { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(PROBE)}, 'echo'], cols: 40, rows: 8, trace: 'off' };`,
  );
  fs.writeFileSync(path.join(dir, 'session.rpg.test.js'), HEADER + body);
  globalThis.__sessionLog = [];
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const { config, plan } = loadPlan({ cwd: dir });
  const events = [];
  const reporter = {};
  for (const method of ['fileStarted', 'testStarted', 'testPassed', 'testFailed', 'testSkipped']) {
    reporter[method] = (name) => events.push(`${method} ${name}`);
  }
  const session = createRunSession(plan, { config, cliOptions: runOptions(config, { retries }), reporter });
  const id = (title) => session.tests.find((entry) => entry.title === title).id;
  return { session, events, id, log: globalThis.__sessionLog };
}

async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('session: lists the selected tests in order, all pending, with ids, titles, files and lines', (t) => {
  const { session } = openSession(t, `test('one', () => {});\ndescribe('group', () => {\n  test('two', () => {});\n});\n`);
  assert.deepEqual(
    session.tests.map(({ title, file, line, status, durationMs, error }) => ({ title, file, line, status, durationMs, error })),
    [
      { title: 'one', file: 'session.rpg.test.js', line: 3, status: 'pending', durationMs: null, error: null },
      { title: 'group > two', file: 'session.rpg.test.js', line: 5, status: 'pending', durationMs: null, error: null },
    ],
  );
  assert.equal(new Set(session.tests.map((entry) => entry.id)).size, 2);
  assert.deepEqual(session.results(), { passed: 0, failed: 0, skipped: 0, flaky: 0 });
  assert.equal(session.paused, false);
});

test('session: runs one test, then the same test again, updating its entry and reporting each run', async (t) => {
  const { session, events, id, log } = openSession(t, `test('ready', async ({ game }) => { log.push('ran'); await game.expectText('READY'); });\ntest('other', () => {});\n`);
  await session.run([id('ready')]);
  const entry = session.tests[0];
  assert.equal(entry.status, 'passed');
  assert.ok(entry.durationMs >= 0);
  assert.equal(session.tests[1].status, 'pending');
  assert.deepEqual(session.results(), { passed: 1, failed: 0, skipped: 0, flaky: 0 });

  entry.durationMs = -1;
  await session.run([id('ready')]);
  assert.equal(entry.status, 'passed');
  assert.ok(entry.durationMs >= 0, 'the rerun updated the duration');
  assert.deepEqual(log, ['ran', 'ran']);
  assert.deepEqual(events, [
    'fileStarted session.rpg.test.js', 'testStarted ready', 'testPassed ready',
    'fileStarted session.rpg.test.js', 'testStarted ready', 'testPassed ready',
  ]);
  assert.deepEqual(session.results(), { passed: 1, failed: 0, skipped: 0, flaky: 0 }, 'latest result per test');
});

test('session: runs several tests in the given order; failures and skips are recorded, the latest result wins', async (t) => {
  const { session, id } = openSession(
    t,
    `test('passes', () => {});
test('fails', () => { if (!globalThis.__sessionFixed) throw new Error('broken'); });
test.skip('skipped', () => {});
`,
  );
  const [passes, fails, skipped] = session.tests;
  await session.run([id('fails'), id('passes'), id('skipped')]);
  assert.equal(passes.status, 'passed');
  assert.equal(fails.status, 'failed');
  assert.match(fails.error.message, /broken/);
  assert.equal(skipped.status, 'skipped');
  assert.deepEqual(session.results(), { passed: 1, failed: 1, skipped: 1, flaky: 0 });

  globalThis.__sessionFixed = true;
  t.after(() => delete globalThis.__sessionFixed);
  await session.run([id('fails')]);
  assert.equal(fails.status, 'passed');
  assert.equal(fails.error, null);
  assert.deepEqual(session.results(), { passed: 2, failed: 0, skipped: 1, flaky: 0 });
});

test('session: a test is marked running while it runs', async (t) => {
  const { session, id, log } = openSession(t, `test('slow', async () => { log.push('in'); await new Promise((r) => setTimeout(r, 200)); });\n`);
  const run = session.run([id('slow')]);
  await until(() => log.includes('in'), 'the test to start');
  assert.equal(session.tests[0].status, 'running');
  await run;
  assert.equal(session.tests[0].status, 'passed');
});

test('session: beforeAll/afterAll run around each run() of the tests in their scope, once per run', async (t) => {
  const { session, id, log } = openSession(
    t,
    `test.beforeAll(() => log.push('file:beforeAll'));
test.afterAll(() => log.push('file:afterAll'));
describe('group', () => {
  test.beforeAll(() => log.push('group:beforeAll'));
  test.afterAll(() => log.push('group:afterAll'));
  test('one', () => log.push('one'));
  test('two', () => log.push('two'));
});
test('three', () => log.push('three'));
`,
  );
  await session.run([id('group > one')]);
  assert.deepEqual(log.splice(0), ['file:beforeAll', 'group:beforeAll', 'one', 'group:afterAll', 'file:afterAll']);
  await session.run([id('group > two'), id('group > one'), id('three')]);
  assert.deepEqual(log.splice(0), ['file:beforeAll', 'group:beforeAll', 'two', 'one', 'group:afterAll', 'three', 'file:afterAll']);
  await session.run([id('three')]);
  assert.deepEqual(log.splice(0), ['file:beforeAll', 'three', 'file:afterAll']);
});

test('session: a failing afterAll counts as a failure of that run', async (t) => {
  const { session, id, events } = openSession(t, `test.afterAll(() => { throw new Error('cleanup broke'); });\ntest('one', () => {});\n`);
  await session.run([id('one')]);
  assert.equal(session.tests[0].status, 'passed');
  assert.deepEqual(session.results(), { passed: 1, failed: 1, skipped: 0, flaky: 0 });
  assert.ok(events.includes('testFailed file > afterAll'));
});

test('session: configured retries apply to each run; a pass on retry is flaky', async (t) => {
  const { session, id, events } = openSession(
    t,
    `test('wobbly', () => { globalThis.__sessionTries = (globalThis.__sessionTries || 0) + 1; if (globalThis.__sessionTries % 2 === 1) throw new Error('first try fails'); });\n`,
    { retries: 1 },
  );
  t.after(() => delete globalThis.__sessionTries);
  await session.run([id('wobbly')]);
  assert.equal(session.tests[0].status, 'passed');
  assert.equal(session.tests[0].flaky, true);
  assert.deepEqual(session.results(), { passed: 1, failed: 0, skipped: 0, flaky: 1 });
  assert.deepEqual(events.slice(1), ['testStarted wobbly', 'testStarted wobbly', 'testPassed wobbly']);
});

test('session: abort stops the running test (aborted, not retried), runs its cleanup, and cancels the rest of the run', async (t) => {
  const { session, id, log, events } = openSession(
    t,
    `test.afterEach(() => log.push('afterEach'));
test.afterAll(() => log.push('afterAll'));
test('hangs', async ({ game }) => {
  globalThis.__sessionGame = game;
  log.push('hanging');
  await game.expectText('never', { timeout: 60000 });
});
test('after', () => log.push('after'));
`,
    { retries: 2 },
  );
  t.after(() => delete globalThis.__sessionGame);
  const start = Date.now();
  const run = session.run([id('hangs'), id('after')]);
  await until(() => log.includes('hanging'), 'the test to start');
  session.abort();
  await run;
  assert.ok(Date.now() - start < 10000, 'the run ended promptly');
  const [hangs, after] = session.tests;
  assert.equal(hangs.status, 'aborted');
  assert.equal(hangs.error.name, 'AbortError');
  assert.equal(after.status, 'pending', 'the rest of the run was cancelled');
  assert.deepEqual(log, ['hanging', 'afterEach', 'afterAll']);
  assert.ok(globalThis.__sessionGame.getTrace().exitInfo, 'its app was stopped');
  assert.equal(events.filter((e) => e === 'testStarted hangs').length, 1, 'not retried');
  assert.ok(events.includes('testFailed hangs'));
  assert.deepEqual(session.results(), { passed: 0, failed: 1, skipped: 0, flaky: 0 });

  // The session is usable again afterwards.
  await session.run([id('after')]);
  assert.equal(after.status, 'passed');
});

test('session: abort with nothing running does nothing; run() rejects an unknown id and a second concurrent run', async (t) => {
  const { session, id } = openSession(t, `test('one', async () => { await new Promise((r) => setTimeout(r, 100)); });\n`);
  session.abort();
  await assert.rejects(session.run(['nope']), /unknown test id "nope"/);
  const run = session.run([id('one')]);
  await assert.rejects(session.run([id('one')]), /already in progress/);
  await run;
  assert.equal(session.tests[0].status, 'passed');
});

test('session: pause holds the next game action until stepOnce (one action) or resume, without timing the test out', async (t) => {
  const { session, id, log } = openSession(
    t,
    `test('gated', async ({ game }) => {
  test.setTimeout(1500);
  log.push('start');
  await game.expectText('READY');
  log.push('a');
  await game.press('x');
  log.push('b');
  await game.expectText('GOT');
  log.push('c');
});
`,
  );
  session.pause();
  assert.equal(session.paused, true);
  const run = session.run([id('gated')]);
  await until(() => log.includes('start'), 'the test to start');
  // Held past the test's own 1500ms timeout: a paused test's clock stops.
  await sleep(1700);
  assert.deepEqual(log, ['start']);
  session.stepOnce();
  await until(() => log.includes('a'), 'one step');
  await sleep(200);
  assert.deepEqual(log, ['start', 'a'], 'exactly one action went through');
  assert.equal(session.paused, true);
  session.resume();
  assert.equal(session.paused, false);
  await run;
  assert.deepEqual(log, ['start', 'a', 'b', 'c']);
  assert.equal(session.tests[0].status, 'passed', session.tests[0].error && session.tests[0].error.message);
});

test('session: abort while paused releases the held test as aborted and unpauses', async (t) => {
  const { session, id, log } = openSession(t, `test('held', async ({ game }) => { log.push('start'); await game.expectText('READY'); log.push('never'); });\n`);
  session.pause();
  const run = session.run([id('held')]);
  await until(() => log.includes('start'), 'the test to start');
  session.abort();
  await run;
  assert.equal(session.tests[0].status, 'aborted');
  assert.equal(session.paused, false);
  await sleep(100);
  assert.deepEqual(log, ['start']);
});
