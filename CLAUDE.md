# CLAUDE.md

Agent-facing gateway to this repo. Read this first; it's deliberately short. For anything beyond a one-line summary, follow the links into `agent_docs/`.

## What RPGWright is

A Playwright-like end-to-end testing framework for terminal applications that depend on real TTY behavior (raw input mode, ANSI escapes, alt-screen buffer, cursor positioning). It launches a target CLI inside a real pseudo-terminal (`node-pty`), drives it with real keystrokes, and asserts against the terminal's actual interpreted screen contents (`@xterm/headless`). Full design rationale: [`RPGWright.md`](./RPGWright.md) at the repo's parent directory context — see that file for the complete spec this build follows.

## Architecture

```
CLI (`rpgwright` bin: init / test / show-report subcommands)      [Phase 3]
   │
   ▼
Test runner (rpgwright/test — test(), expect(), fixtures, reporter) [Phase 3]
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
- `src/assertions.js` — `waitUntil()` (event-driven wait, never polling) and `formatFailureReport()` (the §9 failure block).
- `src/keys.js` — named key → raw byte sequence table (`KEY_SEQUENCES`), extendable via `launchGame`'s `keys` option.
- `src/game.js` — `GameDriver`/`launchGame()`, the public API: `press`, `type`, `expectText`, `stop`, plus `getScreenText`/`actions`.
- `src/index.js` — core package entry point re-exporting the above for advanced/direct consumption.
- `runner/`, `bin/rpgwright.js` — the bundled test runner and CLI (Phase 3; not yet built).

## Engineering conventions (in brief — see `RPGWright.md` §11 for the full rationale)

- DRY: one implementation per concern (e.g., every failure path renders through `formatFailureReport`, no parallel formatters).
- No unnecessary allocation/polling in hot paths; `waitUntil` only re-checks on actual update events.
- No stale code: superseded scaffolding is deleted in the same change that replaces it, not left "for reference."
- Prefer extending an existing file/function over creating a new one.
- No phase/plan references in source comments — that context belongs in commit messages and `agent_docs/`.

## `agent_docs/` index

- [`agent_docs/pty.md`](./agent_docs/pty.md) — node-pty spawn/write/resize/kill contract, the SIGHUP default-signal trap, process lifecycle. Read before touching `src/pty.js` or anything about process spawning/killing.
- [`agent_docs/terminal.md`](./agent_docs/terminal.md) — the `@xterm/headless` integration, why regex ANSI-stripping was rejected, how "current screen" is re-derived rather than accumulated. Read before touching `src/terminal.js` or debugging screen-text mismatches.
- [`agent_docs/assertions.md`](./agent_docs/assertions.md) — `waitUntil`'s event-driven design, the update-emitter contract, `TimeoutError`, the failure-report format and its rationale. Read before touching `src/assertions.js` or any `expect*` method in `game.js`.
- [`agent_docs/game-driver.md`](./agent_docs/game-driver.md) — the full `GameDriver` API, action history, signal/lifecycle handling, the diagnostics hook, and a documented real-world Ink input-timing race discovered while building this. Read before touching `src/game.js` or writing a new fixture app.

Docs not yet written (later phases): `testing-strategy.md`, `runner.md` (Phase 3). Consumer-facing `docs/` (Playwright-style usage guide) also starts in Phase 3 — see `RPGWright.md` §12.
