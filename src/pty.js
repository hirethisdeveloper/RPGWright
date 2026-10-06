'use strict';

const os = require('node:os');
const { spawn } = require('node:child_process');
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
  term = 'xterm-color',
}) {
  // node-pty sets TERM in the child's env from `name`.
  const ptyProcess = pty.spawn(command, args, {
    name: term,
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

/**
 * The same handle as spawnPty, for a process with plain pipes instead of a
 * terminal: `process.stdout.isTTY` is false in the child, which is how apps
 * decide to drop colors, spinners and interactive prompts. stdout and stderr
 * are merged into one stream, as a terminal would show them. There is no
 * terminal size to change, so resize() does nothing.
 */
function spawnPipe({ command, args = [], cwd = process.cwd(), env = process.env }) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });

  const listeners = new Set();
  const emit = (chunk) => listeners.forEach((listener) => listener(chunk.toString('utf8')));
  child.stdout.on('data', emit);
  child.stderr.on('data', emit);
  // Writing after the child closed stdin would otherwise throw EPIPE.
  child.stdin.on('error', () => {});

  let exitInfo = null;
  const exitWaiters = [];
  function exited(info) {
    if (exitInfo) return;
    exitInfo = info;
    while (exitWaiters.length > 0) exitWaiters.shift()(exitInfo);
  }
  // Signals are reported as numbers, the way node-pty reports them.
  child.on('close', (code, signal) => exited({ exitCode: code ?? 0, signal: signal ? os.constants.signals[signal] : null }));
  // A failed spawn (no such command) emits 'error' and may never emit
  // 'close'; report it like a shell does, as exit code 127.
  child.on('error', () => exited({ exitCode: 127, signal: null }));

  return {
    onData(callback) {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
    write(data) {
      if (!child.stdin.destroyed) child.stdin.write(data);
    },
    resize() {},
    waitForExit() {
      if (exitInfo) return Promise.resolve(exitInfo);
      return new Promise((resolve) => exitWaiters.push(resolve));
    },
    getExitInfo() {
      return exitInfo;
    },
    kill(signal = 'SIGTERM') {
      child.kill(signal);
    },
    pid: child.pid,
  };
}

module.exports = { spawnPty, spawnPipe };
