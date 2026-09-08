---
name: terminal
description: The @xterm/headless integration in src/terminal.js — why it was chosen over regex ANSI-stripping, and how "current screen" is re-derived rather than accumulated.
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
// getCursor(): { x, y }
// dispose()
```

`write()` wraps `Terminal#write(data, callback)` — xterm.js processes writes asynchronously and only guarantees `buffer` reflects a given chunk once that chunk's callback fires. This is the single most important contract in the whole module: **nothing may read screen state before a given `write()`'s promise resolves**, or it will see stale buffer content from before that chunk was applied. `game.js` builds its entire update-notification mechanism around this — see [[assertions]] for how the `onUpdate` emitter is wired to fire only after `write()` resolves, never directly off raw PTY bytes.

xterm.js does support calling `write()` repeatedly without awaiting between calls (it internally queues and processes chunks in FIFO order, firing each callback once *that* chunk is done) — this is the normal streaming-input use case and is exactly how `game.js` uses it (each PTY `onData` chunk triggers a `write().then(() => emit update)`, unawaited relative to the next chunk).

## "Current screen" is re-derived, never accumulated

`getScreenText()`/`getScreenLines()` read `terminal.buffer.active` fresh on every call (`buffer.viewportY + row` for each visible row), rather than concatenating raw bytes ever received. This matters because TUI frameworks redraw full frames — string-concatenating raw output would produce a scrolling transcript full of duplicated/overwritten content, not the actual visible screen a player would see. Verified directly in `test/terminal.test.js`'s "full-frame redraw... replaces rather than appends" case using a synthetic cursor-up/clear-line sequence matching the real one captured above.

## Manual verification (Phase 1 requirement)

Per the build plan, this module was verified manually against real captured PTY output from `fixtures/minimal-ink-app` before `assertions.js`/`game.js` were built on top of it — confirming initial-render, post-input-redraw, and post-resize screen text all matched what a real terminal would show, with no stale content bleeding through a redraw. That real-process path is also covered on an ongoing basis by `test/game.test.js`'s smoke test (through the full `GameDriver` API), so `terminal.test.js` itself sticks to fast, deterministic synthetic-ANSI unit tests rather than duplicating real-process coverage at a lower level.
