# Changelog

## 0.2.0

A large feature release, with a few breaking changes (listed at the end).

### Added
- **Layout and style assertions:** locators (strict, lazy screen regions), box detection, and checks for position, alignment, gaps, clipping, text, style and focus (`expectLayout`, `expectCount`, `expectFocusGroup`, `getFocused`).
- **Terminal assertions:** cursor position and visibility, alt screen, title, bell, hyperlinks (OSC 8), clipboard (OSC 52), scrollback, mouse tracking and bracketed paste; frame history with `expectSeen` and `expectNoFlicker`.
- **Input:** `paste`, `mouse` (all tracking modes and encodings), Playwright-style key chords (`Control+ArrowLeft`), `press.raw`.
- **Diagnostics:** HTML traces (`--trace`), asciinema `.cast` recordings, `game.renderHtml()`, `game.getTrace()`.
- **Runner:** lazy fixtures (`game`, `viewport`, `launch`, `tmpHome`, `testInfo`), `test.extend`, `test.use`, hooks, `describe`, `skip`/`only`/`fixme`/`fail`, `test.step`, `test.eachViewport`, retries, `--workers`, `--repeat-each`, `--grep`, `file:line` filters, background `services`, `globalSetup`/`globalTeardown`, `json`/`junit`/`github`/`dot` reporters, `--watch`, `.ts` test files.
- **`tty: false`** to run an app with plain pipes; `term`, `colorDepth` and `locale` launch options.
- **TypeScript declarations** (`types/`) and new docs: `layout-and-focus.md`, plus updates across `docs/`.

### Fixed
- `stop()` no longer hangs when a `tty: false` process or service left a child process holding its pipes; the whole process group is stopped.
- No more false "process exited before condition became true" failures with `tty: false`.
- `expectExit({ code: 0 })` no longer passes for a process killed by a signal.
- A timed-out test no longer leaves its app running or hangs the CLI, and its `afterEach` runs before the next test.
- `beforeAll`/`afterAll` hooks have a timeout; a run that never reaches its summary exits 1.
- Unhandled rejections and non-`Error` throws are reported as failures instead of crashing the run.
- Memory no longer grows with every action (screens are kept only when recording).
- `--watch` works for ES-module test files and ignores its own output.
- UTF-8 split across chunks, X10 mouse reports past column 94, and box detection on ordinary text (`a+b`).
- Adding `styles: true` to an existing snapshot compares the recorded text first.

### Breaking changes
- Requires **Node 20 or later** (was 18).
- Recording a snapshot waits for the screen to stop changing first (`stable: false` skips it), so a screen that never settles can no longer be recorded.
- `*.rpg.test.ts` files are picked up by default.
- `rpgwright test` rejects unknown flags instead of ignoring them.
- Trace and recording file names use the test file's path under `testDir`.
- A test whose parameter isn't destructured gets every fixture except `tmpHome`.
- `game.actions` entries gain fields (`depth`, `t`, `frame`, `bells`, and with `record`, `screen` and `cursor`); `getCursor()` returns `{ x, y, visible }`; run totals gain `flaky`.
- `tty: false` apps and services run in their own process group.
- `locator.source.driver` is replaced by `locator.driver`; `test.eachViewport([...])` validates the list it is given.
