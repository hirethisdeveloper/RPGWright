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
  assert.deepEqual(term.getCursor(), { x: 3, y: 0 });
  term.dispose();
});

test('terminal: resize() changes the visible row/column count', async () => {
  const term = createVirtualTerminal({ cols: 20, rows: 5 });
  await term.write('hello world this is long'.padEnd(30, ' '));
  term.resize(10, 3);
  assert.equal(term.getScreenLines().length, 3);
  term.dispose();
});
