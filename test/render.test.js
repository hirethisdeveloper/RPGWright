'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVirtualTerminal } = require('../src/terminal');
const { renderScreenFragment, renderScreenHtml, renderScreenAnsi, paletteColor, escapeHtml } = require('../src/render');

async function grid(text, cols = 12, rows = 2) {
  const term = createVirtualTerminal({ cols, rows });
  await term.write(text);
  const cells = term.getScreenCells();
  term.dispose();
  return cells;
}

test('paletteColor: the 16 base colors, the 6x6x6 cube and the gray ramp', () => {
  assert.equal(paletteColor(1), '#cd0000');
  assert.equal(paletteColor(14), '#00ffff');
  assert.equal(paletteColor(16), '#000000');
  assert.equal(paletteColor(196), '#ff0000');
  assert.equal(paletteColor(231), '#ffffff');
  assert.equal(paletteColor(232), '#080808');
  assert.equal(paletteColor(255), '#eeeeee');
});

test('escapeHtml: escapes markup characters', () => {
  assert.equal(escapeHtml('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
});

test('renderScreenFragment: groups same-styled cells into one span; inverse swaps colors', async () => {
  const html = renderScreenFragment(await grid('\x1b[7;36m> Play\x1b[0m <x>'));
  assert.match(html, /^<pre class="rpgw-screen">/);
  assert.match(html, /<span style="color:#1e1e1e;background:#00cdcd">&gt; Play<\/span> &lt;x&gt;/);
});

test('renderScreenFragment: attributes and truecolor become CSS', async () => {
  const html = renderScreenFragment(await grid('\x1b[1;4;38;2;10;20;30mB\x1b[0m\x1b[2;3;9mD\x1b[0m'));
  assert.match(html, /<span style="color:#0a141e;font-weight:bold;text-decoration:underline">B<\/span>/);
  assert.match(html, /<span style="opacity:\.6;font-style:italic;text-decoration:line-through">D<\/span>/);
});

test('renderScreenFragment: a wide character gets a two-column box and its continuation cell is skipped', async () => {
  const html = renderScreenFragment(await grid('a界b'));
  assert.match(html, /a<span class="w2">界<\/span>b/);
});

test('renderScreenFragment: the visible cursor is outlined; a hidden one is not', async () => {
  const cells = await grid('ab');
  assert.match(renderScreenFragment(cells, { x: 2, y: 0, visible: true }), /ab<span style="outline:1px solid #f5c542;outline-offset:-1px"> <\/span>/);
  assert.doesNotMatch(renderScreenFragment(cells, { x: 2, y: 0, visible: false }), /outline/);
});

test('renderScreenHtml: a standalone page with the title escaped', async () => {
  const html = renderScreenHtml(await grid('hi'), { title: 'a < b' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>a &lt; b<\/title>/);
  assert.match(html, /<pre class="rpgw-screen">hi/);
});

const R = '\x1b[0m';

test('renderScreenAnsi: palette low, bright and 256 colors', async () => {
  const [row] = renderScreenAnsi(await grid('\x1b[31;42ma\x1b[91;102mb\x1b[38;5;200;48;5;17mc', 3, 1));
  assert.equal(row, `\x1b[0;31;42ma\x1b[0;91;102mb\x1b[0;38;5;200;48;5;17mc${R}`);
});

test('renderScreenAnsi: rgb foreground and background', async () => {
  const [row] = renderScreenAnsi(await grid('\x1b[38;2;10;20;30;48;2;1;2;3mx', 2, 1));
  assert.equal(row, `\x1b[0;38;2;10;20;30;48;2;1;2;3mx${R} ${R}`);
});

test('renderScreenAnsi: each attribute maps to its SGR code', async () => {
  const codes = { 1: 1, 2: 2, 3: 3, 4: 4, 7: 7, 8: 8, 9: 9 };
  for (const code of Object.keys(codes)) {
    const [row] = renderScreenAnsi(await grid(`\x1b[${code}mx`, 2, 1));
    assert.equal(row, `\x1b[0;${code}mx${R} ${R}`);
  }
});

test('renderScreenAnsi: SGR only where style changes; default cells emit none', async () => {
  const [row] = renderScreenAnsi(await grid('ab\x1b[1mcd\x1b[0mef', 6, 1));
  assert.equal(row, `ab\x1b[0;1mcd\x1b[0mef${R}`);
});

test('renderScreenAnsi: wide characters emit once and the row keeps its width', async () => {
  const [row] = renderScreenAnsi(await grid('a界b', 6, 1));
  assert.equal(row, `a界b  ${R}`);
});

test('renderScreenAnsi: a visible cursor toggles inverse on its cell; hidden does not', async () => {
  const cells = await grid('ab', 4, 1);
  assert.equal(renderScreenAnsi(cells, { x: 2, y: 0, visible: true })[0], `ab\x1b[0;7m \x1b[0m ${R}`);
  assert.equal(renderScreenAnsi(cells, { x: 2, y: 0, visible: false })[0], `ab  ${R}`);
  const inv = await grid('\x1b[7mab', 2, 1);
  assert.equal(renderScreenAnsi(inv, { x: 0, y: 0, visible: true })[0], `a\x1b[0;7mb${R}`);
});

test('renderScreenAnsi: a blank grid is one space-filled row per grid row', async () => {
  assert.deepEqual(renderScreenAnsi(await grid('', 5, 2)), [`     ${R}`, `     ${R}`]);
});
