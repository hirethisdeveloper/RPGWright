# CLAUDE.md

Agent-facing gateway to this repo. Read this first; it's deliberately short. For anything beyond a one-line summary, follow the links into `agent_docs/`.

## What RPGWright is

A Playwright-like end-to-end testing framework for terminal applications that depend on real TTY behavior (raw input mode, ANSI escapes, alt-screen buffer, cursor positioning). It launches a target CLI inside a real pseudo-terminal (`node-pty`), drives it with real keystrokes, and asserts against the terminal's actual interpreted screen contents (`@xterm/headless`). Full design rationale: [`RPGWright.md`](./RPGWright.md) at the repo's parent directory context — see that file for the complete spec this build follows.

## Architecture

```
CLI (`rpgwright` bin: init / test subcommands)
   │
   ▼
Test runner (rpgwright/test — test(), expect(), fixtures, reporter)
   │
   ▼
GameDriver  (game.js — public Playwright-like API)
   │
   ├── press(key) / type(text)          → pty.js: write bytes
   ├── expectText/expectNotText/...      → assertions.js: waitUntil()
   ├── resize(cols, rows)                → pty.js + terminal.js
   └── stop()                            → pty.js: signal + escalate
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
- `src/assertions.js` — three wait primitives (`waitUntil`, `waitUntilAbsent`, `pollUntil`, all event/poll-driven, never a raw setInterval-as-sync-mechanism) and `formatFailureReport()` (the §9 failure block).
- `src/keys.js` — named key → raw byte sequence table (`KEY_SEQUENCES`), extendable via `launchGame`'s `keys` option.
- `src/game.js` — `GameDriver`/`launchGame()`, the full public API: `press`/`press.raw`, `type`, `expectText`, `expectNotText`, `expectScreen`, `expectState`, `resize`, `stop`, plus `getScreenText`/`actions`.
- `src/index.js` — core package entry point re-exporting the above for advanced/direct consumption.
- `runner/config.js` — `rpgwright.config.js` loader + validation; defaults `testDir`/`testMatch`/`timeout` only (launchGame-specific fields pass through untouched).
- `runner/discover.js` — hand-rolled glob-to-RegExp test-file discovery (no external glob dependency).
- `runner/test.js` — the `test()`/`describe()`/`test.skip` authoring API and its per-file registry (`_beginFile`/`_collect`), re-exported with `expect` as `rpgwright/test`.
- `runner/expect.js` — `expect(game).toX()` sugar, delegating straight to `GameDriver`'s `expect*` methods.
- `runner/reporter.js` — the one built-in console reporter (list-style, prints §9 blocks on failure).
- `runner/run.js` — orchestration: discover → for each file, launch a fresh `GameDriver` per test, run it (bounded by `config.timeout`), auto-`stop()` in a `finally`, report.
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
- [`agent_docs/assertions.md`](./agent_docs/assertions.md) — the three wait primitives (`waitUntil`, `waitUntilAbsent`, `pollUntil`), the update-emitter contract, `TimeoutError`, the failure-report format and its rationale. Read before touching `src/assertions.js` or any `expect*` method in `game.js`.
- [`agent_docs/game-driver.md`](./agent_docs/game-driver.md) — the full `GameDriver` API (including `expectScreen`'s two matcher modes + snapshots), action history, signal/lifecycle handling, the diagnostics hook, and two documented real-world PTY/Ink timing gotchas found while building this (an input-wiring race at mount, and rapid-keystroke coalescing). Read before touching `src/game.js` or writing a new fixture app.
- [`agent_docs/runner.md`](./agent_docs/runner.md) — config resolution, the `game` fixture's launch/stop lifecycle, discovery/reporter behavior, the `init` scaffold, and how `rpgwright/test` self-references from inside this repo. Read before touching anything under `runner/` or `bin/`.
- [`agent_docs/testing-strategy.md`](./agent_docs/testing-strategy.md) — why RPGWright's own suite deliberately splits across `node:test` (internals/CLI black-box tests) and `rpgwright test` (GameDriver-integration dogfooding), and what "well tested" means at each exit gate. Read before adding a new test file, to know which runner it belongs on.

Consumer-facing `docs/` (Playwright-style usage guide, for people using RPGWright in their own project rather than working on RPGWright itself) starts in Phase 3 — see `RPGWright.md` §12.
