# CLAUDE.md

Agent-facing gateway to this repo. Read this first; it's deliberately short. For anything beyond a one-line summary, follow the links into `agent_docs/`.

## What RPGWright is

An end-to-end testing framework for terminal applications that depend on real TTY behavior (raw input mode, ANSI escapes, alt-screen buffer, cursor positioning). It launches a target CLI inside a real pseudo-terminal (`node-pty`), drives it with real keystrokes, and asserts against the terminal's actual interpreted screen contents (`@xterm/headless`). Full design rationale: [`RPGWright.md`](./RPGWright.md) at the repo's parent directory context — see that file for the complete spec this build follows.

## Architecture

```
CLI (`rpgwright` bin: init / test subcommands)
   │
   ▼
Test runner (rpgwright/test — test(), expect(), fixtures, reporter)
   │
   ▼
GameDriver  (game.js — public API)
   │
   ├── press(key) / type(text)          → pty.js: write bytes
   ├── expectText/expectNotText/...      → assertions.js: waitUntil()
   ├── resize(cols, rows)                → pty.js + terminal.js
   └── stop()                            → stopProcess(): signal + escalate via pty.js
          │
          ▼
      terminal.js  (ANSI/VT100 interpretation via @xterm/headless)
          ▲
          │ write(chunk)
          │
      pty.js  (node-pty: spawn/write/resize/exit/kill — no policy)
          │
          ▼
   Target CLI process (any real TTY-driven app)
```

## Module responsibilities (one line each)

- `src/pty.js` — owns the raw OS process via node-pty; spawn/write/resize/kill primitives, no app knowledge, no signal policy.
- `src/terminal.js` — wraps `@xterm/headless`; re-derives the currently visible screen from live buffer state on every read.
- `src/assertions.js` — four wait primitives (`waitUntil`, `waitUntilAbsent`, `waitForQuiet`, `pollUntil`, all event/poll-driven, never a raw setInterval-as-sync-mechanism) and `formatFailureReport()` (the §9 failure block).
- `src/keys.js` — named key → raw byte sequence table (`KEY_SEQUENCES`), extendable via `launchGame`'s `keys` option, plus `resolveKey()` for modifier chords (`Control+ArrowLeft`) and `encodeMouse()` for mouse reports in each encoding.
- `src/layout.js` — pure screen geometry over the cell grid: text and box-drawing detection, strict lazy locators (`createLocator`), and the layout/style checks (`CHECKS`/`evaluateCheck`) that `GameDriver.expectLayout` waits on.
- `src/render.js` — pure cell-grid → HTML rendering (xterm default palette, inverse, wide characters, cursor), used by `game.renderHtml()` and traces.
- `src/game.js` — `GameDriver`/`launchGame()`, the full public API: `press`/`press.raw`, `type`, `expectText`, `expectNotText`, `expectScreen`, `expectState`, `waitForStable`, `step`, `locator`/`expectLayout`/`expectCount`/`expectFocusGroup`/`getFocused`, `expectCursorAt`/`expectCursorVisible`/`getCursor`, `expectSeen`/`expectNoFlicker` (over a bounded frame history), `expectTerminal` (modes, title, bell, hyperlinks, clipboard, scrollback), `paste`/`mouse`, `kill`/`waitForExit`/`expectExit`, `resize`, `stop`, plus `getScreenText`/`renderHtml`/`getTrace`/`actions`; also forwards terminal query replies and applies `term`/`colorDepth`/`locale`.
- `src/index.js` — core package entry point re-exporting the above for advanced/direct consumption (`launchGame`, `spawnPty`/`spawnPipe`, `createVirtualTerminal`, `KEY_SEQUENCES`/`resolveKey`/`encodeMouse`, `renderScreenHtml`).
- `src/pty.js` also provides `spawnPipe`, the same handle over plain pipes, for `tty: false` and background services.
- `types/` — hand-written TypeScript declarations (`index.d.ts`, `test.d.ts`), checked against the code by `test/types.test.js` (exported names, every `GameDriver` member including `press.*`/`mouse.*`, `LaunchOptions`, built-in fixtures, layout checks, `test.*` and the matchers; not parameter or return types).
- `runner/config.js` — `rpgwright.config.js` loader + validation; validates and defaults the runner-level fields (`testDir`, `testMatch`, `timeout`, `reporter`, `viewports`, `trace`, `retries`, `workers`, `services`, `globalSetup`/`globalTeardown`, `outputDir`); launchGame-specific fields pass through untouched.
- `runner/discover.js` — hand-rolled glob-to-RegExp test-file discovery (no external glob dependency).
- `runner/test.js` — the authoring API (`test`/`describe` and their `skip`/`only`/`fixme`/`fail` variants, hooks, `test.use`, `test.setTimeout`/`slow`/`step`/`info`) and its per-file scope tree (`_beginFile`/`_collect`/`_scopeChain`), re-exported with `expect` as `rpgwright/test`.
- `runner/fixtures.js` — lazy fixtures: reading destructured fixture names, and the per-test scope that creates/tears down built-ins (`game`, `viewport`, `launch`, `tmpHome`, `testInfo`) and `test.extend` fixtures.
- `runner/expect.js` — `expect(game).toX()` and `expect(locator).toX()` sugar, delegating straight to `GameDriver`'s `expect*` methods.
- `runner/trace.js` — per-test HTML trace files (`trace: on | retain-on-failure`) and asciinema `.cast` recordings, built from `game.getTrace()`.
- `runner/services.js` — background `services` (ready by output text or port) and `globalSetup`/`globalTeardown` around a run.
- `runner/reporter.js` — built-in reporters: console `list`/`dot` (sharing one summary/failure-block printer that prints §9 blocks), file-writing `json`/`junit`, and `github` annotations; several can run at once.
- `runner/run.js` — orchestration: parse CLI options → discover → collect every file (`.ts` included) → select (filters/grep/only/repeat-each) → start services/globalSetup → run files on up to `workers` concurrent workers (output kept in file order) → per test, open/close scopes (beforeAll/afterAll), set up requested fixtures with merged `test.use` options, run hooks + body under an adjustable deadline (inside an AsyncLocalStorage context), tear fixtures down, retry failures, write traces, report; plus `--watch`.
- `runner/init.js` — `rpgwright init`'s scaffold (a genuinely self-contained, dependency-free example that passes immediately).
- `bin/rpgwright.js` — the `rpgwright` CLI entry (`init`, `test` subcommands).

## Engineering conventions (in brief — see `RPGWright.md` §11 for the full rationale)

- DRY: one implementation per concern (e.g., every failure path renders through `formatFailureReport`, no parallel formatters).
- No unnecessary allocation/polling in hot paths; `waitUntil` only re-checks on actual update events.
- No stale code: superseded scaffolding is deleted in the same change that replaces it, not left "for reference."
- Prefer extending an existing file/function over creating a new one.
- No phase/plan references in source comments — that context belongs in commit messages and `agent_docs/`.

## `agent_docs/` index

- [`agent_docs/pty.md`](./agent_docs/pty.md) — node-pty spawn/write/resize/kill contract, the SIGHUP default-signal trap, process lifecycle. Read before touching `src/pty.js` or anything about process spawning/killing.
- [`agent_docs/terminal.md`](./agent_docs/terminal.md) — the `@xterm/headless` integration, why regex ANSI-stripping was rejected, how "current screen" is re-derived rather than accumulated. Read before touching `src/terminal.js` or debugging screen-text mismatches.
- [`agent_docs/assertions.md`](./agent_docs/assertions.md) — the four wait primitives (`waitUntil`, `waitUntilAbsent`, `waitForQuiet`, `pollUntil`), the update-emitter contract, `TimeoutError`, the failure-report format and its rationale. Read before touching `src/assertions.js` or any `expect*` method in `game.js`.
- [`agent_docs/layout.md`](./agent_docs/layout.md) — locators (lazy, strict screen regions), text/box detection over the cell grid, the pure layout checks and how they become waiting assertions. Read before touching `src/layout.js`, any locator matcher, or box detection.
- [`agent_docs/game-driver.md`](./agent_docs/game-driver.md) — the full `GameDriver` API (including `expectScreen`'s two matcher modes + snapshots), action history, signal/lifecycle handling, the diagnostics hook, and two documented real-world PTY/Ink timing gotchas found while building this (an input-wiring race at mount, and rapid-keystroke coalescing). Read before touching `src/game.js` or writing a new fixture app.
- [`agent_docs/runner.md`](./agent_docs/runner.md) — config resolution, the `game` fixture's launch/stop lifecycle, discovery/reporter behavior, the `init` scaffold, and how `rpgwright/test` self-references from inside this repo. Read before touching anything under `runner/` or `bin/`.
- [`agent_docs/testing-strategy.md`](./agent_docs/testing-strategy.md) — why RPGWright's own suite deliberately splits across `node:test` (internals/CLI black-box tests) and `rpgwright test` (GameDriver-integration dogfooding), what "well tested" means at each exit gate, and what Phase 4's real external integration (Watcher in the Dark) found. Read before adding a new test file, to know which runner it belongs on.

## `docs/` (consumer-facing, complete)

`docs/` is the usage guide for people using RPGWright in their own project — a different audience from `agent_docs/` above (see `RPGWright.md` §12 for the split). The nine pages required for the v1.0 exit gate (`intro.md`, `writing-tests.md`, `configuration.md`, `cli.md`, `assertions.md`, `key-sequences.md`, `diagnostics.md`, `best-practices.md`, `ci.md`) plus `layout-and-focus.md`. Never link from a `docs/` page into `agent_docs/` or vice versa — they're for different readers.
