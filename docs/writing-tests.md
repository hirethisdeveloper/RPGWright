# Writing tests

## The basics

A test file matches `**/*.rpg.test.js` by default (configurable — see [Configuration](./configuration.md#testmatch)) and imports `test`/`expect` from `rpgwright/test`:

```js
const { test, expect } = require('rpgwright/test');

test('reaches the main menu', async ({ game }) => {
  await game.expectText('Main Menu');
});
```

`test(name, fn)` registers a test. `fn` receives a fixtures object with one property, `game` — already launched for you, using whatever your `rpgwright.config.js` says to launch, before `fn` runs. You never call `launchGame()` yourself, and you never call `game.stop()` yourself either (unless you specifically want to inspect the exit info — see [below](#inspecting-clean-shutdown)) — `rpgwright test` starts a fresh `game` for every single test and stops it afterwards automatically, whether the test passed, failed, or timed out.

That per-test isolation is deliberate: nothing about one test's screen state, keystrokes, or process can leak into the next.

## Grouping tests

```js
const { test, describe } = require('rpgwright/test');

describe('settings screen', () => {
  test('toggles sound', async ({ game }) => {
    /* ... */
  });

  test('returns to the main menu on Escape', async ({ game }) => {
    /* ... */
  });
});
```

`describe` is for organizing related tests and labeling them in output (`settings screen > toggles sound`) — it doesn't add its own setup/teardown hooks. Use `test.skip(name, fn)` to temporarily disable a test without deleting it.

## Driving the app: `press` and `type`

```js
await game.press('ENTER');
await game.press('ARROWDOWN');
await game.type('hello world');
```

`press(key)` sends a named key from the built-in table (`ENTER`, `ESCAPE`, `TAB`, `BACKSPACE`, `DELETE`, arrow keys, `SPACE`, `CTRL_C`, `CTRL_D`, `HOME`/`END`, `PAGEUP`/`PAGEDOWN`, `F1`–`F12`) — see [Configuration](./configuration.md#keys) for extending the table with your own. `type(text)` sends literal characters, for text-input fields. Both resolve as soon as the bytes are written; they don't wait for the app to react. Waiting is `expectText`'s job — see [Assertions](./assertions.md).

For anything not in the key table, `press.raw(bytes)` sends a literal byte sequence:

```js
await game.press.raw('\x1b[1;5C'); // Ctrl+Right, for example
```

### A note on rapid keystrokes

Confirm each keystroke's on-screen effect before sending the next one, rather than firing several `press()`/`type()` calls back to back with no `expectText`/`expect` in between:

```js
// Prefer this:
await game.press.raw(' ');
await game.expectText('Score: 1');
await game.press.raw(' ');
await game.expectText('Score: 2');

// Not this — the OS can coalesce rapid consecutive writes into a single
// read on the target process, and many apps (Ink included) treat a
// multi-character chunk as one "paste" event rather than N keystrokes:
await game.press.raw(' ');
await game.press.raw(' ');
```

This mirrors how a real player interacts with the app anyway (press, look at the screen, press again) — it isn't an RPGWright-specific workaround.

**This applies to `type()` immediately followed by `press('ENTER')` too** — a very common pattern ("type some text, press Enter to submit") that's easy to overlook because it reads as one action even though it's two writes:

```js
// Prefer this:
await game.type('42');
await game.expectText('42'); // confirm the typed text actually landed
await game.press('ENTER');

// Not this:
await game.type('42');
await game.press('ENTER');
```

Plain typed text is more exposed to this than named keys like arrows or function keys: an escape sequence (`\x1b[...`) is self-delimiting, so a well-behaved input parser can usually split several of them correctly even from one merged chunk, but a run of plain characters has no such structure — there's no way to tell "42" followed by Enter apart from someone pasting the literal text `"42\r"`, and an app whose input handling doesn't specifically guard against multi-character paste input can end up appending the raw `\r` into whatever it's building, rather than treating it as a submit.

## Asserting: two equivalent styles

Every assertion is available directly on `game` (`game.expectText(...)`), and as `expect(...).toX()` sugar over the exact same method:

```js
await game.expectText('Main Menu');
// is equivalent to:
await expect(game).toHaveText('Main Menu');
```

Use whichever reads better in context — `expect(game).not.toHaveText(...)` reads naturally for a negative assertion, for instance. See [Assertions](./assertions.md) for the full set (`expectText`/`toHaveText`, `expectNotText`/`not.toHaveText`, `expectScreen`/`toMatchScreen`+`toMatchScreenSnapshot`, `expectState`/`toHaveState`) with real examples of each.

## Reading the screen directly

```js
const text = game.getScreenText(); // synchronous, current visible screen only
```

An escape hatch for ad hoc checks outside the built-in assertions — for example, printing the screen while debugging a new test.

## Inspecting clean shutdown

If you want to assert the app actually exits cleanly (rather than just letting the runner's automatic cleanup handle it silently), call `stop()` yourself — it's safe to call more than once:

```js
const assert = require('node:assert/strict');

test('quits cleanly from the main menu', async ({ game }) => {
  await game.expectText('Main Menu');
  await game.type('3'); // "Quit"
  const exitInfo = await game.stop();
  assert.equal(exitInfo.exitCode, 0);
});
```

RPGWright's `expect()` is intentionally thin — it wraps `GameDriver`'s own methods (see [Assertions](./assertions.md)), not a general-purpose assertion library with matchers like `toBe`/`toEqual`. For plain value checks like the one above, reach for Node's built-in `assert`/`assert/strict`, as shown.

## Per-test overrides and multiple target apps

A single `rpgwright.config.js` launches one `command` for every test in the files it covers. If you need to test more than one target application, give each its own config and test directory, and run `rpgwright test --config path/to/each/rpgwright.config.js` separately for each — see [Configuration](./configuration.md) and [CLI reference](./cli.md#--config-path).

## Escape hatch: using `GameDriver` outside the bundled runner

Everything above is sugar over `launchGame()`, exported from RPGWright's core entry point. If you need to embed RPGWright in an existing Vitest/Jest/Mocha/`node:test` suite instead of adopting `rpgwright test`, you can — call `launchGame()` and `stop()` yourself:

```js
const { launchGame } = require('rpgwright');

const game = await launchGame({ command: 'node', args: ['bin/my-cli-app.js'] });
await game.expectText('Main Menu');
await game.stop();
```

This path is unsupported and undocumented beyond this note — the bundled runner is what's tested and recommended.
