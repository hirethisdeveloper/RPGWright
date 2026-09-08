'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { launchGame } = require('../src/game');
const { FIXTURE_MINIMAL } = require('./helpers');

function launchFixture(overrides = {}) {
  return launchGame({ command: process.execPath, args: [FIXTURE_MINIMAL], cols: 40, rows: 10, ...overrides });
}

test('game: smoke test — launch, observe, input, observe, assert, clean termination', async () => {
  const game = await launchFixture({ scenarioName: 'smoke test' });

  await game.expectText('Press ENTER to continue');
  await game.press('ENTER');
  await game.expectText('You pressed ENTER');
  assert.ok(game.getScreenText().includes('You pressed ENTER'));

  const exitInfo = await game.stop();
  assert.equal(exitInfo.exitCode, 0);
});

// Permanent regression test (not a one-off manual check): proves the §9
// failure-report format actually renders correctly against a real failure.
test('game: a failing expectText throws an Error whose message matches the §9 failure-report format', async () => {
  const game = await launchFixture({
    scenarioName: 'failure report regression',
    getDiagnostics: async () => 'regression-test diagnostics',
  });

  await game.expectText('Press ENTER to continue');

  await assert.rejects(
    game.expectText('this text will never appear', { timeout: 300 }),
    (err) => {
      assert.match(err.message, /^E2E TEST FAILED/);
      assert.match(err.message, /Scenario: failure report regression/);
      assert.match(err.message, /Last action:\n {2}expectText\("this text will never appear"\)/);
      assert.match(err.message, /Expected:\n {2}"this text will never appear"/);
      assert.match(err.message, /Current screen:\n {2}MINIMAL APP/);
      assert.match(err.message, /PTY exit code:\n {2}still running/);
      assert.match(err.message, /Diagnostics:\n {2}regression-test diagnostics/);
      assert.match(err.message, /1\. launchGame\(/);
      assert.match(err.message, /expectText\("this text will never appear"\) {2}← failed after this action/);
      return true;
    },
  );

  await game.stop();
});

test('game: press() throws on an unknown key name instead of writing it literally', async () => {
  const game = await launchFixture();
  await game.expectText('Press ENTER to continue');
  await assert.rejects(game.press('NOT_A_REAL_KEY'), /Unknown key "NOT_A_REAL_KEY"/);
  await game.stop();
});

test('game: press.raw() sends a literal byte sequence, bypassing the key table', async () => {
  const game = await launchFixture();
  await game.expectText('Press ENTER to continue');
  await game.press.raw('\r');
  await game.expectText('You pressed ENTER');
  await game.stop();
});

test('game: type() writes literal text to the process', async () => {
  const game = await launchFixture();
  await game.expectText('Press ENTER to continue');
  await game.press('ENTER');
  await game.expectText('Press q to quit');
  await game.type('q');

  const exitInfo = await game.stop();
  assert.equal(exitInfo.exitCode, 0);
});

test('game: actions records press/type/expectText calls in order with correct ok status', async () => {
  const game = await launchFixture();
  await game.expectText('Press ENTER to continue');
  await game.press('ENTER');
  await game.expectText('You pressed ENTER');
  await game.stop();

  assert.deepEqual(
    game.actions.map((a) => [a.type, a.ok]),
    [
      ['expectText', true],
      ['press', true],
      ['expectText', true],
    ],
  );
});

test('game: stop() is idempotent and safe when the process already exited on its own', async () => {
  const game = await launchFixture();
  await game.expectText('Press ENTER to continue');
  await game.press('ENTER');
  await game.expectText('Press q to quit');
  await game.type('q');

  const first = await game.stop();
  const second = await game.stop();
  assert.equal(first.exitCode, 0);
  assert.deepEqual(second, first);
});

test('game: killSignal defaults to SIGTERM, not node-pty\'s SIGHUP default, against a well-behaved app', async () => {
  const game = await launchFixture();
  await game.expectText('Press ENTER to continue');
  const exitInfo = await game.stop();
  assert.equal(exitInfo.exitCode, 0);
});
