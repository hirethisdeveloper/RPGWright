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

## Runner options

These are specific to `rpgwright test` itself, not to any individual launched process.

| Field | Default | Description |
|---|---|---|
| `testDir` | the directory containing `rpgwright.config.js` | Where to look for test files. |
| `testMatch` | `**/*.rpg.test.js` | A glob, or array of globs, matched against each file's path relative to `testDir`. |
| `timeout` | `30000` | Per-test overall timeout (ms) — bounds the whole test function, distinct from `expectTimeout`, which bounds a single assertion. A test that hangs (rather than a single slow assertion) fails after this, with a clear "exceeded its timeout" message. |

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

Entries here are merged into (not replacing) the built-in table, so all the standard names (`ENTER`, `ARROWUP`, etc.) keep working alongside your additions.
