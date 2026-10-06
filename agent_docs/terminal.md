---
name: terminal
description: The @xterm/headless integration in src/terminal.js — why it was chosen over regex ANSI-stripping, how "current screen" is re-derived rather than accumulated, the styled cell grid (colors, attributes, wide characters, caching), cursor visibility tracking, and forwarding query replies.
---

# `terminal.js`

## Why @xterm/headless instead of hand-rolled ANSI parsing

A regex-based stripper can remove SGR color codes from a byte stream, but it cannot correctly interpret cursor-positioned redraws, alternate-screen-buffer switches, or box-drawing/CSI sequences that overwrite specific cells rather than appending text. Ink (and most TUI frameworks) redraw a full frame per update using exactly this kind of cursor-relative sequence — confirmed directly against `fixtures/minimal-ink-app`'s real output:

```
\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[GMINIMAL APP\r\n...
```

(clear-line + cursor-up, repeated once per line of the previous frame, then the new frame written from the cursor's new position). A regex stripper has no way to know that this sequence *replaces* three prior lines rather than adding new ones below them; `@xterm/headless` — the same engine VS Code's integrated terminal uses, running headless — interprets it correctly because it maintains real cell-grid buffer state, the same way a real terminal emulator does.

## API shape and the async `write()` contract

```js
createVirtualTerminal({ cols, rows })
// write(data): Promise<void>   — resolves only once xterm's own parser has
//                                 fully applied this chunk to buffer state
// resize(cols, rows)
// getScreenText(): string      — visible rows only, joined by \n
// getScreenLines(): string[]
// getScreenCells(): Cell[][]   — cells[y][x], styled, cached until the buffer changes
// getWrappedRows(): boolean[]  — true where a row continues the one above (auto-wrap)
// getScrollbackLines(): string[] — lines scrolled off the top (normal buffer only)
// getModes(): { altScreen, cursorVisible, applicationCursorKeys, bracketedPaste,
//               mouseTracking, mouseEncoding, focusReporting }
// getSignals(): { title, bellCount, hyperlinks: [{ uri, text }], clipboardWrites }
// getCursor(): { x, y, visible }
// getBufferType(): 'normal' | 'alternate'
// getSize(): { cols, rows }
// onReply(listener): Disposable — bytes the emulator answers queries with
// dispose()
```

`write()` wraps `Terminal#write(data, callback)` — xterm.js processes writes asynchronously and only guarantees `buffer` reflects a given chunk once that chunk's callback fires. This is the single most important contract in the whole module: **nothing may read screen state before a given `write()`'s promise resolves**, or it will see stale buffer content from before that chunk was applied. `game.js` builds its entire update-notification mechanism around this — see [[assertions]] for how the `onUpdate` emitter is wired to fire only after `write()` resolves, never directly off raw PTY bytes.

xterm.js does support calling `write()` repeatedly without awaiting between calls (it internally queues and processes chunks in FIFO order, firing each callback once *that* chunk is done) — this is the normal streaming-input use case and is exactly how `game.js` uses it (each PTY `onData` chunk triggers a `write().then(() => emit update)`, unawaited relative to the next chunk).

## The styled cell grid

`getScreenCells()` returns the visible screen as `cells[y][x]`, exactly one entry per column, so coordinates line up with what a user sees. Each cell is:

```js
{ ch, width, fg, bg, bold, dim, italic, underline, inverse, strike, invisible }
```

- **Colors** are normalized from xterm's mode+value pair: `null` for the terminal's default color, `{ palette: n }` for the 16 ANSI colors (0–15, with 8–15 the bright variants) and the 256-color palette, `{ rgb: '#rrggbb' }` for truecolor. The palette index isn't resolved to an RGB value, because what color index 1 looks like depends on the user's terminal theme; comparing indices is the honest assertion.
- **Wide characters** (CJK, most emoji) occupy two columns: the first cell has `width: 2` and the character, the second has `width: 0` and `ch: ''`. Keeping the continuation cell is what keeps `x` equal to the on-screen column for everything to its right.
- **Never-written cells** have `ch: ''` and `width: 1`, unlike a space the app wrote (`ch: ' '`). The distinction matters: `translateToString(true)` trims only never-written cells at the end of a row, so trailing spaces an app actually wrote are part of `getScreenText()`. An earlier version of the grid read both as `' '`, and text rebuilt from it trimmed written spaces too, which would have silently changed every existing `.snap` file and exact-screen match. [[layout]]'s `cellText()` renders a never-written cell as a space wherever text is shown.

Building the grid allocates one object per cell, and layout/style assertions read it on every update, often more than once. So the grid is cached and invalidated **synchronously inside `write()`'s parse callback** (and in `resize()`), which every buffer change passes through. Callers must treat it as read-only; it is replaced, never mutated, so holding a reference (as the action history does for traces) is a free, stable snapshot.

The first version invalidated on xterm's `onWriteParsed` event instead. That event is throttled to at most once per frame, so a reader between a chunk's parse and the event got the stale grid: three back-to-back writes read back as `a, a, a` instead of `a, ab, abc`. For an assertion, that means evaluating an old screen, and if no further update arrives it times out on a screen that is actually correct. `test/terminal.test.js`'s back-to-back test guards it.

## `write(data, onParsed)`

`write()` takes an optional `onParsed` callback that runs synchronously the moment xterm has applied that chunk, before the promise resolves. xterm parses queued chunks in batches within one tick, so a promise continuation can already see a *later* chunk's result. `game.js`'s frame history (`recordFrame`) uses `onParsed` so it records one screen per chunk, including screens that the very next chunk replaces.

## Cursor visibility and the active buffer

xterm's public API exposes cursor position but not visibility. `terminal.js` tracks DECTCEM itself with parser hooks: `CSI ? … h`/`l` sets visibility when parameter 25 is among the (possibly several) parameters, and a full reset (`ESC c`) or soft reset (`CSI ! p`) shows it again. Every handler returns `false` so xterm's own handling still runs. Ink and most full-screen TUIs hide the hardware cursor, which is why focus assertions can't rely on cursor position alone (see [[layout]]).

`getBufferType()` reports whether the app is on the alternate screen (`?1049h` and friends). `getScreenLines`/`getScreenCells` always read whichever buffer is active.

## `convertEol` for piped output

A PTY's line discipline turns the app's `\n` into `\r\n` before the terminal sees it; plain pipes don't. Without that, every line of piped output would start in the column where the previous line ended (a "staircase"). `createVirtualTerminal({ convertEol: true })` passes xterm's own `convertEol` option, and `game.js` sets it exactly when `tty: false`.

## Modes and out-of-band signals

`getModes()` combines xterm's public `terminal.modes` (bracketed paste, mouse tracking mode, application cursor keys, focus reporting) with what xterm doesn't expose and `terminal.js` tracks itself in the same private-mode CSI handler as DECTCEM: the **mouse report encoding** (`?1006` SGR, `?1015` urxvt, `?1005` UTF-8, else legacy X10). `game.js` needs the encoding to send mouse events the way the app asked for them.

`getSignals()` records what an app says *to the terminal* rather than draws: the title (`onTitleChange`), the bell (`onBell`, counted), OSC 8 hyperlinks and OSC 52 clipboard writes. The two OSC handlers return `false` so xterm's own handling continues. For OSC 8, the handler runs at that point in the parse, so the cursor marks where the link text starts (on the opening sequence) and ends (on the closing one); the text is read straight from the buffer line rather than from the cached grid, which may predate the chunk being parsed. OSC 52 payloads are base64-decoded; a `?` payload is a clipboard *read* request and isn't recorded. `getSignals()` returns copies.

`getScrollbackLines()` reads buffer lines `0 .. viewportY-1`: what has scrolled off the top of the normal screen. The alternate screen has no scrollback. The number kept is `createVirtualTerminal`'s `scrollback` option (xterm's default, 1000), exposed as a launch option.

## Query replies must be forwarded to the process

A real terminal answers some escape sequences: a cursor-position report request (`ESC[6n`, DSR) gets `ESC[<row>;<col>R`, a device-attributes request (`ESC[c`) gets `ESC[?1;2c`. Apps use these to find the cursor, detect terminal features, or measure how wide the terminal renders a character. xterm emits the answer through its `onData` event (the same event a browser-based xterm uses for user keystrokes), which `onReply` exposes. `game.js` forwards every reply to `ptyHandle.write`, skipping it once the process has exited. Before that wiring existed, an app that queried the terminal hung waiting for an answer that never came; `fixtures/term-probe`'s `query` mode reproduces that, and `test/rpg/term-probe` guards it.

Headless xterm only answers what it can compute without a renderer: DSR, DA and mode reports. It does not answer OSC 10/11 color queries (`ESC]11;?`, used to detect a light or dark background), because it has no theme. An app that requires an answer to those will still wait; answering them would need RPGWright to register its own OSC handler with a configured color scheme.

## "Current screen" is re-derived, never accumulated

`getScreenText()`/`getScreenLines()` read `terminal.buffer.active` fresh on every call (`buffer.viewportY + row` for each visible row), rather than concatenating raw bytes ever received. This matters because TUI frameworks redraw full frames — string-concatenating raw output would produce a scrolling transcript full of duplicated/overwritten content, not the actual visible screen a player would see. Verified directly in `test/terminal.test.js`'s "full-frame redraw... replaces rather than appends" case using a synthetic cursor-up/clear-line sequence matching the real one captured above.

## Manual verification (Phase 1 requirement)

Per the build plan, this module was verified manually against real captured PTY output from `fixtures/minimal-ink-app` before `assertions.js`/`game.js` were built on top of it — confirming initial-render, post-input-redraw, and post-resize screen text all matched what a real terminal would show, with no stale content bleeding through a redraw. That real-process path is also covered on an ongoing basis by `test/game.test.js`'s smoke test (through the full `GameDriver` API), so `terminal.test.js` itself sticks to fast, deterministic synthetic-ANSI unit tests rather than duplicating real-process coverage at a lower level.
