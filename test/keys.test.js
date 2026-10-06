'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { KEY_SEQUENCES } = require('../src/keys');

test('keys: covers the standard xterm/VT100 set with correct byte sequences', () => {
  assert.equal(KEY_SEQUENCES.ENTER, '\r');
  assert.equal(KEY_SEQUENCES.ESCAPE, '\x1b');
  assert.equal(KEY_SEQUENCES.TAB, '\t');
  assert.equal(KEY_SEQUENCES.BACKSPACE, '\x7f');
  assert.equal(KEY_SEQUENCES.ARROWUP, '\x1b[A');
  assert.equal(KEY_SEQUENCES.ARROWDOWN, '\x1b[B');
  assert.equal(KEY_SEQUENCES.ARROWRIGHT, '\x1b[C');
  assert.equal(KEY_SEQUENCES.ARROWLEFT, '\x1b[D');
  assert.equal(KEY_SEQUENCES.CTRL_C, '\x03');
  assert.equal(KEY_SEQUENCES.CTRL_D, '\x04');
});

test('keys: every entry is a non-empty string', () => {
  for (const [name, sequence] of Object.entries(KEY_SEQUENCES)) {
    assert.equal(typeof sequence, 'string', `${name} should map to a string`);
    assert.ok(sequence.length > 0, `${name} should not be an empty sequence`);
  }
});

const { resolveKey } = require('../src/keys');

test('resolveKey: exact table entries (legacy names and overrides) win before chord parsing', () => {
  assert.equal(resolveKey('CTRL_C'), '\x03');
  assert.equal(resolveKey('ARROWUP'), '\x1b[A');
  assert.equal(resolveKey('Shift+Tab', { ...KEY_SEQUENCES, 'Shift+Tab': 'custom' }), 'custom');
});

test('resolveKey: named keys are case-insensitive and single characters pass through', () => {
  assert.equal(resolveKey('Enter'), '\r');
  assert.equal(resolveKey('ArrowLeft'), '\x1b[D');
  assert.equal(resolveKey('pageup'), '\x1b[5~');
  assert.equal(resolveKey('a'), 'a');
  assert.equal(resolveKey('+'), '+');
});

test('resolveKey: modified CSI/SS3 keys use the xterm 1;<mod> parameter', () => {
  assert.equal(resolveKey('Shift+ArrowUp'), '\x1b[1;2A');
  assert.equal(resolveKey('Alt+ArrowUp'), '\x1b[1;3A');
  assert.equal(resolveKey('Control+ArrowLeft'), '\x1b[1;5D');
  assert.equal(resolveKey('Control+Shift+ArrowRight'), '\x1b[1;6C');
  assert.equal(resolveKey('Control+Alt+Shift+Home'), '\x1b[1;8H');
  assert.equal(resolveKey('Control+Delete'), '\x1b[3;5~');
  assert.equal(resolveKey('Shift+F5'), '\x1b[15;2~');
  assert.equal(resolveKey('Control+F1'), '\x1b[1;5P');
});

test('resolveKey: Ctrl+letter and Ctrl+punctuation produce control bytes', () => {
  assert.equal(resolveKey('Control+c'), '\x03');
  assert.equal(resolveKey('Control+C'), '\x03');
  assert.equal(resolveKey('Ctrl+a'), '\x01');
  assert.equal(resolveKey('Control+z'), '\x1a');
  assert.equal(resolveKey('Control+['), '\x1b');
  assert.equal(resolveKey('Control+Space'), '\x00');
  assert.equal(resolveKey('Control+Backspace'), '\x08');
});

test('resolveKey: Alt prefixes ESC; Shift uppercases letters; Shift+Tab is back-tab', () => {
  assert.equal(resolveKey('Alt+x'), '\x1bx');
  assert.equal(resolveKey('Meta+x'), '\x1bx');
  assert.equal(resolveKey('Alt+Control+c'), '\x1b\x03');
  assert.equal(resolveKey('Alt+Enter'), '\x1b\r');
  assert.equal(resolveKey('Alt+Backspace'), '\x1b\x7f');
  assert.equal(resolveKey('Shift+a'), 'A');
  assert.equal(resolveKey('Shift+Tab'), '\x1b[Z');
  assert.equal(resolveKey('Alt+Shift+Tab'), '\x1b\x1b[Z');
  assert.equal(resolveKey('Alt++'), '\x1b+');
});

test('resolveKey: unknown keys and modifiers throw the same "Unknown key" error press() always has', () => {
  assert.throws(() => resolveKey('ENTR'), /Unknown key "ENTR"/);
  assert.throws(() => resolveKey('Hyper+a'), /Unknown key "Hyper\+a"/);
  assert.throws(() => resolveKey('Control+Bogus'), /Unknown key/);
  assert.throws(() => resolveKey(''), /Unknown key/);
});

test('resolveKey: chords with no terminal encoding throw a specific error instead of sending the unmodified key', () => {
  assert.throws(() => resolveKey('Control+Enter'), /no standard terminal encoding/);
  assert.throws(() => resolveKey('Shift+Enter'), /no standard terminal encoding/);
  assert.throws(() => resolveKey('Control+1'), /no standard terminal encoding/);
  assert.throws(() => resolveKey('Shift+1'), /no standard terminal encoding/);
});

const { encodeMouse } = require('../src/keys');

test('encodeMouse: SGR encoding, 1-based, release as a final "m"', () => {
  assert.equal(encodeMouse({ x: 0, y: 0 }, 'sgr'), '\x1b[<0;1;1M');
  assert.equal(encodeMouse({ x: 9, y: 4, action: 'release' }, 'sgr'), '\x1b[<0;10;5m');
  assert.equal(encodeMouse({ x: 2, y: 3, button: 'right' }, 'sgr'), '\x1b[<2;3;4M');
  assert.equal(encodeMouse({ x: 2, y: 3, button: 'wheelDown' }, 'sgr'), '\x1b[<65;3;4M');
  assert.equal(encodeMouse({ x: 2, y: 3, action: 'move', button: 'left' }, 'sgr'), '\x1b[<32;3;4M');
  assert.equal(encodeMouse({ x: 2, y: 3, action: 'move', button: null }, 'sgr'), '\x1b[<35;3;4M');
  assert.equal(encodeMouse({ x: 0, y: 0, modifiers: ['shift', 'ctrl'] }, 'sgr'), '\x1b[<20;1;1M');
});

test('encodeMouse: X10 and urxvt encodings; release loses the button', () => {
  assert.equal(encodeMouse({ x: 0, y: 0 }), '\x1b[M !!');
  assert.equal(encodeMouse({ x: 0, y: 0, button: 'right', action: 'release' }), '\x1b[M#!!');
  assert.equal(encodeMouse({ x: 4, y: 1 }, 'urxvt'), '\x1b[32;5;2M');
  assert.equal(encodeMouse({ x: 300, y: 0 }, 'utf8'), `\x1b[M ${String.fromCharCode(333)}!`);
});

test('encodeMouse: rejects unknown buttons/modifiers and X10 coordinates past 222', () => {
  assert.throws(() => encodeMouse({ x: 0, y: 0, button: 'thumb' }), /Unknown mouse button "thumb"/);
  assert.throws(() => encodeMouse({ x: 0, y: 0, modifiers: ['hyper'] }), /Unknown mouse modifier/);
  assert.throws(() => encodeMouse({ x: 222, y: 0 }), /past what the legacy X10 mouse encoding can report/);
});
