'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, DEFAULT_TEST_MATCH, DEFAULT_TEST_TIMEOUT, DEFAULT_REPORTER } = require('../runner/config');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-config-test-'));
}

test('loadConfig: throws a clear error when no config file exists and none was specified', () => {
  const cwd = tempDir();
  assert.throws(() => loadConfig({ cwd }), /No rpgwright\.config\.js found/);
});

test('loadConfig: throws a clear error when an explicit --config path does not exist', () => {
  const cwd = tempDir();
  assert.throws(() => loadConfig({ cwd, configPath: 'does-not-exist.js' }), /Config file not found/);
});

test('loadConfig: throws if the config does not export a "command"', () => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), 'module.exports = { args: [] };');
  assert.throws(() => loadConfig({ cwd }), /must export a "command"/);
});

test('loadConfig: applies testDir/testMatch/timeout defaults when the config omits them', () => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), "module.exports = { command: 'node' };");
  const config = loadConfig({ cwd });
  assert.equal(config.command, 'node');
  assert.equal(config.testDir, cwd);
  assert.deepEqual(config.testMatch, DEFAULT_TEST_MATCH);
  assert.equal(config.timeout, DEFAULT_TEST_TIMEOUT);
  assert.equal(config.reporter, DEFAULT_REPORTER);
});

test('loadConfig: an explicit reporter choice overrides the default', () => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), "module.exports = { command: 'node', reporter: 'dot' };");
  const config = loadConfig({ cwd });
  assert.equal(config.reporter, 'dot');
});

test('loadConfig: passes through launchGame-specific fields untouched, without inventing its own defaults', () => {
  const cwd = tempDir();
  fs.writeFileSync(
    path.join(cwd, 'rpgwright.config.js'),
    "module.exports = { command: 'node', cols: 100, killSignal: 'SIGINT' };",
  );
  const config = loadConfig({ cwd });
  assert.equal(config.cols, 100);
  assert.equal(config.killSignal, 'SIGINT');
  assert.equal(config.rows, undefined, 'rows was not set in the config and loadConfig should not invent one');
});

test('loadConfig: an explicit testDir in the config is resolved relative to the config file', () => {
  const cwd = tempDir();
  fs.mkdirSync(path.join(cwd, 'suite'));
  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), "module.exports = { command: 'node', testDir: './suite' };");
  const config = loadConfig({ cwd });
  assert.equal(config.testDir, path.join(cwd, 'suite'));
});

test('loadConfig: --config can point at a config file outside the current directory', () => {
  const cwd = tempDir();
  const configPath = path.join(cwd, 'nested', 'rpgwright.config.js');
  fs.mkdirSync(path.dirname(configPath));
  fs.writeFileSync(configPath, "module.exports = { command: 'node' };");
  const config = loadConfig({ cwd, configPath });
  assert.equal(config.testDir, path.dirname(configPath));
});
