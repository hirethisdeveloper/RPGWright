---
name: game-driver
description: The full GameDriver API (press/type/expectText/expectNotText/expectScreen/expectState/waitForStable/step/resize/stop), action history, environment options, signal/lifecycle handling, the diagnostics hook, and two real PTY/Ink timing gotchas discovered while building this.
---

# `game.js` — `GameDriver` / `launchGame()`

## What's implemented

`launchGame(options)` returns a `GameDriver` with `press`/`press.raw`, `type`, `expectText`, `expectNotText`, `expectScreen`, `expectState`, `waitForStable`, `step`, `resize`, `stop`, plus `getScreenText()` and `actions`. It wires together [[pty]] and [[terminal]] through the update-emitter contract described in [[assertions]], and the `expect*`/`wait*` methods build on [[assertions]]'s wait primitives rather than reimplementing wait logic per method (`expectText`/`expectScreen` on `waitUntil`, `expectNotText` on `waitUntilAbsent`, `waitForStable` on `waitForQuiet`, `expectState` on `pollUntil`; recording a snapshot runs `waitForQuiet` first). The exceptions are `waitForExit`/`expectExit`, which wait on the process rather than the screen: `exitWithin` races its exit against a timer. It also forwards the terminal's query replies back to the process (see [[terminal]]).

Layout, style and focus assertions (`locator`, `expectLayout`, `expectCount`, `expectFocusGroup`, `getFocused`) and the cursor ones (`expectCursorAt`, `expectCursorVisible`, `getCursor`) are covered in [[layout]]. Every `expect*`/`wait*` method goes through one helper, `runAssertion(type, detail, expected, wait)`, which records the action, runs the wait, and turns a failure into the §9 report; `expected` may be a function evaluated at failure time, which is how layout failures include an up-to-date `Observed:` line.

## Environment options: `term`, `colorDepth`, `locale`

`term` is passed to [[pty]] (it becomes `TERM`). `colorDepth` and `locale` are applied by `buildEnv()` on top of the caller's `env` before spawning: `COLOR_DEPTH_ENV` maps each depth to the variables to set and the ones to delete (`undefined` means delete), so an inherited `NO_COLOR` can't contradict a `'truecolor'` run and an inherited `COLORTERM` can't contradict `'none'`. `FORCE_COLOR` is the variable chalk/supports-color (and so Ink) honors; `NO_COLOR` and `COLORTERM` are the conventions most other libraries read. An unknown `colorDepth` throws from `launchGame` before anything is spawned. None of these change what RPGWright itself does with the output; they only change what the app is told about the terminal.

## Frame history, `expectSeen`, `expectNoFlicker`

Every parsed PTY chunk appends `{ seq, t, text }` to a bounded ring (`historySize`, default 500) via `terminal.write(chunk, recordFrame)`, which is synchronous per chunk (see [[terminal]]). Only text is stored per frame: storing a styled grid per chunk would allocate thousands of objects per update for every test, where text costs one string per row. Each action record stores `frame` (the frame count when it started), so "since the last input" is `lastInputFrame()`: the `frame` of the most recent `press`/`type`/`resize`.

- `expectSeen(needle, { since })` waits until any frame after that mark (or any retained frame, with `since: 'start'`), or the current screen, matches.
- `expectNoFlicker()` waits for quiet, then scans frames from the mark onward (inclusive: the frame showing when the input was sent is the predecessor a blank first frame needs) for a blank frame with drawn frames on both sides. It detects only whole-screen blanking; partial-redraw flicker would need per-frame grids.

## Traces and rendering

With `record: true`, each action record also stores `screen` (a grid reference) and `cursor`, captured when the action is recorded and again when an assertion settles, so a trace shows the screen each action *finished* on. Without `record` they're not kept: each grid is a full styled copy of the screen (about 0.6 MB at 120×40) and the action list is unbounded, so keeping them unconditionally made memory grow with every action. `stop()` keeps the final grid and cursor before disposing the terminal, so `getTrace()` and `renderHtml()` keep working afterwards. `getTrace()` returns `{ command, args, actions, frames, final, exitInfo, recording }`; the runner turns it into an HTML file (see [[runner]]). `renderHtml()` and the trace both draw screens with `src/render.js`: pure grid-to-HTML, xterm's default palette for indices, inverse as swapped colors, wide characters in a fixed two-column box, the cursor as an outline.

## `tty: false` and `record`

`tty: false` swaps [[pty]]'s `spawnPty` for `spawnPipe` and turns on the terminal's `convertEol`; everything above that (screen, assertions, traces) is unchanged, which is the point: piped-output behavior is tested with the same API. Every "has it exited?" decision (the fail-fast `exitPromise` in `waitForScreen`, `waitForExit`, `expectExit`) goes through `exitedAndParsed()`, which also waits for the last `terminal.write` to finish parsing: xterm parses asynchronously, and with pipes the exit routinely arrives while the end of a large output is still queued, which made `waitForExit(); expectText(...)` fail on a screen that hadn't caught up yet. `record: true` (set by the runner whenever traces are on) keeps every output chunk (`o`), input write (`i`, through the single `writeInput` path that `send` and the mouse share; terminal query replies are deliberately not recorded as input) and resize (`r`), timestamped in seconds, as `getTrace().recording`, which the runner writes as an asciinema v2 `.cast` file.

## Paste and mouse input

`paste(text)` mirrors a real terminal: wrapped in `ESC[200~`/`ESC[201~` only when the app has bracketed paste on, otherwise sent like typing. (The plan floated rejecting a paste when the mode is off; a real terminal doesn't do that, so neither does RPGWright.)

`game.mouse` (`down`/`up`/`move`/`click`/`wheel`/`drag`) encodes events with `keys.js`'s `encodeMouse(event, encoding)` in the encoding from `terminal.getModes()`. It throws if mouse tracking is off, since a real terminal would send nothing and a silently dropped click is the worst kind of test failure. Within a tracking mode it sends only what that mode reports (x10: presses; vt200: plus releases; drag: plus motion with a button held, tracked in `heldButton`; any: all motion); anything else is recorded as "not reported in <mode> mode" and not sent. `{ settle }` applies after *each* event: during a drag, the motion and release reports coalesced into one read without it, just as keystrokes do. `locator.click()`/`hover()` aim at the region's center through `source.driver.mouse`.

## Process exit and signals

`kill(signal)` forwards to the PTY and records a `kill` action. `waitForExit()` and `expectExit({ code, signal })` race `ptyHandle.waitForExit()` against `expectTimeout` (`exitWithin`). Signals compare as numbers (`os.constants.signals`), since node-pty reports the number. Every input action (`press`/`type`/`paste`/`mouse`/`resize`) stamps its record with the bell count, so `toHaveBell` can mean "since the last input".

## Terminal-state assertions

`expectTerminal(name, args, opts)` waits on one entry of `TERMINAL_CHECKS` (alt screen, title, bell, mouse tracking, bracketed paste, hyperlink, clipboard, scrollback): pure functions of `terminalState()` returning `{ pass, expected, observed }`, the same shape as the layout checks, through the same `runAssertion`. `opts.not` negates.

## `step(name, fn)` and nested action records

`step` records one `{ type: 'step' }` action, then runs `fn` with `stepDepth` incremented, so every action recorded inside is stamped `depth: n` and the failure report indents it (see [[assertions]]). The step record's `ok` flips to `false` if `fn` throws, and the error propagates unchanged — `step` adds structure to the report, not its own failure message. The runner's `test.step` is a thin delegation to the running test's `game.step`.

## `expectScreen`: string, RegExp and snapshot modes

`expectScreen(matcher, opts)` is deliberately *not* the same check as `expectText` with a different name. A string matcher requires the **entire visible screen to equal it exactly**; a RegExp matcher behaves like `expectText`'s (`.test()` against the full screen, so it matches anywhere) but is framed as a whole-screen assertion because pairing it with the string mode's exact-equality semantics makes the method genuinely useful for "assert there's nothing else unexpected on screen," which `expectText`'s substring check can't do. The third mode, `{ snapshot: name }`, is Jest/Vitest-style compare-and-store.

All three modes read the screen through `captureScreen(opts)`, which applies `mask` (strings/RegExps/locators/rects whose cells are replaced by `*` via `layout.maskGrid`) and `normalize` to the text, and with `styles: true` adds `layout.styleSpans(grid)`. Text is rebuilt from the grid with `layout.gridText`, which matches `getScreenText()` exactly (see [[terminal]] on never-written vs. written cells), so snapshots recorded before masking existed still compare equal.

Snapshot mode, in `matchSnapshot`:

- **Recording** happens if `<snapshotsDir>/<name>.snap` (or, with `styles`, `<name>.styles.snap`) is missing, or `opts.updateSnapshot`/the `updateSnapshots` launch option (from `--update-snapshots` or `RPGWRIGHT_UPDATE_SNAPSHOTS=1`) is set. It first waits for `DEFAULT_STABLE_QUIET` ms without an update (`waitForQuiet`, unless `stable: false`): recording the instant a test reached the line used to be able to capture a frame mid-redraw, baking a half-drawn screen into the reference. `test/rpg/term-probe` guards this by snapshotting a spinner.
- **Comparing** waits (`waitForScreen`) until the capture equals the stored text and styles, or, with `maxDiffCells: n`, until `layout.countCellDiffs` (differing characters plus differing cell styles) is at most `n`.
- **On failure**, `expectScreen` passes `runAssertion` an `expected` function returning `{ expected, diff }`, so the report shows a row diff of the text and a line-set diff of the styles against a fresh capture.

`snapshotsDir` defaults to `<cwd>/__snapshots__`; every snapshot-mode test in `test/rpg/**` points it at a temp directory so the repo doesn't accumulate generated snapshot files from its own test runs.

## Action history shape

Every `press`/`type`/`expect*`/`wait*`/`step` call pushes `{ type, detail, ok, depth }` onto `actions`, in call order. `press`/`type`/`resize` set `ok: true` immediately (a raw write or resize call can't fail on its own). Any `expect*` call starts a record at `ok: null` and flips it to `true`/`false` once its underlying wait settles — the *same* record object is what gets passed to `formatFailureReport` as `failedRecord` on failure, so the report's "Last action" and the numbered list's `← failed after this action` marker both key off object identity (`fullActions.indexOf(failedRecord)`), not a fragile index number computed separately.

Note that `actions` does **not** include the `launchGame(...)` call itself — that's synthesized fresh inside `buildFailureMessage()` at failure time (`{ type: 'launchGame', detail: JSON.stringify({ command, args }) }`), not tracked as a persistent record. See [[assertions]] for why that split exists.

## `press` vs `press.raw`, and chords

`press(key)` resolves `key` through `keys.js`'s `resolveKey(key, table)` against the merged key table (`KEY_SEQUENCES` plus `launchGame`'s `keys` override). An exact table entry always wins, so overrides and the legacy names (`CTRL_C`, `ARROWUP`) behave exactly as before. Otherwise `key` is parsed as a Playwright-style chord (`'Control+ArrowLeft'`, `'Shift+Tab'`, `'Alt+x'`) and encoded the way xterm encodes it: the `1;<mod>` CSI parameter for cursor/function keys, a control byte for Ctrl+letter, an ESC prefix for Alt. Named keys match case-insensitively, and a single character is sent as-is. Chords a terminal can't distinguish from the unmodified key (`Control+Enter`, `Shift+1`) throw a specific "no standard terminal encoding" error rather than silently sending the plain key; apps using an extended keyboard protocol get those via `press.raw`.

`press` **throws on an unknown key name** rather than silently writing the string literally — this catches typos (`press('ENTR')`) at the point of the mistake instead of producing a silent no-op that only surfaces as a confusing downstream `expectText` timeout. `press.raw(bytes)` is the documented escape hatch for literal byte sequences not in the table; it's attached as a property on the `press` function itself (`press.raw = async (bytes) => {...}`), matching the exact shape called out in the build plan (§4's `keys.js` section: "a raw escape hatch (`press.raw(bytes)` or equivalent)").

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

**Not an RPGWright bug, and not fixed with implicit product behavior.** The write path did exactly what it was asked: three separate one-byte writes went out. What happens to bytes between leaving the pty master and being read by the child's stdin is governed by the OS and the target app's own input parser — and a real, very fast human "button masher" can trigger this exact same coalescing on a real terminal. A retry or a hidden inter-write delay in `press()` would be exactly the kind of magic behavior §2 rules out (and could double-fire an input the app actually did receive but was just slow to render). The fix lives in the *test*: confirm each keystroke's on-screen effect (`expectText`/`expectState`) before sending the next, which is also just the idiomatic way to drive a target app through this API.

**The explicit opt-in: `{ settle }`.** `press`, `press.raw` and `type` accept `{ settle: true | ms }`, which runs `waitForStable` right after the write: it waits until the screen has gone quiet (no update for 150ms, or `ms`), measured from real update events. That's not a fixed sleep and not a retry; it waits for the app to finish reacting, which also guarantees the next write lands in a separate `read()`. It stays opt-in because it costs at least the quiet window per keystroke, and because a specific `expectText` remains the stronger check when one exists. `navigation.rpg.test.js` uses it in the typed-digit and triple-space tests in place of an intermediate `expectText`, and those passed three consecutive full-suite runs.

### The risk is specific to plain text, not to named/escape-sequence keys

A second instance surfaced later, under heavier load (three full test runs back to back): `type('2')` immediately followed by `press('ENTER')` — no confirmation in between — intermittently failed the same way (`test/rpg/menu-nav/navigation.rpg.test.js`, several tests). Sending `'2\r'` as one coalesced chunk to confirm the mechanism reproduced something worse than a dropped keystroke: the fixture's `useInput` handler checked `/[0-9]/.test(input)` with no length guard, so it matched the *whole* two-character paste string and appended the literal `'2\r'` — carriage return included — into `typedBuffer`. Rendering a bare `\r` mid-line then moved the cursor back to the start of that terminal row, so the *next* character painted over the line's own text, corrupting the visible screen (`)rrow keys` where `arrow keys` should have been) — and the Enter press was gone with no transition to the next screen, since a multi-character paste gets none of Ink's `key.*` flags set, including `key.return`.

Stress-testing showed this is **not** a risk for escape-sequence-based named keys (arrows, function keys, etc.) sent back to back with no confirmation — `press('ARROWDOWN')` immediately followed by `press('ENTER')` passed 8/8 repeated runs. The likely reason: a CSI sequence (`ESC [ ... final-byte`) is self-delimiting, so Ink's ANSI-aware parser can find sequence boundaries and split multiple recognized sequences out of one chunk correctly. Plain printable characters have no such structure — a run of them is indistinguishable from an actual paste, so it's handled as one opaque string. In practice, this means the confirm-before-the-next-action rule (above) matters most specifically for **`type()` calls, and anything typed immediately before a `press()`** — not for chains of named-key presses, which have held up reliably under the same stress testing.

A later full-suite run (after per-chunk frame capture was added to `game.js`, which shifts timing slightly) saw the full-navigation scenario fail once at exactly an unconfirmed `press('ARROWDOWN')` → `press('ENTER')` pair, and it didn't reproduce in about twenty further runs. Escape sequences are *less* exposed than plain text, not immune; that pair now uses `{ settle: true }`, and no unconfirmed pairs remain in the suite.

Fixed two ways, consistent with how the mount-race above was handled — at the source, not papered over centrally:
- The fixture (`fixtures/menu-nav-ink-app/cli.js`) now guards its digit check with `input.length === 1`, so a multi-character paste can no longer be silently absorbed into `typedBuffer` — a real Ink app should defend against paste-corrupting single-character-oriented state the same way.
- Every `type(digit)` in the test suite immediately followed by `press('ENTER')` now confirms the digit actually registered first (`await game.expectText('(typed: 2)')`) before sending Enter — the same "confirm before the next action" pattern as the `press.raw(' ')` case above, applied to the one common real-world shape (type text, press Enter to submit) that's easy to overlook since it reads as "one action" even though it's two writes.
