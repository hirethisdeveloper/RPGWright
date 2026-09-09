'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rpgTest = require('../runner/test');

test('test()/_collect: registers tests in call order under their given names', () => {
  rpgTest._beginFile();
  rpgTest.test('first', () => {});
  rpgTest.test('second', () => {});
  const collected = rpgTest._collect();
  assert.deepEqual(collected.map((t) => t.name), ['first', 'second']);
  assert.equal(collected[0].skip, false);
});

test('test.skip: marks a test as skip without needing the runner to inspect the fn', () => {
  rpgTest._beginFile();
  rpgTest.test.skip('skipped one', () => {
    throw new Error('should never run');
  });
  const [collected] = rpgTest._collect();
  assert.equal(collected.skip, true);
});

test('describe(): prefixes nested test names with the describe path, and restores it after', () => {
  rpgTest._beginFile();
  rpgTest.describe('Group A', () => {
    rpgTest.test('does a thing', () => {});
    rpgTest.describe('Nested', () => {
      rpgTest.test('does a nested thing', () => {});
    });
  });
  rpgTest.test('top level after group', () => {});

  const names = rpgTest._collect().map((t) => t.name);
  assert.deepEqual(names, ['Group A > does a thing', 'Group A > Nested > does a nested thing', 'top level after group']);
});

test('_collect: returns an empty array and resets state when no tests were registered', () => {
  rpgTest._beginFile();
  assert.deepEqual(rpgTest._collect(), []);
});

test('_collect: clears the registry so a second file cannot see the first file\'s tests', () => {
  rpgTest._beginFile();
  rpgTest.test('from file one', () => {});
  rpgTest._collect();

  rpgTest._beginFile();
  const collected = rpgTest._collect();
  assert.deepEqual(collected, []);
});

test('test(): throws a clear error when called before _beginFile (i.e. outside a running test file)', () => {
  rpgTest._beginFile();
  rpgTest._collect();
  assert.throws(() => rpgTest.test('orphaned', () => {}), /outside of a running test file/);
});
