'use strict';

const assert = require('node:assert/strict');
const { test, expect } = require('rpgwright/test');

test('smoke test — launch, observe, input, observe, assert, clean termination', async ({ game }) => {
  await game.expectText('Press ENTER to continue');
  await game.press('ENTER');
  await expect(game).toHaveText('You pressed ENTER');
  assert.ok(game.getScreenText().includes('You pressed ENTER'));

  const exitInfo = await game.stop();
  assert.equal(exitInfo.exitCode, 0);
});

test('a failing expectText throws an Error whose message matches the §9 failure-report format', async ({ game }) => {
  await game.expectText('Press ENTER to continue');

  await assert.rejects(game.expectText('this text will never appear', { timeout: 300 }), (err) => {
    assert.match(err.message, /^E2E TEST FAILED/);
    assert.match(err.message, /Last action:\n {2}expectText\("this text will never appear"\)/);
    assert.match(err.message, /Current screen:\n {2}MINIMAL APP/);
    assert.match(err.message, /1\. launchGame\(/);
    assert.match(err.message, /expectText\("this text will never appear"\) {2}← failed after this action/);
    return true;
  });
});

test('press() throws on an unknown key name instead of writing it literally', async ({ game }) => {
  await game.expectText('Press ENTER to continue');
  await assert.rejects(game.press('NOT_A_REAL_KEY'), /Unknown key "NOT_A_REAL_KEY"/);
});

test('press.raw() sends a literal byte sequence, bypassing the key table', async ({ game }) => {
  await game.expectText('Press ENTER to continue');
  await game.press.raw('\r');
  await expect(game).toHaveText('You pressed ENTER');
});

test('type() writes literal text to the process', async ({ game }) => {
  await game.expectText('Press ENTER to continue');
  await game.press('ENTER');
  await game.expectText('Press q to quit');
  await game.type('q');

  const exitInfo = await game.stop();
  assert.equal(exitInfo.exitCode, 0);
});

test('actions records press/type/expectText calls in order with correct ok status', async ({ game }) => {
  await game.expectText('Press ENTER to continue');
  await game.press('ENTER');
  await game.expectText('You pressed ENTER');

  assert.deepEqual(
    game.actions.map((a) => [a.type, a.ok]),
    [
      ['expectText', true],
      ['press', true],
      ['expectText', true],
    ],
  );
});

test('a global-flag RegExp needle can be reused across repeated checks without lastIndex drift', async ({ game }) => {
  const needle = /ENTER/g;
  await game.expectText(needle);
  // A RegExp's own .test() advances lastIndex on a match when the 'g'/'y'
  // flag is set; a naive implementation that doesn't reset it before each
  // check would fail this second call even though "ENTER" is still on
  // screen, since the search would resume past the first match.
  await game.expectText(needle);
});

test('stop() is idempotent and safe when the process already exited on its own', async ({ game }) => {
  await game.expectText('Press ENTER to continue');
  await game.press('ENTER');
  await game.expectText('Press q to quit');
  await game.type('q');

  const first = await game.stop();
  const second = await game.stop();
  assert.equal(first.exitCode, 0);
  assert.deepEqual(second, first);
});
