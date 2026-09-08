# RPGWright

A Playwright-like end-to-end testing framework for terminal applications that depend on real TTY behavior — raw input mode, ANSI escape sequences, the alternate screen buffer, cursor positioning. Built for Ink/React CLI apps and RPG/MUD-style text adventures in particular, but works with any real-TTY-driven program.

> **Status:** early development (Phase 1 of the build — see `RPGWright.md`). Not yet published.

## Why

A plain `child_process.spawn` can't exercise raw-mode TTY behavior, because Node only enables it when it detects a real terminal. RPGWright launches your app inside an actual pseudo-terminal (`node-pty`), drives it with real keystrokes, and asserts against the terminal's actual interpreted screen contents (`@xterm/headless`) — closing the gap between unit tests and manual QA.

## Install

```
npm install -D rpgwright
```

## Quickstart

```
npx rpgwright init
npx rpgwright test
```

Full documentation lives in [`docs/`](./docs/intro.md).

## License

MIT
