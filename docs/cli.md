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
| `--ui` | Pick tests from a full-screen list and watch each one's live terminal screen as it runs, with pause, step and abort. See [UI mode](#ui-mode). |
| `--repeat-each <n>` | Run every selected test `n` times, named `[repeat i/n]`. |
| `--trace <mode>` | Write an HTML trace for each test: `on`, `off`, or `retain-on-failure` (only for failing tests). Overrides the config's `trace`. See [Diagnostics](./diagnostics.md#traces). |
| `--save-run` | Save a replayable `.run.json` file for each test that launched an app, passed or failed, for `rpgwright play`. Same as `saveRun: true` in the config. See [Saving and replaying runs](#saving-and-replaying-runs). |

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

### UI mode

`rpgwright test --ui` takes over your terminal. You pick which tests to run from a list, and watch the running test's screen live. The screen is redrawn in place as the app changes, instead of scrolling.

#### Interactive selection

The filters, `--grep`, `test.only` and `--repeat-each` choose which tests are in the list, as they choose what a normal run runs.

- **Several tests match** (`rpgwright test hudLayout --ui`): nothing runs yet. The UI opens on a list of the matching tests showing each one's status (`·` pending, `●` running, `✓` passed, `✖` failed, `⊘` aborted, `-` skipped) and how long its last run took. The selected test's file, line and last error are shown below the list. Run whichever tests you want, as often as you want. When a run finishes, you're back on the list.
- **One test matches** (`rpgwright test menu.rpg.test.js:12 --ui`): it runs at once, and its result stays on screen until you press `q`.

Keys on the list:

| Key | Does |
| --- | --- |
| `↑`/`↓` or `k`/`j` | Move the selection |
| `enter` | Run the selected test |
| `a` | Run every test in the list, in order |
| `f` | Run the tests that failed or were aborted |
| `r` | Rerun the last run (or the selected test, if nothing has run yet) |
| `q` | Quit |

Keys while a test runs:

| Key | Does |
| --- | --- |
| `space` | Pause before the test's next action (a key press, an `expect`, a `test.step`), or resume |
| `n` | While paused: let one action run, then pause again |
| `esc` | Abort the test and go back to the list. Its `afterEach`/`afterAll` hooks and fixture teardown still run, and the rest of the run is cancelled |
| `q` | Abort the test and quit |

`Ctrl+C` always quits, whatever is happening.

A paused test doesn't time out: its timeout clock stops while it's paused. An aborted test counts as failed but is never retried, and gets no trace.

#### The live view

While a test runs, the UI shows:

- **Header:** the test file and name, how far through the run you are (`3/12`), how many tests have passed, failed and been skipped so far, and how long the test and the whole run have taken.
- **The app's screen**, drawn in a box at the app's own size (`cols`×`rows`), with its colors and cursor. If your terminal is smaller than that, the top-left part that fits is shown and the box's label says so (`100×30 (showing 78×18)`). Resizing your terminal re-draws the layout.
- **Footer:** the `test.step` you're inside, the last action (`press "Enter" ✓`), and the test's status (`RUNNING`, `PASSED`, or `FAILED` with the first line of its error).

When you quit, the terminal goes back to how it was and the usual summary and full failure reports are printed, exactly as `list` prints them, counting each test you ran once, by its latest result. Tests you never ran aren't counted. Anything your tests print with `console.log` is printed then too. The exit code is `1` if the latest run of any test failed or was aborted (or an `afterAll` hook failed in the last run), otherwise `0`. The terminal is also restored if the run crashes.

`--ui` changes how some other options behave:

- **Workers:** tests run one file at a time (`workers` is forced to `1`), so there's only ever one screen to show.
- **Reporters:** console reporters (`list`, `dot`, `github`) are replaced by the UI. File reporters (`json`, `junit`) from your config or `--reporter` still write their files.
- **Retries:** configured `retries` apply to every test you run from the list.
- **Services and `globalSetup`:** started once when the UI opens, and stopped after you quit.
- **Watch mode:** `--ui` can't be combined with `--watch`; the run stops with an error.
- **Output must be a terminal.** If stdout is piped or redirected (CI logs, `| tee`), `--ui` stops with an error. Run without it there.

A test that launches more than one process (`launch()`) shows the first one.

### Exit codes

`rpgwright test` exits `0` if every test passed, `1` if any test failed, a test only passed on a retry with `--fail-on-flaky`, a rejection went unhandled (a missing `await`), or the config itself couldn't be loaded — the standard convention for wiring into CI or a pre-commit/pre-push hook.

## Saving and replaying runs

### Saving a run: `--save-run`

`rpgwright test --save-run` (or `saveRun: true` in the config) writes one file per test that launched an app, to `<outputDir>/<file>--<test>.run.json` (`outputDir` defaults to `test-results` next to the config file; the name is the test file's path under `testDir` and the test's name, like trace files). It's written whatever the outcome: passed, failed, or aborted from the UI. A failing test's report includes a `Run: <path>` line pointing at it. In a `--ui` session, rerunning a test saves each run as a new file (`-2`, `-3`, …) instead of overwriting.

The file holds everything needed to watch the test again: the test's name, file and line, its result, how long it took and its error, and for each process the test launched, every byte of output the app wrote, every resize, and every action and `test.step` with its time.

- It works together with `--ui` and `--trace`.
- With `--retries`, only a test's final attempt is saved.
- A test that launched several processes (`launch()`) gets one file with a session for each, in launch order.
- Run files can be large: they keep all of an app's output, so a long test, or an app that redraws often, makes a big file. Turn the option on when you need it, rather than for every CI run.

### Replaying a run: `rpgwright play`

```bash
npx rpgwright play test-results/menu--opens-the-settings.run.json
npx rpgwright play test-results/menu--two-apps.run.json --session 2
```

`rpgwright play` replays a saved run full-screen, in the same view as `--ui`, at the speed it was recorded. It doesn't run anything: your app isn't launched and no test code is loaded, so you can replay a run from CI on your own machine, without the app or its setup.

- **Header:** `REPLAY`, the test's file, line and name, its original result (`recorded ✖ failed in 2.3s`), and the playback position (`▶ 1.2s / 4.0s`).
- **The app's screen** as it was at that moment, in a box at the app's size; it changes size when the app's terminal was resized.
- **Footer:** the `test.step` the test was in and its last action at that moment. When playback ends, it says `Playback finished`, with what the failure expected and the last action if the test failed. The screen stays up until you quit.

| Key | Does |
| --- | --- |
| `q` | Quit |
| `Ctrl+C` | Quit |

| Option | Effect |
|---|---|
| `--session <n>` | Which of the test's processes to replay, counting from `1` in launch order (default `1`). The header shows `session n/m` when the run has more than one. |

`rpgwright play` needs a terminal. It exits `1` with an error if stdin or stdout is piped or redirected, if the file is missing or isn't a run file (or was saved by a newer, incompatible RPGWright), or if `--session` is out of range. It exits `0` when you quit.
