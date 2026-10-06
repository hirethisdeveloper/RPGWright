'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVirtualTerminal } = require('../src/terminal');

test('terminal: write() resolves only once the chunk is fully applied', async () => {
  const term = createVirtualTerminal({ cols: 20, rows: 5 });
  await term.write('hello');
  assert.equal(term.getScreenLines()[0], 'hello');
  term.dispose();
});

test('terminal: getScreenText() strips SGR color codes and joins visible rows', async () => {
  const term = createVirtualTerminal({ cols: 20, rows: 3 });
  await term.write('\x1b[31mred\x1b[0m\r\nplain\r\n');
  assert.equal(term.getScreenText(), 'red\nplain\n');
  term.dispose();
});

test('terminal: a full-frame redraw (cursor-up + clear-line) replaces rather than appends', async () => {
  const term = createVirtualTerminal({ cols: 20, rows: 3 });
  await term.write('OLD LINE 1\r\nOLD LINE 2\r\n');
  await term.write('\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[GNEW LINE 1\r\nNEW LINE 2\r\n');
  const text = term.getScreenText();
  assert.ok(text.includes('NEW LINE 1'));
  assert.ok(!text.includes('OLD LINE'));
  term.dispose();
});

test('terminal: getCursor() reflects the cursor position after writes', async () => {
  const term = createVirtualTerminal({ cols: 20, rows: 5 });
  await term.write('abc');
  assert.deepEqual(term.getCursor(), { x: 3, y: 0, visible: true });
  term.dispose();
});

test('terminal: resize() changes the visible row/column count', async () => {
  const term = createVirtualTerminal({ cols: 20, rows: 5 });
  await term.write('hello world this is long'.padEnd(30, ' '));
  term.resize(10, 3);
  assert.equal(term.getScreenLines().length, 3);
  term.dispose();
});

test('terminal: onReply() emits the emulator\'s answers to cursor-position and device-attribute queries', async () => {
  const term = createVirtualTerminal({ cols: 20, rows: 5 });
  const replies = [];
  const subscription = term.onReply((data) => replies.push(data));
  await term.write('abc\x1b[6n\x1b[c');
  assert.deepEqual(replies, ['\x1b[1;4R', '\x1b[?1;2c']);
  subscription.dispose();
  await term.write('\x1b[6n');
  assert.equal(replies.length, 2, 'a disposed subscription receives nothing');
  term.dispose();
});

test('terminal: getScreenCells() has one entry per column and row; never-written cells have ch "" and width 1', async () => {
  const term = createVirtualTerminal({ cols: 6, rows: 2 });
  await term.write('ab \x1b[2Cz');
  const cells = term.getScreenCells();
  assert.equal(cells.length, 2);
  assert.equal(cells[0].length, 6);
  assert.deepEqual(cells[0][0], {
    ch: 'a', width: 1, fg: null, bg: null,
    bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false, invisible: false,
  });
  assert.deepEqual(cells[0].map((c) => [c.ch, c.width]), [['a', 1], ['b', 1], [' ', 1], ['', 1], ['', 1], ['z', 1]]);
  assert.deepEqual([cells[1][0].ch, cells[1][0].width], ['', 1]);
  term.dispose();
});

test('terminal: getScreenCells() reads SGR attributes', async () => {
  const term = createVirtualTerminal({ cols: 10, rows: 1 });
  await term.write('\x1b[1mB\x1b[0m\x1b[2mD\x1b[0m\x1b[3mI\x1b[0m\x1b[4mU\x1b[0m\x1b[7mR\x1b[0m\x1b[9mS\x1b[0m\x1b[8mH\x1b[0m');
  const [row] = term.getScreenCells();
  const on = (cell) => Object.keys(cell).filter((k) => cell[k] === true);
  assert.deepEqual(row.slice(0, 7).map(on), [['bold'], ['dim'], ['italic'], ['underline'], ['inverse'], ['strike'], ['invisible']]);
  term.dispose();
});

test('terminal: getScreenCells() normalizes 16-color, 256-color and truecolor foreground/background', async () => {
  const term = createVirtualTerminal({ cols: 10, rows: 1 });
  await term.write('\x1b[31;42ma\x1b[0m\x1b[91mb\x1b[0m\x1b[38;5;200;48;5;17mc\x1b[0m\x1b[38;2;255;128;0;48;2;0;0;1md\x1b[0me');
  const [row] = term.getScreenCells();
  assert.deepEqual(row.slice(0, 5).map((c) => [c.fg, c.bg]), [
    [{ palette: 1 }, { palette: 2 }],
    [{ palette: 9 }, null],
    [{ palette: 200 }, { palette: 17 }],
    [{ rgb: '#ff8000' }, { rgb: '#000001' }],
    [null, null],
  ]);
  term.dispose();
});

test('terminal: a wide character fills two columns: width 2, then an empty width-0 continuation', async () => {
  const term = createVirtualTerminal({ cols: 6, rows: 1 });
  await term.write('a界b');
  const [row] = term.getScreenCells();
  assert.deepEqual(row.slice(0, 4).map((c) => [c.ch, c.width]), [['a', 1], ['界', 2], ['', 0], ['b', 1]]);
  term.dispose();
});

test('terminal: getScreenCells() is cached until the buffer changes or the terminal resizes', async () => {
  const term = createVirtualTerminal({ cols: 6, rows: 2 });
  await term.write('a');
  const first = term.getScreenCells();
  assert.equal(term.getScreenCells(), first, 'a second read with no change returns the same grid');
  await term.write('b');
  const second = term.getScreenCells();
  assert.notEqual(second, first);
  assert.equal(second[0][1].ch, 'b');
  term.resize(4, 3);
  assert.equal(term.getScreenCells().length, 3);
  assert.equal(term.getScreenCells()[0].length, 4);
  term.dispose();
});

test('terminal: getCursor().visible tracks DECTCEM hide/show and resets on RIS', async () => {
  const term = createVirtualTerminal({ cols: 10, rows: 2 });
  await term.write('\x1b[?25l');
  assert.equal(term.getCursor().visible, false);
  await term.write('\x1b[?25h');
  assert.equal(term.getCursor().visible, true);
  await term.write('\x1b[?1049;25l');
  assert.equal(term.getCursor().visible, false, 'DECTCEM inside a multi-parameter sequence counts');
  await term.write('\x1bc');
  assert.equal(term.getCursor().visible, true);
  await term.write('\x1b[?25l\x1b[!p');
  assert.equal(term.getCursor().visible, true, 'soft reset (DECSTR) shows the cursor');
  term.dispose();
});

test('terminal: getBufferType() reports normal vs. alternate screen, and cells follow the active buffer', async () => {
  const term = createVirtualTerminal({ cols: 10, rows: 2 });
  await term.write('main');
  assert.equal(term.getBufferType(), 'normal');
  await term.write('\x1b[?1049h\x1b[Halt');
  assert.equal(term.getBufferType(), 'alternate');
  assert.equal(term.getScreenCells()[0].map((c) => c.ch).join('').trim(), 'alt');
  await term.write('\x1b[?1049l');
  assert.equal(term.getBufferType(), 'normal');
  assert.equal(term.getScreenLines()[0], 'main');
  term.dispose();
});

test('terminal: getSize() reflects construction and resize', async () => {
  const term = createVirtualTerminal({ cols: 10, rows: 2 });
  assert.deepEqual(term.getSize(), { cols: 10, rows: 2 });
  term.resize(30, 7);
  assert.deepEqual(term.getSize(), { cols: 30, rows: 7 });
  term.dispose();
});

test('terminal: the cell grid reflects a chunk as soon as its write() callback runs, even for back-to-back writes', async () => {
  const term = createVirtualTerminal({ cols: 10, rows: 1 });
  const seen = [];
  // Several chunks queued at once are parsed in one tick; each onParsed
  // must see its own chunk applied, not a grid cached before it.
  await Promise.all(['a', 'b', 'c'].map((ch) => term.write(ch, () => seen.push(term.getScreenCells()[0].map((c) => c.ch).join('')))));
  assert.deepEqual(seen, ['a', 'ab', 'abc']);
  term.dispose();
});

test('terminal: getModes() reports mouse tracking and encoding, bracketed paste, cursor keys, focus and alt screen', async () => {
  const term = createVirtualTerminal({ cols: 20, rows: 3 });
  assert.deepEqual(term.getModes(), {
    altScreen: false, cursorVisible: true, applicationCursorKeys: false, bracketedPaste: false,
    mouseTracking: 'none', mouseEncoding: 'x10', focusReporting: false,
  });
  await term.write('\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1h\x1b[?1004h\x1b[?1049h');
  assert.deepEqual(term.getModes(), {
    altScreen: true, cursorVisible: true, applicationCursorKeys: true, bracketedPaste: true,
    mouseTracking: 'drag', mouseEncoding: 'sgr', focusReporting: true,
  });
  await term.write('\x1b[?1006l');
  assert.equal(term.getModes().mouseEncoding, 'x10');
  await term.write('\x1b[?1015h\x1bc');
  assert.equal(term.getModes().mouseEncoding, 'x10', 'a full reset restores the default encoding');
  term.dispose();
});

test('terminal: getSignals() records the title, bell count, OSC 8 hyperlinks with their text, and OSC 52 writes', async () => {
  const term = createVirtualTerminal({ cols: 30, rows: 3 });
  await term.write('\x1b]2;Title\x07\x07\x07go to \x1b]8;id=1;https://x.dev/a\x1b\\the site\x1b]8;;\x1b\\ now');
  await term.write('\x1b]52;c;aGk=\x07\x1b]52;c;?\x07');
  assert.deepEqual(term.getSignals(), {
    title: 'Title',
    bellCount: 2,
    hyperlinks: [{ uri: 'https://x.dev/a', text: 'the site' }],
    clipboardWrites: ['hi'],
  });
  term.getSignals().hyperlinks.push('mutation');
  assert.equal(term.getSignals().hyperlinks.length, 1, 'callers get copies');
  term.dispose();
});

test('terminal: getScrollbackLines() returns lines scrolled off the top, bounded by the scrollback option', async () => {
  const term = createVirtualTerminal({ cols: 10, rows: 3, scrollback: 2 });
  await term.write('1\r\n2\r\n3\r\n4\r\n5\r\n6');
  assert.deepEqual(term.getScrollbackLines(), ['2', '3']);
  assert.deepEqual(term.getScreenLines(), ['4', '5', '6']);
  term.dispose();
});
