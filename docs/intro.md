# Getting started

RPGWright is an end-to-end testing framework for terminal applications that depend on real TTY behavior — raw input mode, ANSI escape sequences, the alternate screen buffer, cursor positioning. If your app is built with [Ink](https://github.com/vadimdemedes/ink), or is any other Node.js program that only behaves correctly inside a real terminal, RPGWright launches it in one, drives it with real keystrokes, and asserts against what actually ends up on screen.

## Why not just `child_process.spawn`?

Node only enables raw-mode/TTY behavior when it detects a real terminal. A piped `child_process.spawn` never looks like one, so any app that checks `process.stdin.isTTY`, calls `setRawMode`, or relies on ANSI cursor positioning behaves differently — or breaks outright — under a plain spawn. RPGWright spawns your app inside an actual pseudo-terminal (via [`node-pty`](https://github.com/microsoft/node-pty)), so it sees a real TTY, and interprets everything it prints through the same terminal engine VS Code's own integrated terminal uses ([`@xterm/headless`](https://github.com/xtermjs/xterm.js)) — so "what does the screen say right now" is always accurate, even across full-frame redraws.

## Installation

```bash
npm install -D rpgwright
```

## Scaffold a project

```bash
npx rpgwright init
```

This creates three files in your current directory:

- **`rpgwright.config.js`** — tells RPGWright what to launch and how.
- **`example-app.js`** — a tiny, dependency-free raw-mode script (not your real app yet — just something to prove the tool works).
- **`example.rpg.test.js`** — a test against that script.

It also adds a `"test:e2e": "rpgwright test"` script to your `package.json`, if one exists.

## Run it

```bash
npx rpgwright test
```

You should see:

```
example.rpg.test.js
  ✓ says hello after pressing enter (52ms)

1 passed (56ms)
```

That's the whole loop working: a real process was launched in a real pseudo-terminal, RPGWright waited for its first screen, sent it a real Enter keystroke, and confirmed the resulting screen — with **no arbitrary sleeps** anywhere in that sequence. Every wait in RPGWright is condition-based: it resolves the instant the thing you're waiting for is true, or fails fast with a complete diagnostic report.

## Point it at your own app

Open `rpgwright.config.js`:

```js
module.exports = {
  command: process.execPath,
  args: [path.join(__dirname, 'example-app.js')],
};
```

Change `command`/`args` to whatever launches your real application (for an Ink app, that's typically `command: 'node'`, `args: ['path/to/your/cli.js']` — see the [configuration reference](./configuration.md) for every available option). Then rewrite `example.rpg.test.js` — or delete it and start fresh — following the patterns in [Writing tests](./writing-tests.md).

## What's next

- **[Writing tests](./writing-tests.md)** — the `test()`/`expect()` API, the `game` fixture, and the full set of interactions (`press`, `type`, `expectText`, and friends) with real examples.
- **[Configuration](./configuration.md)** — every `rpgwright.config.js` option.
- **[CLI reference](./cli.md)** — `rpgwright init` and `rpgwright test` in full, including flags and exit codes.
- **[Assertions](./assertions.md)** — a deeper look at each `expect*` method, including snapshot testing and waiting on external state.
