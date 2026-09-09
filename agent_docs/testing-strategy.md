---
name: testing-strategy
description: How RPGWright tests itself — which suites run on node:test vs. rpgwright test, and why that split is deliberate, not inconsistent.
---

# How RPGWright tests itself

RPGWright's own test suite runs on **two** runners, on purpose, for two different concerns:

## `node:test` — RPGWright's own internals

`test/pty.test.js`, `terminal.test.js`, `assertions.test.js`, `keys.test.js`, and everything under `test/runner-*.test.js` test RPGWright's own implementation modules directly: `spawnPty` against the real fixture (no target-app *scenario*, just process primitives), `createVirtualTerminal` against synthetic ANSI strings (no process at all), `waitUntil`/`waitUntilAbsent`/`pollUntil` against fake emitters, `formatFailureReport` against fabricated input, the `runner/` modules' own logic (config loading, discovery, the test registry, `expect()`'s delegation, the reporter). None of these are "using RPGWright to test an app" — they're unit tests of the tool itself, with no `GameDriver`/fixture lifecycle involved in most of them. Forcing them through `rpgwright test`'s app-launching `{ game }` fixture (see [[runner]]) would mean either spawning a real process for tests that have nothing to do with one, or building a genuine lazy-fixture system just to let some tests opt out — real added machinery for a problem `node:test` already solves today. They stay on `node:test`, and that's a deliberate scope boundary, not leftover Phase 1/2 scaffolding.

`test/runner-e2e.test.js` is a `node:test` file too, even though it spawns real `rpgwright test`/`rpgwright init` subprocesses against real fixtures — it's testing the **CLI as a black box** (exit codes, stdout content), which is a different concern from authoring a `GameDriver` scenario, so it fits the same "testing RPGWright's own internals/tooling" bucket.

## `rpgwright test` — GameDriver-integration tests, dogfooding the real public API

`test/rpg/minimal/basic.rpg.test.js` and `test/rpg/menu-nav/navigation.rpg.test.js` are the Phase 3 port of what used to be `test/game.test.js` and `test/menu-nav.test.js` — hand-rolled `node:test` files that manually called `launchGame()`/`game.stop()` around every test. They're exactly the shape of test a real consumer would write (`test(name, async ({ game }) => {...})`, `expect(game).toX()`), run via `rpgwright test --config test/rpg/<suite>/rpgwright.config.js`, against the real bundled fixtures. Porting real, substantial test content — not throwaway examples — is what actually proves the runner/CLI/config stack works end to end; a trivial synthetic test could pass while missing real issues a full scenario suite exercises (multi-screen navigation, snapshots, external state, resizing).

Each dogfood suite gets its **own** `rpgwright.config.js` because a single config can only point at one `command` — `fixtures/minimal-ink-app` and `fixtures/menu-nav-ink-app` are two different target apps, so they run as two separate `rpgwright test` invocations (`npm run test:e2e` runs both in sequence). This isn't a limitation specific to testing RPGWright itself — any real consumer with more than one target app under test would do the same thing.

These suites can `require('rpgwright/test')` directly (rather than a relative path into `runner/`) because they live inside RPGWright's own package directory, where Node's package self-referencing resolves the package's own name via its own `"exports"` map — see [[runner]] for the mechanism.

## Phase 4: a real external consumer, not another bundled fixture

`fixtures/minimal-ink-app` and `menu-nav-ink-app` are deliberately small and self-contained — good for proving the API surface works, but neither uses the alternate screen buffer with a multi-panel layout, neither depends on an external database, and neither was written by someone other than RPGWright's own author with RPGWright already in mind. Phase 4's job was specifically to find out what breaks against something that *wasn't* built to be easy to test: **Watcher in the Dark**, a real MongoDB-backed MUD-style Ink game (a sibling project, integrated via `npm install <path-to-rpgwright> --save-dev`, config and tests under its own `e2e/` directory).

It worked end to end on the first extended attempt — full character creation (multi-step `TextInput`-driven forms), a genuinely complex real-time gameplay screen (procedural ASCII map, multi-box HUD, live stats), a real typed gameplay command, and a clean SIGTERM-triggered save-and-exit — all correctly captured and driven with zero changes to RPGWright's own core. Two pieces of real friction came out of it, both now reflected in `docs/` rather than left as tribal knowledge:

- A test asserted against a component's literal prop string (`'Create Character'`) and failed, because the UI uppercases and brackets its title (`[ CREATE CHARACTER ]`) for visual consistency — nothing wrong with RPGWright or the app, just a wrong assumption about what actually renders. See `docs/best-practices.md`.
- The `type(digit)` + `press('ENTER')` coalescing risk documented in [[game-driver]] (found originally in RPGWright's own fixture suite) applies here too, and is exactly the shape of mistake a first-time RPGWright user would make on a real "type an answer, hit enter" form. Called out explicitly in `docs/writing-tests.md` and `docs/best-practices.md` rather than assumed obvious.

Neither finding required a change to RPGWright's core — both were assumptions to correct in test-authoring guidance, which is itself a meaningful signal: the tool's actual mechanics (PTY handling, alt-screen/multi-panel terminal interpretation, event-driven waiting) held up against real, unplanned-for complexity without modification.

## What "well tested" means at each exit gate

- **Phase 1/2** (§13): every core module (`pty`, `terminal`, `assertions`, `game`) has direct unit coverage, plus at least one real end-to-end scenario proving the pieces compose correctly against a real fixture, plus a permanent regression test for the §9 failure format — not just inspected once by hand.
- **Phase 3** (§13): the runner/CLI have their own direct unit coverage (config, discovery, the test registry, `expect()`, the reporter) *and* real subprocess end-to-end tests (`runner-e2e.test.js`) asserting on actual CLI output/exit codes — plus the GameDriver-integration suites actually running through the shipped CLI, not just through `launchGame()` directly, so a bug in the runner itself would be caught by RPGWright's own suite before a consumer ever saw it.
- **Phase 4** (§13): proven against a real, independently-written consumer app with dependencies and UI complexity RPGWright's own fixtures don't exercise (external database, alternate-screen multi-panel layout) — not just RPGWright's own bundled examples.

## Running everything

```
npm test            # node:test (internals + CLI black-box tests) then both rpgwright test dogfood suites
npm run test:unit   # node:test only
npm run test:e2e    # both rpgwright test dogfood suites only
```
