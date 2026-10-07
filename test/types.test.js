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

// The text of one member's declaration inside `export interface <name>`,
// up to the next member at the same indentation.
function memberDeclaration(source, name, member) {
  const start = source.search(new RegExp(`export interface ${name}\\b`));
  const from = source.slice(start).search(new RegExp(`\\n  (?:readonly\\s+)?${member}\\??[(<:]`));
  const rest = source.slice(start + from + 1);
  const end = rest.slice(1).search(/\n  (?:readonly\s+)?\w+\??[(<:]|\n}/);
  return rest.slice(0, end + 1);
}

test('types: GameDriver declares exactly the driver methods launchGame returns, including those on press and mouse', async () => {
  const game = await launchGame({ command: process.execPath, args: [FIXTURE_MINIMAL], cols: 40, rows: 10 });
  try {
    assert.deepEqual([...interfaceMembers(indexDts, 'GameDriver')].sort(), Object.keys(game).sort());
    for (const member of ['press', 'mouse']) {
      const declaration = memberDeclaration(indexDts, 'GameDriver', member);
      const declared = [...declaration.matchAll(/^\s{4}(\w+)\(/gm)].map((m) => m[1]);
      assert.deepEqual(declared.sort(), Object.keys(game[member]).sort(), `${member}.*`);
    }
  } finally {
    await game.stop();
  }
});

test('types: LaunchOptions declares exactly the options launchGame reads', () => {
  const { requestedFixtures } = require('../runner/fixtures');
  assert.deepEqual([...interfaceMembers(indexDts, 'LaunchOptions')].sort(), requestedFixtures(launchGame).sort());
});

test('types: BuiltinFixtures declares exactly the built-in fixtures, and LayoutCheck every layout check', () => {
  const { BUILTIN_FIXTURES } = require('../runner/fixtures');
  assert.deepEqual([...interfaceMembers(testDts, 'BuiltinFixtures')].sort(), [...BUILTIN_FIXTURES].sort());
  const union = /export type LayoutCheck =([^;]+);/.exec(indexDts)[1];
  const declared = [...union.matchAll(/'(\w+)'/g)].map((m) => m[1]);
  assert.deepEqual(declared.sort(), Object.keys(require('../src/layout').CHECKS).sort());
});

test('types: TestApi declares every method on test, and test.d.ts exports test, describe and expect', () => {
  assert.deepEqual([...interfaceMembers(testDts, 'TestApi')].sort(), Object.keys(rpgTest.test).sort());
  assert.deepEqual([...exportedNames(testDts)].sort(), ['describe', 'expect', 'test']);
});

test('types: the matcher interfaces declare every matcher expect() returns', () => {
  const fakeLocator = { _isLocator: true, driver: {} };
  const locatorMatchers = expect(fakeLocator);
  const declaredLocator = new Set([...interfaceMembers(testDts, 'LocatorMatchers'), ...interfaceMembers(testDts, 'LocatorAssertions')]);
  assert.deepEqual([...declaredLocator].sort(), Object.keys(locatorMatchers).sort());
  assert.deepEqual([...interfaceMembers(testDts, 'LocatorAssertions')].sort(), Object.keys(locatorMatchers.not).sort());

  const gameMatchers = expect({});
  const declaredGame = new Set([...interfaceMembers(testDts, 'GameMatchers'), ...interfaceMembers(testDts, 'TerminalAssertions')]);
  assert.deepEqual([...declaredGame].sort(), Object.keys(gameMatchers).sort());
});

test('types: Locator declares every locator method', async () => {
  const game = await launchGame({ command: process.execPath, args: [FIXTURE_MINIMAL], cols: 40, rows: 10 });
  try {
    const runtime = Object.keys(game.locator('x')).filter((k) => !['source', 'target', 'resolveAll', 'resolveOne', 'driver'].includes(k));
    assert.deepEqual([...interfaceMembers(indexDts, 'Locator')].sort(), runtime.sort());
  } finally {
    await game.stop();
  }
});

test('package.json: each export points at its declarations, and they ship', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.exports['.'].types, './types/index.d.ts');
  assert.equal(pkg.exports['./test'].types, './types/test.d.ts');
  assert.ok(pkg.files.includes('types'));
});
