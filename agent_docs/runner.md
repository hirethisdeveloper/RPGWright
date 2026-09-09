---
name: runner
description: The built-in test runner and CLI — config resolution, the game fixture's launch/stop lifecycle, discovery/reporter behavior, and the init scaffold.
---

# `runner/` and `bin/rpgwright.js`

## Why a bundled runner exists, and its actual scope

Per §2/§10 of the plan, `rpgwright test` is the primary, documented interface — installed and used the way `@playwright/test` is — with the low-level `launchGame()` core staying available as an unsupported escape hatch for embedding in another test runner. The scope of what this runner needs to do is narrower than a general-purpose test framework: it exists specifically to remove the launch/run/stop boilerplate around `GameDriver`, for tests that are fundamentally "launch an app, drive it, assert." It is **not** a replacement for `node:test` as a general unit-test runner — see [[testing-strategy]] for why RPGWright's own internal unit tests (of `pty.js`/`terminal.js`/`assertions.js`/`keys.js`) deliberately stay on `node:test` rather than being forced through this runner's app-launching fixture model.

## Config resolution (`runner/config.js`)

`loadConfig({ configPath, cwd })` finds `rpgwright.config.js` (explicit `--config` path, or `<cwd>/rpgwright.config.js`), `require()`s it, and validates that it exports a `command` — the one field with no sensible default, since RPGWright has no built-in notion of what app to launch. Everything else launch-related (`cols`, `killSignal`, `getDiagnostics`, `keys`, `snapshotsDir`, ...) is passed through **untouched**, not re-defaulted here — `src/game.js`'s `launchGame()` already owns those defaults, and duplicating them in the config loader would create a second source of truth for the same values. Only genuinely runner-level concerns get defaults at this layer: `testDir` (the config file's own directory, unless overridden), `testMatch` (`**/*.rpg.test.js`), and `timeout` (30000ms — the *test-level* timeout, distinct from `expectTimeout`, which bounds individual assertions).

## Discovery (`runner/discover.js`)

A hand-rolled glob-to-RegExp converter and recursive directory walker — not a `glob`/`minimatch` dependency. RPGWright's only two dependencies are `node-pty` and `@xterm/headless` (§4); `testMatch`'s real-world need is a handful of simple patterns (the default `**/*.rpg.test.js` plus straightforward variants), which a ~20-line converter handles correctly without pulling in a third dependency for it. `node_modules`, `.git`, and `__snapshots__` are always skipped during the walk.

## The `game` fixture's lifecycle (`runner/run.js`)

This is the runner's actual reason to exist. For each discovered file: `runner/test.js`'s registry is reset (`_beginFile()`), the file is `require()`'d (which synchronously calls `test()`/`describe()` to populate the registry — registration and execution are deliberately separate phases), then `_collect()` hands back the registered tests for that file. For each one (unless `.skip`), `run.js`:

1. Calls `launchGame(config)` fresh — a new `GameDriver`, new process, every test. No shared/reused fixture across tests, which is what makes tests independent of run order and immune to one test's leftover state leaking into the next.
2. Races the test function against `config.timeout` (test-level hang protection, separate from any individual `expectTimeout`).
3. Calls `game.stop()` in a `finally` block — always, whether the test passed, failed, or timed out. `stop()`'s own idempotency (see [[game-driver]]) means a test that already called `game.stop()` itself for its own reasons doesn't cause a problem when the runner's automatic call runs afterward.

There is deliberately no fixture dependency-injection system here (no lazy/opt-in fixtures based on parsing which destructured parameters a test function uses, the way Playwright Test's real fixture system works) — every test gets a `game`, always. That scope boundary is *why* pure internal-unit tests don't run through this runner (see [[testing-strategy]]): building real lazy fixtures just to let some tests skip launching a process would be meaningfully more machinery than Phase 3 needs, for a problem that `node:test` already solves for those tests today.

## Reporter (`runner/reporter.js`)

Two built-in styles, selected via config's `reporter` field (`'list'`, the default, or `'dot'`), both sharing one `printSummary()` — the failure-block dump and final summary line are identical between them; only the per-test progress indicator differs (`'list'`: a running ✓/✖ line per test; `'dot'`: a single `.`/`F`/`-` character, Mocha-style). `createReporter(style)` looks the factory up in a small `REPORTERS` map and throws immediately (before any test runs) on an unrecognized name, rather than silently falling back to the default — a typo'd `reporter: 'dots'` in config should fail loudly, not quietly run with the wrong output shape. Respects `NO_COLOR` and non-TTY output (no ANSI codes when `process.stdout.isTTY` is false) for both styles. A third style (e.g. `json`, for machine consumption) would extend the same `REPORTERS` map — the registry, not a hardcoded if/else, is what makes that an addition rather than a refactor.

## `rpgwright init` (`runner/init.js`)

Scaffolds a **genuinely self-contained, immediately-runnable** example — deliberately not a placeholder the consumer has to edit before anything works. The scaffolded target (`example-app.js`) is a dependency-free raw-mode Node script (just `process.stdin.setRawMode`/`process.stdout.write`), not an Ink app — so `rpgwright init && rpgwright test` passes with zero new dependencies and zero edits, immediately proving the tool works before a consumer wires it up to their real app. `writeIfAbsent` never overwrites an existing file unless `--force` is passed, so re-running `init` in a project that's already been customized is safe. If `package.json` exists, `"test:e2e": "rpgwright test"` is merged into its `scripts`; if it doesn't, that step is skipped with a clear message rather than fabricating a `package.json` (creating one from scratch isn't `rpgwright init`'s job).

## Self-referencing: how `.rpg.test.js` files can `require('rpgwright/test')` from inside this repo

Node resolves a package requiring its own name (as declared in its own `package.json`) via the `"exports"` map, without needing a `node_modules` entry — this is a stable, built-in Node feature (self-referencing), not an RPGWright mechanism. It's why the dogfood suites under `test/rpg/**` (see [[testing-strategy]]) can `require('rpgwright/test')` directly. It only resolves for files that are actually inside the package's own directory tree, though — testing `rpgwright init`'s scaffold from a truly external temp directory (as `test/runner-e2e.test.js` does) needs a real `node_modules/rpgwright` entry, which those tests create as a symlink to the repo root (the standard local-package-testing technique, equivalent to `npm link`).
