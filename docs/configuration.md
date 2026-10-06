# Configuration reference

`rpgwright.config.js` (CommonJS, at your project root by default) centralizes everything `rpgwright test` needs: what to launch, how, and where to find your test files. Every field is optional except `command`.

```js
module.exports = {
  command: 'node',
  args: ['bin/my-cli-app.js'],
};
```

## Launch options

These are passed straight through to `launchGame()` for every test. RPGWright does not re-default any of these at the config layer; a field you omit gets `launchGame`'s own default, listed below.

| Field | Default | Description |
|---|---|---|
| `command` | *(required)* | The executable to launch. |
| `args` | `[]` | Arguments passed to `command`. |
| `cwd` | `process.cwd()` | Working directory for the launched process. |
| `env` | `process.env` | Environment variables for the launched process. |
| `cols` | `120` | Initial terminal width. |
| `rows` | `40` | Initial terminal height. |
| `expectTimeout` | `10000` | Default timeout (ms) for `expectText`/`expectScreen`/`expectState`/`expectNotText`'s overall bound, when a call doesn't specify its own `timeout`. |
| `killSignal` | `'SIGTERM'` | Signal `stop()` sends first. Node's own `node-pty` defaults to `SIGHUP` if unspecified — RPGWright deliberately overrides that, since many apps only handle `SIGTERM`. |
| `killTimeout` | `3000` | Grace period (ms) `stop()` waits for a graceful exit before escalating to `SIGKILL`. |
| `getDiagnostics` | `null` | `() => Promise<string> \| string`, called once at failure time and appended to the failure report's `Diagnostics:` section. See [Assertions](./assertions.md#diagnostics). |
| `keys` | `{}` | Extra/override entries merged into the named-key table `press()` looks up (e.g. `{ CONFIRM: '\r' }`). |
| `snapshotsDir` | `<cwd>/__snapshots__` | Where `expectScreen({ snapshot: name })` reads/writes recorded screens. |
| `updateSnapshots` | `RPGWRIGHT_UPDATE_SNAPSHOTS === '1'` | Re-record every snapshot instead of comparing. Usually set with `rpgwright test --update-snapshots` rather than in config. |
| `term` | `'xterm-color'` | The terminal type the app sees in `TERM`. |
| `colorDepth` | *(unset: `env` is used as-is)* | The color support to advertise: `'none'`, `16`, `256` or `'truecolor'`. See [below](#colordepth-and-locale). |
| `locale` | *(unset)* | Sets `LANG` and `LC_ALL`, e.g. `'en_US.UTF-8'` or `'C'`. |
| `scrollback` | `1000` | How many lines that scroll off the top of the screen are kept, for `toHaveScrollbackText()`. |
| `homeFiles` | *(none)* | Files to create in a fresh, isolated `HOME` before the app starts: `{ 'relative/path': 'contents' }`. See [Writing tests](./writing-tests.md#fixtures). |
| `tty` | `true` | Set `false` to run the app with plain pipes instead of a terminal, to test what it does when its output is piped (no colors, no prompts). Assertions work the same. |
| `historySize` | `500` | How many past screens to keep for `expectSeen()`, `expectNoFlicker()` and traces. |
| `focus` | `{ style: { inverse: true }, cursor: true }` | How your app shows focus, for `toBeFocused()`: any of `style`, `marker` and `cursor`. See [Layout and focus](./layout-and-focus.md#focus). |

Any of these can also be set for one group of tests with `test.use()` (see [Writing tests](./writing-tests.md#per-group-options-testuse)).

## Runner options

These are specific to `rpgwright test` itself, not to any individual launched process.

| Field | Default | Description |
|---|---|---|
| `testDir` | the directory containing `rpgwright.config.js` | Where to look for test files. |
| `testMatch` | `['**/*.rpg.test.js', '**/*.rpg.test.ts']` | A glob, or array of globs, matched against each file's path relative to `testDir`. |
| `timeout` | `30000` | Per-test overall timeout (ms) — bounds the whole test function, distinct from `expectTimeout`, which bounds a single assertion. A test that hangs (rather than a single slow assertion) fails after this, with a clear "exceeded its timeout" message. |
| `viewports` | *(none)* | Terminal sizes for `test.eachViewport()`: `[{ cols: 80, rows: 24 }, { name: 'wide', cols: 160, rows: 50 }]`. Each needs positive integer `cols` and `rows`; `name` defaults to `"<cols>x<rows>"`. See [Writing tests](./writing-tests.md#running-a-test-at-several-terminal-sizes). |
| `workers` | `1` | How many test files to run at once. See [CLI reference](./cli.md#running-tests-in-parallel). |
| `services` | `[]` | Background processes to start before the tests and stop after. See [below](#services-globalsetup-and-globalteardown). |
| `globalSetup` / `globalTeardown` | *(none)* | Paths (relative to the config file) to modules exporting an `async (config) => {}` that runs once before / after all the tests. |
| `watchPaths` | `[]` | Extra directories `--watch` watches, relative to the config file. |
| `retries` | `0` | How many times to rerun a failed test. A test that passes on a retry is reported as flaky. See [Writing tests](./writing-tests.md#retries-and-repeated-runs). |
| `trace` | `'off'` | Write an HTML trace per test: `'on'`, `'off'`, or `'retain-on-failure'`. See [Diagnostics](./diagnostics.md#traces). |
| `outputDir` | `test-results` next to the config file | Where traces are written. |
| `reporter` | `'list'` | Output style: `'list'`, `'dot'`, `'json'`, `'junit'` or `'github'`, or a list of several (`['list', ['junit', { outputFile: 'e2e.xml' }]]`). See [CLI reference](./cli.md#reporter-styles). An unrecognized value fails immediately with a clear error rather than silently falling back to the default. |

## `--config <path>`

By default, `rpgwright test` looks for `rpgwright.config.js` in the current directory. Pass `--config` to point at a different file:

```bash
npx rpgwright test --config ./configs/rpgwright.config.js
```

`testDir` then defaults to *that file's* directory, not the current directory — useful for keeping multiple target apps' configs and test files grouped separately (see [Writing tests](./writing-tests.md#per-test-overrides-and-multiple-target-apps)).

## `keys`: extending the key table

```js
module.exports = {
  command: 'node',
  args: ['bin/my-cli-app.js'],
  keys: {
    CONFIRM: '\r', // an alias, if your app's docs call it that
    SUPER_JUMP: '\x1b[1;5A', // Ctrl+Up, for a key combo not in the default table
  },
};
```

Entries here are merged into (not replacing) the built-in table, so all the standard names (`ENTER`, `ARROWUP`, etc.) keep working alongside your additions. Modifier combinations don't need an entry: `press('Control+ArrowUp')` works out of the box (see [Key sequences](./key-sequences.md#chords-modifier-keys)).

## `colorDepth` and `locale`

Most color libraries decide what to emit from environment variables, so `colorDepth` sets those for you:

| `colorDepth` | Sets | Removes |
|---|---|---|
| `'none'` | `NO_COLOR=1`, `FORCE_COLOR=0` | `COLORTERM` |
| `16` | `FORCE_COLOR=1` | `NO_COLOR`, `COLORTERM` |
| `256` | `FORCE_COLOR=2` | `NO_COLOR`, `COLORTERM` |
| `'truecolor'` | `FORCE_COLOR=3`, `COLORTERM=truecolor` | `NO_COLOR` |

These are applied on top of `env`, so a `NO_COLOR` inherited from your shell can't leak into a `'truecolor'` run. `FORCE_COLOR` is what chalk and `supports-color` (and so Ink) read; `NO_COLOR` and `COLORTERM` are the conventions most other libraries follow. Use it to test your app's no-color and limited-color output:

```js
const { test, describe } = require('rpgwright/test');

describe('without color', () => {
  test.use({ colorDepth: 'none' });

  test('still marks the selected item', async ({ game }) => {
    await game.expectText('> Play');
  });
});
```

`locale` sets `LANG` and `LC_ALL`, for apps whose output or character handling depends on the locale.

## `services`, `globalSetup` and `globalTeardown`

If your app needs something running first (a database, an API server, a fake of either), let `rpgwright test` start it:

```js
module.exports = {
  command: 'node',
  args: ['bin/my-cli-app.js'],
  services: [
    { name: 'api', command: 'node', args: ['test/fake-api.js'], readyText: 'listening' },
    { command: 'redis-server', args: ['--port', '6390'], readyPort: 6390, timeout: 10000 },
  ],
  globalSetup: './e2e/seed-database.js',
};
```

Each service is started in order, with `args`, `cwd` (relative to the config file) and `env` as you'd expect, and the run waits until it's ready: until its output contains `readyText` (a string or RegExp), until `readyPort` accepts connections, or not at all if you give neither. If a service exits first, or isn't ready within `timeout` (default 30 seconds), the run stops with the end of the service's output. Services are stopped (SIGTERM, then SIGKILL after 3 seconds) when the run ends.

`globalSetup` runs once after the services are up and before any test. If it returns a function, that runs once after all the tests. `globalTeardown` runs after that, and then the services are stopped. Nothing is started for `--list` or when no tests are selected.

