---
name: game-driver
description: The GameDriver API, action history, signal/lifecycle handling, the diagnostics hook, and a real Ink input-timing race discovered while building Phase 1.
---

# `game.js` — `GameDriver` / `launchGame()`

## What's implemented in Phase 1

`launchGame(options)` returns a `GameDriver` with `press`, `type`, `expectText`, `stop`, plus `getScreenText()` and `actions` (both trivial enough to ship early rather than gate behind Phase 2's `expectNotText`/`expectScreen`/`expectState`/`resize`). It wires together [[pty]] and [[terminal]] through the update-emitter contract described in [[assertions]].

## Action history shape

Every `press`/`type`/`expectText` call pushes `{ type, detail, ok }` onto `actions`, in call order. `press`/`type` set `ok: true` immediately (a raw write can't fail on its own). `expectText` starts a record at `ok: null` and flips it to `true`/`false` once `waitUntil` settles — the *same* record object is what gets passed to `formatFailureReport` as `failedRecord` on failure, so the report's "Last action" and the numbered list's `← failed after this action` marker both key off object identity (`fullActions.indexOf(failedRecord)`), not a fragile index number computed separately.

Note that `actions` does **not** include the `launchGame(...)` call itself — that's synthesized fresh inside `buildFailureMessage()` at failure time (`{ type: 'launchGame', detail: JSON.stringify({ command, args }) }`), not tracked as a persistent record. See [[assertions]] for why that split exists.

## `press` vs `press.raw`

`press(key)` looks up `key` in the merged key table (`KEY_SEQUENCES` plus `launchGame`'s `keys` override) and **throws on an unknown key name** rather than silently writing the string literally — this catches typos (`press('ENTR')`) at the point of the mistake instead of producing a silent no-op that only surfaces as a confusing downstream `expectText` timeout. `press.raw(bytes)` is the documented escape hatch for literal byte sequences not in the table; it's attached as a property on the `press` function itself (`press.raw = async (bytes) => {...}`), matching the exact shape called out in the build plan (§4's `keys.js` section: "a raw escape hatch (`press.raw(bytes)` or equivalent)").

## `stop()` and the SIGHUP trap

`stop()` sends `killSignal` (default `'SIGTERM'`, **not** node-pty's own default of `SIGHUP` — see [[pty]] for why that distinction matters), races the process's exit against `killTimeout`, and escalates to `SIGKILL` only if it doesn't exit in time. It's idempotent: calling it twice, or calling it after the target process already exited on its own (e.g., via an in-app quit keystroke), returns the same `exitInfo` without throwing — verified directly in `test/game.test.js` by having the fixture quit itself via a `type('q')` keystroke before `stop()` is ever called.

## A real Ink input-timing race (found via testing, not theorized)

While writing Phase 1's own test suite, `press()`/`press.raw()` calls issued **immediately** after an `expectText()` resolved on an Ink app's very first rendered frame intermittently failed to register — the keystroke was silently lost, and the subsequent `expectText()` for the post-keypress screen timed out. This was flaky, not deterministic: some runs succeeded, others didn't, which is the signature of a genuine race rather than a logic bug.

**Root cause:** Ink's `useInput` hook (`ink/build/hooks/use-input.js`) enables raw mode and attaches its stdin listener inside a `useEffect`, not synchronously during render/commit:

```js
useEffect(() => {
  setRawMode(true);
  return () => setRawMode(false);
}, [options.isActive, setRawMode]);
```

`useEffect` callbacks are deferred until *after* React's commit — but the actual terminal frame (e.g., the text "Press ENTER to continue") is flushed to stdout as part of that same commit, which can complete and become visible **before** the effect has run. Before `setRawMode(true)` fires, the child's stdin is still in cooked/canonical mode with no `'readable'` listener attached (`App.js`'s `handleSetRawMode` is what calls `stdin.addListener('readable', this.handleReadable)`, and it's only reachable through that same effect). A keystroke sent in that window can be lost.

This is **not an RPGWright bug** — `pty.js`'s `write()` and `terminal.js`'s screen interpretation are both correct; the race is entirely in the target app's own startup sequence. A real human player could never trigger it (no one reacts in sub-millisecond time to a freshly drawn screen), but an automated tool that reacts the instant matching text appears can, every time, if the target app happens to gate interactivity behind a deferred effect like this.

**Fix applied, at the source (`fixtures/minimal-ink-app/cli.js`), not papered over in RPGWright's core:** the fixture now gates its interactive prompt behind its own `ready` state, flipped by a `useEffect` declared *after* the `useInput(...)` call in the same component:

```js
useInput((input, key) => { /* ... */ });

// React flushes a component's effects in hook-declaration order, so this
// effect is guaranteed to run after useInput's own raw-mode-enabling effect.
useEffect(() => { setReady(true); }, []);

if (!ready) return <Text>Loading...</Text>;
// ... interactive content only rendered once ready
```

This makes the fixture's own readiness observable and condition-waitable (`expectText` on the real prompt text now only ever resolves once input truly works) — fully consistent with the "no arbitrary sleeps" principle (§2), since the fix is a real condition, not a timer. Five consecutive stress-test runs and the full test suite (32/32) passed reliably after this change, versus intermittent failures before it.

**Why this belongs here and not just in the fixture's source:** any real consumer testing a real Ink app that shows an interactive prompt before its own input handling is wired up will hit the exact same race, entirely outside RPGWright's control. This is worth surfacing prominently in the eventual `docs/best-practices.md` (Phase 3+) as guidance for consumers: *don't render an interactive prompt before your app can actually accept input* — good practice for a real app regardless of whether it's being tested. RPGWright's core deliberately does **not** work around this with a retry-on-press or an implicit settle delay, because both would be worse than the disease: a retry could double-submit a real keystroke the target app actually did receive but was just slow to respond to, and an implicit delay would violate the no-arbitrary-sleep principle for a problem that isn't RPGWright's to solve.
