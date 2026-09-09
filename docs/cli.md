# CLI reference

## `rpgwright init`

Scaffolds a new project in the current directory:

- `rpgwright.config.js` — a config pointing at a small, self-contained example.
- `example-app.js` — a dependency-free raw-mode Node script, so the example runs with nothing else installed.
- `example.rpg.test.js` — a test against that script.
- Adds `"test:e2e": "rpgwright test"` to `package.json`'s `scripts`, if `package.json` exists.

Safe to re-run: existing files are left alone unless you pass `--force`.

```bash
npx rpgwright init          # scaffold, skipping any files that already exist
npx rpgwright init --force  # scaffold, overwriting existing files
```

If no `package.json` is found in the current directory, `init` still writes the other files but skips the `test:e2e` script — run `npm init` first if you want that added automatically.

## `rpgwright test`

Discovers and runs every test file matching your config's `testMatch` (default `**/*.rpg.test.js`) under `testDir`, printing a running pass/fail line per test and a summary at the end.

```bash
npx rpgwright test
npx rpgwright test --config ./path/to/rpgwright.config.js
```

### `--config <path>`

Points at a specific config file instead of looking for `rpgwright.config.js` in the current directory. See [Configuration](./configuration.md#--config-path).

### Output

```
example.rpg.test.js
  ✓ says hello after pressing enter (52ms)

1 passed (56ms)
```

A failing test prints its full failure report inline — everything needed to understand what happened without a separate log file: the scenario name (the test's own name — every test run through `rpgwright test` gets this automatically), the last action attempted, what was expected, the complete current screen, the process's exit status, any configured diagnostics, and the full numbered history of actions leading up to the failure:

```
broken.rpg.test.js
  ✖ never happens (410ms)

1) never happens
    E2E TEST FAILED
    ────────────────────────────────

    Scenario: never happens

    Last action:
      expectText("this will never appear")
    ...

1 failed (424ms)
```

Output respects `NO_COLOR` and non-TTY environments (CI logs, piped output) automatically — no flag needed.

### Reporter styles

Set `reporter` in `rpgwright.config.js` to choose the console output style (see [Configuration](./configuration.md)):

```js
module.exports = {
  command: 'node',
  args: ['bin/my-cli-app.js'],
  reporter: 'dot', // or 'list' (the default)
};
```

- **`'list'`** (default) — a running pass/fail/skip line per test, as shown above.
- **`'dot'`** — one compact character per test (`.` pass, `F` fail, `-` skip) on a single line, Mocha-style, useful for a large suite where a full per-test line per pass is more noise than signal:

  ```
  ....F..

  1) reaches settings
      E2E TEST FAILED
      ...

  6 passed, 1 failed (2103ms)
  ```

  Both styles print the identical full §9 failure block and summary — only the per-test progress indicator differs.

### Exit codes

`rpgwright test` exits `0` if every test passed, `1` if any test failed (or the config itself couldn't be loaded) — the standard convention for wiring into CI or a pre-commit/pre-push hook.
