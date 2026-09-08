---
name: pty
description: node-pty spawn/write/resize/kill contract, the SIGHUP default-signal trap, and process lifecycle gotchas behind src/pty.js.
---

# `pty.js`

## Purpose and boundaries

`spawnPty()` is the only place in RPGWright that touches `node-pty` directly. It owns exactly one thing: the raw OS process running inside a pseudo-terminal. It has no opinion about *when* to kill the process, what signal escalation policy to use, or what the process's output means — that's `game.js`'s and `terminal.js`'s job respectively. Keeping this boundary strict is what let `terminal.js` and `assertions.js` be built and tested independently of any real process.

## The returned handle

```js
{ onData(cb): Disposable, write(data), resize(cols, rows),
  waitForExit(): Promise<ExitInfo>, getExitInfo(): ExitInfo|null,
  kill(signal = 'SIGTERM'), pid }
```

`onData` and the exit-tracking machinery are built on node-pty's own `EventEmitter2`-based `onData`/`onExit` (see `node_modules/node-pty/lib/eventEmitter2.js`) — a small hand-rolled emitter, not Node's core `EventEmitter`. Its `dispose()` just splices one listener out of an array; it has no side effects on the underlying socket (no pause/resume triggered by listener count), so subscribing and disposing listeners freely (as `assertions.js`'s `waitUntil` does on every call) is safe and doesn't drop data between listener swaps.

`waitForExit()` is memoized against a single `exitInfo` value set once by node-pty's `onExit` — calling it after the process has already exited resolves immediately with the same info, rather than hanging (verified by `test/pty.test.js`'s "resolves immediately once the process has already exited" case).

## Known gotchas

### `kill()`'s default signal is SIGHUP, not SIGTERM

This is node-pty's own default (`ptyProcess.kill(signal)` with `signal` defaulting to `'SIGHUP'` if you call it with no argument), not something RPGWright adds. A target app that only handles `SIGTERM` (the common convention) would never see a clean-shutdown signal if a caller relied on node-pty's default. `pty.js`'s own `kill(signal = 'SIGTERM')` default exists specifically to avoid this trap for `game.js`'s `stop()` — but anyone calling `spawnPty()` directly and using the returned `kill()` without an explicit signal should know the default here is intentionally overridden from node-pty's own.

### Prebuilt native binary permissions can get stripped

On this development environment, `node-pty`'s prebuilt `spawn-helper` binary (`node_modules/node-pty/prebuilds/<platform>/spawn-helper`) came out of `npm install` **without its executable bit set**, causing every spawn to fail immediately with `Error: posix_spawnp failed.` The fix was `chmod +x` on that file. This is not an RPGWright bug — it's an artifact of how this particular install/tarball-extraction pipeline handled the prebuilt binary's permissions — but it's the first thing to check if `spawnPty()` throws `posix_spawnp failed` in a fresh environment (CI image, Docker layer, certain npm/yarn caching configurations are the usual suspects). Symptom is immediate and deterministic (throws on `pty.spawn()` itself, not a timeout), so it's easy to distinguish from a genuine target-app problem.

### `command` should be an absolute path or resolvable via PATH

`process.execPath` (the absolute path to the current Node binary) is what RPGWright's own fixtures and tests use as `command`, rather than the bare string `'node'` — both work once the spawn-helper permission issue above is fixed, but using `process.execPath` sidesteps any PATH-resolution ambiguity entirely and is the safer default to document for consumers.

## Testing notes

`test/pty.test.js` exercises spawn/write/resize/kill/exit against the real `fixtures/minimal-ink-app` fixture — no mocking, consistent with [[game-driver]]'s "simulate the player, not the internals" principle applied one layer down. See [[game-driver]] for a real input-timing race that was discovered through this real-process testing and is unrelated to `pty.js` itself (it's a target-app/Ink characteristic, not a pty-layer bug).
