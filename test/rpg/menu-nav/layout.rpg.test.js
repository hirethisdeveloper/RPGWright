'use strict';

const assert = require('node:assert/strict');
const { test, describe, expect } = require('rpgwright/test');

// The fixture's menu screen: a centered title, the menu in a rounded box,
// an INFO side panel (>= 60 columns only), and a right-aligned build label.

test.beforeEach(async ({ game }) => {
  await game.expectText('build 42');
});

describe('narrow terminal (config default, 40x12)', () => {
  test('the title is centered and the build label is flush right', async ({ game }) => {
    await expect(game.locator('MENU NAV APP')).toBeAligned('center');
    await expect(game.locator('build 42')).toBeAligned('right');
    await expect(game.locator('build 42')).toFitWithoutClipping();
  });

  test('the menu box sits under the title, inside the screen, holding every option left-aligned', async ({ game }) => {
    const menu = game.locator({ box: { containing: 'Quit' } });
    await expect(menu).toHaveBox({ x: 0, y: 1, height: 5 });
    await expect(menu).toBeWithinScreen();
    await expect(menu).toBeBelow(game.locator('MENU NAV APP'));
    for (const option of ['Play', 'Settings', 'Quit']) {
      await expect(game.locator(option)).toBeWithin(menu);
    }
    await expect(game.locator('Settings')).toBeAligned('left', { with: game.locator('Quit') });
    await expect(game.locator('Settings')).toHaveGap(game.locator('Quit'), { min: 0, max: 0 });
  });

  test('there is no side panel, and only one box', async ({ game }) => {
    await expect(game.locator({ box: { containing: 'INFO' } })).not.toBeVisible();
    await expect(game.locator({ box: true })).toHaveCount(1);
  });

  test('a locator scoped to the menu box ignores matching text outside it', async ({ game }) => {
    const menu = game.locator({ box: { containing: 'Quit' } });
    // "arrow keys" appears in the help line, outside the box.
    await expect(game.locator('arrow keys')).toBeVisible();
    await expect(menu.locator('arrow keys')).toHaveCount(0);
    await expect(menu).toHaveText('Settings');
    await expect(menu).not.toHaveText('arrow keys');
  });
});

describe('wide terminal (80x20)', () => {
  test.use({ cols: 80, rows: 20 });

  test('the INFO panel sits to the right of the menu, top-aligned, two cells away, without overlapping', async ({ game }) => {
    const menu = game.locator({ box: { containing: 'Quit' } });
    const info = game.locator({ box: { containing: 'INFO' } });
    await expect(info).toBeVisible();
    await expect(info).toBeRightOf(menu);
    await expect(info).not.toOverlap(menu);
    await expect(info).toBeAligned('top', { with: menu });
    await expect(info).toHaveGap(menu, { min: 2, max: 2 });
    await expect(info).toHaveBox({ width: 20 });
    await expect(game.locator({ box: true })).toHaveCount(2);
  });

  test('the title stays centered on the wider screen', async ({ game }) => {
    await expect(game.locator('MENU NAV APP')).toBeAligned('center');
    await expect(game.locator('MENU NAV APP')).toHaveBox({ x: 34, y: 0 });
  });

  test('the panel follows the selection, so a waiting layout assertion sees the redraw', async ({ game }) => {
    const info = game.locator({ box: { containing: 'INFO' } });
    await game.press('ArrowDown');
    await expect(info).toHaveText('Selected: Settings');
  });
});

test('resizing narrow -> wide -> narrow adds and removes the side panel', async ({ game }) => {
  const info = game.locator({ box: { containing: 'INFO' } });
  await expect(info).not.toBeVisible();
  await game.resize(80, 20);
  await expect(info).toBeVisible();
  await game.resize(40, 12);
  await expect(info).not.toBeVisible();
});

describe('layout assertions that should fail', () => {
  test('a false relation fails with the standard report, including what was observed', async ({ game }) => {
    await assert.rejects(
      expect(game.locator('build 42')).toBeAbove(game.locator('MENU NAV APP'), { timeout: 300 }),
      (err) => {
        assert.match(err.message, /E2E TEST FAILED/);
        assert.match(err.message, /Expected:\n  locator\("build 42"\) to be above locator\("MENU NAV APP"\)\n  Observed: at \(x=32, y=9, 8×1\); other at \(x=14, y=0, 12×1\)/);
        assert.match(err.message, /expect\(locator\("build 42"\)\.toBeAbove\(locator\("MENU NAV APP"\)/);
        return true;
      },
    );
  });

  test('an ambiguous locator fails rather than silently picking one match', async ({ game }) => {
    await assert.rejects(
      expect(game.locator(/[│╭╰]/)).toBeWithinScreen({ timeout: 300 }),
      /matched \d+ regions[\s\S]*use \.first\(\), \.last\(\) or \.nth\(i\)/,
    );
    await expect(game.locator(/[│╭╰]/).first()).toBeAt(0, 1);
  });

  test('a negated check still fails when its locator matches nothing', async ({ game }) => {
    await assert.rejects(
      expect(game.locator('No such text')).not.toOverlap(game.locator('Play'), { timeout: 300 }),
      /matched nothing/,
    );
  });
});

describe('focus', () => {
  const options = (game) => game.locator(/Play|Settings|Quit/);

  test('the highlight follows the arrow keys, with exactly one option focused at a time', async ({ game }) => {
    await expect(game.locator('Play')).toBeFocused();
    await expect(options(game)).toHaveExactlyOneFocused();

    await game.press('ArrowDown');
    await expect(game.locator('Settings')).toBeFocused();
    await expect(game.locator('Play')).not.toBeFocused();
    await expect(options(game)).toHaveExactlyOneFocused();

    await game.press('ArrowDown');
    await expect(game.locator('Quit')).toBeFocused();
    assert.deepEqual(
      game.getFocused(options(game)).map((r) => [r.x, r.y]),
      [[3, 4]],
    );
  });

  test('the focused option is drawn inverse and cyan; the others are plain', async ({ game }) => {
    await expect(game.locator('Play')).toHaveStyle({ inverse: true, fg: 'cyan' });
    await expect(game.locator('Settings')).toHaveStyle({ inverse: false, fg: null });
  });

  describe('with a marker as the focus indicator', () => {
    test.use({ focus: { marker: '> ' } });

    test('the "> " prefix identifies the focused option', async ({ game }) => {
      await expect(game.locator('Play')).toBeFocused();
      await game.press('ArrowUp');
      await expect(game.locator('Quit')).toBeFocused();
      await expect(options(game)).toHaveExactlyOneFocused();
    });
  });

  describe('without color (colorDepth: none)', () => {
    test.use({ colorDepth: 'none' });

    test('the inverse highlight disappears, so focus has to come from the marker', async ({ game }) => {
      await expect(game.locator('Play')).toHaveStyle({ inverse: false, fg: null });
      await expect(game.locator('Play')).not.toBeFocused();
      await expect(game.locator('Play')).toBeFocused({ marker: '> ' });
    });
  });

  test('focus assertions fail with the indicators that were checked and what was found', async ({ game }) => {
    await assert.rejects(
      expect(game.locator('Quit')).toBeFocused({ timeout: 300 }),
      /to be focused \(by style \{inverse=true\} or cursor\)\n\s+Observed: at \(x=3, y=4, 4×1\); no focus indicator present; cursor at \(\d+, \d+\) hidden/,
    );
    await assert.rejects(
      expect(options(game)).toHaveExactlyOneFocused({ style: { bold: true }, timeout: 300 }),
      /to have exactly one focused match \(by style \{bold=true\}\)\n\s+Observed: 3 matches, 0 focused/,
    );
    await assert.rejects(
      expect(game.locator('Settings')).toHaveStyle({ inverse: true }, { timeout: 300 }),
      /Observed: at \(x=3, y=3, 8×1\); cell \(3, 3\) "S" has fg=default, bg=default/,
    );
  });
});

describe('every configured viewport', () => {
  test.eachViewport('the title stays centered, the label flush right, everything on screen', async ({ game }) => {
    await expect(game.locator('MENU NAV APP')).toBeAligned('center');
    await expect(game.locator('build 42')).toBeAligned('right');
    await expect(game.locator({ box: { containing: 'Quit' } })).toBeWithinScreen();
    await expect(game.locator('build 42')).toFitWithoutClipping();
  });

  test.eachViewport('the INFO panel appears exactly when there are at least 60 columns', async ({ game, viewport }) => {
    const info = game.locator({ box: { containing: 'INFO' } });
    if (viewport.cols >= 60) {
      await expect(info).toBeVisible();
      await expect(info).toBeWithinScreen();
    } else {
      await expect(info).not.toBeVisible();
    }
  });

  test.eachViewport([{ cols: 40, rows: 12 }], 'a failure names the viewport it happened at', async ({ game }) => {
    await assert.rejects(expect(game.locator('build 42')).toBeAt(0, 0, { timeout: 200 }), /Scenario: .*\[40x12\]\nViewport: 40x12\n/);
  });
});
