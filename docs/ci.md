# Running in CI

`rpgwright test` needs nothing CI-specific beyond a working Node install — it doesn't need an actual terminal window, X server, or display of any kind, since `node-pty` allocates a real pseudo-terminal at the OS level, not a visual one.

```yaml
# example: GitHub Actions
- run: npm ci
- run: npx rpgwright test
```

## Output

The bundled reporter respects `NO_COLOR` and automatically drops ANSI color codes when stdout isn't a TTY (true for most CI log viewers) — no flag needed either way. Exit code is `0` on an all-passing run, `1` otherwise (a failing test, or a config that couldn't be loaded) — the standard signal for a CI step to fail the build.

## If `node-pty` fails to spawn anything

`node-pty` ships prebuilt native binaries per platform. If every single test fails immediately with something like `Error: posix_spawnp failed` (rather than a normal assertion timeout), the most common cause is the prebuilt helper binary losing its executable permission bit during install — this can happen with certain Docker layer-caching setups or CI cache-restore configurations that don't preserve file modes exactly. It's a `node-pty` packaging/environment detail, not an RPGWright-specific failure mode, and it's easy to tell apart from a real test failure: it happens instantly, before any process output at all, rather than after a timeout.

## Your target app's own dependencies

RPGWright has no concept of what your app needs to boot — a database, an API it calls, environment variables. Bring those up as a normal step before `rpgwright test` runs, the same as you would for any other test suite against the same app. See [Best practices](./best-practices.md#isolate-side-effects-your-app-depends-on) for pointing your app at disposable/test-only versions of anything it persists to, so CI runs never touch real data.

## Parallelism

`rpgwright test` runs test files sequentially within one process, launching a fresh target-app process per test. If your CI setup runs multiple jobs in parallel (e.g., sharding), point each job at its own config/`testMatch` subset, the same way you would split any other test suite — there's no built-in sharding flag in v1.
