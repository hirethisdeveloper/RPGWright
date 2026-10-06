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

Discovers and runs every test file matching your config's `testMatch` (default `**/*.rpg.test.js` and `**/*.rpg.test.ts`) under `testDir`, printing a running pass/fail line per test and a summary at the end.

```bash
npx rpgwright test
npx rpgwright test --config ./path/to/rpgwright.config.js
npx rpgwright test settings              # only files whose path contains "settings"
npx rpgwright test menu.rpg.test.js:42   # only the test (or describe block) declared on line 42
npx rpgwright test --grep @smoke
```

### Options

| Option | Effect |
|---|---|
| `--config <path>` | Use this config file instead of `rpgwright.config.js` in the current directory. See [Configuration](./configuration.md#--config-path). |
| `--grep <regex>` | Only run tests whose full name (including `describe` titles, joined with ` > `) matches. Put tags such as `@smoke` in test names and select them this way. |
| `--grep-invert <regex>` | Skip tests whose full name matches. |
| `--list` | Print the selected tests as `file:line › name`, plus a total, and run nothing. |
| `--reporter <name>` | Override the config's `reporter` for this run. Separate several with commas: `--reporter list,github`. |
| `--update-snapshots` | Re-record every snapshot this run touches instead of comparing against it. |
| `--max-failures <n>` | Stop the run once `n` tests have failed. |
| `--retries <n>` | Rerun a failed test up to `n` times; overrides the config's `retries`. |
| `--fail-on-flaky` | Fail the run if any test only passed on a retry. |
| `--workers <n>` | Run up to `n` test files at the same time; overrides the config's `workers`. See [Running tests in parallel](#running-tests-in-parallel). |
| `--watch` | Run the tests, then run them again whenever a file changes. See [Watch mode](#watch-mode). |
| `--repeat-each <n>` | Run every selected test `n` times, named `[repeat i/n]`. |
| `--trace <mode>` | Write an HTML trace for each test: `on`, `off`, or `retain-on-failure` (only for failing tests). Overrides the config's `trace`. See [Diagnostics](./diagnostics.md#traces). |

### Filters

Anything that isn't an option is a filter. A filter selects the test files whose path contains it; with `:line` appended, it selects only the test declared on that line, or every test in the `describe` block declared on it. Several filters select the union. `--grep`, `--grep-invert` and `test.only` (see [Writing tests](./writing-tests.md#focusing-skipping-and-expected-failures)) then narrow that selection further.

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

Set `reporter` in `rpgwright.config.js` to choose the console output style (see [Configuration](./configuration.md)), or override it for one run with `--reporter`:

```js
module.exports = {
  command: 'node',
  args: ['bin/my-cli-app.js'],
  reporter: 'dot', // or 'list' (the default)
};
```

- **`'list'`** (default) — a running pass/fail/skip line per test, as shown above.
- **`'dot'`** — one compact character per test (`.` pass, `±` flaky, `F` fail, `-` skip) on a single line, Mocha-style, useful for a large suite where a full per-test line per pass is more noise than signal:

  ```
  ....F..

  1) reaches settings
      E2E TEST FAILED
      ...

  6 passed, 1 failed (2103ms)
  ```

  Both styles print the identical full §9 failure block and summary — only the per-test progress indicator differs.

- **`'json'`** — every test's result as JSON, written to `test-results/results.json`: `{ stats: { passed, failed, skipped, flaky, durationMs }, tests: [{ name, file, line, status, retry, durationMs, error? }] }`.
- **`'junit'`** — JUnit XML, written to `test-results/results.xml`. Most CI systems can show test results from this format.
- **`'github'`** — GitHub Actions annotations: each failure becomes an error on the test's line in the pull request, and each flaky test a warning. It prints nothing else, so use it alongside a console reporter.

To use several at once, give a list. Use `[name, { outputFile }]` to choose where a file reporter writes (relative to the current directory):

```js
module.exports = {
  command: 'node',
  args: ['bin/my-cli-app.js'],
  reporter: ['list', 'github', ['junit', { outputFile: 'reports/e2e.xml' }]],
};
```

`--reporter <name>` on the command line replaces the whole list, with that one reporter or a comma-separated list (`--reporter dot,github`).

### Running tests in parallel

`--workers 4` (or `workers: 4` in config) runs up to four test files at once. Tests inside one file still run in order, one at a time. The output is the same as a serial run, in the same order, because each file's results are printed once the files before it have finished.

Every test already gets its own app process, so tests in different files only conflict through things outside RPGWright: a shared database, a file the app writes, a fixed network port. Give each test its own (the `tmpHome` fixture gives each test its own `HOME`), or use `testInfo.workerIndex` (`0` to `workers - 1`) to pick a per-worker database or port.

### Watch mode

`rpgwright test --watch` runs the tests, then waits. When a test file changes, it reruns that file. When any other file changes, it reruns everything you selected. By default it watches the test directory and the config file's directory. If your app's source lives elsewhere, add it with `watchPaths: ['../src']` in the config. Press Ctrl+C to stop.

### Exit codes

`rpgwright test` exits `0` if every test passed, `1` if any test failed, a test only passed on a retry with `--fail-on-flaky`, a rejection went unhandled (a missing `await`), or the config itself couldn't be loaded — the standard convention for wiring into CI or a pre-commit/pre-push hook.
