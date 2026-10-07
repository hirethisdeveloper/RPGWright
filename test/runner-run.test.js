'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, resolveOutput, runTests } = require('../runner/run');

test('parseArgs: defaults to no config path and no filters', () => {
  assert.deepEqual(parseArgs([]), { configPath: null, filters: [] });
});

test('parseArgs: reads value flags, boolean flags and positional filters in any order', () => {
  const opts = parseArgs([
    'menu.rpg.test.js:12',
    '--config', 'cfg.js',
    '--grep', '@smoke',
    '--grep-invert', 'slow',
    '--reporter', 'dot',
    '--max-failures', '2',
    '--list',
    '--update-snapshots',
    'other',
  ]);
  assert.deepEqual(opts, {
    configPath: 'cfg.js',
    filters: ['menu.rpg.test.js:12', 'other'],
    grep: '@smoke',
    grepInvert: 'slow',
    reporter: 'dot',
    maxFailures: 2,
    list: true,
    updateSnapshots: true,
  });
});

test('parseArgs: a value flag with no value fails clearly', () => {
  assert.throws(() => parseArgs(['--config']), /--config requires a path/);
  assert.throws(() => parseArgs(['--grep', '--list']), /--grep requires a value/);
});

test('parseArgs: rejects unknown options and a non-positive --max-failures', () => {
  assert.throws(() => parseArgs(['--bogus']), /Unknown option "--bogus"/);
  assert.throws(() => parseArgs(['--max-failures', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--max-failures', 'x']), /positive integer/);
});

test('parseArgs: --retries, --repeat-each and --fail-on-flaky', () => {
  assert.deepEqual(parseArgs(['--retries', '2', '--repeat-each', '3', '--fail-on-flaky']), {
    configPath: null,
    filters: [],
    retries: 2,
    repeatEach: 3,
    failOnFlaky: true,
  });
  assert.equal(parseArgs(['--retries', '0']).retries, 0);
  assert.throws(() => parseArgs(['--retries', '-1']), /--retries requires a non-negative integer/);
  assert.throws(() => parseArgs(['--repeat-each', '0']), /--repeat-each requires a positive integer/);
});

test('parseArgs: --workers and --watch', () => {
  assert.deepEqual(parseArgs(['--workers', '4', '--watch']), { configPath: null, filters: [], workers: 4, watch: true });
  assert.throws(() => parseArgs(['--workers', '0']), /--workers requires a positive integer/);
});

test('parseArgs: --ui, and its rejection alongside --watch', () => {
  assert.deepEqual(parseArgs(['--ui', 'menu']), { configPath: null, filters: ['menu'], ui: true });
  assert.throws(() => parseArgs(['--ui', '--watch']), /--ui can't be combined with --watch/);
});

test('resolveOutput: --ui forces one worker and keeps only the file reporters', () => {
  const config = { reporter: ['list', ['junit', { outputFile: 'j.xml' }], 'github'], workers: 4 };
  assert.deepEqual(resolveOutput({ ui: true, workers: 3 }, config), { reporterSpec: [['junit', { outputFile: 'j.xml' }]], workers: 1 });
  assert.deepEqual(resolveOutput({ ui: true, reporter: 'dot,json' }, config), { reporterSpec: ['json'], workers: 1 });
  assert.deepEqual(resolveOutput({ ui: true, reporter: 'list' }, config), { reporterSpec: null, workers: 1 });
  // Without --ui, nothing changes.
  assert.deepEqual(resolveOutput({ reporter: 'dot,json' }, config), { reporterSpec: ['dot', 'json'], workers: 4 });
  assert.deepEqual(resolveOutput({ workers: 2 }, config), { reporterSpec: config.reporter, workers: 2 });
});

test('runTests: --ui fails clearly when stdout is not a terminal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-ui-tty-'));
  fs.writeFileSync(path.join(dir, 'rpgwright.config.js'), `module.exports = { command: 'true' };`);
  try {
    await assert.rejects(runTests({ cwd: dir, ui: true, stdout: { isTTY: false } }), /--ui needs an interactive terminal, but stdout is not a TTY/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
