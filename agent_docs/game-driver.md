---
name: game-driver
description: The full GameDriver API (press/type/expectText/expectNotText/expectScreen/expectState/resize/stop), action history, signal/lifecycle handling, the diagnostics hook, and two real PTY/Ink timing gotchas discovered while building this.
---

# `game.js` — `GameDriver` / `launchGame()`

## What's implemented

`launchGame(options)` returns a `GameDriver` with `press`/`press.raw`, `type`, `expectText`, `expectNotText`, `expectScreen`, `expectState`, `resize`, `stop`, plus `getScreenText()` and `actions`. It wires together [[pty]] and [[terminal]] through the update-emitter contract described in [[assertions]], and every `expect*` method builds on exactly one of [[assertions]]'s three wait primitives rather than reimplementing wait logic per method (`expectText`/`expectScreen` on `waitUntil`, `expectNotText` on `waitUntilAbsent`, `expectState` on `pollUntil`).

## `expectScreen`'s two matcher modes

`expectScreen(matcher, opts)` is deliberately *not* the same check as `expectText` with a different name. A string matcher requires the **entire visible screen to equal it exactly**; a RegExp matcher behaves like `expectText`'s (`.test()` against the full screen, so it matches anywhere) but is framed as a whole-screen assertion because pairing it with the string mode's exact-equality semantics makes the method genuinely useful for "assert there's nothing else unexpected on screen," which `expectText`'s substring check can't do. The third mode, `{ snapshot: name }`, is Jest/Vitest-style: if `<snapshotsDir>/<name>.snap` doesn't exist yet (or `opts.updateSnapshot`/`RPGWRIGHT_UPDATE_SNAPSHOTS=1` is set), the current screen is captured and written immediately, with no waiting — recording a new snapshot isn't a condition to wait for. If it exists, the stored text becomes the `waitUntil` predicate's target, same as string-mode equality. `snapshotsDir` defaults to `<cwd>/__snapshots__`; every snapshot-mode test in `test/menu-nav.test.js` overrides it to a temp directory specifically so the repo doesn't accumulate generated snapshot files from its own test runs.

## Action history shape

Every `press`/`type`/`expect*` call pushes `{ type, detail, ok }` onto `actions`, in call order. `press`/`type`/`resize` set `ok: true` immediately (a raw write or resize call can't fail on its own). Any `expect*` call starts a record at `ok: null` and flips it to `true`/`false` once its underlying wait settles — the *same* record object is what gets passed to `formatFailureReport` as `failedRecord` on failure, so the report's "Last action" and the numbered list's `← failed after this action` marker both key off object identity (`fullActions.indexOf(failedRecord)`), not a fragile index number computed separately.

Note that `actions` does **not** include the `launchGame(...)` call itself — that's synthesized fresh inside `buildFailureMessage()` at failure time (`{ type: 'launchGame', detail: JSON.stringify({ command, args }) }`), not tracked as a persistent record. See [[assertions]] for why that split exists.

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

## Rapid, unconfirmed keystrokes can be coalesced before the target app ever sees them

Found while writing `test/menu-nav.test.js`: three back-to-back `press.raw(' ')` calls, fired without awaiting each one's on-screen effect first, only incremented the fixture's score by 1 instead of 3. This is a different mechanism from the mount-timing race above — it happens well after the app is already accepting input.

**Root cause:** each `press()`/`type()` call does one `ptyHandle.write()` and returns immediately (per §4's design: the write is "effectively synchronous," the *next* `expect*` call is what actually waits). Three such calls fired in quick succession, only microtask-ticks apart, can have their bytes land in the kernel's tty input buffer close enough together that a single `read()` on the child's end returns all three as one chunk. Ink's `handleReadable` (`App.js`) treats a multi-character chunk as a single **paste** event (its own doc comment: "if user pastes text and it's more than one character, the callback will be called only once and the whole string will be passed as `input`"), not as N separate keypresses. The fixture's handler checked `input === ' '` (strict equality against a single space), so a coalesced `'  '`/`'   '` chunk matched nothing and was silently dropped — explaining the partial count (some presses landed alone, others merged and were ignored).

**Not an RPGWright bug, and not fixed with product code.** The write path did exactly what it was asked: three separate one-byte writes went out. What happens to bytes between leaving the pty master and being read by the child's stdin is governed by the OS and the target app's own input parser — and a real, very fast human "button masher" can trigger this exact same coalescing on a real terminal. A retry or an inter-write delay in `press()` would be exactly the kind of magic behavior §2 rules out (and could double-fire an input the app actually did receive but was just slow to render). The correct fix lives in the *test*: confirm each keystroke's on-screen effect (`expectText`/`expectState`) before sending the next, which is also just the idiomatic way to drive a target app through this API.

### The risk is specific to plain text, not to named/escape-sequence keys

A second instance surfaced later, under heavier load (three full test runs back to back): `type('2')` immediately followed by `press('ENTER')` — no confirmation in between — intermittently failed the same way (`test/rpg/menu-nav/navigation.rpg.test.js`, several tests). Sending `'2\r'` as one coalesced chunk to confirm the mechanism reproduced something worse than a dropped keystroke: the fixture's `useInput` handler checked `/[0-9]/.test(input)` with no length guard, so it matched the *whole* two-character paste string and appended the literal `'2\r'` — carriage return included — into `typedBuffer`. Rendering a bare `\r` mid-line then moved the cursor back to the start of that terminal row, so the *next* character painted over the line's own text, corrupting the visible screen (`)rrow keys` where `arrow keys` should have been) — and the Enter press was gone with no transition to the next screen, since a multi-character paste gets none of Ink's `key.*` flags set, including `key.return`.

Stress-testing showed this is **not** a risk for escape-sequence-based named keys (arrows, function keys, etc.) sent back to back with no confirmation — `press('ARROWDOWN')` immediately followed by `press('ENTER')` passed 8/8 repeated runs. The likely reason: a CSI sequence (`ESC [ ... final-byte`) is self-delimiting, so Ink's ANSI-aware parser can find sequence boundaries and split multiple recognized sequences out of one chunk correctly. Plain printable characters have no such structure — a run of them is indistinguishable from an actual paste, so it's handled as one opaque string. In practice, this means the confirm-before-the-next-action rule (above) matters most specifically for **`type()` calls, and anything typed immediately before a `press()`** — not for chains of named-key presses, which have held up reliably under the same stress testing.

Fixed two ways, consistent with how the mount-race above was handled — at the source, not papered over centrally:
- The fixture (`fixtures/menu-nav-ink-app/cli.js`) now guards its digit check with `input.length === 1`, so a multi-character paste can no longer be silently absorbed into `typedBuffer` — a real Ink app should defend against paste-corrupting single-character-oriented state the same way.
- Every `type(digit)` in the test suite immediately followed by `press('ENTER')` now confirms the digit actually registered first (`await game.expectText('(typed: 2)')`) before sending Enter — the same "confirm before the next action" pattern as the `press.raw(' ')` case above, applied to the one common real-world shape (type text, press Enter to submit) that's easy to overlook since it reads as "one action" even though it's two writes.
