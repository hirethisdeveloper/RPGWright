# Layout and focus

Text assertions tell you *what* is on screen. The assertions on this page tell you *where* it is and *how it's drawn*: whether a panel sits beside the menu or on top of it, whether a title is centered, whether a status line got cut off, and which item has focus. Like every RPGWright assertion, they wait for the screen to match rather than checking once.

Positions and sizes are in terminal cells, counted from 0: `x` is the column, `y` the row. A region is a rectangle `{ x, y, width, height }`.

## Locators

A locator describes a region of the screen. Get one from `game.locator(target)`:

```js
game.locator('Settings');                           // the text "Settings"
game.locator(/Score: \d+/);                         // a regular-expression match
game.locator({ box: { containing: 'Inventory' } }); // the bordered box around "Inventory"
game.locator({ box: true });                        // every bordered box
game.locator({ row: 0 });                           // the whole first row
game.locator({ x: 0, y: 2, width: 20, height: 5 }); // an explicit rectangle
game.locator();                                     // the whole screen
```

A locator doesn't capture the screen when you create it. Every assertion looks it up again on each screen update, so you can create one before the thing it describes has been drawn.

**Boxes** are rectangles drawn with box-drawing characters: every Ink `borderStyle`, and the `┌─┐ │ └─┘` family generally, including ASCII `+-|`. Text drawn into the top border, as in `┌─ Inventory ─┐`, counts as part of the box. When boxes are nested, `{ box: { containing } }` lists the innermost one first.

### Narrowing a locator

```js
const items = game.locator(/^. (Play|Settings|Quit)/m);
items.first();                       // the first match, in reading order
items.last();
items.nth(1);                        // the second match
const panel = game.locator({ box: { containing: 'INFO' } });
panel.locator('Selected');           // "Selected", but only inside the panel
```

### Locators are strict

An assertion on a locator needs it to match **exactly one** region. If it matches several, the assertion fails and lists them, rather than quietly using the first:

```
locator(box containing "Play") matched 2 regions ((x=0, y=1, 13×5), (x=15, y=1, 20×5)); use .first(), .last() or .nth(i) to pick one
```

When that happens, either pick one with `.first()`/`.nth(i)`, or choose text that's actually unique. The message above came from a real test: "Play" appeared in the menu box *and* in a side panel showing `Selected: Play`.

### Reading a locator

These read the screen once, without waiting:

| Method | Returns |
|---|---|
| `count()` | how many regions match right now |
| `boundingBox()` | `{ x, y, width, height }`, or `null` if nothing matches |
| `textContent()` | the text inside the region, or `null` |
| `cells()` | the region's cells with their styles (see [Focus and style](#focus-and-style)) |

`boundingBox()`, `textContent()` and `cells()` throw if the locator matches more than one region.

## Layout assertions

```js
const { test, expect } = require('rpgwright/test');

test('the side panel sits beside the menu', async ({ game }) => {
  const menu = game.locator({ box: { containing: 'Quit' } });
  const info = game.locator({ box: { containing: 'INFO' } });

  await expect(info).toBeRightOf(menu);
  await expect(info).not.toOverlap(menu);
  await expect(info).toBeAligned('top', { with: menu });
  await expect(info).toHaveGap(menu, { min: 2, max: 2 });
});
```

Wherever an assertion takes another region, you can pass a locator or a plain `{ x, y, width, height }` rectangle.

| Assertion | Passes when |
|---|---|
| `toBeVisible()` | the locator matches exactly one region |
| `not.toBeVisible()` | it matches nothing |
| `toHaveCount(n)` | it matches exactly `n` regions |
| `toHaveBox({ x, y, width, height }, { tolerance })` | each given field matches. Give any subset; each value is a number or a `[min, max]` range, and `tolerance` allows ±n on numbers. |
| `toBeAt(x, y)` | its top-left corner is at `(x, y)` |
| `toBeWithinScreen()` | it lies entirely on screen |
| `toBeWithin(other)` | it lies entirely inside `other` |
| `toOverlap(other)` | the two regions share at least one cell |
| `toBeLeftOf(other)`, `toBeRightOf(other)`, `toBeAbove(other)`, `toBeBelow(other)` | it lies entirely on that side of `other` |
| `toHaveGap(other, { min, max, axis })` | the number of blank cells between the two is within `min`..`max` |
| `toBeAligned(edge, { with, tolerance })` | the given edge lines up with `with` (another region; the screen if omitted) |
| `toFitWithoutClipping()` | its text wasn't cut off (see below) |
| `toHaveText(needle)` | the text inside the region contains `needle` (a string or RegExp) |

Every assertion accepts `{ timeout }` in its options, and every one except `toHaveCount` has a `not.` form.

**`toHaveGap`** counts blank cells along the direction in which the regions are apart: columns if they're side by side, rows if one is above the other. If they're diagonal from each other, pass `{ axis: 'x' }` or `{ axis: 'y' }`.

**`toBeAligned`** takes `'left'`, `'right'`, `'top'`, `'bottom'`, `'center'` (horizontal) or `'middle'` (vertical). `'center'` and `'middle'` allow half a cell of difference by default: centering a 12-cell title on an 81-cell screen can't come out exact.

**`toFitWithoutClipping`** fails if the terminal had to wrap a line inside the region, or if the region's text ends in an ellipsis (`…` or `...`, which Ink's `wrap="truncate"` produces). Text that merely reaches the right edge, like a right-aligned status line, passes.

### A negated assertion still needs its regions

`not.toBeLeftOf(other)` fails, rather than passing, if either locator matches nothing or several regions. "Not left of the sidebar" can't be confirmed when there's no sidebar. To assert that something is absent, use `not.toBeVisible()`.

### Failure output

A layout failure produces the standard failure report, with an `Observed:` line giving the actual positions:

```
Expected:
  locator("build 42") to be above locator("MENU NAV APP")
  Observed: at (x=32, y=9, 8×1); other at (x=14, y=0, 12×1)
```

## Focus and style

### Style

`toHaveStyle(style)` checks how a region is drawn. Give only the fields you care about:

```js
await expect(game.locator('Play')).toHaveStyle({ inverse: true, fg: 'cyan' });
await expect(game.locator('Error:')).toHaveStyle({ fg: 'red', bold: true });
await expect(game.locator('Settings')).toHaveStyle({ inverse: false, fg: null });
```

| Field | Values |
|---|---|
| `fg`, `bg` | `null` (the terminal's default color), a color name, a palette index `0`–`255`, or `'#rrggbb'` |
| `bold`, `dim`, `italic`, `underline`, `inverse`, `strike` | `true` or `false` |

Color names are the 16 standard terminal colors: `black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`, and `brightBlack` (also `gray`/`grey`) through `brightWhite`. They match the palette index the app chose, not a particular shade, because what "cyan" looks like depends on the user's terminal theme.

Every character in the region has to match; spaces are ignored. On failure the report names the first cell that didn't match and how it was actually drawn:

```
Observed: at (x=3, y=3, 8×1); cell (3, 3) "S" has fg=default, bg=default
```

`locator.cells()` gives you every cell's style if you need to inspect it yourself.

### Focus

Terminal apps show focus in different ways: a highlighted (often inverse) row, a marker like `>` in front of the item, or the blinking cursor in a text field. `toBeFocused()` passes if any of the **focus indicators** you've configured marks the region:

```js
await game.press('ArrowDown');
await expect(game.locator('Settings')).toBeFocused();
```

| Indicator | Focused when |
|---|---|
| `style: { … }` | every character in the region has this style (see [Style](#style)) |
| `marker: '> '` | the text just left of the region on the same row ends with this string. A RegExp is tested against all the text left of the region instead, e.g. `/[>▶]\s*$/`. |
| `cursor: true` | the visible cursor is inside the region, or just after it on the same row (where a text field's cursor sits) |

The default is `{ style: { inverse: true }, cursor: true }`. To match how your app shows focus, set `focus` in `rpgwright.config.js` (see [Configuration](./configuration.md#launch-options)), with `test.use()`, or in a single assertion:

```js
await expect(game.locator('Play')).toBeFocused({ marker: '> ' });
```

To check that a menu or list has exactly one focused item (not none, and not two after a rendering bug), use a locator that matches all of them:

```js
const options = game.locator(/Play|Settings|Quit/);
await expect(options).toHaveExactlyOneFocused();
game.getFocused(options); // [{ x, y, width, height }] of the focused match(es), right now
```

Check your focus indicator under `colorDepth: 'none'` too. Most color libraries drop *all* styling when color is off, inverse included, so a style-only indicator stops working there. A marker still works:

```js
describe('without color', () => {
  test.use({ colorDepth: 'none' });

  test('still shows which option is selected', async ({ game }) => {
    await expect(game.locator('Play')).toBeFocused({ marker: '> ' });
  });
});
```

### The cursor

```js
await expect(game).toHaveCursorVisible();
await expect(game).not.toHaveCursorVisible();
await expect(game).toHaveCursorAt(10, 1);                    // exact cell
await expect(game).toHaveCursorAt(game.locator({ row: 1 })); // anywhere in a region
game.getCursor();                                            // { x, y, visible }, right now
```

Many full-screen apps, Ink apps included, hide the cursor entirely; text inputs usually show it.

## Testing several terminal sizes

Layout problems usually show up at particular sizes. Use `test.use()` to run a group of tests at a given size (see [Writing tests](./writing-tests.md#per-group-options-testuse)):

```js
describe('on a wide terminal', () => {
  test.use({ cols: 80, rows: 20 });

  test('shows the INFO panel', async ({ game }) => {
    await expect(game.locator({ box: { containing: 'INFO' } })).toBeVisible();
  });
});
```

To run the same test at every size in your config's `viewports`, use `test.eachViewport()` (see [Writing tests](./writing-tests.md#running-a-test-at-several-terminal-sizes)):

```js
test.eachViewport('the title stays centered', async ({ game }) => {
  await expect(game.locator('MENU NAV APP')).toBeAligned('center');
});
```

`game.resize(cols, rows)` changes the size in the middle of a test, and layout assertions wait for the app to redraw at the new size. `game.getSize()` returns the current `{ cols, rows }`.
