'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'rpgwright.js');

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    ...options,
  });
}

test('rpgwright test: runs the minimal-ink-app dogfood suite as a real subprocess, exit code 0', () => {
  const result = runCli(['test', '--config', 'test/rpg/minimal/rpgwright.config.js'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\d+ passed/);
  assert.doesNotMatch(result.stdout, /✖/);
});

test('rpgwright test: runs the menu-nav-ink-app dogfood suite as a real subprocess, exit code 0', () => {
  const result = runCli(['test', '--config', 'test/rpg/menu-nav/rpgwright.config.js'], { cwd: REPO_ROOT });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /\d+ passed/);
  assert.doesNotMatch(result.stdout, /✖/);
});

test('rpgwright test: a failing test produces a nonzero exit code and prints the §9 block to stdout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-e2e-fail-'));
  fs.writeFileSync(
    path.join(dir, 'rpgwright.config.js'),
    `module.exports = { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(
      path.join(REPO_ROOT, 'fixtures', 'minimal-ink-app', 'cli.js'),
    )}], cols: 40, rows: 10 };`,
  );
  fs.writeFileSync(
    path.join(dir, 'broken.rpg.test.js'),
    `const { test } = require(${JSON.stringify(path.join(REPO_ROOT, 'runner', 'test.js'))});
test('never happens', async ({ game }) => {
  await game.expectText('this will never appear', { timeout: 300 });
});
`,
  );

  const result = runCli(['test'], { cwd: dir });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /E2E TEST FAILED/);
  assert.match(result.stdout, /1 failed/);
  // The runner must wire the running test's name into launchGame's
  // scenarioName, not leave every failure report saying "unnamed scenario"
  // regardless of which test actually failed.
  assert.match(result.stdout, /Scenario: never happens/);
  assert.doesNotMatch(result.stdout, /Scenario: unnamed scenario/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright test: --config with no path errors clearly instead of silently falling back to default discovery', () => {
  const result = runCli(['test', '--config'], { cwd: REPO_ROOT });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /--config requires a path/);
});

test('rpgwright test: a missing config file produces a clear, actionable error and nonzero exit code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-e2e-noconfig-'));
  const result = runCli(['test'], { cwd: dir });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /rpgwright init/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright init then rpgwright test: the scaffolded example passes out of the box', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-e2e-init-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'consumer-app', version: '1.0.0' }));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.symlinkSync(REPO_ROOT, path.join(dir, 'node_modules', 'rpgwright'), 'dir');

  const initResult = runCli(['init'], { cwd: dir });
  assert.equal(initResult.status, 0, initResult.stdout + initResult.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'rpgwright.config.js')));
  assert.ok(fs.existsSync(path.join(dir, 'example-app.js')));
  assert.ok(fs.existsSync(path.join(dir, 'example.rpg.test.js')));

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:e2e'], 'rpgwright test');

  const testResult = runCli(['test'], { cwd: dir });
  assert.equal(testResult.status, 0, testResult.stdout + testResult.stderr);
  assert.match(testResult.stdout, /1 passed/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright init: is safe to re-run and does not overwrite existing files without --force', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-e2e-reinit-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'consumer-app', version: '1.0.0' }));

  runCli(['init'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'rpgwright.config.js'), '// customized by the user\n');

  const second = runCli(['init'], { cwd: dir });
  assert.equal(second.status, 0);
  assert.match(second.stdout, /skipped rpgwright\.config\.js/);
  assert.equal(fs.readFileSync(path.join(dir, 'rpgwright.config.js'), 'utf8'), '// customized by the user\n');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('rpgwright (no subcommand): prints usage and exits 0', () => {
  const result = runCli([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: rpgwright/);
});

test('rpgwright (unknown subcommand): prints usage and exits nonzero', () => {
  const result = runCli(['bogus']);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Usage: rpgwright/);
});
