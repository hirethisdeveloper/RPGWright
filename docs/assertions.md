# Assertions

This page covers the screen-level assertions. For assertions about where things are and how they're drawn (position, alignment, overlap, style, focus), see [Layout and focus](./layout-and-focus.md).

Every assertion in RPGWright waits: it checks immediately, and if the condition isn't true yet, it keeps checking every time the screen actually updates — never a fixed `sleep()`. If the condition never becomes true, it fails with a complete diagnostic report (see [CLI reference](./cli.md#output)) once its timeout elapses. Each method is available both as `game.expectX(...)` and as `expect(game).toX(...)` sugar over the identical call — pick whichever reads better.

## `expectText` / `toHaveText`

The assertion you'll use the most: does this text appear anywhere on the current screen?

```js
await game.expectText('Main Menu');
// or:
await expect(game).toHaveText('Main Menu');
```

Accepts a string (substring match) or a `RegExp` (tested against the full screen text):

```js
await game.expectText(/Score: \d+/);
```

Options: `{ timeout }` (ms, defaults to your config's `expectTimeout`).

## `expectNotText` / `not.toHaveText`

Confirms text is **not** present — and stays that way for a short confirmation window (`holdFor`, default 500ms), not just absent at the exact instant you call it:

```js
await game.press('ENTER'); // toggles a setting off
await expect(game).not.toHaveText('Sound: ON');
await expect(game).toHaveText('Sound: OFF');
```

That confirmation window matters: `press()` resolves before the target app has had any chance to react, so the text you're expecting to disappear is, by construction, still on screen the instant `press()` returns. `expectNotText` handles that correctly — it doesn't fail just because the text was present a moment ago; it waits for it to actually go away and stay gone. It *does* fail if the text reappears partway through the confirmation window (a delayed/racy appearance), and it's still bounded overall by `timeout`.

Options: `{ timeout, holdFor }`.

## `expectScreen` / `toMatchScreen` + `toMatchScreenSnapshot`

Whole-screen assertions, for when you want to check more than "does this text appear somewhere."

**String matcher — exact equality**, not substring:

```js
await expect(game).toMatchScreen('MENU\n> Play\n  Settings\n  Quit');
```

Useful for asserting there's *nothing else* unexpected on screen — something `expectText`'s substring check can't do.

**RegExp matcher** — behaves like `expectText`, matches anywhere, but as a whole-screen assertion:

```js
await expect(game).toMatchScreen(/MENU[\s\S]*Quit/);
```

**Snapshot mode** — Jest/Vitest-style compare-and-store:

```js
await expect(game).toMatchScreenSnapshot('main-menu');
```

The first time this runs, there's nothing to compare against yet, so the screen is recorded to `<snapshotsDir>/main-menu.snap` and the assertion passes. Before recording, it waits until the screen has stopped changing for 150ms, so an animation or a redraw in progress can't end up in the snapshot (pass `{ stable: false }` to record immediately). Every run after that compares the live screen against what was recorded, waiting (same as any other assertion) until it matches or `timeout` elapses.

To intentionally re-record snapshots after a real UI change, run `rpgwright test --update-snapshots` (see [CLI reference](./cli.md#options)), delete the `.snap` file, pass `{ updateSnapshot: true }`, or set `RPGWRIGHT_UPDATE_SNAPSHOTS=1` in the environment.

`snapshotsDir` defaults to `<cwd>/__snapshots__` — configurable per [Configuration](./configuration.md). Commit your `__snapshots__` directory to version control, same as you would with Jest or Vitest snapshots — it's the reference your tests compare against.

When a snapshot (or an exact string match) fails, the report includes a row-by-row diff, with `^` under the characters that changed:

```
Diff (- expected, + actual):
                  MENU NAV APP
    ╭───────────╮
  - │> Play     │
  + │  Play     │
     ^
  - │  Settings │
  + │> Settings │
     ^
```

#### Styled snapshots

A plain snapshot records only text, so it can't tell a highlighted menu item from a plain one. Pass `{ styles: true }` to also record how the screen is drawn:

```js
await expect(game).toMatchScreenSnapshot('main-menu', { styles: true });
```

This writes `main-menu.styles.snap` next to `main-menu.snap`, one line per run of identically styled cells:

```
2:1+1 fg=6 inverse
2:3+4 fg=6 inverse
9:32+5 dim
```

Each line is `row:column+width` followed by the style: `fg=`/`bg=` (a palette index or `#rrggbb`) and any of `bold`, `dim`, `italic`, `underline`, `inverse`, `strike`. Unstyled cells aren't listed. On a space, only the background, `inverse` and `underline` are recorded, because a space's text color and boldness don't show. A style difference appears in the failure report's diff as `-`/`+` lines.

#### Volatile content: `mask`, `normalize`, `maxDiffCells`

Clocks, random IDs and version numbers make a snapshot fail on every run. Keep them out:

```js
await expect(game).toMatchScreenSnapshot('status-bar', {
  mask: [/\d\d:\d\d:\d\d/, game.locator({ box: { containing: 'Session' } })],
  normalize: (text) => text.replace(/v\d+\.\d+\.\d+/, 'vX.Y.Z'),
});
```

- **`mask`**: a list of strings, RegExps, locators or `{ x, y, width, height }` rectangles. Every cell they cover is replaced with `*` before recording or comparing, in both the text and the styles. Masking keeps the length, so the layout around the masked content is still checked.
- **`normalize(text)`**: a function applied to the screen text before recording or comparing.
- **`maxDiffCells`**: how many cells may differ (a different character, or with `styles`, a different style) and still pass. Use it sparingly: it hides real changes too.

`mask` and `normalize` also apply to `toMatchScreen` with a string or RegExp.

Options: `{ timeout }`, and for snapshot mode also `{ updateSnapshot, styles, mask, normalize, maxDiffCells, stable }`.

## `expectState` / `toHaveState`

For asserting on state that isn't visible on screen at all — a database row, a file your app writes, anything you can fetch independently:

```js
await expect(game).toHaveState(
  async () => JSON.parse(fs.readFileSync('game-state.json', 'utf8')),
  (state) => state.score === 3,
);
```

You provide both halves: how to fetch the current state (`getState`, an async function), and what "correct" looks like (`matcher`, a plain predicate over whatever `getState` returns). RPGWright has no built-in notion of "state" beyond that — this is a wait-and-retry wrapper, not a database client. Unlike the other assertions, this one polls (`pollInterval`, default 100ms) rather than reacting to terminal updates, since there's no terminal event tied to an arbitrary external state change.

Options: `{ timeout, pollInterval }`.

## `expectSeen`

Like `expectText`, but it also passes if the text appeared at any point since your last `press()`, `type()` or `resize()`, even if it has since been replaced:

```js
await game.press('s');
await game.waitForStable();      // ...the "Saved!" toast has already gone
await game.expectSeen('Saved!');  // still passes
```

`expectText` only ever looks at the current screen, so a message that flashes up and disappears before you check for it can't be caught that way. RPGWright keeps a history of recent screens (the last 500 by default; see `historySize` in [Configuration](./configuration.md)), and `expectSeen` searches it. Pass `{ since: 'start' }` to search every retained screen instead of only those since the last input. Like every assertion, it also waits for the text to appear if it hasn't yet.

Options: `{ timeout, since }`.

## `expectNoFlicker`

Waits for the screen to settle after your last input, then fails if, along the way, the screen went completely blank between two drawn screens:

```js
await game.press('Tab');
await game.expectNoFlicker();
```

That blank flash is what users see as flicker: an app that clears the screen in one write and draws the new one in another. Drawing the new screen in a single write (or clearing and drawing together) avoids it. This assertion only detects whole-screen blanking, not partial redraws.

Options: `{ quiet, timeout }`.

## `waitForStable`

Waits until the screen has stopped changing: no update for `quiet` ms (default 150).

```js
await game.press('Enter');
await game.waitForStable();           // the loading spinner has finished
await expect(game).toMatchScreenSnapshot('results');
```

Use it before a snapshot or any whole-screen check on an app that animates, and when there's no particular text to wait for. It fails with the usual report if the screen is still changing when `timeout` elapses, for example a spinner that never stops. When there *is* text to wait for, `expectText` is the stronger check.

`press()`, `press.raw()` and `type()` accept `{ settle: true }` (or `{ settle: ms }`) to do the same wait right after writing. See [Writing tests](./writing-tests.md#a-note-on-rapid-keystrokes).

Options: `{ quiet, timeout }`.

## Terminal state

Some of what an app does doesn't appear in the screen's text. These assertions check it, and like the others they wait and have `not.` forms:

| Assertion | Passes when |
|---|---|
| `toBeInAltScreen()` | the app is using the alternate screen (full-screen apps switch to it so the shell's history is restored when they exit) |
| `toHaveTitle(text)` | the window title (set with OSC 0/2) matches a string or RegExp |
| `toHaveBell()` | the terminal bell has rung since your last input |
| `toHaveMouseTracking(mode?)` | the app has turned on mouse reporting, optionally a specific mode: `'x10'`, `'vt200'`, `'drag'` or `'any'` |
| `toHaveBracketedPaste()` | the app has turned on bracketed paste mode |
| `toHaveHyperlink(url, { text })` | the app has printed a clickable link (OSC 8) to `url`, optionally with link text `text` (each a string or RegExp) |
| `toHaveCopied(text)` | the app has copied `text` to the clipboard through the terminal (OSC 52) |
| `toHaveScrollbackText(text)` | `text` has scrolled off the top of the screen into the scrollback |
| `toHaveExited({ code, signal })` | the process has ended, with that exit code and/or signal (`'SIGINT'` or a number); `code` only matches a process that exited on its own, not one killed by a signal |

```js
await expect(game).toHaveTitle('My App — Inventory');
await expect(game).toHaveHyperlink('https://example.com/docs', { text: 'the docs' });
await game.press('q');
await expect(game).toHaveExited({ code: 0 });
```

`toHaveScrollbackText` is for apps that print a log rather than drawing a full screen. `game.getScrollbackText()` reads the scrollback directly, and `scrollback` in [Configuration](./configuration.md) sets how many lines are kept. `game.getModes()` returns every mode at once.

## Method forms

Every `expect(...)` matcher calls a `game` method you can also call directly. The screen-level ones are named after the matcher (`expectText`, `expectScreen`, ...). The rest go through a few general methods:

| `expect(...)` matcher | Method |
|---|---|
| layout, style and focus matchers on a locator | `game.expectLayout(locator, 'toBeLeftOf', [other], { not, timeout })` |
| `toHaveCount`, `toBeVisible` | `game.expectCount(locator, n, { timeout })` |
| `toHaveExactlyOneFocused` | `game.expectFocusGroup(locator, indicators, { timeout })` |
| `toHaveCursorAt`, `toHaveCursorVisible` | `game.expectCursorAt({ x, y } \| locator)`, `game.expectCursorVisible(visible)` |
| terminal-state matchers | `game.expectTerminal('toHaveTitle', [title], { not, timeout })` |
| `toHaveExited` | `game.expectExit({ code, signal })` |

The `expect` forms read better and are what the rest of these docs use.

## Diagnostics

None of the above need a diagnostics hook to work, but if your app writes structured logs, wire them into every failure report with `getDiagnostics` in your config:

```js
module.exports = {
  command: 'node',
  args: ['bin/my-cli-app.js'],
  getDiagnostics: async () => {
    const fs = require('fs');
    try {
      return fs.readFileSync('logs/error.log', 'utf8').slice(-2000);
    } catch {
      return '(no error log present)';
    }
  },
};
```

Called once, only when a test actually fails, and its return value is appended verbatim to the failure report's `Diagnostics:` section. Without one configured, the report says so explicitly rather than showing a blank field — worth remembering that a PTY merges stdout and stderr into a single stream by construction, so the process's raw output is already visible in the report's `Current screen:` section either way.
