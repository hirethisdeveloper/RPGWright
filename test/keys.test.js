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
