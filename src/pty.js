'use strict';

const pty = require('node-pty');

/**
 * Spawns `command` inside a real pseudo-terminal and returns a small set of
 * primitives for driving it. No app-specific knowledge, no signal-escalation
 * policy — that belongs to game.js. `kill()` here just forwards to node-pty,
 * whose POSIX default signal is SIGHUP (not SIGTERM); callers must pass an
 * explicit signal if they want graceful-shutdown semantics.
 */
function spawnPty({
  command,
  args = [],
  cols = 120,
  rows = 40,
  cwd = process.cwd(),
  env = process.env,
}) {
  const ptyProcess = pty.spawn(command, args, {
    name: 'xterm-color',
    cols,
    rows,
    cwd,
    env,
  });

  let exitInfo = null;
  const exitWaiters = [];

  ptyProcess.onExit(({ exitCode, signal }) => {
    exitInfo = { exitCode, signal: signal || null };
    while (exitWaiters.length > 0) {
      exitWaiters.shift().resolve(exitInfo);
    }
  });

  function onData(callback) {
    const disposable = ptyProcess.onData(callback);
    return { dispose: () => disposable.dispose() };
  }

  function write(data) {
    ptyProcess.write(data);
  }

  function resize(cols, rows) {
    ptyProcess.resize(cols, rows);
  }

  function getExitInfo() {
    return exitInfo;
  }

  function waitForExit() {
    if (exitInfo) return Promise.resolve(exitInfo);
    return new Promise((resolve) => {
      exitWaiters.push({ resolve });
    });
  }

  function kill(signal = 'SIGTERM') {
    ptyProcess.kill(signal);
  }

  return {
    onData,
    write,
    resize,
    waitForExit,
    getExitInfo,
    kill,
    pid: ptyProcess.pid,
  };
}

module.exports = { spawnPty };
