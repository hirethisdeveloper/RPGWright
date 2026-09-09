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

Most config-driven apps read a variable like this from `process.env` via something like `dotenv` — and `dotenv`'s default behavior is to never override a variable that's already set, so an override passed through `env` here takes precedence over whatever's in the app's own `.env` file. If your target app persists state you need to reset between runs, do it once in the config file itself (config files are just JavaScript, evaluated once per `rpgwright test` invocation) rather than trying to add setup/teardown hooks that don't exist in the runner.

## Don't chase flakiness with sleeps

If a test is intermittently failing, the fix is almost never a `setTimeout` — it's usually one of the two things above: an assertion checking for text that isn't quite what renders, or an action sent before the previous one's effect was confirmed. A `sleep()` that happens to make a flaky test pass usually means the *next* environment (slower CI, a busier machine) will make it fail again.
