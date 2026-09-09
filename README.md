# RPGWright

A Playwright-like end-to-end testing framework for terminal applications that depend on real TTY behavior — raw input mode, ANSI escape sequences, the alternate screen buffer, cursor positioning. Built for Ink/React CLI apps and RPG/MUD-style text adventures in particular, but works with any real-TTY-driven program.

> **Status:** Phase 4 of the build (real-world integration — see `RPGWright.md`). Validated against a real, independently-written MongoDB-backed Ink game. Not yet published to npm.

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
- [Key sequences](./docs/key-sequences.md)
- [Diagnostics](./docs/diagnostics.md)
- [Best practices](./docs/best-practices.md)
- [Running in CI](./docs/ci.md)

## License

MIT
