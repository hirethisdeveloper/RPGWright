'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test, describe, expect } = require('rpgwright/test');
const { launchGame } = require('rpgwright');
const stateFile = require('./state-path');

const FIXTURE = path.join(__dirname, '..', '..', '..', 'fixtures', 'menu-nav-ink-app', 'cli.js');

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
  // settle waits for the screen to stop changing after the write, so the
  // digit and the Enter can't coalesce into one "paste" on the app's side.
  await game.type('2', { settle: true });
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

test('a failing snapshot comparison shows a row diff against the recorded screen', async ({ game }) => {
  await game.expectText('build 42');
  await expect(game).toMatchScreenSnapshot('diffed');
  await game.press('ArrowDown');
  await game.expectText('> Settings');
  await assert.rejects(expect(game).toMatchScreenSnapshot('diffed', { timeout: 300 }), (err) => {
    assert.match(err.message, /Diff \(- expected, \+ actual\):/);
    assert.match(err.message, /- │> Play     │\n\s+\+ │  Play     │\n\s+\^/);
    assert.match(err.message, /- │  Settings │\n\s+\+ │> Settings │/);
    return true;
  });
});

test('a styled snapshot also records and compares how the screen is drawn', async ({ game }) => {
  await game.expectText('build 42');
  await expect(game).toMatchScreenSnapshot('styled', { styles: true });
  await expect(game).toMatchScreenSnapshot('styled', { styles: true, timeout: 300 });
});

describe('the same screen, drawn without color', () => {
  const snapshotsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-styled-vs-plain-'));
  test.use({ colorDepth: 'none', snapshotsDir });

  test('matches the text snapshot but fails the styled one, with a style diff', async ({ game }) => {
    // Record the reference from a colored instance of the same app.
    const colored = await launchGame({ command: process.execPath, args: [FIXTURE], cols: 40, rows: 12, snapshotsDir });
    try {
      await colored.expectText('build 42');
      await expect(colored).toMatchScreenSnapshot('styled-vs-plain', { styles: true });
    } finally {
      await colored.stop();
    }

    await game.expectText('build 42');
    await expect(game).toMatchScreenSnapshot('styled-vs-plain', { timeout: 300 });
    await assert.rejects(expect(game).toMatchScreenSnapshot('styled-vs-plain', { styles: true, timeout: 300 }), (err) => {
      assert.match(err.message, /Styles \(y:x\+width style\):\n[\s\S]*- 2:1\+1 fg=6 inverse\n\s+- 2:2\+1 inverse\n\s+- 2:3\+4 fg=6 inverse/);
      assert.doesNotMatch(err.message, /^\s+[-+] .*MENU NAV APP/m, 'the text itself did not change');
      return true;
    });
  });
});

describe('a screen whose build number changes', () => {
  const snapshotsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-volatile-'));
  test.use({ snapshotsDir });

  test('mask and normalize keep it out of the snapshot; without them the comparison fails', async ({ game, launch }) => {
    await game.expectText('build 42');
    const mask = { mask: [/build \d+/] };
    const normalize = { normalize: (text) => text.replace(/build \d+/, 'build N') };
    await expect(game).toMatchScreenSnapshot('masked', mask);
    await expect(game).toMatchScreenSnapshot('normalized', normalize);
    await expect(game).toMatchScreenSnapshot('plain');

    const rebuilt = await launch({ env: { ...process.env, BUILD_ID: '97' } });
    await rebuilt.expectText('build 97');
    await expect(rebuilt).toMatchScreenSnapshot('masked', { ...mask, timeout: 300 });
    await expect(rebuilt).toMatchScreenSnapshot('normalized', { ...normalize, timeout: 300 });
    await assert.rejects(expect(rebuilt).toMatchScreenSnapshot('plain', { timeout: 300 }), /E2E TEST FAILED/);
  });

  test('adding styles: true to an existing snapshot still compares its text before recording the styles', async ({ game, launch }) => {
    await game.expectText('build 42');
    await expect(game).toMatchScreenSnapshot('styled-later');
    const rebuilt = await launch({ env: { ...process.env, BUILD_ID: '97' } });
    await rebuilt.expectText('build 97');
    await assert.rejects(expect(rebuilt).toMatchScreenSnapshot('styled-later', { styles: true, timeout: 300 }), /E2E TEST FAILED/);
    assert.equal(fs.readFileSync(path.join(snapshotsDir, 'styled-later.snap'), 'utf8').includes('build 42'), true, 'the text snapshot was not re-recorded');
    assert.equal(fs.existsSync(path.join(snapshotsDir, 'styled-later.styles.snap')), false);
    await expect(game).toMatchScreenSnapshot('styled-later', { styles: true });
    assert.equal(fs.existsSync(path.join(snapshotsDir, 'styled-later.styles.snap')), true, 'recorded once the text matched');
  });
});

test('maxDiffCells tolerates small changes, alongside mask and normalize', async ({ game }) => {
  await game.expectText('build 42');
  const opts = { mask: [/build \d+/], normalize: (text) => text.replace(/Narrow|Wide/, 'LAYOUT') };
  await expect(game).toMatchScreenSnapshot('masked', opts);
  // Moving the cursor moves the ">" marker: one character on each of two rows.
  await game.press('ArrowDown');
  await game.expectText('> Settings');
  await assert.rejects(expect(game).toMatchScreenSnapshot('masked', { ...opts, timeout: 300 }), /E2E TEST FAILED/);
  await expect(game).toMatchScreenSnapshot('masked', { ...opts, maxDiffCells: 2, timeout: 300 });
  await assert.rejects(expect(game).toMatchScreenSnapshot('masked', { ...opts, maxDiffCells: 1, timeout: 300 }), /E2E TEST FAILED/);
});

test('expectState polls an external state file the target app writes, independent of screen text', async ({ game }) => {
  await game.expectText('MENU NAV APP');
  await game.type('1');
  await game.expectText('(typed: 1)');
  await game.press('ENTER');
  await game.expectText('PLAYING');

  // Rapid consecutive writes can be coalesced by the OS into a single read
  // on the child's end, and Ink treats a multi-character chunk as one
  // "paste" rather than N keystrokes. settle lets each press land and
  // render before the next is sent.
  await game.press.raw(' ', { settle: true });
  await game.press.raw(' ', { settle: true });
  await game.press.raw(' ', { settle: true });
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

  // Settle so the arrow and the Enter can't reach the app as one read.
  await game.press('ARROWDOWN', { settle: true });
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
