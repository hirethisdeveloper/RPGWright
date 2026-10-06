'use strict';

const net = require('node:net');
const { spawnPipe } = require('../src/pty');

const DEFAULT_READY_TIMEOUT = 30000;
const STOP_GRACE_MS = 3000;

function portIsOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

function matches(output, needle) {
  return needle instanceof RegExp ? needle.test(output) : output.includes(needle);
}

/**
 * Starts one background service and resolves once it is ready: when its
 * output contains `readyText`, when `readyPort` accepts connections, or
 * immediately if neither is given. Fails if it exits or times out first,
 * showing the end of its output.
 */
async function startService(service) {
  const name = service.name || [service.command, ...(service.args || [])].join(' ');
  const handle = spawnPipe({ command: service.command, args: service.args, cwd: service.cwd, env: service.env });
  let output = '';
  handle.onData((chunk) => {
    output += chunk;
    if (output.length > 20000) output = output.slice(-10000);
  });
  const fail = (reason) => {
    handle.kill('SIGKILL');
    const tail = output.trim().split('\n').slice(-20).join('\n');
    return new Error(`Service "${name}" ${reason}.${tail ? `\nIts last output:\n${tail}` : ''}`);
  };

  const deadline = Date.now() + (service.timeout ?? DEFAULT_READY_TIMEOUT);
  for (;;) {
    const exit = handle.getExitInfo();
    if (exit) throw fail(`exited (code ${exit.exitCode}) before it was ready`);
    if (service.readyText === undefined && service.readyPort === undefined) break;
    if (service.readyText !== undefined && matches(output, service.readyText)) break;
    if (service.readyPort !== undefined && (await portIsOpen(service.readyPort))) break;
    if (Date.now() > deadline) throw fail(`wasn't ready within ${service.timeout ?? DEFAULT_READY_TIMEOUT}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    name,
    async stop() {
      if (handle.getExitInfo()) return;
      handle.kill('SIGTERM');
      const exited = await Promise.race([handle.waitForExit(), new Promise((r) => setTimeout(() => r(null), STOP_GRACE_MS))]);
      if (!exited) {
        handle.kill('SIGKILL');
        await handle.waitForExit();
      }
    },
  };
}

function loadHook(modulePath) {
  const loaded = require(modulePath);
  const fn = typeof loaded === 'function' ? loaded : loaded && loaded.default;
  if (typeof fn !== 'function') throw new Error(`${modulePath} must export a function (module.exports = async (config) => { ... }).`);
  return fn;
}

/**
 * Everything a run needs around its tests: start `services` (in order),
 * then run `globalSetup`. Returns a teardown that undoes it all in reverse:
 * the function globalSetup returned (if any), `globalTeardown`, then the
 * services. If anything fails part-way, what was already started is torn
 * down before the error is rethrown.
 */
async function startRunEnvironment(config) {
  const undo = [];
  async function teardown() {
    let firstError = null;
    while (undo.length) {
      try {
        await undo.pop()();
      } catch (err) {
        if (!firstError) firstError = err;
      }
    }
    if (firstError) throw firstError;
  }

  try {
    for (const service of config.services || []) {
      const started = await startService(service);
      undo.push(() => started.stop());
    }
    if (config.globalTeardown) {
      const globalTeardown = loadHook(config.globalTeardown);
      undo.push(() => globalTeardown(config));
    }
    if (config.globalSetup) {
      const returned = await loadHook(config.globalSetup)(config);
      if (typeof returned === 'function') undo.push(returned);
    }
  } catch (err) {
    await teardown().catch(() => {});
    throw err;
  }
  return teardown;
}

module.exports = { startService, startRunEnvironment, portIsOpen };
