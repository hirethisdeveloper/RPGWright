'use strict';

const os = require('node:os');
const { spawn } = require('node:child_process');
const pty = require('node-pty');

// How long spawnPipe waits, after its process exits, for the pipes to close
// (the rest of its output to arrive) before reporting the exit anyway.
const PIPE_CLOSE_GRACE_MS = 200;

// spawnPipe's processes run in their own session, so unlike a terminal's
// they get no hangup (and no Ctrl+C) when this process goes away. Kill any
// still running when it exits, so a crashed or interrupted run can't leave
// them behind.
const live = new Set();
process.on('exit', () => {
  for (const child of live) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

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
  // Its own process group (POSIX), so kill() reaches whatever it started
  // too: `sh -c`, `npm run` and dev servers leave the real work in a child.
  const groupKill = process.platform !== 'win32';
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: groupKill });

  const listeners = new Set();
  const emit = (chunk) => listeners.forEach((listener) => listener(chunk));
  // Decoded per stream, so a multi-byte character split across two chunks
  // isn't turned into replacement characters.
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
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
  // 'exit' fires when the process ends; 'close' once its pipes have closed
  // too, which is when all of its output has been delivered. Report the
  // exit at 'close', but don't wait for it forever: a process it started
  // can hold the pipes open long after it's gone. Signals are reported as
  // numbers, the way node-pty reports them.
  child.on('exit', (code, signal) => {
    live.delete(child);
    const info = { exitCode: code ?? 0, signal: signal ? os.constants.signals[signal] : null };
    child.on('close', () => exited(info));
    setTimeout(() => exited(info), PIPE_CLOSE_GRACE_MS).unref();
  });
  // A failed spawn (no such command) emits 'error' and never 'exit'; report
  // it like a shell does, as exit code 127, keeping the reason.
  child.on('error', (err) => {
    live.delete(child);
    exited({ exitCode: 127, signal: null, error: err.message });
  });
  if (groupKill && child.pid) live.add(child);

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
      try {
        if (groupKill) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Already gone (or never started).
      }
    },
    pid: child.pid,
  };
}

module.exports = { spawnPty, spawnPipe };
