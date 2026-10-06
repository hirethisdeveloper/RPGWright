# Best practices

## Simulate the player, not the internals

Interact through `press()`/`type()` (real keystrokes) and assert through rendered screen text. Reaching into your app's internal state to force a transition defeats the purpose of an end-to-end test — it can pass even when a real player, typing real keys, would be stuck. `expectState` exists for *verifying the consequences* of an interaction (a database row changed, a file was written) — never for shortcutting *causing* one.

## Assert against what's actually on screen, not what you assume is there

Found integrating RPGWright against a real game: a test asserted `expectText('Create Character')`, matching the screen title's prop string in the source code — and failed, because the UI component rendered it as `[ CREATE CHARACTER ]` (uppercased, wrapped in brackets, for a consistent visual style). Nothing was wrong with the app or with RPGWright; the test's assumption was wrong.

This is easy to hit with any styled TUI — a title bar that uppercases, an input field that truncates, a status line that pads or right-aligns. Before asserting on text you haven't seen rendered, dump the real screen once:

```js
await game.expectText('Loading'); // something you're already confident about
console.log(game.getScreenText());
```

...and copy what you actually see, rather than what the component's prop or variable name suggests it should say.

## Confirm each action's effect before sending the next one

`press()`/`type()` resolve as soon as their bytes are written — they don't wait for the app to react. Two calls fired back to back with nothing in between race the target app's own processing:

```js
// Fragile:
await game.type('42');
await game.press('ENTER');

// Reliable:
await game.type('42');
await game.expectText('42'); // confirm it actually landed first
await game.press('ENTER');

// Also reliable, when there's nothing specific to confirm:
await game.type('42', { settle: true }); // waits until the screen stops changing
await game.press('ENTER');
```

This isn't paranoia — the OS can genuinely coalesce two rapid writes into a single read on the target process, and many input-handling libraries (Ink's `useInput` included) treat a multi-character chunk as one pasted string rather than N separate keystrokes. Plain typed text is more exposed to this than named keys like arrow keys or function keys, which are usually self-delimiting escape sequences a parser can split correctly even from a merged chunk. See [Writing tests](./writing-tests.md#a-note-on-rapid-keystrokes) for the concrete failure mode.

## Isolate side effects your app depends on

RPGWright has no concept of your app's database, filesystem state, or any other external dependency (see the [intro](./intro.md) — that's the consuming project's responsibility). If your app persists to a real database, point it at a disposable one for tests via `env`, rather than letting test runs pollute real data:

```js
module.exports = {
  command: 'node',
  args: ['src/index.js'],
  env: { ...process.env, MONGO_DB: 'my-app-test' },
};
```

Most config-driven apps read a variable like this from `process.env` via something like `dotenv` — and `dotenv`'s default behavior is to never override a variable that's already set, so an override passed through `env` here takes precedence over whatever's in the app's own `.env` file. If your target app persists state you need to reset, do it in a hook: `test.beforeAll` for once per file or `describe`, `test.beforeEach` for before every test (see [Writing tests](./writing-tests.md#setup-and-teardown-hooks)). For a reset that should happen once per whole run, do it in the config file itself (config files are just JavaScript, evaluated once per `rpgwright test` invocation).

## Give each test its own home directory

Apps often keep settings, save files and caches under `HOME`. If tests share the real one, one test's save file changes what the next test sees, and running tests on your machine changes your own setup. Ask for the `tmpHome` fixture, or seed it with the `homeFiles` option, and the app runs with `HOME` pointing at a fresh directory that's deleted afterwards (see [Writing tests](./writing-tests.md#fixtures)).

## Make tests safe to run in parallel

With `--workers`, tests in different files run at the same time. Each one gets its own app process, but nothing stops two apps from writing the same settings file, the same database, or listening on the same port. Use `tmpHome` (or `homeFiles`) for anything under `HOME`, and `testInfo.workerIndex` to give each worker its own database name or port.

## Retries reveal flakiness; they don't fix it

`--retries` keeps an intermittent failure from blocking a build, and marks the test as flaky. Treat a flaky report as a bug: usually an action sent before the previous one's effect landed (see above) or a wait on the wrong thing. `--repeat-each 20` on just that test is a quick way to reproduce it and to check a fix.

## Keep volatile content out of snapshots

A snapshot that includes a clock, a random ID or a build number fails on every run, and people learn to re-record it without looking. That defeats the point. Mask such content where it appears (`mask: [/\d\d:\d\d/]`), or replace it with `normalize`, so the snapshot still checks everything around it. See [Assertions](./assertions.md#volatile-content-mask-normalize-maxdiffcells). For anything where *how* it's drawn matters, such as a highlight, an error shown in red, or a dimmed disabled item, use `{ styles: true }`; a text-only snapshot can't see styling.

## Don't chase flakiness with sleeps

If a test is intermittently failing, the fix is almost never a `setTimeout` — it's usually one of the two things above: an assertion checking for text that isn't quite what renders, or an action sent before the previous one's effect was confirmed. A `sleep()` that happens to make a flaky test pass usually means the *next* environment (slower CI, a busier machine) will make it fail again.

When you need the screen to stop moving rather than to show something specific (an animation or spinner finishing, a redraw completing before a snapshot), use `waitForStable()` (see [Assertions](./assertions.md#waitforstable)). It waits for a quiet period measured from the last real screen update, so it adapts to a slow machine where a fixed sleep wouldn't.
