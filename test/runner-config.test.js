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

test('loadConfig: passes terminal-environment fields (term, colorDepth, locale) through untouched', () => {
  const cwd = tempDir();
  fs.writeFileSync(
    path.join(cwd, 'rpgwright.config.js'),
    "module.exports = { command: 'node', term: 'xterm-256color', colorDepth: 'none', locale: 'C' };",
  );
  const config = loadConfig({ cwd });
  assert.equal(config.term, 'xterm-256color');
  assert.equal(config.colorDepth, 'none');
  assert.equal(config.locale, 'C');
});

test('loadConfig: viewports are validated and named "<cols>x<rows>" unless given a name', () => {
  const cwd = tempDir();
  fs.writeFileSync(
    path.join(cwd, 'rpgwright.config.js'),
    "module.exports = { command: 'node', viewports: [{ cols: 80, rows: 24 }, { name: 'tiny', cols: 20, rows: 5 }] };",
  );
  assert.deepEqual(loadConfig({ cwd }).viewports, [
    { name: '80x24', cols: 80, rows: 24 },
    { name: 'tiny', cols: 20, rows: 5 },
  ]);
});

test('loadConfig: viewports is left undefined when absent, and rejected when malformed', () => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), "module.exports = { command: 'node' };");
  assert.equal(loadConfig({ cwd }).viewports, undefined);

  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), "module.exports = { command: 'node', viewports: [] };");
  assert.throws(() => loadConfig({ cwd }), /"viewports" must be a non-empty array/);

  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), "module.exports = { command: 'node', viewports: [{ cols: 80 }] };");
  assert.throws(() => loadConfig({ cwd }), /viewports\[0\] must have positive integer "cols" and "rows"/);
});

test('loadConfig: trace defaults to "off" and outputDir to test-results next to the config; bad trace modes fail', () => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), "module.exports = { command: 'node' };");
  const config = loadConfig({ cwd });
  assert.equal(config.trace, 'off');
  assert.equal(config.outputDir, path.join(cwd, 'test-results'));

  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), "module.exports = { command: 'node', trace: 'retain-on-failure', outputDir: 'out' };");
  assert.equal(loadConfig({ cwd }).trace, 'retain-on-failure');
  assert.equal(loadConfig({ cwd }).outputDir, path.join(cwd, 'out'));

  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), "module.exports = { command: 'node', trace: 'always' };");
  assert.throws(() => loadConfig({ cwd }), /"trace" must be one of off, on, retain-on-failure/);
});

test('loadConfig: retries defaults to 0 and must be a non-negative integer', () => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), "module.exports = { command: 'node' };");
  assert.equal(loadConfig({ cwd }).retries, 0);
  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), "module.exports = { command: 'node', retries: 2 };");
  assert.equal(loadConfig({ cwd }).retries, 2);
  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), "module.exports = { command: 'node', retries: 1.5 };");
  assert.throws(() => loadConfig({ cwd }), /"retries" must be a non-negative integer/);
});

test('loadConfig: workers defaults to 1; services get cwd resolved; globalSetup/Teardown resolve next to the config', () => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), "module.exports = { command: 'node' };");
  const defaults = loadConfig({ cwd });
  assert.equal(defaults.workers, 1);
  assert.deepEqual(defaults.services, []);
  assert.equal(defaults.globalSetup, undefined);

  fs.writeFileSync(
    path.join(cwd, 'rpgwright.config.js'),
    "module.exports = { command: 'node', workers: 4, services: [{ command: 'redis-server', cwd: 'srv' }], globalSetup: './setup.js', globalTeardown: 'hooks/down.js' };",
  );
  const config = loadConfig({ cwd });
  assert.equal(config.workers, 4);
  assert.deepEqual(config.services, [{ command: 'redis-server', cwd: path.join(cwd, 'srv') }]);
  assert.equal(config.globalSetup, path.join(cwd, 'setup.js'));
  assert.equal(config.globalTeardown, path.join(cwd, 'hooks', 'down.js'));
});

test('loadConfig: rejects bad workers and services', () => {
  const cwd = tempDir();
  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), "module.exports = { command: 'node', workers: 0 };");
  assert.throws(() => loadConfig({ cwd }), /"workers" must be a positive integer/);
  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), "module.exports = { command: 'node', services: { command: 'x' } };");
  assert.throws(() => loadConfig({ cwd }), /"services" must be an array/);
  fs.writeFileSync(path.join(cwd, 'rpgwright.config.js'), "module.exports = { command: 'node', services: [{ args: [] }] };");
  assert.throws(() => loadConfig({ cwd }), /services\[0\] must have a "command"/);
});
