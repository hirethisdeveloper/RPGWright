'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverTestFiles, globToRegExp } = require('../runner/discover');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-discover-test-'));
}

function touch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '');
}

test('globToRegExp: a double-star segment matches across nested directories', () => {
  const re = globToRegExp('**/*.rpg.test.js');
  assert.ok(re.test('a.rpg.test.js'));
  assert.ok(re.test('sub/dir/a.rpg.test.js'));
  assert.ok(!re.test('a.test.js'));
});

test('discoverTestFiles: finds matching files at any depth under testDir', () => {
  const dir = tempDir();
  touch(path.join(dir, 'top.rpg.test.js'));
  touch(path.join(dir, 'nested', 'deep.rpg.test.js'));
  touch(path.join(dir, 'ignored.js'));

  const files = discoverTestFiles({ testDir: dir, testMatch: '**/*.rpg.test.js' });
  assert.deepEqual(
    files.map((f) => path.relative(dir, f)).sort(),
    ['nested/deep.rpg.test.js', 'top.rpg.test.js'],
  );
});

test('discoverTestFiles: skips node_modules and .git directories', () => {
  const dir = tempDir();
  touch(path.join(dir, 'real.rpg.test.js'));
  touch(path.join(dir, 'node_modules', 'some-pkg', 'fake.rpg.test.js'));
  touch(path.join(dir, '.git', 'fake.rpg.test.js'));

  const files = discoverTestFiles({ testDir: dir, testMatch: '**/*.rpg.test.js' });
  assert.deepEqual(files.map((f) => path.relative(dir, f)), ['real.rpg.test.js']);
});

test('discoverTestFiles: accepts an array of patterns', () => {
  const dir = tempDir();
  touch(path.join(dir, 'a.rpg.test.js'));
  touch(path.join(dir, 'b.spec.js'));
  touch(path.join(dir, 'c.txt'));

  const files = discoverTestFiles({ testDir: dir, testMatch: ['**/*.rpg.test.js', '**/*.spec.js'] });
  assert.deepEqual(files.map((f) => path.relative(dir, f)).sort(), ['a.rpg.test.js', 'b.spec.js']);
});

test('discoverTestFiles: returns an empty array when testDir does not exist', () => {
  const files = discoverTestFiles({ testDir: path.join(tempDir(), 'missing'), testMatch: '**/*.rpg.test.js' });
  assert.deepEqual(files, []);
});
