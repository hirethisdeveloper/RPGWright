# Assertions

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

The first time this runs, there's nothing to compare against yet, so the current screen is recorded to `<snapshotsDir>/main-menu.snap` and the assertion passes immediately. Every run after that compares the live screen against what was recorded, waiting (same as any other assertion) until it matches or `timeout` elapses. To intentionally re-record a snapshot after a real UI change, either delete the `.snap` file, pass `{ updateSnapshot: true }`, or set `RPGWRIGHT_UPDATE_SNAPSHOTS=1` in the environment.

`snapshotsDir` defaults to `<cwd>/__snapshots__` — configurable per [Configuration](./configuration.md). Commit your `__snapshots__` directory to version control, same as you would with Jest or Vitest snapshots — it's the reference your tests compare against.

Options: `{ timeout }` (and `{ updateSnapshot }` for snapshot mode).

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
