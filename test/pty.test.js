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

const { spawnPipe } = require('../src/pty');

test('spawnPipe: same handle shape, the child sees no TTY, and stdout and stderr are merged', { timeout: 10000 }, async () => {
  const handle = spawnPipe({
    command: process.execPath,
    args: ['-e', "process.stdout.write('isTTY=' + Boolean(process.stdout.isTTY) + '\\n'); process.stderr.write('to stderr\\n'); process.stdin.on('data', (d) => { process.stdout.write('echo ' + d); process.exit(4); });"],
  });
  for (const method of ['onData', 'write', 'resize', 'waitForExit', 'getExitInfo', 'kill']) assert.equal(typeof handle[method], 'function', method);
  let output = '';
  handle.onData((chunk) => {
    output += chunk;
  });
  while (!output.includes('to stderr')) await new Promise((r) => setTimeout(r, 10));
  assert.match(output, /isTTY=false/);
  assert.equal(handle.getExitInfo(), null);
  handle.write('hi\n');
  assert.deepEqual(await handle.waitForExit(), { exitCode: 4, signal: null });
  assert.match(output, /echo hi/);
  assert.deepEqual(await handle.waitForExit(), { exitCode: 4, signal: null }, 'resolves again once exited');
});

test('spawnPipe: kill() reports the signal as a number; a missing command exits 127', async () => {
  const sleeper = spawnPipe({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 10000)'] });
  sleeper.kill('SIGTERM');
  assert.deepEqual(await sleeper.waitForExit(), { exitCode: 0, signal: 15 });

  const missing = spawnPipe({ command: '/nonexistent/command' });
  assert.equal((await missing.waitForExit()).exitCode, 127);
});

test('spawnPipe: a multi-byte character split across two chunks decodes cleanly', async () => {
  const handle = spawnPipe({
    command: process.execPath,
    args: ['-e', "const b = Buffer.from('─'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 50);"],
  });
  let output = '';
  handle.onData((chunk) => {
    output += chunk;
  });
  await handle.waitForExit();
  assert.equal(output, '─');
});

test('spawnPipe: the exit is reported while a process it started still holds the pipes, and kill() reaches that process too', { timeout: 10000 }, async () => {
  const handle = spawnPipe({ command: 'sh', args: ['-c', 'sleep 30 & echo "pid=$!"'] });
  let output = '';
  handle.onData((chunk) => {
    output += chunk;
  });
  const exitInfo = await handle.waitForExit();
  assert.deepEqual(exitInfo, { exitCode: 0, signal: null });
  const sleeper = Number(/pid=(\d+)/.exec(output)[1]);
  assert.doesNotThrow(() => process.kill(sleeper, 0), 'the background process is still running');
  handle.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 100));
  assert.throws(() => process.kill(sleeper, 0), /ESRCH/, 'kill() signalled the whole process group');
});

test('spawnPipe: a command that cannot be started keeps the reason', async () => {
  const missing = spawnPipe({ command: '/nonexistent/command' });
  assert.match((await missing.waitForExit()).error, /ENOENT/);
});

test('stopProcess: SIGTERM when the process cooperates, SIGKILL after the timeout when it ignores it', { timeout: 15000 }, async () => {
  const { stopProcess } = require('../src/game');
  const polite = spawnPipe({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
  assert.deepEqual(await stopProcess(polite, { timeout: 5000 }), { exitCode: 0, signal: 15 });

  const stubborn = spawnPipe({ command: process.execPath, args: ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"] });
  await new Promise((resolve) => stubborn.onData((chunk) => chunk.includes('ready') && resolve()));
  const started = Date.now();
  assert.deepEqual(await stopProcess(stubborn, { timeout: 300 }), { exitCode: 0, signal: 9 });
  assert.ok(Date.now() - started >= 300, 'waited out the grace period before escalating');
});
