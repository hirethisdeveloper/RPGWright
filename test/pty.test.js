'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnPty } = require('../src/pty');
const { FIXTURE_MINIMAL, waitForData } = require('./helpers');

function spawnFixture(overrides = {}) {
  return spawnPty({ command: process.execPath, args: [FIXTURE_MINIMAL], cols: 40, rows: 10, ...overrides });
}

test('pty: spawns a process and streams its output', async () => {
  const p = spawnFixture();
  await waitForData(p, (buf) => buf.includes('MINIMAL APP'));
  p.kill('SIGTERM');
  await p.waitForExit();
});

test('pty: write() delivers input to the child process', async () => {
  const p = spawnFixture();
  await waitForData(p, (buf) => buf.includes('Press ENTER to continue'));
  const pressed = waitForData(p, (buf) => buf.includes('You pressed ENTER'));
  p.write('\r');
  await pressed;
  p.kill('SIGTERM');
  await p.waitForExit();
});

test('pty: resize() changes the size the child process observes', async () => {
  const p = spawnFixture();
  await waitForData(p, (buf) => buf.includes('Size: 40x10'));
  const resized = waitForData(p, (buf) => buf.includes('Size: 20x6'));
  p.resize(20, 6);
  await resized;
  p.kill('SIGTERM');
  await p.waitForExit();
});

test('pty: kill(SIGTERM) triggers a clean exit with exit code 0', async () => {
  const p = spawnFixture();
  await waitForData(p, (buf) => buf.includes('MINIMAL APP'));
  p.kill('SIGTERM');
  const exitInfo = await p.waitForExit();
  assert.equal(exitInfo.exitCode, 0);
  assert.deepEqual(p.getExitInfo(), exitInfo);
});

test('pty: getExitInfo() is null while the process is still running', async () => {
  const p = spawnFixture();
  await waitForData(p, (buf) => buf.includes('MINIMAL APP'));
  assert.equal(p.getExitInfo(), null);
  p.kill('SIGTERM');
  await p.waitForExit();
});

test('pty: waitForExit() resolves immediately once the process has already exited', async () => {
  const p = spawnFixture();
  await waitForData(p, (buf) => buf.includes('MINIMAL APP'));
  p.kill('SIGTERM');
  await p.waitForExit();
  const exitInfo = await p.waitForExit();
  assert.equal(exitInfo.exitCode, 0);
});
