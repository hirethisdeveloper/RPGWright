'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnPty, spawnPipe } = require('./pty');
const { createVirtualTerminal } = require('./terminal');
const {
  waitUntil,
  waitUntilAbsent,
  waitForQuiet,
  pollUntil,
  TimeoutError,
  formatFailureReport,
  formatScreenDiff,
  formatLineSetDiff,
  formatNeedle,
  matchesNeedle,
  formatExitInfo,
  DEFAULT_QUIET_MS,
} = require('./assertions');
const { KEY_SEQUENCES, resolveKey, encodeMouse } = require('./keys');
const { renderScreenHtml } = require('./render');
const {
  createLocator,
  evaluateCheck,
  evaluateFocusGroup,
  formatRect,
  isRect,
  findText,
  maskGrid,
  gridText,
  styleSpans,
  countCellDiffs,
} = require('./layout');

const UPDATE_EVENT = 'update';
const SCREEN_EVENT = { type: 'screen' };
// Input actions start a new "since" window for expectSeen, expectNoFlicker
// and toHaveBell.
const INPUT_ACTIONS = new Set(['press', 'type', 'paste', 'mouse', 'resize']);

// FORCE_COLOR is honored by chalk/supports-color (and so by Ink); COLORTERM
// and NO_COLOR are the cross-ecosystem conventions. `undefined` leaves the
// caller's env untouched.
const COLOR_DEPTH_ENV = {
  none: { NO_COLOR: '1', FORCE_COLOR: '0', COLORTERM: undefined },
  16: { FORCE_COLOR: '1', NO_COLOR: undefined, COLORTERM: undefined },
  256: { FORCE_COLOR: '2', NO_COLOR: undefined, COLORTERM: undefined },
  truecolor: { FORCE_COLOR: '3', NO_COLOR: undefined, COLORTERM: 'truecolor' },
};

function buildEnv(env, { colorDepth, locale }) {
  const overrides = { ...(colorDepth === undefined ? {} : COLOR_DEPTH_ENV[colorDepth]) };
  if (colorDepth !== undefined && !COLOR_DEPTH_ENV[colorDepth]) {
    throw new Error(`Unknown colorDepth ${JSON.stringify(colorDepth)}. Supported: ${Object.keys(COLOR_DEPTH_ENV).join(', ')}.`);
  }
  if (locale !== undefined) Object.assign(overrides, { LANG: locale, LC_ALL: locale });

  const result = { ...env };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete result[name];
    else result[name] = value;
  }
  return result;
}

function settleQuiet(settle) {
  return typeof settle === 'number' ? settle : DEFAULT_QUIET_MS;
}

function formatArg(arg) {
  if (arg && arg._isLocator) return arg.describe();
  if (arg instanceof RegExp) return arg.toString();
  return JSON.stringify(arg);
}

function signalNumber(signal) {
  return typeof signal === 'number' ? signal : os.constants.signals[signal];
}

// An exit code only counts for a process that exited on its own: one killed
// by a signal also reports exit code 0, which must not pass { code: 0 }.
function exitMatches(info, want) {
  if (want.code !== undefined && (info.signal || info.exitCode !== want.code)) return false;
  if (want.signal !== undefined && signalNumber(info.signal) !== signalNumber(want.signal)) return false;
  return true;
}

function describeExit(want) {
  const parts = [];
  if (want.code !== undefined) parts.push(`code ${want.code}`);
  if (want.signal !== undefined) parts.push(`signal ${want.signal}`);
  return parts.length ? ` with ${parts.join(' and ')}` : '';
}

/**
 * Assertions about terminal state other than the screen's contents: modes
 * the app switched on, and out-of-band signals it sent (title, bell,
 * hyperlinks, clipboard), plus scrollback. Each gets terminalState() and the
 * matcher's arguments, and returns { pass, expected, observed }.
 */
const TERMINAL_CHECKS = {
  toBeInAltScreen: (state) => ({
    pass: state.modes.altScreen,
    expected: 'the app to be on the alternate screen',
    observed: `on the ${state.modes.altScreen ? 'alternate' : 'normal'} screen`,
  }),
  toHaveTitle: (state, needle) => ({
    pass: matchesNeedle(state.signals.title, needle),
    expected: `the window title to match ${formatNeedle(needle)}`,
    observed: `the title is ${JSON.stringify(state.signals.title)}`,
  }),
  toHaveBell: (state) => ({
    pass: state.bellsSinceInput > 0,
    expected: 'the bell to ring since the last input',
    observed: `${state.bellsSinceInput} bell${state.bellsSinceInput === 1 ? '' : 's'} since the last input`,
  }),
  toHaveMouseTracking: (state, mode) => ({
    pass: mode === undefined ? state.modes.mouseTracking !== 'none' : state.modes.mouseTracking === mode,
    expected: `mouse reporting to be ${mode === undefined ? 'on' : `in ${mode} mode`}`,
    observed: `mouse reporting is ${state.modes.mouseTracking}, encoding ${state.modes.mouseEncoding}`,
  }),
  toHaveBracketedPaste: (state) => ({
    pass: state.modes.bracketedPaste,
    expected: 'bracketed paste to be on',
    observed: `bracketed paste is ${state.modes.bracketedPaste ? 'on' : 'off'}`,
  }),
  toHaveHyperlink: (state, uri, { text } = {}) => {
    const links = state.signals.hyperlinks;
    return {
      pass: links.some((l) => matchesNeedle(l.uri, uri) && (text === undefined || matchesNeedle(l.text, text))),
      expected: `a hyperlink to ${formatNeedle(uri)}${text === undefined ? '' : ` with text ${formatNeedle(text)}`}`,
      observed: links.length ? links.map((l) => `${JSON.stringify(l.text)} -> ${l.uri}`).join(', ') : 'no hyperlinks',
    };
  },
  toHaveCopied: (state, needle) => {
    const writes = state.signals.clipboardWrites;
    return {
      pass: writes.some((w) => matchesNeedle(w, needle)),
      expected: `the app to have copied ${formatNeedle(needle)} to the clipboard`,
      observed: writes.length ? `copied ${writes.map((w) => JSON.stringify(w)).join(', ')}` : 'nothing copied',
    };
  },
  toHaveScrollbackText: (state, needle) => ({
    pass: matchesNeedle(state.scrollback, needle),
    expected: `${formatNeedle(needle)} in the scrollback`,
    observed: `${state.scrollbackLines} line${state.scrollbackLines === 1 ? '' : 's'} of scrollback`,
  }),
};

function isSnapshotMatcher(matcher) {
  return Boolean(matcher) && typeof matcher === 'object' && typeof matcher.snapshot === 'string';
}

function formatScreenMatcher(matcher) {
  if (isSnapshotMatcher(matcher)) return `snapshot "${matcher.snapshot}"`;
  if (matcher instanceof RegExp) return matcher.toString();
  return `${JSON.stringify(matcher)} (exact screen match)`;
}

/**
 * The one shutdown policy for a spawned process: send `signal`, give it
 * `timeout` ms to exit, then SIGKILL. Used for launched apps (stop()) and
 * background services alike; pty.js itself has no policy. The grace timer
 * is cleared once the process exits, so it can't keep the caller's event
 * loop alive for the rest of `timeout`.
 */
async function stopProcess(handle, { signal = 'SIGTERM', timeout }) {
  handle.kill(signal);
  let graceTimer;
  const exitInfo = await Promise.race([
    handle.waitForExit(),
    new Promise((resolve) => {
      graceTimer = setTimeout(() => resolve(null), timeout);
    }),
  ]);
  clearTimeout(graceTimer);
  if (exitInfo) return exitInfo;
  handle.kill('SIGKILL');
  return handle.waitForExit();
}

async function launchGame({
  command,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  cols = 120,
  rows = 40,
  expectTimeout = 10000,
  killSignal = 'SIGTERM',
  killTimeout = 3000,
  getDiagnostics = null,
  scenarioName = null,
  keys = {},
  snapshotsDir = path.join(cwd, '__snapshots__'),
  updateSnapshots = process.env.RPGWRIGHT_UPDATE_SNAPSHOTS === '1',
  term,
  colorDepth,
  locale,
  focus,
  historySize = 500,
  scrollback = 1000,
  record = false,
  tty = true,
  // Awaited before every action (input, expect*/wait*, step, resize) when
  // given: how the runner's UI pauses a test between actions.
  gate = null,
} = {}) {
  const keySequences = { ...KEY_SEQUENCES, ...keys };
  const childEnv = buildEnv(env, { colorDepth, locale });
  // With tty: false the app gets plain pipes (isTTY false); its output is
  // still drawn into a virtual screen so every assertion works the same.
  const ptyHandle = tty
    ? spawnPty({ command, args, cols, rows, cwd, env: childEnv, term })
    : spawnPipe({ command, args, cwd, env: childEnv });
  const terminal = createVirtualTerminal({ cols, rows, scrollback, convertEol: !tty });
  const updates = new EventEmitter();
  const actions = [];
  const startedAt = Date.now();
  let stopped = false;
  let stepDepth = 0;
  let finalScreen = null;

  // A bounded history of every screen state, one entry per parsed chunk, so
  // assertions can ask about screens that have already been replaced.
  const frames = [];
  let frameCount = 0;

  // With `record`, every output chunk, input write and resize, timestamped
  // in seconds since launch: an asciinema recording of the session.
  const recording = record ? { cols, rows, startedAt, events: [] } : null;
  function recordEvent(type, data) {
    if (recording) recording.events.push([(Date.now() - startedAt) / 1000, type, data]);
  }
  function recordFrame() {
    frameCount += 1;
    frames.push({ seq: frameCount, t: Date.now() - startedAt, text: terminal.getScreenText() });
    if (frames.length > historySize) frames.shift();
  }

  let parsed = Promise.resolve();
  const dataSubscription = ptyHandle.onData((chunk) => {
    // stop() disposes this subscription before disposing the terminal, but
    // a chunk already in flight when that happens could still resolve (or
    // throw, via the Promise constructor) afterward — .catch keeps that
    // from surfacing as an unhandled rejection.
    recordEvent('o', chunk);
    parsed = terminal
      .write(chunk, recordFrame)
      .then(() => {
        updates.emit(UPDATE_EVENT);
        notify(SCREEN_EVENT);
      })
      .catch(() => {});
  });

  // The process's exit, once every chunk it wrote has been parsed. The
  // handle can report an exit while its last output is still queued in the
  // terminal (xterm parses asynchronously), so anything deciding "it exited
  // without showing X" must wait for that output first.
  function exitedAndParsed() {
    return ptyHandle.waitForExit().then((info) => parsed.then(() => info));
  }

  const replySubscription = terminal.onReply((reply) => {
    if (!ptyHandle.getExitInfo()) ptyHandle.write(reply);
  });

  // Live observers (see observe()). Events are only built when someone is
  // listening, and a throwing listener never reaches the driver.
  const observers = new Set();
  function notify(event) {
    if (observers.size === 0) return;
    const payload = typeof event === 'function' ? event() : event;
    for (const listener of [...observers]) {
      try {
        listener(payload);
      } catch {
        // an observer's failure is its own
      }
    }
  }

  function observe(listener) {
    observers.add(listener);
    return { dispose: () => observers.delete(listener) };
  }

  exitedAndParsed().then((exitInfo) => notify(() => ({ type: 'exit', exitInfo })));

  function onUpdate(listener) {
    updates.on(UPDATE_EVENT, listener);
    return { dispose: () => updates.off(UPDATE_EVENT, listener) };
  }

  // `frame` is how many frames had been recorded when the action started;
  // with `record`, `screen`/`cursor` are what the screen showed when it
  // finished. Only kept when recording: each grid is a full styled copy of
  // the screen, and the action list is unbounded.
  function recordAction(type, detail, ok = null) {
    const record = { type, detail, ok, depth: stepDepth, t: Date.now() - startedAt, frame: frameCount };
    if (!stopped) record.bells = terminal.getSignals().bellCount;
    captureInto(record);
    actions.push(record);
    notify(() => ({ type: 'action', action: record }));
    return record;
  }

  function captureInto(record) {
    if (stopped || !recording) return;
    record.screen = terminal.getScreenCells();
    record.cursor = terminal.getCursor();
  }

  function lastInput() {
    for (let i = actions.length - 1; i >= 0; i -= 1) {
      if (INPUT_ACTIONS.has(actions[i].type)) return actions[i];
    }
    return null;
  }

  // The frame count at the most recent input action: "since the last input"
  // for expectSeen and expectNoFlicker.
  function lastInputFrame() {
    const input = lastInput();
    return input ? input.frame : 0;
  }

  async function buildFailureMessage(expected, failedRecord, diff = null) {
    let diagnostics = null;
    if (getDiagnostics) {
      try {
        diagnostics = await getDiagnostics();
      } catch (err) {
        diagnostics = `(getDiagnostics threw: ${err.message})`;
      }
    }
    const launchEntry = { type: 'launchGame', detail: JSON.stringify({ command, args }) };
    const fullActions = [launchEntry, ...actions];
    const failedIndex = fullActions.indexOf(failedRecord);
    return formatFailureReport({
      scenarioName,
      viewport: terminal.getSize(),
      actions: fullActions,
      failedIndex,
      expected,
      screenText: terminal.getScreenText(),
      exitInfo: ptyHandle.getExitInfo(),
      extraDiagnostics: diagnostics,
      diff,
    });
  }

  // Every expect*/wait* method: record the action, run its wait, and turn a
  // failed wait into the standard failure report. `expected` may be a
  // function, evaluated at failure time, so the report can include what was
  // last observed; it may return { expected, diff } to add a diff section.
  // `gated` is false for a wait that is part of another action (settling).
  async function runAssertion(type, detail, expected, wait, gated = true) {
    if (gate && gated) await gate();
    const record = recordAction(type, detail, null);
    try {
      await wait();
      record.ok = true;
      captureInto(record);
    } catch (err) {
      record.ok = false;
      captureInto(record);
      const result = typeof expected === 'function' ? expected() : expected;
      const { expected: text, diff } = typeof result === 'string' ? { expected: result } : result;
      throw new Error(await buildFailureMessage(text, record, diff));
    }
  }

  // Re-checks `predicate` on every screen update; fails fast if the process
  // exits first.
  function waitForScreen(predicate, opts) {
    return waitUntil(onUpdate, predicate, {
      timeout: opts.timeout ?? expectTimeout,
      exitPromise: exitedAndParsed(),
    });
  }

  // Writes, records, then optionally waits for the screen to settle. Settling
  // keeps the next write from landing in the same read() on the app's side
  // (see agent_docs/game-driver.md on keystroke coalescing).
  function writeInput(bytes) {
    ptyHandle.write(bytes);
    recordEvent('i', typeof bytes === 'string' ? bytes : bytes.toString('latin1'));
  }

  async function send(type, bytes, detail, opts) {
    if (gate) await gate();
    writeInput(bytes);
    recordAction(type, detail, true);
    if (opts && opts.settle) await settle(opts.settle);
  }

  async function press(key, opts) {
    await send('press', resolveKey(key, keySequences), JSON.stringify(key), opts);
  }

  press.raw = async function pressRaw(bytes, opts) {
    await send('press', bytes, JSON.stringify(bytes), opts);
  };

  async function type(text, opts) {
    await send('type', text, JSON.stringify(text), opts);
  }

  // Like a real terminal: wrapped in bracketed-paste markers when the app
  // has turned that mode on, otherwise sent as plain typed text.
  async function paste(text, opts) {
    const bracketed = terminal.getModes().bracketedPaste;
    const bytes = bracketed ? `\x1b[200~${text}\x1b[201~` : text;
    await send('paste', bytes, `${JSON.stringify(text)}${bracketed ? ', bracketed' : ''}`, opts);
  }

  // Mouse events, encoded the way the app asked for. A real terminal only
  // reports what the app's tracking mode covers: x10 reports presses only,
  // vt200 adds releases, drag adds motion while a button is held, any adds
  // all motion. Unreported events are recorded but not sent.
  let heldButton = null;
  async function sendMouse(event, detail, opts = {}) {
    if (gate) await gate();
    const { mouseTracking, mouseEncoding } = terminal.getModes();
    if (mouseTracking === 'none') {
      throw new Error(
        `mouse.${detail}: the app hasn't enabled mouse reporting, so a real terminal would send nothing. Wait until it has (expect(game).toHaveMouseTracking()) before using the mouse.`,
      );
    }
    const reported =
      event.action === 'press' ||
      (event.action === 'release' && mouseTracking !== 'x10') ||
      (event.action === 'move' && (mouseTracking === 'any' || (mouseTracking === 'drag' && event.button !== null)));
    // Plain X10 reports are single bytes per value, up to 255; as a string
    // anything past 127 would be sent UTF-8 encoded, as two bytes.
    const report = reported && encodeMouse(event, mouseEncoding);
    if (reported) writeInput(mouseEncoding === 'x10' ? Buffer.from(report, 'latin1') : report);
    recordAction('mouse', reported ? detail : `${detail}, not reported in ${mouseTracking} mode`, true);
    if (opts.settle) await settle(opts.settle);
  }

  function mouseDetail(name, x, y, opts = {}) {
    const extras = [opts.button && opts.button !== 'left' ? opts.button : null, ...(opts.modifiers || [])].filter(Boolean);
    return `${name}(${x}, ${y}${extras.length ? `, ${extras.join('+')}` : ''})`;
  }

  const mouse = {
    async down(x, y, opts = {}) {
      const button = opts.button || 'left';
      await sendMouse({ x, y, button, action: 'press', modifiers: opts.modifiers }, mouseDetail('down', x, y, opts), opts);
      heldButton = button;
    },
    async up(x, y, opts = {}) {
      const button = opts.button || heldButton || 'left';
      heldButton = null;
      await sendMouse({ x, y, button, action: 'release', modifiers: opts.modifiers }, mouseDetail('up', x, y, opts), opts);
    },
    async move(x, y, opts = {}) {
      await sendMouse({ x, y, button: heldButton, action: 'move', modifiers: opts.modifiers }, mouseDetail('move', x, y, opts), opts);
    },
    // `settle` applies after each event, so the separate reports can't
    // coalesce into one read on the app's side.
    async click(x, y, opts = {}) {
      for (let i = 0; i < (opts.clickCount || 1); i += 1) {
        await mouse.down(x, y, opts);
        await mouse.up(x, y, opts);
      }
    },
    // One wheel notch per unit of deltaY; negative scrolls up.
    async wheel(x, y, { deltaY = 1, ...opts } = {}) {
      const button = deltaY < 0 ? 'wheelUp' : 'wheelDown';
      for (let i = 0; i < Math.max(1, Math.abs(Math.round(deltaY))); i += 1) {
        await sendMouse({ x, y, button, action: 'press', modifiers: opts.modifiers }, mouseDetail('wheel', x, y, { ...opts, button }), opts);
      }
    },
    async drag(from, to, opts = {}) {
      await mouse.down(from.x, from.y, opts);
      await mouse.move(to.x, to.y, opts);
      await mouse.up(to.x, to.y, opts);
    },
  };

  function kill(signal = 'SIGTERM') {
    ptyHandle.kill(signal);
    recordAction('kill', JSON.stringify(signal), true);
  }

  function exitWithin(timeout) {
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`Timed out after ${timeout}ms waiting for the process to exit`)), timeout);
    });
    return Promise.race([exitedAndParsed(), timedOut]).finally(() => clearTimeout(timer));
  }

  async function waitForExit(opts = {}) {
    let info = null;
    await runAssertion('waitForExit', '', 'the process to exit', async () => {
      info = await exitWithin(opts.timeout ?? expectTimeout);
    });
    return info;
  }

  // Waits for the process to exit, then checks how: { code } and/or
  // { signal } (a name like 'SIGINT' or a number).
  function expectExit(want = {}, opts = {}) {
    return runAssertion(
      'expectExit',
      JSON.stringify(want),
      () => `the process to exit${describeExit(want)}\nObserved: ${formatExitInfo(ptyHandle.getExitInfo())}`,
      async () => {
        const info = await exitWithin(opts.timeout ?? expectTimeout);
        if (!exitMatches(info, want)) throw new Error('exited differently');
      },
    );
  }

  function terminalState() {
    const signals = terminal.getSignals();
    const input = lastInput();
    // Rebuilt on every update while a check waits, so the scrollback (up to
    // `scrollback` lines) is only read by the check that wants it.
    let lines = null;
    const scrollbackLines = () => (lines ??= terminal.getScrollbackLines());
    return {
      modes: terminal.getModes(),
      signals,
      bellsSinceInput: signals.bellCount - (input ? input.bells : 0),
      get scrollback() {
        return scrollbackLines().join('\n');
      },
      get scrollbackLines() {
        return scrollbackLines().length;
      },
    };
  }

  // Waits until the named TERMINAL_CHECKS entry passes; opts.not negates it.
  function expectTerminal(name, args = [], opts = {}) {
    const check = TERMINAL_CHECKS[name];
    if (!check) throw new Error(`Unknown terminal check "${name}".`);
    const negate = Boolean(opts.not);
    const evaluate = () => {
      const result = check(terminalState(), ...args);
      return { ...result, pass: negate ? !result.pass : result.pass };
    };
    return runAssertion(
      'expect',
      `${negate ? 'not.' : ''}${name}(${args.filter((a) => a !== undefined).map(formatArg).join(', ')})`,
      () => {
        const { expected, observed } = evaluate();
        return `${negate ? 'not ' : ''}${expected}\nObserved: ${observed}`;
      },
      () => waitForScreen(() => evaluate().pass, opts),
    );
  }

  function getScrollbackText() {
    return terminal.getScrollbackLines().join('\n');
  }

  function getModes() {
    return terminal.getModes();
  }

  function quietFor(opts, gated) {
    const quiet = opts.quiet ?? DEFAULT_QUIET_MS;
    return runAssertion(
      'waitForStable',
      `quiet ${quiet}ms`,
      `no screen update for ${quiet}ms`,
      () => waitForQuiet(onUpdate, { quiet, timeout: opts.timeout ?? expectTimeout }),
      gated,
    );
  }

  function waitForStable(opts = {}) {
    return quietFor(opts, true);
  }

  // An input's `settle` option: part of that action, so not gated again.
  function settle(option) {
    return quietFor({ quiet: settleQuiet(option) }, false);
  }

  // Groups the actions recorded inside `fn` under a named entry, so the
  // failure report's action list reads as an outline of the scenario.
  async function step(name, fn) {
    if (gate) await gate();
    const record = recordAction('step', JSON.stringify(name), null);
    stepDepth += 1;
    try {
      const result = await fn();
      record.ok = true;
      return result;
    } catch (err) {
      record.ok = false;
      throw err;
    } finally {
      stepDepth -= 1;
      notify(() => ({ type: 'action', action: record }));
    }
  }

  function expectText(needle, opts = {}) {
    return runAssertion('expectText', formatNeedle(needle), formatNeedle(needle), () =>
      waitForScreen(() => matchesNeedle(terminal.getScreenText(), needle), opts),
    );
  }

  // Passes if the text appeared on any screen since the last input action
  // (or, with { since: 'start' }, any retained screen), even one that has
  // since been replaced: catches toasts and status flashes expectText misses.
  function expectSeen(needle, opts = {}) {
    const since = opts.since === 'start' ? 0 : lastInputFrame();
    const seen = () => frames.some((f) => f.seq > since && matchesNeedle(f.text, needle)) || matchesNeedle(terminal.getScreenText(), needle);
    return runAssertion('expectSeen', formatNeedle(needle), `${formatNeedle(needle)} to appear at some point since ${since === 0 ? 'launch' : 'the last input'}`, () =>
      waitForScreen(seen, opts),
    );
  }

  // Waits for the screen to settle, then fails if any screen since the last
  // input was blank between two non-blank ones: the "clear, then redraw in a
  // separate write" flash.
  function expectNoFlicker(opts = {}) {
    const since = lastInputFrame();
    const quiet = opts.quiet ?? DEFAULT_QUIET_MS;
    let flash = null;
    return runAssertion(
      'expectNoFlicker',
      `quiet ${quiet}ms`,
      () => (flash ? `no blank intermediate screen\nObserved: a blank screen at +${flash.t}ms (frame ${flash.seq}) between two drawn ones` : `the screen to settle within the timeout (no update for ${quiet}ms)`),
      async () => {
        await waitForQuiet(onUpdate, { quiet, timeout: opts.timeout ?? expectTimeout });
        // Start from the frame that was showing when the input was sent, so
        // a blank first frame after it still has a drawn predecessor.
        const window = frames.filter((f) => f.seq >= since);
        const blank = (f) => f.text.trim() === '';
        flash = window.find((f, i) => blank(f) && i > 0 && !blank(window[i - 1]) && window.slice(i + 1).some((g) => !blank(g))) || null;
        if (flash) throw new Error('flicker');
      },
    );
  }

  function expectNotText(needle, opts = {}) {
    const holdFor = opts.holdFor ?? 500;
    const expected = `${formatNeedle(needle)} to not appear (held for ${holdFor}ms)`;
    return runAssertion('expectNotText', formatNeedle(needle), expected, () =>
      waitUntilAbsent(onUpdate, () => matchesNeedle(terminal.getScreenText(), needle), {
        timeout: opts.timeout ?? expectTimeout,
        holdFor,
      }),
    );
  }

  // The screen as a whole-screen assertion sees it: with `mask`ed regions
  // blanked out and `normalize` applied to the text, plus the style spans
  // when `styles` is set.
  function captureScreen(opts) {
    let grid = terminal.getScreenCells();
    if (opts.mask && opts.mask.length) {
      const source = grid;
      const rects = opts.mask.flatMap((m) => {
        if (m && m._isLocator) return m.resolveAll(source);
        if (isRect(m)) return [m];
        return findText(source, m);
      });
      grid = maskGrid(grid, rects);
    }
    const text = opts.normalize ? opts.normalize(gridText(grid)) : gridText(grid);
    return opts.styles ? { text, styles: styleSpans(grid) } : { text };
  }

  function captureDiff(expected, actual) {
    const parts = [];
    if (expected.text !== actual.text) parts.push(formatScreenDiff(expected.text, actual.text));
    if (expected.styles !== undefined && expected.styles !== actual.styles) {
      parts.push(`Styles (y:x+width style):\n${formatLineSetDiff(expected.styles, actual.styles)}`);
    }
    return parts.join('\n\n') || null;
  }

  function expectScreen(matcher, opts = {}) {
    // Set once the expected capture is known, so a failure can show a diff.
    const comparison = { expected: null };
    return runAssertion(
      'expectScreen',
      formatScreenMatcher(matcher),
      () => ({
        expected: formatScreenMatcher(matcher),
        diff: comparison.expected && captureDiff(comparison.expected, captureScreen(opts)),
      }),
      () => {
        if (isSnapshotMatcher(matcher)) return matchSnapshot(matcher.snapshot, opts, comparison);
        if (matcher instanceof RegExp) return waitForScreen(() => matchesNeedle(captureScreen(opts).text, matcher), opts);
        comparison.expected = { text: matcher };
        return waitForScreen(() => captureScreen(opts).text === matcher, opts);
      },
    );
  }

  async function matchSnapshot(name, opts, comparison) {
    const textPath = path.join(snapshotsDir, `${name}.snap`);
    const stylesPath = path.join(snapshotsDir, `${name}.styles.snap`);
    const shouldRecord = opts.updateSnapshot ?? updateSnapshots;
    const textMissing = !fs.existsSync(textPath);
    const stylesMissing = opts.styles && !fs.existsSync(stylesPath);

    async function writeSnapshot({ text }) {
      // Recording a frame mid-redraw would bake a half-drawn screen into
      // the snapshot, so wait for the app to stop drawing first.
      if (opts.stable !== false) {
        await waitForQuiet(onUpdate, { quiet: DEFAULT_QUIET_MS, timeout: opts.timeout ?? expectTimeout });
      }
      const capture = captureScreen(opts);
      fs.mkdirSync(snapshotsDir, { recursive: true });
      if (text) fs.writeFileSync(textPath, capture.text, 'utf8');
      if (opts.styles) fs.writeFileSync(stylesPath, capture.styles, 'utf8');
    }

    if (shouldRecord || textMissing) {
      await writeSnapshot({ text: true });
      return;
    }
    // Only the styles are new (styles: true added to an existing snapshot):
    // the recorded text must still match before the styles are recorded
    // beside it, or a text regression would be silently re-recorded.
    if (stylesMissing) {
      await matchSnapshot(name, { ...opts, styles: false }, comparison);
      await writeSnapshot({ text: false });
      return;
    }

    const expected = { text: fs.readFileSync(textPath, 'utf8') };
    if (opts.styles) expected.styles = fs.readFileSync(stylesPath, 'utf8');
    comparison.expected = expected;
    const allowed = opts.maxDiffCells ?? 0;
    await waitForScreen(() => {
      const actual = captureScreen(opts);
      if (allowed > 0) return countCellDiffs(expected, actual) <= allowed;
      return actual.text === expected.text && actual.styles === expected.styles;
    }, opts);
  }

  function expectState(getState, matcher, opts = {}) {
    return runAssertion('expectState', 'getState()', 'state to satisfy the provided matcher', () =>
      pollUntil(async () => matcher(await getState()), {
        timeout: opts.timeout ?? expectTimeout,
        pollInterval: opts.pollInterval,
      }),
    );
  }

  // A lazy handle on a region of the screen; see src/layout.js.
  function locator(target, opts) {
    return createLocator(locatorSource, target, opts);
  }

  function layoutState() {
    return {
      grid: terminal.getScreenCells(),
      wrapped: terminal.getWrappedRows(),
      size: terminal.getSize(),
      cursor: terminal.getCursor(),
      focus,
    };
  }

  /**
   * Waits until the named layout check (src/layout.js's CHECKS) passes for
   * `loc`, re-evaluating on every screen update. `opts.not` negates it.
   */
  function expectLayout(loc, name, args = [], opts = {}) {
    const negate = Boolean(opts.not);
    const evaluate = () => evaluateCheck(name, loc, args, { negate, ...layoutState() });
    const detail = `${loc.describe()}${negate ? '.not' : ''}.${name}(${args.filter((a) => a !== undefined).map(formatArg).join(', ')})`;
    return runAssertion(
      'expect',
      detail,
      () => {
        const { expected, observed } = evaluate();
        return `${loc.describe()} ${expected}\nObserved: ${observed}`;
      },
      () => waitForScreen(() => evaluate().pass, opts),
    );
  }

  // For a locator matching a group of items: exactly one of them must be
  // focused. `indicators` overrides the launch-level `focus` option.
  function expectFocusGroup(loc, indicators, opts = {}) {
    const evaluate = () => evaluateFocusGroup(loc, indicators || focus, layoutState());
    return runAssertion(
      'expect',
      `${loc.describe()}.toHaveExactlyOneFocused()`,
      () => {
        const { expected, observed } = evaluate();
        return `${expected}\nObserved: ${observed}`;
      },
      () => waitForScreen(() => evaluate().pass, opts),
    );
  }

  // The regions of `loc`'s matches that are currently focused.
  function getFocused(loc, indicators) {
    return evaluateFocusGroup(loc, indicators || focus, layoutState()).focused;
  }

  function getCursor() {
    return terminal.getCursor();
  }

  function getSize() {
    return terminal.getSize();
  }

  // `target` is { x, y } or a locator whose region must contain the cursor.
  function expectCursorAt(target, opts = {}) {
    const isLoc = Boolean(target && target._isLocator);
    const describeTarget = isLoc ? target.describe() : `(${target.x}, ${target.y})`;
    const matches = () => {
      const cursor = terminal.getCursor();
      if (!isLoc) return cursor.x === target.x && cursor.y === target.y;
      const { rect } = target.resolveOne();
      return Boolean(rect) && cursor.y >= rect.y && cursor.y < rect.y + rect.height && cursor.x >= rect.x && cursor.x < rect.x + rect.width;
    };
    return runAssertion(
      'expect',
      `cursor.toBeAt(${describeTarget})`,
      () => {
        const cursor = terminal.getCursor();
        const where = isLoc ? `${describeTarget} ${target.resolveOne().rect ? `at ${formatRect(target.resolveOne().rect)}` : '(unresolved)'}` : describeTarget;
        return `the cursor to be in ${where}\nObserved: cursor at (${cursor.x}, ${cursor.y})${cursor.visible ? '' : ', hidden'}`;
      },
      () => waitForScreen(matches, opts),
    );
  }

  function expectCursorVisible(visible = true, opts = {}) {
    return runAssertion(
      'expect',
      `cursor.toBeVisible(${visible})`,
      `the cursor to be ${visible ? 'visible' : 'hidden'}`,
      () => waitForScreen(() => terminal.getCursor().visible === visible, opts),
    );
  }

  function expectCount(loc, count, opts = {}) {
    return runAssertion(
      'expect',
      `${loc.describe()}.toHaveCount(${count})`,
      () => `${loc.describe()} to match ${count} region${count === 1 ? '' : 's'}\nObserved: ${loc.count()}`,
      () => waitForScreen(() => loc.count() === count, opts),
    );
  }

  async function resize(cols, rows) {
    if (gate) await gate();
    ptyHandle.resize(cols, rows);
    terminal.resize(cols, rows);
    recordEvent('r', `${cols}x${rows}`);
    recordAction('resize', `${cols}, ${rows}`, true);
    notify(SCREEN_EVENT);
  }

  async function stop(opts = {}) {
    if (stopped) return ptyHandle.getExitInfo();
    stopped = true;

    const exitInfo = await stopProcess(ptyHandle, { signal: killSignal, timeout: opts.timeout ?? killTimeout });

    dataSubscription.dispose();
    replySubscription.dispose();
    finalScreen = { grid: terminal.getScreenCells(), cursor: terminal.getCursor() };
    terminal.dispose();
    return exitInfo;
  }

  // The cell grid as it is now, or as it was when stop() ran.
  function getScreenCells() {
    return finalScreen ? finalScreen.grid : terminal.getScreenCells();
  }

  function getScreenText() {
    return terminal.getScreenText();
  }

  function currentScreen() {
    return finalScreen || { grid: terminal.getScreenCells(), cursor: terminal.getCursor() };
  }

  // The current screen (or the last one, after stop()) as a standalone HTML
  // page, drawn the way a terminal would draw it.
  function renderHtml(opts = {}) {
    const { grid, cursor } = currentScreen();
    return renderScreenHtml(grid, { cursor, title: opts.title || scenarioName || 'Terminal screen' });
  }

  // Everything the runner's trace file needs: actions with the screen each
  // one finished on, the retained text frames, and the final screen.
  function getTrace() {
    return {
      command,
      args,
      actions,
      frames: frames.slice(),
      final: currentScreen(),
      exitInfo: ptyHandle.getExitInfo(),
      recording,
    };
  }

  const driver = {
    press,
    type,
    expectText,
    expectNotText,
    expectScreen,
    expectState,
    expectSeen,
    expectNoFlicker,
    expectTerminal,
    expectExit,
    waitForExit,
    kill,
    paste,
    mouse,
    getModes,
    getScrollbackText,
    expectLayout,
    expectCount,
    expectFocusGroup,
    expectCursorAt,
    expectCursorVisible,
    locator,
    getFocused,
    getCursor,
    getSize,
    waitForStable,
    step,
    resize,
    stop,
    getScreenText,
    getScreenCells,
    observe,
    renderHtml,
    getTrace,
    actions,
  };
  const locatorSource = {
    getScreenCells: () => terminal.getScreenCells(),
    // What a locator can do that geometry can't: point the mouse at its
    // region, and lead runner/expect.js back to this driver.
    extend: (locator, { center }) => ({
      driver,
      click(opts) {
        const { x, y } = center();
        return mouse.click(x, y, opts);
      },
      hover(opts) {
        const { x, y } = center();
        return mouse.move(x, y, opts);
      },
    }),
  };
  return driver;
}

module.exports = { launchGame, stopProcess };
