# RPGWright

A Playwright-like end-to-end testing framework for terminal applications that depend on real TTY behavior — raw input mode, ANSI escape sequences, the alternate screen buffer, cursor positioning. Built for Ink/React CLI apps and RPG/MUD-style text adventures in particular, but works with any real-TTY-driven program.

> **Status:** early development (Phase 3 of the build — see `RPGWright.md`). Not yet published.

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

`rpgwright init` scaffolds a config and a self-contained example that passes immediately, so you can see the tool work before wiring it up to your own app.

## Documentation

Full documentation lives in [`docs/`](./docs/intro.md):

- [Getting started](./docs/intro.md)
- [Writing tests](./docs/writing-tests.md)
- [Configuration reference](./docs/configuration.md)
- [CLI reference](./docs/cli.md)
- [Assertions](./docs/assertions.md)

## License

MIT
