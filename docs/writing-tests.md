# Writing tests

## The basics

A test file matches `**/*.rpg.test.js` or `**/*.rpg.test.ts` by default (configurable with `testMatch` — see [Configuration](./configuration.md#runner-options)) and imports `test`/`expect` from `rpgwright/test`:

```js
const { test, expect } = require('rpgwright/test');

test('reaches the main menu', async ({ game }) => {
  await game.expectText('Main Menu');
});
```

`test(name, fn)` registers a test. `fn` receives a fixtures object; `game` is the app, already launched for you, using whatever your `rpgwright.config.js` says to launch, before `fn` runs. (Fixtures are set up only when a test asks for them by name, so a test that doesn't destructure `game` doesn't launch the app. See [Fixtures](#fixtures).) You never call `launchGame()` yourself, and you never call `game.stop()` yourself either (unless you specifically want to inspect the exit info — see [below](#inspecting-clean-shutdown)) — `rpgwright test` starts a fresh `game` for every single test and stops it afterwards automatically, whether the test passed, failed, or timed out.

That per-test isolation is deliberate: nothing about one test's screen state, keystrokes, or process can leak into the next.

## TypeScript

Name test files `*.rpg.test.ts` and write them in TypeScript; RPGWright ships type declarations for `rpgwright` and `rpgwright/test`:

```ts
import { test, expect } from 'rpgwright/test';
import type { Viewport } from 'rpgwright/test';

test('reaches the main menu', async ({ game }) => {
  await game.expectText('Main Menu');
  await expect(game.locator('Play')).toBeFocused();
});
```

On Node 22.18 or later, `.ts` files run directly with nothing else to install: Node removes the type annotations itself. It doesn't type-check them, so run `tsc --noEmit` separately (in CI, for instance) if you want type errors to fail a build. On older Node versions, install [`tsx`](https://tsx.is) in your project and RPGWright uses it. The declarations refer to Node's own types, so a TypeScript project should have `@types/node` installed.

For type-checked config files, annotate `rpgwright.config.js` with JSDoc:

```js
/** @type {import('rpgwright/test').Config} */
module.exports = { command: 'node', args: ['bin/my-cli-app.js'] };
```

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

`describe` groups related tests and labels them in output (`settings screen > toggles sound`). It also scopes hooks and `test.use()` options to the tests inside it. `test.describe` is the same function, for those used to Playwright's spelling.

## Setup and teardown: hooks

```js
const { test, describe } = require('rpgwright/test');

test.beforeEach(async ({ game }) => {
  await game.expectText('Main Menu'); // every test starts from a ready menu
});

describe('settings screen', () => {
  test.beforeEach(async ({ game }) => {
    await game.press('ArrowDown');
    await game.press('Enter');
    await game.expectText('SETTINGS');
  });

  test('toggles sound', async ({ game }) => {
    /* starts on the settings screen */
  });
});
```

- `test.beforeEach(fn)` and `test.afterEach(fn)` run around every test in their scope, and receive the same fixtures as the test (the same `game`, for example). Outer hooks run first for `beforeEach` and last for `afterEach`. `afterEach` runs even when the test failed or timed out, before the next test starts.
- `test.beforeAll(fn)` and `test.afterAll(fn)` run once per scope, before its first test and after its last. They don't receive a `game` (each test gets its own), so use them for things like seeding a database or creating a fixture directory. If a `beforeAll` throws, every test in its scope fails with that error, without being launched. `beforeAll` and `afterAll` hooks have the same timeout as a test in their scope.

Hooks declared at the top of a file apply to every test in that file.

## Per-group options: `test.use()`

`test.use(options)` overrides any [launch option](./configuration.md#launch-options) for the tests in its scope (the whole file at top level, or one `describe`):

```js
describe('on a small terminal', () => {
  test.use({ cols: 40, rows: 12 });

  test('collapses the sidebar', async ({ game }) => {
    await game.expectText('Narrow layout');
  });
});

describe('without color', () => {
  test.use({ colorDepth: 'none' });
  /* ... */
});
```

Inner scopes override outer ones key by key, and both override `rpgwright.config.js`.

## Running a test at several terminal sizes

`test.eachViewport(name, fn)` registers one copy of the test for each size in your config's `viewports`, named after the size:

```js
// rpgwright.config.js
module.exports = {
  command: 'node',
  args: ['bin/my-cli-app.js'],
  viewports: [{ cols: 40, rows: 12 }, { cols: 80, rows: 24 }, { name: 'wide', cols: 160, rows: 50 }],
};
```

```js
test.eachViewport('the status bar stays on screen', async ({ game, viewport }) => {
  await expect(game.locator('Ready')).toBeWithinScreen();
  if (viewport.cols >= 80) {
    await expect(game.locator({ box: { containing: 'Help' } })).toBeVisible();
  }
});
```

This runs as `the status bar stays on screen [40x12]`, `[80x24]` and `[wide]`, so the report shows exactly which size failed. To use a list for just one test, pass it first: `test.eachViewport([{ cols: 30, rows: 10 }], name, fn)`.

Every test (and `beforeEach`/`afterEach` hook) can receive `viewport` (`{ name, cols, rows }`) alongside `game`: the eachViewport size, or otherwise the size the test was launched at. Failure reports always include a `Viewport:` line with the terminal's size at the moment of failure.

## Focusing, skipping and expected failures

| Call | Effect |
|---|---|
| `test.skip(name, fn)` | Don't run this test; report it as skipped. |
| `test.fixme(name, fn)` | Same as `skip`, but says the test is known-broken and should be fixed. |
| `test.only(name, fn)` | Run only the `only` tests, across every file in the run. |
| `describe.skip(name, fn)` / `describe.only(name, fn)` | The same, for a whole group. |
| `test.fail(name, fn)` | The test is expected to fail: it passes if its body throws, and fails with "Expected this test to fail" if it passes. Use it to pin a known bug, so you notice when it's fixed. |

Don't commit `test.only`: it silently skips everything else.

## Timeouts

Each test is bounded by the config's `timeout` (30 seconds by default). To change it:

```js
describe('slow import', () => {
  test.setTimeout(120000); // for every test in this group
  /* ... */
});

test('big save file', async ({ game }) => {
  test.slow(); // triples this test's timeout
  /* ... */
});
```

Called at the top of a file or `describe`, `test.setTimeout(ms)` and `test.slow()` apply to that scope. Called inside a test, they apply to that test only. `test.setTimeout(0)` disables the timeout. This is separate from `expectTimeout`, which bounds each individual assertion.

## Fixtures

Every test function receives an object of **fixtures**, and gets only the ones it destructures:

```js
test('saves settings', async ({ game, tmpHome }) => { /* ... */ });
```

| Fixture | What it is |
|---|---|
| `game` | The app, launched for this test and stopped afterwards. |
| `viewport` | `{ name, cols, rows }`: the test's terminal size. |
| `tmpHome` | A fresh empty directory, deleted after the test. A test that asks for it launches `game` with `HOME` set to it, so the app's settings and save files can't leak between tests. |
| `launch` | `launch(options)` starts another process (a second player, a server) with the config's options plus yours, stopped after the test. |
| `testInfo` | The running test: `title`, `titlePath`, `file`, `line`, `retry`, `repeatEachIndex`, `outputDir`, `timeout`. |

To put files in `tmpHome` before the app starts, use the `homeFiles` option, which also turns on the isolated home:

```js
describe('with an existing save', () => {
  test.use({ homeFiles: { '.config/my-app/save.json': JSON.stringify({ level: 3 }) } });

  test('resumes at level 3', async ({ game }) => {
    await game.expectText('Level 3');
  });
});
```

### Your own fixtures: `test.extend`

`test.extend()` returns a new `test` function whose tests can also request your fixtures:

```js
const { test: base, expect } = require('rpgwright/test');

const test = base.extend({
  // Set up, hand the value to the test with use(), then clean up.
  server: async ({}, use) => {
    const server = await startFakeServer();
    await use(server);
    await server.close();
  },
  // A fixture can use other fixtures, built-in or your own.
  loggedIn: async ({ game, server }, use) => {
    await game.type(server.username, { settle: true });
    await game.press('Enter');
    await game.expectText('Welcome');
    await use(true);
  },
});

test('shows the inbox', async ({ game, loggedIn }) => {
  await game.expectText('Inbox');
});
```

A fixture is created once per test, the first time the test or one of its hooks asks for it, after the fixtures it depends on. Cleanup runs after the test and its `afterEach` hooks, in reverse order of setup. A plain value works as a fixture too: `base.extend({ apiUrl: 'http://localhost:4000' })`. Built-in fixture names can't be redefined.

RPGWright reads which fixtures a function wants from how it's written (`async ({ game, server }) => …`), as Playwright does. If a test or hook takes its fixtures without destructuring (`async (fixtures) => …`), every fixture is set up except `tmpHome`, which changes the game's `HOME` and so is only set up when a test names it. A fixture definition must destructure the fixtures it depends on; one that doesn't gets none.

## Retries and repeated runs

Terminal apps are timing-sensitive, so a test can fail intermittently. `rpgwright test --retries 2` (or `retries: 2` in config) reruns a failed test up to twice, each time with fresh fixtures. A test that passes on a retry is reported as **flaky**:

```
  ✓ opens the inventory (flaky: passed on retry 1) (812ms)

3 passed, 1 flaky (2410ms)
```

Flaky tests still pass the run unless you add `--fail-on-flaky`. To find flakiness on purpose, `rpgwright test --repeat-each 20 menu.rpg.test.js` runs every selected test 20 times. Retries are for noticing flakiness without blocking everyone; the fix is still in the test or the app (see [Best practices](./best-practices.md)).

## Steps

`test.step(name, fn)` groups the actions inside it under a name, which makes long scenarios easier to read when one fails:

```js
test('new game', async ({ game }) => {
  await test.step('create a character', async () => {
    await game.type('Aria', { settle: true });
    await game.press('Enter');
    await game.expectText('Choose a class');
  });
  await test.step('enter the dungeon', async () => {
    /* ... */
  });
});
```

The failure report's action list then shows each step with its actions indented beneath it (for every process the test has started, `game` and `launch()` alike). `test.step` returns whatever `fn` returns. `test.info()` returns the running test's details (`title`, `titlePath`, `file`, `line`, `timeout`).

## Driving the app: `press` and `type`

```js
await game.press('ENTER');
await game.press('ArrowDown');
await game.press('Control+c');
await game.type('hello world');
```

`press(key)` sends a named key (`ENTER`, `ESCAPE`, `TAB`, `BACKSPACE`, `DELETE`, arrow keys, `SPACE`, `HOME`/`END`, `PAGEUP`/`PAGEDOWN`, `F1`–`F12`), a single character, or a chord like `'Shift+Tab'` — see [Key sequences](./key-sequences.md). `type(text)` sends literal characters, for text-input fields. Both resolve as soon as the bytes are written; they don't wait for the app to react. Waiting is `expectText`'s job — see [Assertions](./assertions.md).

For anything no key name or chord produces, `press.raw(bytes)` sends a literal byte sequence:

```js
await game.press.raw('\x1b[13;5u'); // an extended-keyboard-protocol Ctrl+Enter, for example
```

### A note on rapid keystrokes

Don't fire several `press()`/`type()` calls back to back with nothing in between. Either confirm each keystroke's on-screen effect before sending the next one, or pass `{ settle: true }`, which waits after the write until the screen has stopped changing (150ms with no update; pass a number of milliseconds instead of `true` to change that):

```js
await game.type('2', { settle: true });
await game.press('ENTER');
```

Confirming with `expectText` is still the better choice when there's a specific change to wait for, because it also checks the change happened:

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

`{ settle: true }` works here too: `await game.type('42', { settle: true })`.

Plain typed text is more exposed to this than named keys like arrows or function keys: an escape sequence (`\x1b[...`) is self-delimiting, so a well-behaved input parser can usually split several of them correctly even from one merged chunk, but a run of plain characters has no such structure — there's no way to tell "42" followed by Enter apart from someone pasting the literal text `"42\r"`, and an app whose input handling doesn't specifically guard against multi-character paste input can end up appending the raw `\r` into whatever it's building, rather than treating it as a submit.

### Pasting

`game.paste(text)` sends text the way a terminal sends a paste. If the app has turned on bracketed paste mode, the text is wrapped in the paste markers (`ESC[200~` … `ESC[201~`) so the app can tell it apart from typing. Otherwise it's sent as plain input, as a real terminal would.

```js
await game.paste('line one\nline two');
```

### The mouse

If your app reads mouse input, `game.mouse` sends real mouse reports in whichever encoding the app asked for:

```js
await game.mouse.click(10, 3);                          // left click at column 10, row 3 (0-based)
await game.mouse.click(10, 3, { button: 'right' });
await game.mouse.click(10, 3, { clickCount: 2 });       // double click
await game.mouse.wheel(10, 3, { deltaY: -3 });          // three notches up
await game.mouse.drag({ x: 2, y: 5 }, { x: 20, y: 5 });
await game.mouse.move(4, 4);
await game.locator('OK').click();                       // the center of a region
await game.locator({ box: { containing: 'Help' } }).hover();
```

Buttons are `'left'`, `'middle'` and `'right'`; `modifiers` is a list of `'shift'`, `'alt'`, `'ctrl'`. Like a real terminal, RPGWright only sends what the app's mouse mode covers: some modes report clicks but not movement, for example. An event the mode doesn't cover is recorded in the action list as "not reported" rather than sent. If the app hasn't turned on mouse reporting at all, the call throws; wait for it with `await expect(game).toHaveMouseTracking()`. Pass `{ settle: true }` to wait for the screen to settle after each event.

### Without a terminal

Many CLIs behave differently when their output isn't a terminal: no colors, no spinners, no interactive prompts. To test that path, set `tty: false` (with `test.use()` or in config). The app then runs with plain pipes, sees `process.stdout.isTTY === false`, and everything it prints is still checked with the same assertions:

```js
describe('when piped', () => {
  test.use({ tty: false });

  test('prints plain progress lines instead of a spinner', async ({ game }) => {
    await game.expectText('Downloading... done');
  });
});
```

### Signals and exiting

```js
await game.press('Control+c');               // Ctrl+C as a keystroke (what a user presses)
game.kill('SIGTERM');                         // a signal sent to the process directly
await expect(game).toHaveExited({ code: 130 });
await game.expectExit({ signal: 'SIGTERM' });
const { exitCode, signal } = await game.waitForExit();
```

`toHaveExited({ code, signal })` waits for the process to end and checks how it ended; give either or both. In raw mode, which most interactive apps use, Ctrl+C arrives as an ordinary byte rather than a signal, so `press('Control+c')` tests what your app does with that keystroke, while `kill('SIGINT')` tests its signal handler.

## Asserting: two equivalent styles

Every assertion is available directly on `game` (`game.expectText(...)`), and as `expect(...).toX()` sugar over the exact same method:

```js
await game.expectText('Main Menu');
// is equivalent to:
await expect(game).toHaveText('Main Menu');
```

Use whichever reads better in context — `expect(game).not.toHaveText(...)` reads naturally for a negative assertion, for instance. See [Assertions](./assertions.md) for the full set (`expectText`/`toHaveText`, `expectNotText`/`not.toHaveText`, `expectScreen`/`toMatchScreen`+`toMatchScreenSnapshot`, `expectState`/`toHaveState`) with real examples of each.

To assert on *where* something is or *how it's drawn*, pass a locator to `expect` instead of `game`:

```js
await expect(game.locator({ box: { containing: 'INFO' } })).toBeRightOf(game.locator({ box: { containing: 'Quit' } }));
```

See [Layout and focus](./layout-and-focus.md).

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

A single `rpgwright.config.js` sets what every test launches by default. `test.use({ command, args })` (see [above](#per-group-options-testuse)) overrides it for a file or `describe` block, so one config can cover several entry points of the same project. For separate applications with different settings throughout, give each its own config and test directory, and run `rpgwright test --config path/to/each/rpgwright.config.js` separately for each — see [Configuration](./configuration.md) and [CLI reference](./cli.md#options).

## Escape hatch: using `GameDriver` outside the bundled runner

Everything above is sugar over `launchGame()`, exported from RPGWright's core entry point. If you need to embed RPGWright in an existing Vitest/Jest/Mocha/`node:test` suite instead of adopting `rpgwright test`, you can — call `launchGame()` and `stop()` yourself:

```js
const { launchGame } = require('rpgwright');

const game = await launchGame({ command: 'node', args: ['bin/my-cli-app.js'] });
await game.expectText('Main Menu');
await game.stop();
```

The bundled runner is what's tested and recommended; outside it you manage launching, stopping and timeouts yourself.

The core package also exports the lower-level pieces RPGWright is built from, for tools built on top of it:

| Export | What it is |
|---|---|
| `spawnPty(options)` / `spawnPipe(options)` | Start a process in a pseudo-terminal, or with plain pipes; both return the same small handle (`onData`, `write`, `resize`, `kill`, `waitForExit`). |
| `createVirtualTerminal({ cols, rows })` | The headless terminal emulator that turns output into a screen (`write`, `getScreenText`, `getScreenCells`, `getCursor`, ...). |
| `KEY_SEQUENCES`, `resolveKey(key)` | The named-key table, and the function that turns a key name or chord into bytes. |
| `encodeMouse(event, encoding)` | The bytes a terminal sends for a mouse event. |
| `renderScreenHtml(cells, options)` | A screen's cells drawn as an HTML page. |
