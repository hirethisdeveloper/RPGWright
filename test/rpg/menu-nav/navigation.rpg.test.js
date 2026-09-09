'use strict';

const fs = require('node:fs');
const assert = require('node:assert/strict');
const { test, expect } = require('rpgwright/test');
const stateFile = require('./state-path');

function readState() {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

test('arrow-key navigation moves the highlighted cursor between menu options', async ({ game }) => {
  await game.expectText('MENU NAV APP');
  assert.ok(game.getScreenText().includes('> Play'));

  await game.press('ARROWDOWN');
  await game.expectText('> Settings');

  await game.press('ARROWDOWN');
  await game.expectText('> Quit');

  await game.press('ARROWUP');
  await game.expectText('> Settings');
});

test('ENTER selects the arrow-highlighted option', async ({ game }) => {
  await game.expectText('MENU NAV APP');
  await game.press('ARROWDOWN');
  await game.expectText('> Settings');
  await game.press('ENTER');
  await expect(game).toHaveText('SETTINGS');
});

test('typing a number and pressing ENTER selects that option directly (no arrow keys)', async ({ game }) => {
  await game.expectText('MENU NAV APP');
  await game.type('2');
  await game.expectText('(typed: 2)');
  await game.press('ENTER');
  await expect(game).toHaveText('SETTINGS');
});

test('expectNotText confirms the pre-toggle text is gone after the state that produced it changes', async ({ game }) => {
  await game.expectText('MENU NAV APP');
  await game.type('2');
  await game.expectText('(typed: 2)');
  await game.press('ENTER');
  await game.expectText('Sound: ON');

  await game.press('ENTER');
  // Called immediately after press() -- "Sound: ON" is still on screen the
  // instant this runs, since the child hasn't reacted yet. This is exactly
  // the case expectNotText exists to handle correctly.
  await expect(game).not.toHaveText('Sound: ON');
  await expect(game).toHaveText('Sound: OFF');
});

test('expectNotText fails if the text is still present once its confirmation window elapses', async ({ game }) => {
  await game.expectText('MENU NAV APP');
  await game.type('2');
  await game.expectText('(typed: 2)');
  await game.press('ENTER');
  await game.expectText('Sound: ON');

  await assert.rejects(game.expectNotText('Sound: ON', { holdFor: 100, timeout: 300 }), /E2E TEST FAILED/);
});

test('expectScreen with a RegExp matches anywhere in the full screen', async ({ game }) => {
  await game.expectText('MENU NAV APP');
  await expect(game).toMatchScreen(/MENU NAV APP[\s\S]*Quit/);
});

test('expectScreen with a string requires an exact whole-screen match, unlike expectText', async ({ game }) => {
  await game.expectText('MENU NAV APP');
  // A substring is enough for expectText, but expectScreen's string mode
  // requires the whole screen to equal the given string exactly.
  await assert.rejects(game.expectScreen('MENU NAV APP', { timeout: 300 }), /E2E TEST FAILED/);
});

test('expectScreen snapshot mode records on first run, then compares on subsequent runs', async ({ game }) => {
  await game.expectText('MENU NAV APP');
  await expect(game).toMatchScreenSnapshot('menu-40x12');
  // Second call against the same now-recorded snapshot just compares, and passes.
  await expect(game).toMatchScreenSnapshot('menu-40x12');
});

test('expectScreen snapshot mode fails when the live screen no longer matches a recorded snapshot', async ({ game }) => {
  await game.expectText('MENU NAV APP');
  await expect(game).toMatchScreenSnapshot('menu-then-settings');

  await game.type('2');
  await game.expectText('(typed: 2)');
  await game.press('ENTER');
  await game.expectText('SETTINGS');

  await assert.rejects(game.expectScreen({ snapshot: 'menu-then-settings' }, { timeout: 300 }), /E2E TEST FAILED/);
});

test('expectState polls an external state file the target app writes, independent of screen text', async ({ game }) => {
  await game.expectText('MENU NAV APP');
  await game.type('1');
  await game.expectText('(typed: 1)');
  await game.press('ENTER');
  await game.expectText('PLAYING');

  // Confirming each press's effect before sending the next, rather than
  // firing all three unawaited: rapid consecutive writes can be coalesced
  // by the OS into a single read on the child's end before it's processed,
  // and Ink treats a multi-character chunk as one "paste" rather than N
  // separate keystrokes -- a real PTY/terminal characteristic, not
  // something RPGWright should (or safely could) paper over.
  await game.press.raw(' ');
  await game.expectText('Score: 1');
  await game.press.raw(' ');
  await game.expectText('Score: 2');
  await game.press.raw(' ');
  await game.expectText('Score: 3');

  await expect(game).toHaveState(async () => readState(), (state) => state.score === 3 && state.screen === 'play');
});

test('expectState fails with a clear timeout if the matcher never becomes true', async ({ game }) => {
  await game.expectText('MENU NAV APP');
  await assert.rejects(
    game.expectState(async () => readState(), (state) => state.score === 999, { timeout: 300, pollInterval: 20 }),
    /E2E TEST FAILED/,
  );
});

test('resize() reflows a responsive layout, toggling text below/above a column threshold', async ({ game }) => {
  await game.expectText('MENU NAV APP');
  await game.expectText('Narrow layout');

  await game.resize(80, 20);
  await game.expectText('Wide layout enabled');

  await game.resize(40, 12);
  await game.expectText('Narrow layout');
});

test('a full navigation scenario — menu to play to menu to settings to quit', async ({ game }) => {
  await game.expectText('MENU NAV APP');
  await game.type('1');
  await game.expectText('(typed: 1)');
  await game.press('ENTER');
  await game.expectText('PLAYING');

  await game.press.raw(' ');
  await game.expectText('Score: 1');

  await game.press('ESCAPE');
  await game.expectText('MENU NAV APP');

  await game.press('ARROWDOWN');
  await game.press('ENTER');
  await game.expectText('SETTINGS');
  await game.press('ESCAPE');
  await game.expectText('MENU NAV APP');

  assert.equal(readState().score, 1);

  await game.type('3');
  await game.expectText('(typed: 3)');
  await game.press('ENTER');
  const exitInfo = await game.stop();
  assert.equal(exitInfo.exitCode, 0);
});
