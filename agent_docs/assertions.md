---
name: assertions
description: waitUntil's event-driven design, the update-emitter contract with terminal.write(), TimeoutError, and the §9 failure-report format.
---

# `assertions.js`

## `waitUntil(onUpdate, predicate, { timeout, exitPromise })`

The one piece of genuinely non-obvious logic in the core. Contract:

1. Check `predicate()` synchronously first. If already true, resolve immediately — no subscription, no wasted tick. (`test/assertions.test.js`'s first case exists specifically to guard this fast path.)
2. Otherwise subscribe via `onUpdate(listener)`, which must return `{ dispose() }` — the same disposable shape used by `pty.js`'s `onData` (see [[pty]]). Re-check `predicate()` on every fire; never a `setInterval` poll.
3. Race against a `timeout` (rejects with `TimeoutError`) and, if given, an `exitPromise` (rejects with a plain `Error` explaining the process exited first) — but re-checks `predicate()` one last time before rejecting on exit, in case the final data chunk and the exit event arrive in either order.
4. Whichever path settles first, `cleanup()` always fires exactly once: clears the timer and disposes the subscription. No dangling listeners survive a settled `waitUntil` call (verified explicitly in `test/assertions.test.js`).

### The `onUpdate` emitter's contract is the load-bearing part

`onUpdate` is not wired directly to raw PTY bytes. In `game.js`, it's wired to fire *only after* `terminal.write(chunk)` has resolved:

```js
ptyHandle.onData((chunk) => {
  terminal.write(chunk).then(() => updates.emit(UPDATE_EVENT));
});
```

If this were wired to raw `onData` instead, `waitUntil`'s predicate (which reads `terminal.getScreenText()`) could run *before* that chunk's escape sequences were actually reflected in xterm's buffer state — a race that would make `expectText()` intermittently see stale content. This exact class of bug (checking derived state before the async operation that produces it has settled) is why the real input-timing race documented in [[game-driver]] was worth taking seriously rather than dismissing as test flakiness: the same "did the async side effect actually land yet" question applies on both the PTY-input side (that race) and the terminal-output side (what this contract prevents).

## `formatFailureReport(...)`

A pure formatter — no waiting, no side effects, so it's trivially unit-testable in isolation (`test/assertions.test.js` covers the block structure directly without spawning any process). Two things worth knowing if you touch it:

- **It does not synthesize the `launchGame(...)` entry itself.** `actions` is rendered exactly as given; `game.js` is responsible for prepending a synthetic `{ type: 'launchGame', detail: ... }` record ahead of `GameDriver.actions` before calling this, since `GameDriver.actions` (per the design in [[game-driver]]) only tracks `press`/`type`/`expect*` calls, not the launch itself. Keeping that synthesis in `game.js` rather than here keeps this module a dumb, testable formatter.
- **The no-diagnostics-hook note is the default, not a special case.** `extraDiagnostics` falsy → the exact §9 wording ships automatically; callers never need to construct that sentence themselves.

The exact block shape (header, `Scenario:`, `Last action:`, `Expected:`, `Current screen:`, `PTY exit code:`, `Diagnostics:`, numbered `Actions:` with a `← failed after this action` marker on the failed entry) is asserted line-by-line in both `test/assertions.test.js` (synthetic input) and `test/game.test.js` (a real failing `expectText` against the real fixture) — the latter is a permanent regression test, not a one-off manual check, per the Phase 1 exit gate requirement that the formatter be proven against an actual failure, not just inspected once and trusted.
