'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs, resolveOutput, runTests, loadPlan, runOptions } = require('../runner/run');

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

test('runOptions: trace and retries come from the config unless given; an unknown --trace fails clearly', () => {
  const config = { trace: 'retain-on-failure', retries: 2 };
  const fromConfig = runOptions(config);
  assert.equal(fromConfig.trace, 'retain-on-failure');
  assert.equal(fromConfig.retries, 2);
  assert.ok(fromConfig.traceNames instanceof Set);
  const flagged = runOptions(config, { trace: 'on', retries: 0, updateSnapshots: true });
  assert.deepEqual([flagged.trace, flagged.retries, flagged.updateSnapshots], ['on', 0, true]);
  assert.throws(() => runOptions(config, { trace: 'sometimes' }), /--trace/);
});

test('parseArgs: --save-run is a boolean flag', () => {
  assert.deepEqual(parseArgs(['--save-run', '--ui']), { configPath: null, filters: [], saveRun: true, ui: true });
});

test('runOptions: saveRun comes from the config unless --save-run is given, with its own name set', () => {
  assert.equal(runOptions({ saveRun: false }).saveRun, false);
  assert.equal(runOptions({ saveRun: true }).saveRun, true);
  assert.equal(runOptions({ saveRun: false }, { saveRun: true }).saveRun, true);
  const options = runOptions({});
  assert.equal(options.saveRun, false);
  assert.ok(options.runNames instanceof Set);
  assert.notEqual(options.runNames, options.traceNames);
});

test('loadConfig: saveRun defaults to false and must be a boolean', (t) => {
  const { loadConfig } = require('../runner/config');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-saverun-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'rpgwright.config.js');
  fs.writeFileSync(configFile, `module.exports = { command: 'true' };`);
  assert.equal(loadConfig({ cwd: dir }).saveRun, false);
  fs.writeFileSync(configFile, `module.exports = { command: 'true', saveRun: true };`);
  assert.equal(loadConfig({ cwd: dir }).saveRun, true);
  fs.writeFileSync(configFile, `module.exports = { command: 'true', saveRun: 'yes' };`);
  assert.throws(() => loadConfig({ cwd: dir }), /"saveRun" must be true or false, got "yes"/);
});

test('loadPlan: selects by filter and grep across files, in file order, repeating with --repeat-each', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const api = JSON.stringify(path.join(__dirname, '..', 'runner', 'test.js'));
  fs.writeFileSync(path.join(dir, 'rpgwright.config.js'), `module.exports = { command: 'true' };`);
  fs.writeFileSync(path.join(dir, 'a.rpg.test.js'), `const { test } = require(${api});\ntest('one @hud', () => {});\ntest('two', () => {});\n`);
  fs.writeFileSync(path.join(dir, 'b.rpg.test.js'), `const { test } = require(${api});\ntest('three @hud', () => {});\n`);

  const names = (plan) => plan.map(({ file, tests }) => [path.basename(file), tests.map((x) => x.name)]);
  assert.deepEqual(names(loadPlan({ cwd: dir, grep: '@hud' }).plan), [['a.rpg.test.js', ['one @hud']], ['b.rpg.test.js', ['three @hud']]]);
  assert.deepEqual(names(loadPlan({ cwd: dir, filters: ['a.rpg'], repeatEach: 2 }).plan), [
    ['a.rpg.test.js', ['one @hud [repeat 1/2]', 'one @hud [repeat 2/2]', 'two [repeat 1/2]', 'two [repeat 2/2]']],
  ]);
  const { files } = loadPlan({ cwd: dir, filters: ['nothing'] });
  assert.equal(files.length, 2);
});
