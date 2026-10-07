'use strict';

const assert = require('node:assert/strict');
const { test, describe, expect } = require('rpgwright/test');
const { PROBE } = require('./rpgwright.config');

describe('terminal query replies', () => {
  test.use({ args: [PROBE, 'query'] });

  test('an app that asks for the cursor position gets the emulator\'s answer', async ({ game }) => {
    await game.expectText('CPR row=1 col=14');
  });
});

describe('key chords', () => {
  test('Modifier chords reach the app as the bytes a real xterm sends', async ({ game }) => {
    await game.expectText('READY');
    const cases = [
      ['Shift+Tab', '\\u001b[Z'],
      ['Control+ArrowLeft', '\\u001b[1;5D'],
      ['Alt+x', '\\u001bx'],
      ['Control+a', '\\u0001'],
    ];
    for (const [key, escaped] of cases) {
      await game.press(key);
      await game.expectText(`GOT "${escaped}"`);
    }
  });

  test('an unrepresentable chord throws before anything is written', async ({ game }) => {
    await game.expectText('READY');
    await assert.rejects(game.press('Control+Enter'), /no standard terminal encoding/);
    assert.equal(game.actions.length, 1, 'only the expectText was recorded');
  });
});

describe('terminal environment', () => {
  test.use({ args: [PROBE, 'env'] });

  test('defaults leave TERM at xterm-color and the color variables untouched', async ({ game }) => {
    await game.expectText('READY');
    await game.expectText('TERM=xterm-color');
  });

  describe('term and locale', () => {
    test.use({ term: 'xterm-256color', locale: 'C' });

    test('set TERM, LANG and LC_ALL in the child', async ({ game }) => {
      await game.expectText('READY');
      await game.expectText('TERM=xterm-256color');
      await game.expectText('LANG=C');
      await game.expectText('LC_ALL=C');
    });
  });

  describe('colorDepth: none', () => {
    test.use({ colorDepth: 'none', env: { ...process.env, COLORTERM: 'truecolor' } });

    test('sets NO_COLOR and FORCE_COLOR=0 and removes an inherited COLORTERM', async ({ game }) => {
      await game.expectText('READY');
      await game.expectText('NO_COLOR=1');
      await game.expectText('FORCE_COLOR=0');
      await game.expectText('COLORTERM=(unset)');
    });
  });

  describe('colorDepth: truecolor', () => {
    test.use({ colorDepth: 'truecolor', env: { ...process.env, NO_COLOR: '1' } });

    test('sets COLORTERM=truecolor and FORCE_COLOR=3 and removes an inherited NO_COLOR', async ({ game }) => {
      await game.expectText('READY');
      await game.expectText('COLORTERM=truecolor');
      await game.expectText('FORCE_COLOR=3');
      await game.expectText('NO_COLOR=(unset)');
    });
  });
});

describe('waitForStable', () => {
  test.use({ args: [PROBE, 'spinner', '10'] });

  test('resolves only once the spinner has stopped redrawing', async ({ game }) => {
    await game.expectText('READY');
    await game.waitForStable({ quiet: 120 });
    assert.ok(game.getScreenText().includes('DONE'), game.getScreenText());
  });

  describe('a spinner that never stops', () => {
    test.use({ args: [PROBE, 'spinner', 'forever'] });

    test('fails with the standard failure report', async ({ game }) => {
      await game.expectText('READY');
      await assert.rejects(
        game.waitForStable({ quiet: 120, timeout: 500 }),
        /E2E TEST FAILED[\s\S]*Expected:\n  no screen update for 120ms/,
      );
    });
  });
});

describe('cursor', () => {
  test.use({ args: [PROBE, 'prompt'] });

  test('a text input shows the cursor right after the typed text, then hides it on submit', async ({ game }) => {
    await game.expectText('Name:');
    await expect(game).toHaveCursorVisible();
    await expect(game).toHaveCursorAt(6, 1);

    await game.type('Aria');
    await expect(game).toHaveCursorAt(10, 1);
    await expect(game.locator('Aria')).toBeFocused({ cursor: true });
    assert.deepEqual(game.getCursor(), { x: 10, y: 1, visible: true });

    await game.press('Backspace');
    await expect(game).toHaveCursorAt(game.locator({ row: 1 }));
    await expect(game).toHaveCursorAt(9, 1);

    await game.press('Enter');
    await expect(game).not.toHaveCursorVisible();
    await expect(game.locator('Ari!')).not.toBeFocused({ cursor: true });
  });

  test('a cursor assertion fails with where the cursor actually was', async ({ game }) => {
    await game.expectText('Name:');
    await assert.rejects(
      expect(game).toHaveCursorAt(0, 0, { timeout: 300 }),
      /the cursor to be in \(0, 0\)\n\s+Observed: cursor at \(6, 1\)/,
    );
    await assert.rejects(expect(game).not.toHaveCursorVisible({ timeout: 300 }), /the cursor to be hidden/);
  });
});

describe('snapshots of an animating screen', () => {
  test.use({ args: [PROBE, 'spinner', '10'] });

  test('recording waits for the screen to stop changing, so the snapshot is the settled frame', async ({ game }) => {
    await game.expectText('READY');
    await expect(game).toMatchScreenSnapshot('spinner-settled');
    assert.match(game.getScreenText(), /DONE/);
    await expect(game).toMatchScreenSnapshot('spinner-settled', { timeout: 300 });
  });
});

describe('frame history', () => {
  describe('a toast that disappears', () => {
    test.use({ args: [PROBE, 'toast'] });

    test('expectSeen finds it after it is gone; expectText, which only sees the current screen, cannot', async ({ game }) => {
      await game.expectText('READY');
      await game.press('s');
      await game.waitForStable();
      assert.doesNotMatch(game.getScreenText(), /Saved!/);
      await assert.rejects(game.expectText('Saved!', { timeout: 300 }), /E2E TEST FAILED/);
      await game.expectSeen('Saved!');
      await assert.rejects(game.expectSeen('Deleted!', { timeout: 300 }), /"Deleted!" to appear at some point since the last input/);
    });

    test('expectSeen only looks at screens since the last input, unless asked to look from the start', async ({ game }) => {
      await game.expectText('READY');
      await game.press('s');
      await game.expectSeen('Saved!');
      await game.waitForStable();
      // resize is an input action too, and this app shows no toast for it.
      await game.resize(60, 12);
      await assert.rejects(game.expectSeen('Saved!', { timeout: 300 }), /E2E TEST FAILED/);
      await game.expectSeen('Saved!', { since: 'start' });
    });
  });

  describe('a redraw that clears the screen in one write and draws in another', () => {
    test.use({ args: [PROBE, 'redraw', 'flicker'] });

    test('expectNoFlicker fails, naming when the blank screen appeared', async ({ game }) => {
      await game.expectText('frame 0');
      await game.press('x');
      await assert.rejects(game.expectNoFlicker(), /no blank intermediate screen\n\s+Observed: a blank screen at \+\d+ms/);
      await game.expectText('frame 1');
    });
  });

  describe('a redraw done in a single write', () => {
    test.use({ args: [PROBE, 'redraw', 'clean'] });

    test('expectNoFlicker passes', async ({ game }) => {
      await game.expectText('frame 0');
      await game.press('x');
      await game.expectNoFlicker();
      await game.expectText('frame 1');
    });
  });
});

describe('rendering and traces', () => {
  test.use({ args: [PROBE, 'prompt'] });

  test('renderHtml draws the current screen, cursor included', async ({ game }) => {
    await game.type('Aria');
    await game.expectText('Name: Aria');
    const html = game.renderHtml();
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /Name: Aria<span style="outline:1px solid #f5c542;outline-offset:-1px"> <\/span>/);
  });

  test('without record, actions keep no screens (memory stays flat over a long test)', async ({ game }) => {
    await game.type('Al');
    await game.expectText('Name: Al');
    assert.ok(game.actions.every((a) => a.screen === undefined && a.cursor === undefined));
  });

  describe('with record', () => {
    test.use({ record: true });

    test('getTrace has every action with the screen it finished on, and the final screen after stop()', async ({ game }) => {
      await game.expectText('Name:');
      await game.type('Al');
      await game.expectText('Name: Al');
      await game.stop();
      const trace = game.getTrace();
      assert.deepEqual(trace.actions.map((a) => a.type), ['expectText', 'type', 'expectText']);
      const lastScreen = trace.actions[2].screen.map((row) => row.map((c) => c.ch || ' ').join('').trimEnd());
      assert.equal(lastScreen[1], 'Name: Al');
      assert.ok(trace.frames.length > 0 && trace.frames.every((f) => typeof f.text === 'string'));
      assert.ok(trace.final.grid.length > 0);
      assert.match(game.renderHtml(), /Name: Al/, 'renderHtml still works after stop()');
    });
  });
});

describe('mouse', () => {
  describe('with SGR reporting (?1000 + ?1006)', () => {
    test.use({ args: [PROBE, 'mouse', '1000', '1006'] });

    test('click, right-click and wheel arrive as SGR reports at 1-based positions', async ({ game }) => {
      await game.expectText('READY');
      await expect(game).toHaveMouseTracking('vt200');
      await game.mouse.click(4, 2, { settle: true });
      await game.expectText('GOT "\\u001b[<0;5;3M"');
      await game.expectText('GOT "\\u001b[<0;5;3m"');
      await game.mouse.click(0, 0, { button: 'right', settle: true });
      await game.expectText('GOT "\\u001b[<2;1;1M"');
      await game.mouse.wheel(1, 1, { deltaY: -1 });
      await game.expectText('GOT "\\u001b[<64;2;2M"');
    });

    test('locator.click() aims at the center of the region', async ({ game }) => {
      await game.expectText('READY');
      await game.locator('READY').click({ settle: true });
      // "READY" is x=0..4 on row 0, so its center is (2, 0): 1-based (3, 1).
      await game.expectText('GOT "\\u001b[<0;3;1M"');
    });

    test('motion is not reported in vt200 mode, and the action list says so', async ({ game }) => {
      await game.expectText('READY');
      await game.mouse.move(3, 3);
      assert.match(game.actions[game.actions.length - 1].detail, /move\(3, 3\), not reported in vt200 mode/);
    });
  });

  describe('with drag tracking and the legacy X10 encoding (?1002)', () => {
    test.use({ args: [PROBE, 'mouse', '1002'] });

    test('drag sends press, motion with the button held, and release', async ({ game }) => {
      await game.expectText('READY');
      await game.mouse.drag({ x: 0, y: 0 }, { x: 2, y: 0 }, { settle: true });
      await game.expectText('GOT "\\u001b[M !!"');
      await game.expectText('GOT "\\u001b[M@#!"');
      await game.expectText('GOT "\\u001b[M##!"');
    });
  });

  describe('with the plain X10 encoding, far to the right (?1000)', () => {
    test.use({ args: [PROBE, 'mouse', '1000', 'hex'], cols: 160 });

    test('a coordinate past 94 is sent as one raw byte, as xterm sends it, not UTF-8 encoded', async ({ game }) => {
      await game.expectText('READY');
      await game.mouse.down(150, 2);
      // ESC [ M, button 0+32, column 151+32 = 0xb7, row 3+32.
      await game.expectText('HEX 1b5b4d20b723');
    });
  });

  describe('when the app has not asked for mouse reports', () => {
    test('using the mouse throws, because a real terminal would send nothing', async ({ game }) => {
      await game.expectText('READY');
      await expect(game).not.toHaveMouseTracking();
      await assert.rejects(game.mouse.click(1, 1), /hasn't enabled mouse reporting/);
    });
  });
});

describe('paste', () => {
  test('without bracketed paste mode, pasted text arrives as plain input', async ({ game }) => {
    await game.expectText('READY');
    await game.paste('hello');
    await game.expectText('GOT "hello"');
  });

  describe('with bracketed paste mode on', () => {
    test.use({ args: [PROBE, 'paste'] });

    test('pasted text arrives wrapped in paste markers', async ({ game }) => {
      await game.expectText('READY');
      await expect(game).toHaveBracketedPaste();
      await game.paste('two\nlines');
      await game.expectText('GOT "\\u001b[200~two\\nlines\\u001b[201~"');
    });
  });
});

describe('terminal signals', () => {
  test.use({ args: [PROBE, 'signals'] });

  test('window title and hyperlinks', async ({ game }) => {
    await game.expectText('READY');
    await expect(game).toHaveTitle('Probe Title');
    await expect(game).toHaveHyperlink('https://example.com/docs', { text: 'the docs' });
    await expect(game).toHaveHyperlink(/example\.com/);
    await assert.rejects(
      expect(game).toHaveHyperlink('https://elsewhere.dev', { timeout: 200 }),
      /a hyperlink to "https:\/\/elsewhere\.dev"\n\s+Observed: "the docs" -> https:\/\/example\.com\/docs/,
    );
  });

  test('the bell counts only since the last input', async ({ game }) => {
    await game.expectText('READY');
    await game.press('b');
    await expect(game).toHaveBell();
    await game.press('x');
    await expect(game).not.toHaveBell({ timeout: 300 });
  });

  test('clipboard writes (OSC 52)', async ({ game }) => {
    await game.expectText('READY');
    await expect(game).not.toHaveCopied('copied text', { timeout: 200 });
    await game.press('c');
    await expect(game).toHaveCopied('copied text');
  });

  test('entering and leaving the alternate screen', async ({ game }) => {
    await game.expectText('READY');
    await expect(game).not.toBeInAltScreen();
    await game.press('a');
    await expect(game).toBeInAltScreen();
    await game.expectText('ALT SCREEN');
    await game.press('n');
    await expect(game).not.toBeInAltScreen();
    await game.expectText('the docs');
  });
});

describe('process exit and signals', () => {
  test.use({ args: [PROBE, 'exit', '3'] });

  test('expectExit checks the exit code', async ({ game }) => {
    await game.expectText('READY');
    await game.press('q');
    await expect(game).toHaveExited({ code: 3 });
    assert.deepEqual(await game.waitForExit(), { exitCode: 3, signal: null });
  });

  test('Ctrl+C in raw mode reaches the app as a byte; this one exits 130', async ({ game }) => {
    await game.expectText('READY');
    await game.press('Control+c');
    await game.expectExit({ code: 130 });
  });

  test('kill() sends a signal; expectExit can check which one ended the process', async ({ game }) => {
    await game.expectText('READY');
    game.kill('SIGTERM');
    await game.expectExit({ signal: 'SIGTERM' });
  });

  test('a mismatched exit fails with how the process actually ended', async ({ game }) => {
    await game.expectText('READY');
    await game.press('q');
    await assert.rejects(game.expectExit({ code: 0 }), /the process to exit with code 0\n\s+Observed: exit code 3/);
  });

  test('waiting for an exit that never comes times out with the usual report', async ({ game }) => {
    await game.expectText('READY');
    await assert.rejects(game.waitForExit({ timeout: 200 }), /E2E TEST FAILED[\s\S]*the process to exit/);
  });
});

describe('scrollback', () => {
  test.use({ args: [PROBE, 'log', '30'], rows: 10 });

  test('lines that scrolled off the screen are still searchable', async ({ game }) => {
    await game.expectText('READY');
    await expect(game).toHaveScrollbackText(/^line 3$/m);
    await expect(game).not.toHaveScrollbackText('line 30', { timeout: 200 });
    assert.match(game.getScrollbackText(), /^line 1\nline 2\n/);
    await game.expectText('line 30');
  });

  describe('with a smaller scrollback', () => {
    test.use({ scrollback: 5 });

    test('only the most recent lines are kept', async ({ game }) => {
      await game.expectText('READY');
      await expect(game).not.toHaveScrollbackText(/^line 3$/m, { timeout: 200 });
      assert.equal(game.getScrollbackText().split('\n').length, 5);
    });
  });
});

describe('built-in fixtures', () => {
  describe('tmpHome and homeFiles', () => {
    test.use({ args: [PROBE, 'env'], cols: 200, homeFiles: { '.config/probe/settings.json': '{"theme":"dark"}' } });

    test('the app runs with HOME set to a fresh directory seeded before launch', async ({ game, tmpHome }) => {
      await game.expectText(`HOME=${tmpHome}`);
      const fs = require('node:fs');
      const path = require('node:path');
      assert.equal(fs.readFileSync(path.join(tmpHome, '.config/probe/settings.json'), 'utf8'), '{"theme":"dark"}');
    });
  });

  test('launch() starts a second session alongside game; both are stopped afterwards', async ({ game, launch }) => {
    const other = await launch({ args: [PROBE, 'echo'] });
    await game.expectText('READY');
    await other.expectText('READY');
    await other.type('to the other one');
    await other.expectText('GOT "to the other one"');
    assert.doesNotMatch(game.getScreenText(), /to the other one/);
  });

  test('testInfo describes the running test', async ({ testInfo }) => {
    assert.equal(testInfo.title, 'testInfo describes the running test');
    assert.deepEqual(testInfo.titlePath, ['built-in fixtures', 'testInfo describes the running test']);
    assert.equal(testInfo.retry, 0);
  });
});

describe('without a terminal (tty: false)', () => {
  test.use({ args: [PROBE, 'env'], tty: false });

  test('the app sees plain pipes, and assertions still work on its output', async ({ game }) => {
    await game.expectText('isTTY=false');
    await game.expectText('TERM=(unset)');
    await expect(game.locator('READY')).toBeAt(0, 8);
  });

  describe('with input', () => {
    test.use({ args: [PROBE, 'exit', '5'] });

    test('input reaches the app through its stdin pipe', async ({ game }) => {
      await game.expectText('READY');
      await game.type('x\n');
      await expect(game).toHaveExited({ code: 5 });
    });
  });

  describe('when the app exits right after a flood of output', () => {
    test.use({ args: [PROBE, 'flood'] });

    test('the end of its output is on screen once the exit is seen', async ({ game }) => {
      await game.waitForExit();
      await game.expectText('DONE', { timeout: 1000 });
    });
  });
});

describe('expectExit', () => {
  describe('an app killed by a signal', () => {
    test.use({ args: [PROBE, 'crash'] });

    test('does not count as exiting with code 0', async ({ game }) => {
      await game.expectText('READY');
      await game.press('x');
      await assert.rejects(game.expectExit({ code: 0 }, { timeout: 2000 }), /the process to exit with code 0[\s\S]*Observed: signal 9/);
      await game.expectExit({ signal: 'SIGKILL' });
    });
  });
});
