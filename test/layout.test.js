'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVirtualTerminal } = require('../src/terminal');
const layout = require('../src/layout');

// Renders `lines` through the real emulator (no process) and returns its
// cell grid, wrapped-row flags and size, the same inputs game.js passes to
// the layout checks.
async function screen(lines, { cols = 30, rows = 8 } = {}) {
  const term = createVirtualTerminal({ cols, rows });
  await term.write(lines.join('\r\n'));
  const state = { grid: term.getScreenCells(), wrapped: term.getWrappedRows(), size: term.getSize() };
  term.dispose();
  return state;
}

function sourceFor(state) {
  return { getScreenCells: () => state.grid, driver: null };
}

function check(state, name, subject, args = [], negate = false) {
  const locator = layout.createLocator(sourceFor(state), subject);
  return layout.evaluateCheck(name, locator, args, { negate, ...state });
}

test('rect helpers: overlaps, contains, gapX/gapY (negative when spans overlap)', () => {
  const a = { x: 0, y: 0, width: 4, height: 2 };
  const b = { x: 6, y: 1, width: 2, height: 2 };
  assert.equal(layout.overlaps(a, b), false);
  assert.equal(layout.overlaps(a, { x: 3, y: 1, width: 2, height: 1 }), true);
  assert.equal(layout.contains(a, { x: 1, y: 0, width: 3, height: 2 }), true);
  assert.equal(layout.contains(a, { x: 1, y: 0, width: 4, height: 1 }), false);
  assert.equal(layout.gapX(a, b), 2);
  assert.equal(layout.gapX(b, a), 2);
  assert.equal(layout.gapY(a, b), -1);
  assert.equal(layout.formatRect(a), '(x=0, y=0, 4×2)');
});

test('findText: each string occurrence as a rect, in reading order', async () => {
  const state = await screen(['Play  Play', '  Play']);
  assert.deepEqual(layout.findText(state.grid, 'Play'), [
    { x: 0, y: 0, width: 4, height: 1 },
    { x: 6, y: 0, width: 4, height: 1 },
    { x: 2, y: 1, width: 4, height: 1 },
  ]);
  assert.deepEqual(layout.findText(state.grid, 'missing'), []);
  assert.deepEqual(layout.findText(state.grid, ''), []);
});

test('findText: a RegExp spanning rows yields the bounding rect of the whole match', async () => {
  const state = await screen(['TITLE', '  Play', '  Quit']);
  assert.deepEqual(layout.findText(state.grid, /Play\n\s+Quit/), [{ x: 0, y: 1, width: 6, height: 2 }]);
  assert.deepEqual(layout.findText(state.grid, /play/i), [{ x: 2, y: 1, width: 4, height: 1 }]);
  const globalNeedle = /a/g;
  assert.equal(layout.findText(state.grid, globalNeedle).length, 1);
  assert.equal(layout.findText(state.grid, globalNeedle).length, 1, 'a global needle is not stateful across calls');
});

test('findText: columns account for wide characters before the match', async () => {
  const state = await screen(['界界Play']);
  assert.deepEqual(layout.findText(state.grid, 'Play'), [{ x: 4, y: 0, width: 4, height: 1 }]);
  assert.deepEqual(layout.findText(state.grid, '界P'), [{ x: 2, y: 0, width: 3, height: 1 }]);
});

test('textIn: the text inside a rect, rows right-trimmed', async () => {
  const state = await screen(['abcdef', 'ghi', 'jklmno']);
  assert.equal(layout.textIn(state.grid, { x: 1, y: 0, width: 3, height: 3 }), 'bcd\nhi\nklm');
});

test('findBoxes: finds each border style Ink can draw, with inner rect', async () => {
  const styles = [
    ['┌──┐', '│ab│', '└──┘'],
    ['╭──╮', '│ab│', '╰──╯'],
    ['╔══╗', '║ab║', '╚══╝'],
    ['┏━━┓', '┃ab┃', '┗━━┛'],
    ['+--+', '|ab|', '+--+'],
  ];
  for (const lines of styles) {
    const state = await screen(lines);
    const boxes = layout.findBoxes(state.grid);
    assert.equal(boxes.length, 1, lines[0]);
    assert.deepEqual({ ...boxes[0], title: undefined }, {
      x: 0, y: 0, width: 4, height: 3, inner: { x: 1, y: 1, width: 2, height: 1 }, title: undefined,
    });
  }
});

test('findBoxes: reads a title drawn into the top edge', async () => {
  const state = await screen(['┌─ Inventory ─┐', '│ sword       │', '└─────────────┘']);
  const [box] = layout.findBoxes(state.grid);
  assert.equal(box.title, 'Inventory');
  assert.equal(box.width, 15);
});

test('findBoxes: side-by-side boxes stay separate; nested boxes come innermost first', async () => {
  const sideBySide = await screen(['┌─┐ ┌─┐', '│a│ │b│', '└─┘ └─┘']);
  assert.deepEqual(layout.findBoxes(sideBySide.grid).map((b) => [b.x, b.width]), [[0, 3], [4, 3]]);

  const nested = await screen(['┌──────┐', '│┌──┐  │', '││in│  │', '│└──┘  │', '└──────┘']);
  assert.deepEqual(layout.findBoxes(nested.grid).map((b) => layout.formatRect(b)), ['(x=1, y=1, 4×3)', '(x=0, y=0, 8×5)']);
});

test('findBoxes: plus signs in ordinary text are not corners; results are computed once per grid', async () => {
  const text = await screen(['a+b c+d', 'e+f g+h', 'i+j k+l']);
  assert.deepEqual(layout.findBoxes(text.grid), []);
  const box = await screen(['+--+', '|ab|', '+--+']);
  assert.equal(layout.findBoxes(box.grid), layout.findBoxes(box.grid), 'the same grid is not scanned twice');
});

test('findBoxes: a panel split by a junction divider yields both halves and the whole', async () => {
  const state = await screen(['┌────┐', '│top │', '├────┤', '│bot │', '└────┘']);
  assert.deepEqual(layout.findBoxes(state.grid).map((b) => layout.formatRect(b)), [
    '(x=0, y=0, 6×3)',
    '(x=0, y=2, 6×3)',
    '(x=0, y=0, 6×5)',
  ]);
});

test('resolveTarget: whole screen, explicit rect, row, and box containing text', async () => {
  const state = await screen(['┌────┐ ┌────┐', '│Menu│ │Bag │', '└────┘ └────┘'], { cols: 20, rows: 4 });
  assert.deepEqual(layout.resolveTarget(state.grid, undefined), [{ x: 0, y: 0, width: 20, height: 4 }]);
  assert.deepEqual(layout.resolveTarget(state.grid, { x: 1, y: 2, width: 3, height: 1 }), [{ x: 1, y: 2, width: 3, height: 1 }]);
  assert.deepEqual(layout.resolveTarget(state.grid, { row: 1 }), [{ x: 0, y: 1, width: 20, height: 1 }]);
  assert.deepEqual(layout.resolveTarget(state.grid, { row: 9 }), []);
  assert.equal(layout.resolveTarget(state.grid, { box: true }).length, 2);
  assert.deepEqual(layout.resolveTarget(state.grid, { box: { containing: 'Bag' } }).map((b) => b.x), [7]);
  assert.throws(() => layout.resolveTarget(state.grid, { bogus: 1 }), /Unsupported locator target/);
});

test('createLocator: nth/first/last, within and chained locator(), count and describe()', async () => {
  const state = await screen(['┌────┐ ┌────┐', '│Item│ │Item│', '└────┘ └────┘'], { cols: 20, rows: 4 });
  const items = layout.createLocator(sourceFor(state), 'Item');
  assert.equal(items.count(), 2);
  assert.equal(items.first().boundingBox().x, 1);
  assert.equal(items.last().boundingBox().x, 8);
  assert.equal(items.nth(1).boundingBox().x, 8);
  assert.equal(items.nth(5).count(), 0);

  const rightBox = layout.createLocator(sourceFor(state), { x: 7, y: 0, width: 6, height: 3 });
  const inRight = rightBox.locator('Item');
  assert.equal(inRight.count(), 1);
  assert.equal(inRight.boundingBox().x, 8);
  assert.equal(inRight.describe(), 'locator((x=7, y=0, 6×3)).locator("Item")');
  assert.equal(items.first().describe(), 'locator("Item").first()');
  assert.equal(layout.createLocator(sourceFor(state), { box: { containing: /It/ } }).describe(), 'locator(box containing /It/)');
});

test('createLocator: boundingBox/textContent are strict: null for no match, an error for several', async () => {
  const state = await screen(['Item Item', 'Solo']);
  const source = sourceFor(state);
  assert.equal(layout.createLocator(source, 'Nope').boundingBox(), null);
  assert.throws(() => layout.createLocator(source, 'Item').boundingBox(), /matched 2 regions[\s\S]*\.first\(\)/);
  assert.equal(layout.createLocator(source, 'Solo').textContent(), 'Solo');
  assert.deepEqual(layout.createLocator(source, 'Solo').cells().map((row) => row.map((c) => c.ch).join('')), ['Solo']);
});

test('checks: toHaveBox matches any subset of x/y/width/height, with ranges and tolerance', async () => {
  const state = await screen(['', '   Settings']);
  assert.equal(check(state, 'toHaveBox', 'Settings', [{ x: 3, y: 1 }]).pass, true);
  assert.equal(check(state, 'toHaveBox', 'Settings', [{ width: [5, 10] }]).pass, true);
  assert.equal(check(state, 'toHaveBox', 'Settings', [{ x: 2 }, { tolerance: 1 }]).pass, true);
  const miss = check(state, 'toHaveBox', 'Settings', [{ x: 0, width: 8 }]);
  assert.equal(miss.pass, false);
  assert.equal(miss.expected, 'to have x=0, width=8');
  assert.equal(miss.observed, 'at (x=3, y=1, 8×1)');
});

test('checks: relative position, overlap and containment', async () => {
  const state = await screen(['Left    Right', '', 'Below']);
  const src = sourceFor(state);
  const rightLoc = layout.createLocator(src, 'Right');
  assert.equal(check(state, 'toBeLeftOf', 'Left', [rightLoc]).pass, true);
  assert.equal(check(state, 'toBeRightOf', 'Left', [rightLoc]).pass, false);
  assert.equal(check(state, 'toBeBelow', 'Below', [rightLoc]).pass, true);
  assert.equal(check(state, 'toBeAbove', 'Left', [{ x: 0, y: 2, width: 5, height: 1 }]).pass, true);
  assert.equal(check(state, 'toOverlap', 'Left', [{ x: 3, y: 0, width: 2, height: 1 }]).pass, true);
  assert.equal(check(state, 'toOverlap', 'Left', [rightLoc], true).pass, true, 'negated: does not overlap');
  assert.equal(check(state, 'toBeWithin', 'Right', [{ x: 8, y: 0, width: 5, height: 1 }]).pass, true);
  assert.equal(check(state, 'toBeWithin', 'Right', [{ x: 9, y: 0, width: 5, height: 1 }]).pass, false);
  assert.equal(check(state, 'toBeWithinScreen', 'Right').pass, true);
  assert.equal(check(state, 'toBeWithinScreen', { x: 25, y: 0, width: 10, height: 1 }).pass, false);
});

test('checks: toHaveGap measures blank cells on the separating axis, and asks for an axis when diagonal', async () => {
  const state = await screen(['Left   Right', '', 'Below']);
  const src = sourceFor(state);
  const rightLoc = layout.createLocator(src, 'Right');
  assert.equal(check(state, 'toHaveGap', 'Left', [rightLoc, { min: 3, max: 3 }]).pass, true);
  assert.equal(check(state, 'toHaveGap', 'Left', [rightLoc, { min: 4 }]).pass, false);
  assert.match(check(state, 'toHaveGap', 'Left', [rightLoc, { min: 4 }]).observed, /gap is 3/);
  assert.equal(check(state, 'toHaveGap', 'Left', [layout.createLocator(src, 'Below'), { min: 1, max: 1 }]).pass, true);
  const diagonal = check(state, 'toHaveGap', 'Below', [rightLoc, { min: 0 }]);
  assert.equal(diagonal.pass, false);
  assert.match(diagonal.observed, /diagonal/);
  assert.equal(check(state, 'toHaveGap', 'Below', [rightLoc, { min: 0 }], true).pass, false, 'not.toHaveGap cannot pass on an undefined gap');
  assert.equal(check(state, 'toHaveGap', 'Below', [rightLoc, { min: 1, max: 1, axis: 'y' }]).pass, true);
});

test('checks: toBeAligned compares edges with another region or the screen; centers allow the half-cell', async () => {
  const state = await screen(['  Title', '  Item one', '      Right'], { cols: 11, rows: 3 });
  const src = sourceFor(state);
  assert.equal(check(state, 'toBeAligned', 'Title', ['left', { with: layout.createLocator(src, 'Item one') }]).pass, true);
  assert.equal(check(state, 'toBeAligned', 'Right', ['right']).pass, true, 'flush with the screen edge');
  assert.equal(check(state, 'toBeAligned', 'Title', ['right']).pass, false);
  // "Title" spans 2..7 on an 11-wide screen: its center is 4.5 cells from
  // the left, the screen's is 5.5 — one cell off, beyond the half-cell.
  assert.equal(check(state, 'toBeAligned', 'Title', ['center']).pass, false);
  assert.equal(check(state, 'toBeAligned', { x: 3, y: 0, width: 5, height: 1 }, ['center']).pass, true);
  assert.equal(check(state, 'toBeAligned', { x: 3, y: 0, width: 4, height: 1 }, ['center']).pass, true, 'off by half a cell');
  assert.throws(() => check(state, 'toBeAligned', 'Title', ['centre']), /unknown edge "centre"/);
  assert.throws(() => check(state, 'toBeAligned', 'Title', ['centre'], true), /unknown edge "centre"/, 'negated too');
});

test('checks: toFitWithoutClipping flags terminal auto-wrap and truncation ellipses, not flush-right text', async () => {
  const flushRight = await screen(['0123456789'], { cols: 10, rows: 3 });
  assert.equal(check(flushRight, 'toFitWithoutClipping', '0123456789').pass, true, 'reaching the last column alone is fine');

  const wrapped = await screen(['0123456789abc'], { cols: 10, rows: 3 });
  const wrapResult = check(wrapped, 'toFitWithoutClipping', '012');
  assert.equal(wrapResult.pass, false);
  assert.match(wrapResult.observed, /row 1 is a wrapped continuation/);

  const truncated = await screen(['Long title…', 'Other tex...'], { cols: 20, rows: 3 });
  assert.equal(check(truncated, 'toFitWithoutClipping', 'Long title…').pass, false);
  assert.match(check(truncated, 'toFitWithoutClipping', { row: 1 }).observed, /truncation ellipsis/);
  assert.equal(check(truncated, 'toFitWithoutClipping', 'Long').pass, true);
});

test('checks: toHaveText looks only inside the region', async () => {
  const state = await screen(['┌────┐ outside', '│ in │', '└────┘']);
  const box = { box: { containing: 'in' } };
  assert.equal(check(state, 'toHaveText', box, ['in']).pass, true);
  assert.equal(check(state, 'toHaveText', box, ['outside']).pass, false);
  assert.equal(check(state, 'toHaveText', box, [/I/i]).pass, true);
});

test('evaluateCheck: an unresolved subject or operand fails even when negated, explaining why', async () => {
  const state = await screen(['Item Item', 'Solo']);
  const src = sourceFor(state);
  const missing = check(state, 'toBeLeftOf', 'Nope', [layout.createLocator(src, 'Solo')], true);
  assert.equal(missing.pass, false);
  assert.match(missing.observed, /locator\("Nope"\) matched nothing/);
  assert.match(missing.expected, /^not to be left of locator\("Solo"\)/);

  const ambiguous = check(state, 'toBeLeftOf', 'Solo', [layout.createLocator(src, 'Item')], true);
  assert.equal(ambiguous.pass, false);
  assert.match(ambiguous.observed, /matched 2 regions/);

  assert.throws(() => check(state, 'toBeSideways', 'Solo'), /Unknown layout check/);
});

test('normalizeColor: null/default, palette index, names and #rrggbb; anything else throws', () => {
  assert.equal(layout.normalizeColor(null), null);
  assert.equal(layout.normalizeColor('default'), null);
  assert.deepEqual(layout.normalizeColor(6), { palette: 6 });
  assert.deepEqual(layout.normalizeColor('cyan'), { palette: 6 });
  assert.deepEqual(layout.normalizeColor('brightRed'), { palette: 9 });
  assert.deepEqual(layout.normalizeColor('#FF8000'), { rgb: '#ff8000' });
  assert.throws(() => layout.normalizeColor('teal'), /Unknown color "teal"/);
  assert.throws(() => layout.normalizeColor(256), /Unknown color/);
});

test('checks: toHaveStyle compares only the given fields, on visible cells only, naming the first mismatch', async () => {
  const state = await screen(['\x1b[7;36m> Play\x1b[0m   Quit', '\x1b[38;2;255;0;0mhot\x1b[0m']);
  assert.equal(check(state, 'toHaveStyle', 'Play', [{ inverse: true, fg: 'cyan' }]).pass, true);
  assert.equal(check(state, 'toHaveStyle', 'Play', [{ inverse: true }]).pass, true);
  assert.equal(check(state, 'toHaveStyle', 'hot', [{ fg: '#ff0000', bg: null }]).pass, true);
  assert.equal(check(state, 'toHaveStyle', { x: 0, y: 0, width: 13, height: 1 }, [{ inverse: true }]).pass, false);

  const miss = check(state, 'toHaveStyle', 'Quit', [{ inverse: true, bold: false }]);
  assert.equal(miss.pass, false);
  assert.equal(miss.expected, 'to have style {inverse=true, bold=false}');
  assert.match(miss.observed, /cell \(9, 0\) "Q" has fg=default, bg=default$/);

  const blank = check(state, 'toHaveStyle', { x: 20, y: 0, width: 3, height: 1 }, [{ bold: true }]);
  assert.equal(blank.pass, false);
  assert.match(blank.observed, /no visible characters/);
});

test('focusIndicators: marker (string or RegExp on the text to the left), style, and cursor in or just after the region', async () => {
  const state = await screen(['  > Play', '    Quit', 'Name: Al']);
  const play = layout.findText(state.grid, 'Play')[0];
  const quit = layout.findText(state.grid, 'Quit')[0];
  const al = layout.findText(state.grid, 'Al')[0];

  assert.deepEqual(layout.focusIndicators(state.grid, play, null, { marker: '> ' }), ['marker']);
  assert.deepEqual(layout.focusIndicators(state.grid, quit, null, { marker: '> ' }), []);
  assert.deepEqual(layout.focusIndicators(state.grid, play, null, { marker: /[>▶]\s*$/ }), ['marker']);

  const cursorAfter = { x: 8, y: 2, visible: true };
  assert.deepEqual(layout.focusIndicators(state.grid, al, cursorAfter, { cursor: true }), ['cursor']);
  assert.deepEqual(layout.focusIndicators(state.grid, al, { ...cursorAfter, visible: false }, { cursor: true }), []);
  assert.deepEqual(layout.focusIndicators(state.grid, al, { x: 9, y: 2, visible: true }, { cursor: true }), []);
  assert.deepEqual(layout.DEFAULT_FOCUS, { cursor: true, style: { inverse: true } });
});

test('checks: toBeFocused uses the given indicators, else ctx.focus, else the default (cursor or inverse)', async () => {
  const state = await screen(['\x1b[7m> Play\x1b[0m', '  Quit']);
  assert.equal(check(state, 'toBeFocused', 'Play', [undefined]).pass, true, 'default: inverse');
  assert.equal(check(state, 'toBeFocused', 'Quit', [undefined]).pass, false);
  assert.equal(check(state, 'toBeFocused', 'Quit', [{ marker: '  ' }]).pass, true);

  const locator = layout.createLocator(sourceFor(state), 'Play');
  const viaCtx = layout.evaluateCheck('toBeFocused', locator, [undefined], { ...state, focus: { marker: '> ' } });
  assert.equal(viaCtx.pass, true);
  assert.match(viaCtx.expected, /to be focused \(by marker "> "\)/);
  assert.match(viaCtx.observed, /marked by marker/);

  const missed = check(state, 'toBeFocused', 'Quit', [undefined]);
  assert.match(missed.expected, /by style \{inverse=true\} or cursor/);
  assert.match(missed.observed, /no focus indicator present/);
});

test('evaluateFocusGroup: passes only when exactly one of the matches is focused', async () => {
  const one = await screen(['  Play', '\x1b[7m  Settings\x1b[0m', '  Quit']);
  const options = (state) => layout.createLocator(sourceFor(state), /Play|Settings|Quit/);
  const result = layout.evaluateFocusGroup(options(one), undefined, one);
  assert.equal(result.pass, true);
  assert.equal(result.focused.length, 1);
  assert.match(result.observed, /3 matches, 1 focused: "Settings"/);

  const two = await screen(['\x1b[7m  Play\x1b[0m', '\x1b[7m  Settings\x1b[0m', '  Quit']);
  assert.equal(layout.evaluateFocusGroup(options(two), undefined, two).pass, false);

  const none = await screen(['  Play', '  Settings', '  Quit']);
  const noneResult = layout.evaluateFocusGroup(options(none), undefined, none);
  assert.equal(noneResult.pass, false);
  assert.match(noneResult.observed, /3 matches, 0 focused$/);
});

test('gridText: the same text getScreenText() returns: written trailing spaces kept, never-written cells trimmed', async () => {
  const term = createVirtualTerminal({ cols: 12, rows: 4 });
  await term.write('ab  \r\n界x\r\na\x1b[3Cb\r\n          界');
  assert.equal(layout.gridText(term.getScreenCells()), term.getScreenText());
  assert.equal(term.getScreenText(), 'ab  \n界x\na   b\n          界');
  term.dispose();
});

test('maskGrid: replaces cells inside the rects with an unstyled mask character, leaving the original alone', async () => {
  const state = await screen(['Time 12:34:56', '\x1b[7mid=8f3a\x1b[0m'], { cols: 20, rows: 2 });
  const masked = layout.maskGrid(state.grid, [...layout.findText(state.grid, /\d\d:\d\d:\d\d/), { x: 3, y: 1, width: 4, height: 1 }]);
  assert.equal(layout.gridText(masked), 'Time ********\nid=****');
  assert.equal(masked[1][3].inverse, false);
  assert.equal(masked[1][0].inverse, true, 'unmasked cells keep their style');
  assert.equal(layout.gridText(state.grid), 'Time 12:34:56\nid=8f3a');
  assert.equal(layout.maskGrid(state.grid, []), state.grid);
});

test('styleSpans: runs of identically styled cells as "y:x+width style"; unstyled cells omitted', async () => {
  const state = await screen(['\x1b[7;36m> Play\x1b[0m  ok', '\x1b[1;31mERR\x1b[0m'], { cols: 12, rows: 3 });
  assert.equal(layout.styleSpans(state.grid), ['0:0+1 fg=6 inverse', '0:1+1 inverse', '0:2+4 fg=6 inverse', '1:0+3 fg=1 bold'].join('\n'));
});

test('styleSpans: on blank cells only background, inverse and underline count', async () => {
  const state = await screen(['\x1b[1;33m   \x1b[0m\x1b[44m  \x1b[0m'], { cols: 8, rows: 1 });
  assert.equal(layout.styleSpans(state.grid), '0:3+2 bg=4', 'bold yellow spaces look like plain spaces');
});

test('parseStyleSpans / countCellDiffs: count differing characters and differing cell styles', async () => {
  const before = await screen(['\x1b[7m> Play\x1b[0m', '  Quit'], { cols: 10, rows: 2 });
  const after = await screen(['  Play', '\x1b[7m> Quit\x1b[0m'], { cols: 10, rows: 2 });
  const capture = (state) => ({ text: layout.gridText(state.grid), styles: layout.styleSpans(state.grid) });
  assert.equal(layout.parseStyleSpans('0:2+3 bold').get('4,0'), 'bold');
  assert.equal(layout.parseStyleSpans('0:2+3 bold').size, 3);
  assert.equal(layout.countCellDiffs(capture(before), capture(before)), 0);
  // ">" moved rows (2 characters), and 6 inverse cells moved rows (12 styles).
  assert.equal(layout.countCellDiffs(capture(before), capture(after)), 14);
  assert.equal(layout.countCellDiffs({ text: 'ab' }, { text: 'ac' }), 1, 'text-only captures compare text only');
});

test('createLocator: source.extend adds members to every locator, including derived ones, with a center() that throws when there is nothing to aim at', async () => {
  const state = await screen(['  Button  ', '', '┌──────┐', '│ big  │', '│      │', '└──────┘']);
  const source = { getScreenCells: () => state.grid, extend: (locator, { center }) => ({ where: () => center() }) };
  assert.deepEqual(layout.createLocator(source, 'Button').where(), { x: 4, y: 0 });
  assert.deepEqual(layout.createLocator(source, { box: { containing: 'big' } }).first().where(), { x: 3, y: 3 });
  assert.deepEqual(layout.createLocator(source, 'Button').locator('ton').where(), { x: 6, y: 0 });
  assert.throws(() => layout.createLocator(source, 'Nope').where(), /matched nothing, so there is nowhere to point the mouse/);
  assert.equal(layout.createLocator({ getScreenCells: () => state.grid }, 'Button').click, undefined, 'a bare source adds nothing');
});
