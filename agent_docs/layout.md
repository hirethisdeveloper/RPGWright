---
name: layout
description: src/layout.js — locators (lazy, strict screen regions), text and box-drawing detection over the cell grid, the pure layout checks, and how GameDriver.expectLayout turns them into waiting assertions.
---

# `layout.js` — locators and layout checks

## Why a separate module

Text assertions can't see where something is or how it's drawn. `layout.js` answers those questions from the styled cell grid that [[terminal]] exposes (`getScreenCells()`). It is pure: it takes a grid (plus wrapped-row flags and the screen size) and returns rects and verdicts, with no PTY, no waiting and no I/O. That keeps every geometry rule unit-testable in `test/layout.test.js` against synthetic ANSI rendered through the real emulator, while `game.js` adds only the waiting and the failure report.

Coordinates are 0-based cells. A rect is `{ x, y, width, height }`; `right = x + width` and `bottom = y + height` are exclusive.

## Finding text: string index ≠ column

`screenIndex(grid)` builds the same text `getScreenText()` returns (rows right-trimmed, joined by `\n`) plus a parallel array mapping every UTF-16 code unit back to its cell. That map is necessary because a wide character takes two columns but one code unit (and an emoji can take two code units in one cell), so after any wide character on a row, string index and column diverge. `findText` matches against that string (strings: every non-overlapping occurrence; RegExps: `matchAll` with a `g` copy, so a caller's stateful global needle is never mutated) and maps each match back to the bounding rect of its cells. A match across rows gets the rect covering all of them.

## Finding boxes

`findBoxes(grid)` finds rectangles drawn with box-drawing characters: every Ink `borderStyle` (single, round, double, bold/heavy, the mixed single/double styles, classic `+-|`). For each top-left candidate it scans right for a top-right candidate, then down both side edges until it finds matching bottom corners, recording each closed rectangle. Rules worth knowing before changing it:

- **Junctions count as corners** (`├ ┬ ┼ …`), so a panel split by a divider yields both halves *and* the whole, and table cells are boxes too.
- **A corner needs its edge drawn next to it.** The cells beside each corner along the top and bottom edges must be border characters (`edgeStarts`); otherwise ASCII `+` in ordinary text (`a+b` above `c+d`) made boxes.
- **Results are cached per grid** (a `WeakMap`; grids are immutable snapshots), so a screen update pays for detection once however many box locators and checks evaluate on it; callers must copy the shared array before sorting it. `title` is computed on first access. Detection is still proportional to the number of rectangles, which in a dense `┼` table is large by design (every rectangle, composites included: 12k boxes, ~20 ms, for a 120×40 table of 10×2 cells).
- **Top and bottom edges may contain anything except a pure corner.** Titles drawn into a top edge (`┌─ Inventory ─┐`) are allowed and reported as `title`. A pure corner (`┐`, `┌`, …) inside an edge means the scan has run from one box into a neighbouring one, so that candidate is rejected — this is what keeps two side-by-side boxes from being merged into one.
- **Side edges must be unbroken** vertical (or junction) characters.
- Results are ordered **innermost first** (smallest area), so `{ box: { containing } }` matching nested boxes puts the most specific one first.

## Locators

`createLocator(source, target, { nth, within })` returns a description of a region, never a stored rect. Every read (`resolveAll`) resolves it against the screen as it is at that moment, which is what lets an assertion on it wait through redraws. Targets:

| Target | Matches |
|---|---|
| `undefined` | the whole screen |
| string / RegExp | each text match |
| `{ x, y, width, height }` | that rect, as given |
| `{ row: n }` | the whole of row `n` |
| `{ box: true }` / `{ box: { containing } }` | bordered boxes, optionally only those whose interior or title contains a text match |

`within` (and the chained `locator.locator(target)`) keeps only matches contained in the outer locator's matches; `nth`/`first()`/`last()` pick one (negative indices count from the end). Text and rect matches are in reading order; box matches keep their innermost-first order.

**Locators are strict**: `resolveOne()` succeeds only for exactly one match and otherwise explains itself ("matched nothing", or "matched 3 regions (…); use .first(), .last() or .nth(i)"). `boundingBox()`/`textContent()`/`cells()` return `null` for no match and throw for several. The strictness paid off immediately in the dogfood suite: `{ box: { containing: 'Play' } }` also matched the INFO panel, because it shows "Selected: Play". Picking an arbitrary match would have made that test pass or fail depending on box order.

`source` is `{ getScreenCells, extend? }`. layout.js stays geometry-only: `extend(locator, { center })` is called for every locator `createLocator` builds (`.first()`, `.locator()`, `.nth()` included) and its result is merged in. `GameDriver` uses it to add `click`/`hover` (aimed with the pure `center()`, which throws when the locator matches nothing) and `driver`, the reference `runner/expect.js` uses to get from `expect(locator)` back to `GameDriver.expectLayout`. A locator made from a bare `{ getScreenCells }` source has none of these.

## Checks

`CHECKS` holds one pure function per matcher: `(rect, ctx, ...args) → { pass, expected, observed }`, where `ctx` provides `grid`, `wrapped`, `size` and `other(operand)` (an operand is a locator or a plain rect). `evaluateCheck(name, locator, args, { negate, grid, wrapped, size })` resolves the subject and runs the check.

- **Negation never rescues an unresolved region**, or a comparison that can't be made: `toHaveGap` between diagonal regions (no axis given) is `unresolved` too, and an unknown `toBeAligned` edge throws, so a typo can't pass as `not.toBeAligned('centre')`. If the subject or an operand doesn't resolve to exactly one rect, the result fails whether or not it's negated: "not left of X" can't be confirmed when X isn't on screen.
- **`expected` is phrased to follow the subject's description** (`locator("build 42") to be above locator("MENU NAV APP")`), and `observed` gives the actual geometry (`at (x=32, y=9, 8×1); other at (x=14, y=0, 12×1)`). `game.js` joins them as `Expected:` + `Observed:` lines in the §9 report (`formatFailureReport` indents multi-line `expected` text).
- **Centers are compared doubled** (`2x + width`) to stay in integers, with a default tolerance of one doubled unit: an odd-width item on an even-width screen can't be centered exactly, and half a cell off is the best a renderer can do.
- **`toHaveGap`** measures blank cells along the axis on which the two regions are separated (`gapX`/`gapY` are negative when spans overlap). If they're diagonal from each other the gap is ambiguous, so it fails and asks for `{ axis }`.
- **`toFitWithoutClipping`** flags only real signals: a row the terminal auto-wrapped (`isWrapped`, from `getWrappedRows()`), or region text ending in `…`/`...`. "Touches the last column" was the first design and was dropped: flush-right text (the fixture's `build 42`) does that legitimately. Apps that wrap or truncate text themselves (Ink does both) never trigger terminal auto-wrap, which is why the ellipsis signal matters.

## Style and focus

`firstStyleMismatch(grid, rect, spec)` is the single style comparison everything uses: it walks the region's **visible** cells (blank cells skipped, since a highlight usually doesn't cover trailing padding the same way across renderers) and returns the first one that differs from `spec` in a field `spec` names, `null` if all match, or `{ empty: true }` when the region has no visible characters. Colors in a spec go through `normalizeColor` into the same shape the grid uses; named colors map to palette indices 0–15, never to RGB, because the palette's actual colors belong to the user's theme.

Focus is configurable because TUIs mark it in different ways. `focusIndicators(grid, rect, cursor, focus)` reports which of three indicators mark a region:

- **marker**: the text left of the region on its first row ends with a string (or matches a RegExp). Checking the *preceding* text, not the region's own, is what lets `locator('Play')` be focused by the `> ` in `> Play`.
- **style**: `firstStyleMismatch(...) === null` for the given style.
- **cursor**: the visible cursor is in the region *or one cell past its right edge* on a covered row. A text input's cursor sits right after the typed text, outside the text's own rect; without that allowance, a focused text field would never count as focused.

`DEFAULT_FOCUS` is `{ cursor: true, style: { inverse: true } }`. The precedence is: indicators given to the assertion, then `launchGame`'s `focus` option (passed into the check context by `game.js`), then the default.

`evaluateFocusGroup` is the one evaluation that deliberately wants *several* matches: it counts how many of a locator's matches are focused and passes for exactly one. That catches both failure modes of a menu (no highlight at all, or a stale highlight left on the previous item).

A finding from the dogfood suite that shaped the docs: under `colorDepth: 'none'`, chalk drops *every* SGR attribute, inverse included. The menu-nav fixture's focused item loses its highlight completely, so a style-only focus indicator can't work without color; the fixture keeps a `> ` marker for that reason, and the suite asserts both.

Cursor assertions (`expectCursorAt`, `expectCursorVisible`) live in `game.js` rather than `CHECKS`, since they're about the screen's cursor rather than a region. `expectCursorAt(locator)` requires the cursor *inside* the region, unlike the focus indicator's one-past allowance: asking "is the cursor in this region" should mean exactly that.

## Snapshot helpers

The pure half of styled and masked snapshots lives here, because it is grid manipulation: `gridText(grid)` (text identical to `getScreenText()`, trimming only never-written cells), `maskGrid(grid, rects)` (a copy with covered cells replaced by an unstyled `*`), `styleSpans(grid)` / `parseStyleSpans(text)` (the `y:x+width style` serialization and its inverse), and `countCellDiffs(expected, actual)` for `maxDiffCells`.

`styleSpans` serializes the style a cell *visibly* has: on a blank cell only `bg`, `inverse` and `underline` are kept. Renderers differ in whether the padding around colored text carries the color; without this rule a snapshot would change with no visible difference. The cost is that a bold title's inner spaces split it into several spans, which is noisier but still correct.

## How a check becomes a waiting assertion

`GameDriver.expectLayout(locator, name, args, opts)` records an `expect` action, then `waitUntil`s on `evaluateCheck(...).pass`, re-evaluated on every screen update (see [[assertions]]). On timeout it evaluates once more for the freshest `expected`/`observed` text. `expectCount(locator, n)` does the same for match counts; `toBeVisible` is `count === 1` and `not.toBeVisible` is `count === 0`. All of it goes through `game.js`'s single `runAssertion` helper, so these failures look exactly like every other `expect*` failure. The grid cache in [[terminal]] is what makes re-evaluating several checks per update cheap.
