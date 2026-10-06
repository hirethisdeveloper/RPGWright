'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../src/index');
const rpgTest = require('../runner/test');
const { expect } = require('../runner/expect');
const { launchGame } = require('../src/game');
const { FIXTURE_MINIMAL } = require('./helpers');

// The hand-written declarations in types/ have no compiler checking them
// against the JavaScript, so these tests catch drift: every runtime name
// must be declared, and every declared member must exist at runtime.

const indexDts = fs.readFileSync(path.join(__dirname, '..', 'types', 'index.d.ts'), 'utf8');
const testDts = fs.readFileSync(path.join(__dirname, '..', 'types', 'test.d.ts'), 'utf8');

// Member names of `export interface <name> ... { ... }` (top level of its body).
function interfaceMembers(source, name) {
  const start = source.search(new RegExp(`export interface ${name}\\b[^{]*\\{`));
  assert.notEqual(start, -1, `interface ${name} not found`);
  let depth = 0;
  let body = '';
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}' && --depth === 0) break;
    if (depth === 1 && source[i] !== '{') body += source[i];
  }
  const names = new Set();
  for (const line of body.split('\n')) {
    const match = /^\s{2}(?:readonly\s+)?(\w+)\??[(<:]/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

function exportedNames(source) {
  return new Set([...source.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]));
}

test('types: every export of rpgwright is declared, and nothing more', () => {
  assert.deepEqual([...exportedNames(indexDts)].sort(), Object.keys(core).sort());
});

test('types: GameDriver declares exactly the driver methods launchGame returns', async () => {
  const game = await launchGame({ command: process.execPath, args: [FIXTURE_MINIMAL], cols: 40, rows: 10 });
  try {
    assert.deepEqual([...interfaceMembers(indexDts, 'GameDriver')].sort(), Object.keys(game).sort());
  } finally {
    await game.stop();
  }
});

test('types: TestApi declares every method on test, and test.d.ts exports test, describe and expect', () => {
  assert.deepEqual([...interfaceMembers(testDts, 'TestApi')].sort(), Object.keys(rpgTest.test).sort());
  assert.deepEqual([...exportedNames(testDts)].sort(), ['describe', 'expect', 'test']);
});

test('types: the matcher interfaces declare every matcher expect() returns', () => {
  const fakeLocator = { _isLocator: true, source: { driver: {} } };
  const locatorMatchers = expect(fakeLocator);
  const declaredLocator = new Set([...interfaceMembers(testDts, 'LocatorMatchers'), ...interfaceMembers(testDts, 'LocatorAssertions')]);
  assert.deepEqual([...declaredLocator].sort(), Object.keys(locatorMatchers).sort());
  assert.deepEqual([...interfaceMembers(testDts, 'LocatorAssertions')].sort(), Object.keys(locatorMatchers.not).sort());

  const gameMatchers = expect({});
  const declaredGame = new Set([...interfaceMembers(testDts, 'GameMatchers'), ...interfaceMembers(testDts, 'TerminalAssertions')]);
  assert.deepEqual([...declaredGame].sort(), Object.keys(gameMatchers).sort());
});

test('types: Locator declares every locator method', () => {
  const locator = require('../src/layout').createLocator({ getScreenCells: () => [] }, 'x');
  const runtime = Object.keys(locator).filter((k) => !['source', 'target', 'resolveAll', 'resolveOne'].includes(k));
  assert.deepEqual([...interfaceMembers(indexDts, 'Locator')].sort(), runtime.sort());
});

test('package.json: each export points at its declarations, and they ship', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.exports['.'].types, './types/index.d.ts');
  assert.equal(pkg.exports['./test'].types, './types/test.d.ts');
  assert.ok(pkg.files.includes('types'));
});
