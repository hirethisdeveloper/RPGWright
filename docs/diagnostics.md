# Diagnostics and reading a failure report

## Anatomy of a failure

Every failing assertion throws an `Error` whose `.message` is a single, self-contained block — everything needed to understand what happened, without a separate log file:

```
E2E TEST FAILED
────────────────────────────────

Scenario: reaches settings

Last action:
  expectText("Settings")

Expected:
  "Settings"

Current screen:
  MAIN MENU
  1. Play
  2. Settings

PTY exit code:
  still running

Diagnostics:
  No diagnostics hook was configured for this launchGame() call. Note: this process ran in a real PTY, so stdout and stderr are already merged into one stream — see "Current screen" above for the process's actual output.

Actions:
  1. launchGame({"command":"node","args":["bin/my-cli-app.js"]})
  2. expectText("Main Menu")
  3. press("ENTER")
  4. expectText("Settings")  ← failed after this action
```

- **Scenario** — the failing test's name, when run through `rpgwright test` (or whatever you passed as `scenarioName` to `launchGame()` directly).
- **Last action** / **Expected** — what was being waited for when it failed.
- **Current screen** — the *actual* full visible screen at the moment of failure, exactly as `getScreenText()` would return it. This is usually the fastest way to spot the real problem — see [Best practices](./best-practices.md#assert-against-whats-actually-on-screen-not-what-you-assume-is-there) for a real example where this field immediately revealed the actual gap.
- **PTY exit code** — `still running`, or the process's actual exit code/signal. A process that already exited when you expected it to still be running (or vice versa) is often the real bug.
- **Diagnostics** — your `getDiagnostics` hook's output, or an explicit note that none was configured (see below).
- **Actions** — the complete history of every `press`/`type`/`expect*` call so far, in order, with the one that failed marked.

Because this is just an `Error.message`, it prints correctly in any test runner's default output with zero custom reporter — `rpgwright test`'s own reporter, `node:test`, Jest, Mocha, all show it as-is.

## `getDiagnostics`: wiring in your app's own logs

A PTY merges stdout and stderr into one stream by construction — there's no separate stderr RPGWright could capture the way a piped `child_process.spawn` might. If your app writes structured logs to disk, wire them in:

```js
module.exports = {
  command: 'node',
  args: ['src/index.js'],
  getDiagnostics: async () => {
    const fs = require('fs');
    try {
      return fs.readFileSync('src/logs/error.txt', 'utf8').slice(-2000);
    } catch {
      return '(no error log present)';
    }
  },
};
```

Called once, only at failure time, and only its return value (not any exception it throws — a throwing hook has its error message substituted in instead, so a broken diagnostics hook never masks the real assertion failure) is appended to the report. Real example: integrating RPGWright against a MongoDB-backed game, this hook was pointed at the game's own per-level log file (`src/logs/error.txt`) — so a failure caused by a database connection issue (rather than a UI/timing issue) shows the actual connection error inline, instead of just an unhelpful screen showing "Loading...".

## Debugging without waiting for a failure

`game.actions` is the same action history the failure report uses, available any time:

```js
console.log(game.actions);
// [{ type: 'expectText', detail: '"Main Menu"', ok: true }, ...]
```

Useful for a quick sanity check mid-test, or from a `console.log` you add temporarily while figuring out why a new scenario isn't behaving as expected.
