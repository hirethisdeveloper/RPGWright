'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { startService, startRunEnvironment, portIsOpen } = require('../runner/services');

const node = process.execPath;

test('startService: ready once its output contains readyText (string or RegExp), and stop() ends it', async () => {
  const service = await startService({ command: node, args: ['-e', "setTimeout(() => console.log('Listening on 4000'), 100); setInterval(() => {}, 1000)"], readyText: /Listening on \d+/ });
  assert.equal(service.name, `${node} -e setTimeout(() => console.log('Listening on 4000'), 100); setInterval(() => {}, 1000)`);
  await service.stop();
});

test('startService: ready once readyPort accepts connections', async () => {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  assert.equal(await portIsOpen(port), true);
  server.close();
  await new Promise((r) => server.on('close', r));
  assert.equal(await portIsOpen(port), false);

  const service = await startService({
    name: 'listener',
    command: node,
    args: ['-e', `setTimeout(() => require('net').createServer().listen(${port}), 150)`],
    readyPort: port,
  });
  assert.equal(await portIsOpen(port), true);
  await service.stop();
});

test('startService: fails with the service output if it exits first, or if it is not ready in time', async () => {
  await assert.rejects(
    startService({ name: 'crash', command: node, args: ['-e', "console.log('bad config'); process.exit(2)"], readyText: 'ok' }),
    /Service "crash" exited \(code 2\) before it was ready\.\nIts last output:\nbad config/,
  );
  await assert.rejects(
    startService({ name: 'slow', command: node, args: ['-e', "console.log('starting'); setInterval(() => {}, 1000)"], readyText: 'ok', timeout: 300 }),
    /Service "slow" wasn't ready within 300ms\.\nIts last output:\nstarting/,
  );
  await assert.rejects(startService({ name: 'missing', command: '/nonexistent/server', readyText: 'up' }), /Service "missing" couldn't be started \(spawn \/nonexistent\/server ENOENT\)/);
});

test('portIsOpen: a server listening on IPv6 localhost only counts as open', async (t) => {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::1', resolve);
    });
  } catch {
    t.skip('no IPv6 loopback here');
    return;
  }
  assert.equal(await portIsOpen(server.address().port), true);
  server.close();
});

test('startRunEnvironment: setup in order, teardown in reverse; a failure part-way undoes what already started', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-env-'));
  const log = [];
  global.__rpgwrightEnvLog = log;
  fs.writeFileSync(path.join(dir, 'setup.js'), "module.exports = async () => { global.__rpgwrightEnvLog.push('setup'); return async () => global.__rpgwrightEnvLog.push('returned teardown'); };");
  fs.writeFileSync(path.join(dir, 'teardown.js'), "module.exports = { default: async () => global.__rpgwrightEnvLog.push('globalTeardown') };");
  fs.writeFileSync(path.join(dir, 'bad-setup.js'), "module.exports = async () => { throw new Error('setup broke'); };");
  fs.writeFileSync(path.join(dir, 'not-a-function.js'), 'module.exports = 42;');

  const teardown = await startRunEnvironment({ globalSetup: path.join(dir, 'setup.js'), globalTeardown: path.join(dir, 'teardown.js') });
  assert.deepEqual(log, ['setup']);
  await teardown();
  assert.deepEqual(log, ['setup', 'returned teardown', 'globalTeardown']);

  log.length = 0;
  await assert.rejects(
    startRunEnvironment({ globalSetup: path.join(dir, 'bad-setup.js'), globalTeardown: path.join(dir, 'teardown.js') }),
    /setup broke/,
  );
  assert.deepEqual(log, ['globalTeardown'], 'the teardown that was already registered still ran');

  await assert.rejects(startRunEnvironment({ globalSetup: path.join(dir, 'not-a-function.js') }), /must export a function/);
  delete global.__rpgwrightEnvLog;
});
