# RPGWright

A Playwright-like end-to-end testing framework for terminal applications that depend on real TTY behavior — raw input mode, ANSI escape sequences, the alternate screen buffer, cursor positioning. Built for Ink/React CLI apps and RPG/MUD-style text adventures in particular, but works with any real-TTY-driven program.

## Why

CLI applications are hard to test. Once your app takes over the terminal — prompts, menus, live-updating screens, keyboard navigation — most testing tools stop being useful, because they were built for asserting on log output or a DOM, not on what actually appears on screen. That usually leaves teams stuck testing CLIs by hand.

RPGWright makes CLI apps testable the way Playwright made web apps testable: it drives your program like a real user would (real keystrokes, real terminal) and lets you assert on what's actually rendered.

Under the hood, this requires more than `child_process.spawn`, since Node only enables raw-mode TTY behavior when it detects a real terminal. RPGWright launches your app inside an actual pseudo-terminal (`node-pty`), drives it with real keystrokes, and asserts against the terminal's actual interpreted screen contents (`@xterm/headless`) — closing the gap between unit tests and manual QA.

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
