'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchGame } = require('../src/game');

const FIXTURE_MENU_NAV = path.join(__dirname, '..', 'fixtures', 'menu-nav-ink-app', 'cli.js');

function launchFixture(overrides = {}) {
  const stateFile = path.join(os.tmpdir(), `rpgwright-menu-nav-state-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const env = { ...process.env, STATE_FILE: stateFile, ...(overrides.env || {}) };
  return {
    stateFile,
    game: launchGame({ command: process.execPath, args: [FIXTURE_MENU_NAV], cols: 40, rows: 12, ...overrides, env }),
  };
}

function readState(stateFile) {
  return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

test('menu-nav: arrow-key navigation moves the highlighted cursor between menu options', async () => {
  const { game: gamePromise } = launchFixture();
  const game = await gamePromise;

  await game.expectText('MENU NAV APP');
  assert.ok(game.getScreenText().includes('> Play'));

  await game.press('ARROWDOWN');
  await game.expectText('> Settings');

  await game.press('ARROWDOWN');
  await game.expectText('> Quit');

  await game.press('ARROWUP');
  await game.expectText('> Settings');

  await game.stop();
});

test('menu-nav: ENTER selects the arrow-highlighted option', async () => {
  const { game: gamePromise } = launchFixture();
  const game = await gamePromise;

  await game.expectText('MENU NAV APP');
  await game.press('ARROWDOWN');
  await game.expectText('> Settings');
  await game.press('ENTER');
  await game.expectText('SETTINGS');

  await game.stop();
});

test('menu-nav: typing a number and pressing ENTER selects that option directly (no arrow keys)', async () => {
  const { game: gamePromise } = launchFixture();
  const game = await gamePromise;

  await game.expectText('MENU NAV APP');
  await game.type('2');
  await game.press('ENTER');
  await game.expectText('SETTINGS');

  await game.stop();
});

test('menu-nav: expectNotText confirms the pre-toggle text is gone after the state that produced it changes', async () => {
  const { game: gamePromise } = launchFixture();
  const game = await gamePromise;

  await game.expectText('MENU NAV APP');
  await game.type('2');
  await game.press('ENTER');
  await game.expectText('Sound: ON');

  await game.press('ENTER');
  // Called immediately after press() — "Sound: ON" is still on screen the
  // instant this runs, since the child hasn't reacted yet. This is exactly
  // the case expectNotText exists to handle correctly.
  await game.expectNotText('Sound: ON');
  await game.expectText('Sound: OFF');

  await game.stop();
});

test('menu-nav: expectNotText fails if the text is still present once its confirmation window elapses', async () => {
  const { game: gamePromise } = launchFixture();
  const game = await gamePromise;

  await game.expectText('MENU NAV APP');
  await game.type('2');
  await game.press('ENTER');
  await game.expectText('Sound: ON');

  await assert.rejects(game.expectNotText('Sound: ON', { holdFor: 100, timeout: 300 }), /E2E TEST FAILED/);

  await game.stop();
});

test('menu-nav: expectScreen with a RegExp matches anywhere in the full screen', async () => {
  const { game: gamePromise } = launchFixture();
  const game = await gamePromise;

  await game.expectText('MENU NAV APP');
  await game.expectScreen(/MENU NAV APP[\s\S]*Quit/);

  await game.stop();
});

test('menu-nav: expectScreen with a string requires an exact whole-screen match, unlike expectText', async () => {
  const { game: gamePromise } = launchFixture();
  const game = await gamePromise;

  await game.expectText('MENU NAV APP');
  // A substring is enough for expectText, but expectScreen's string mode
  // requires the whole screen to equal the given string exactly.
  await assert.rejects(game.expectScreen('MENU NAV APP', { timeout: 300 }), /E2E TEST FAILED/);

  await game.stop();
});

test('menu-nav: expectScreen snapshot mode records on first run, then compares on subsequent runs', async () => {
  const snapshotsDir = path.join(os.tmpdir(), `rpgwright-snapshots-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const { game: gamePromise } = launchFixture({ snapshotsDir });
  const game = await gamePromise;

  await game.expectText('MENU NAV APP');
  await game.expectScreen({ snapshot: 'menu-40x12' });

  const snapshotPath = path.join(snapshotsDir, 'menu-40x12.snap');
  assert.ok(fs.existsSync(snapshotPath), 'snapshot file should be recorded on first run');
  const recorded = fs.readFileSync(snapshotPath, 'utf8');
  assert.ok(recorded.includes('MENU NAV APP'));

  // Second run against the same recorded snapshot should just compare, and pass.
  await game.expectScreen({ snapshot: 'menu-40x12' });

  await game.stop();
  fs.rmSync(snapshotsDir, { recursive: true, force: true });
});

test('menu-nav: expectScreen snapshot mode fails when the live screen no longer matches a recorded snapshot', async () => {
  const snapshotsDir = path.join(os.tmpdir(), `rpgwright-snapshots-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const { game: gamePromise } = launchFixture({ snapshotsDir });
  const game = await gamePromise;

  await game.expectText('MENU NAV APP');
  await game.expectScreen({ snapshot: 'menu-then-settings' });

  await game.type('2');
  await game.press('ENTER');
  await game.expectText('SETTINGS');

  await assert.rejects(game.expectScreen({ snapshot: 'menu-then-settings' }, { timeout: 300 }), /E2E TEST FAILED/);

  await game.stop();
  fs.rmSync(snapshotsDir, { recursive: true, force: true });
});

test('menu-nav: expectState polls an external state file the target app writes, independent of screen text', async () => {
  const { game: gamePromise, stateFile } = launchFixture();
  const game = await gamePromise;

  await game.expectText('MENU NAV APP');
  await game.type('1');
  await game.press('ENTER');
  await game.expectText('PLAYING');

  // Confirming each press's effect before sending the next, rather than
  // firing all three unawaited: rapid consecutive writes can be coalesced
  // by the OS into a single read on the child's end before it's processed,
  // and Ink treats a multi-character chunk as one "paste" rather than N
  // separate keystrokes — a real PTY/terminal characteristic, not
  // something RPGWright should (or safely could) paper over.
  await game.press.raw(' ');
  await game.expectText('Score: 1');
  await game.press.raw(' ');
  await game.expectText('Score: 2');
  await game.press.raw(' ');
  await game.expectText('Score: 3');

  await game.expectState(
    async () => readState(stateFile),
    (state) => state.score === 3 && state.screen === 'play',
  );

  await game.stop();
});

test('menu-nav: expectState fails with a clear timeout if the matcher never becomes true', async () => {
  const { game: gamePromise, stateFile } = launchFixture();
  const game = await gamePromise;

  await game.expectText('MENU NAV APP');

  await assert.rejects(
    game.expectState(async () => readState(stateFile), (state) => state.score === 999, {
      timeout: 300,
      pollInterval: 20,
    }),
    /E2E TEST FAILED/,
  );

  await game.stop();
});

test('menu-nav: resize() reflows a responsive layout, toggling text below/above a column threshold', async () => {
  const { game: gamePromise } = launchFixture({ cols: 40, rows: 12 });
  const game = await gamePromise;

  await game.expectText('MENU NAV APP');
  await game.expectText('Narrow layout');

  await game.resize(80, 20);
  await game.expectText('Wide layout enabled');

  await game.resize(40, 12);
  await game.expectText('Narrow layout');

  await game.stop();
});

test('menu-nav: a full navigation scenario — menu to play to menu to settings to quit', async () => {
  const { game: gamePromise, stateFile } = launchFixture();
  const game = await gamePromise;

  await game.expectText('MENU NAV APP');
  await game.type('1');
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

  const state = readState(stateFile);
  assert.equal(state.score, 1);

  await game.type('3');
  await game.press('ENTER');
  const exitInfo = await game.stop();
  assert.equal(exitInfo.exitCode, 0);
});
