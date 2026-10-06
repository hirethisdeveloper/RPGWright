# Running in CI

`rpgwright test` needs nothing CI-specific beyond a working Node install — it doesn't need an actual terminal window, X server, or display of any kind, since `node-pty` allocates a real pseudo-terminal at the OS level, not a visual one.

```yaml
# example: GitHub Actions
- run: npm ci
- run: npx rpgwright test
```

## Output

The bundled reporter respects `NO_COLOR` and automatically drops ANSI color codes when stdout isn't a TTY (true for most CI log viewers) — no flag needed either way. Exit code is `0` on an all-passing run, `1` otherwise (a failing test, or a config that couldn't be loaded) — the standard signal for a CI step to fail the build.

## Keep traces from failed runs

A CI log shows the failure report, but not what the screen looked like at each step. Write an HTML trace for every failing test and upload the folder as a build artifact:

```yaml
# example: GitHub Actions
- run: npx rpgwright test --trace retain-on-failure
- if: failure()
  uses: actions/upload-artifact@v4
  with:
    name: rpgwright-traces
    path: test-results/
```

Each failure report ends with a `Trace:` line giving the file's path. See [Diagnostics](./diagnostics.md#traces).

## If `node-pty` fails to spawn anything

`node-pty` ships prebuilt native binaries per platform. If every single test fails immediately with something like `Error: posix_spawnp failed` (rather than a normal assertion timeout), the most common cause is the prebuilt helper binary losing its executable permission bit during install — this can happen with certain Docker layer-caching setups or CI cache-restore configurations that don't preserve file modes exactly. It's a `node-pty` packaging/environment detail, not an RPGWright-specific failure mode, and it's easy to tell apart from a real test failure: it happens instantly, before any process output at all, rather than after a timeout.

## Your target app's own dependencies

RPGWright has no concept of what your app needs to boot — a database, an API it calls, environment variables. Bring those up as a normal step before `rpgwright test` runs, the same as you would for any other test suite against the same app. See [Best practices](./best-practices.md#isolate-side-effects-your-app-depends-on) for pointing your app at disposable/test-only versions of anything it persists to, so CI runs never touch real data.

## Retries

On a shared CI machine, timing varies more than on your laptop. `--retries 1` keeps one intermittent failure from failing the build, and the summary still lists the test as flaky so it doesn't go unnoticed. To hold the line on flakiness instead, add `--fail-on-flaky`.

```yaml
- run: npx rpgwright test --retries 1 --trace retain-on-failure
```

## Test results in the CI interface

```yaml
# example: GitHub Actions
- run: npx rpgwright test --retries 1 --trace retain-on-failure
  # with reporter: ['list', 'github', 'junit'] in rpgwright.config.js
```

The `github` reporter turns each failure into an annotation on the failing test's line, and `junit` writes `test-results/results.xml`, which most CI systems (GitLab, Jenkins, CircleCI, Azure Pipelines, and GitHub through a test-report action) can display. See [CLI reference](./cli.md#reporter-styles).

## Parallelism

`--workers <n>` runs up to `n` test files at once in one process (see [CLI reference](./cli.md#running-tests-in-parallel)); a CI machine with spare cores can usually go to 2–4. To split a large suite across several CI jobs, point each job at its own subset with filters (`rpgwright test e2e/menus`) or `--grep`; there's no built-in sharding flag.

## Services your app needs

Instead of a separate CI step, you can let `rpgwright test` start your app's dependencies and wait until they're ready, using `services` in the config. See [Configuration](./configuration.md#services-globalsetup-and-globalteardown).
