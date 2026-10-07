'use strict';

const util = require('node:util');
const { renderScreenAnsi } = require('../src/render');
const { createState, recordPass, printSummary } = require('./reporter');

// Alternate screen, hidden cursor, no autowrap (a row that is a column too
// wide must not push the frame down), cleared. LEAVE undoes each.
const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J';
const LEAVE = '\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l';
// Synchronized output: a terminal that supports it shows the frame at once.
const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
const FRAME_MS = 16;
const HEADER_ROWS = 2;
// The HUD's detail pane: a rule, file:line, up to ERROR_LINES of the last
// error, a message row and the key hints.
const ERROR_LINES = 3;
const DETAIL_ROWS = ERROR_LINES + 4;
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'];
const SIGNALS = { SIGINT: 130, SIGTERM: 143 };

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const INVERSE = '\x1b[7m';
const RESET = '\x1b[0m';
const STATUS_COLOR = { pending: '\x1b[2m', running: '\x1b[33m', passed: '\x1b[32m', failed: '\x1b[31m', skipped: '\x1b[2m', aborted: '\x1b[35m' };
const STATUS_GLYPH = { pending: '·', running: '●', passed: '✓', failed: '✖', skipped: '-', aborted: '⊘' };
const HUD_HINTS = '↑/↓ move  enter run  a all  f failed  r rerun  q quit';
const RUN_HINTS = 'space pause  esc abort  q quit';
const PAUSED_HINTS = 'space resume  n step  esc abort  q quit';

// Escape sequences by what follows the ESC: CSI (`[`) and SS3 (`O`) forms
// of the keys the HUD uses, as terminals send them in either cursor mode.
const KEY_SEQUENCES = {
  '[A': 'up',
  OA: 'up',
  '[B': 'down',
  OB: 'down',
  '[5~': 'pageup',
  '[6~': 'pagedown',
  '[H': 'home',
  OH: 'home',
  '[1~': 'home',
  '[7~': 'home',
  '[F': 'end',
  OF: 'end',
  '[4~': 'end',
  '[8~': 'end',
};
const ESCAPE_SEQUENCE = /^\x1b(\[[0-9;?]*[ -/]*[@-~]|O[@-~])/;

/**
 * One stdin chunk as key names: 'up'/'down'/'pageup'/'pagedown'/'home'/
 * 'end', 'enter', 'escape', 'space', 'ctrl+c', 'unknown' for any other
 * escape sequence, else the character itself. A raw-mode terminal sends a
 * whole sequence in one chunk, so an ESC that doesn't start one (a lone
 * ESC, or one at the end of the chunk) is the Escape key.
 */
function decodeKeys(text) {
  const keys = [];
  let rest = String(text);
  while (rest) {
    const sequence = ESCAPE_SEQUENCE.exec(rest);
    if (sequence) {
      keys.push(KEY_SEQUENCES[sequence[1]] || 'unknown');
      rest = rest.slice(sequence[0].length);
      continue;
    }
    const [ch] = rest;
    keys.push({ '\x1b': 'escape', '\r': 'enter', ' ': 'space', '\x03': 'ctrl+c' }[ch] || ch);
    rest = rest.slice(ch.length);
  }
  return keys;
}

// Text cut or padded to `width` columns (by code point), with any escape
// sequences and control characters (an error message's colors, a newline
// in an action's detail) taken out so they can't move the cursor.
function fit(text, width) {
  const chars = [...text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ')];
  if (chars.length <= width) return text + ' '.repeat(width - chars.length);
  return width <= 0 ? '' : `${chars.slice(0, width - 1).join('')}…`;
}

// The top-left `cols`×`rows` of a grid. A wide character cut in half by
// the right edge becomes a space, so every row stays exactly `cols` wide.
function clipGrid(grid, cols, rows) {
  return grid.slice(0, rows).map((row) => {
    const kept = row.slice(0, cols);
    const last = kept[kept.length - 1];
    if (last && last.width === 2) kept[kept.length - 1] = { ...last, ch: ' ', width: 1 };
    return kept;
  });
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function duration(ms) {
  if (ms === null || ms === undefined) return '';
  return ms < 1000 ? `${ms}ms` : seconds(ms);
}

/**
 * The --ui reporter: takes over the terminal (alternate screen) and redraws
 * the running test's live screen in place, framed at the app's own size,
 * with a header (file, test, progress, counts, elapsed) and a footer
 * (current step, last action, status). Redraws are coalesced to at most one
 * write per FRAME_MS, each a complete frame in one stdout.write.
 *
 * The terminal is always given back: by close() (which summary() and the
 * run's own cleanup call), and by guards on process exit, SIGINT/SIGTERM
 * and uncaught exceptions. console output during the run is held and
 * printed after leaving the alternate screen, where it stays readable.
 *
 * interactive(session) turns it into the test-selection HUD: stdin goes
 * into raw mode (given back by the same close()), and between runs the
 * frame is the list of the session's tests instead of a live screen.
 *
 * `stdout`, `stdin` and `proc` are injectable for tests.
 */
function createUiReporter({ stdout = process.stdout, stdin = process.stdin, proc = process, console: con = console, total = 0, now = Date.now } = {}) {
  const state = createState();
  const runStart = now();
  let started = false;
  let closed = false;
  let file = '';
  let current = null; // { name, retry, start, status, error, game, subscription, steps, lastAction }
  let lastGrid = null;
  let timer = null;
  let clock = null;
  let lastDraw = 0;
  const heldConsole = [];
  const originalConsole = {};
  // Interactive session state; `session` stays null for a plain --ui run.
  let session = null;
  let reading = false;
  let selected = 0;
  let top = 0;
  let message = '';
  let runSet = null; // the ids of the run in progress, or of the last one
  let running = null; // the in-progress run, settled (never rejects)
  let quitting = false;
  let resolveQuit = null;

  const log = (line) => stdout.write(`${line}\n`);

  function schedule() {
    if (!started || closed || timer) return;
    timer = setTimeout(draw, Math.max(0, FRAME_MS - (now() - lastDraw)));
  }

  function screen() {
    const game = current && current.game;
    if (!game) return null;
    try {
      lastGrid = game.getScreenCells();
    } catch {
      // A stopped game keeps its final grid; anything else, the last one seen.
    }
    let cursor = null;
    if (current.status === 'running') {
      try {
        cursor = game.getCursor();
      } catch {
        cursor = null;
      }
    }
    return lastGrid && { grid: lastGrid, cursor };
  }

  // Pass/fail/skip counts: the run's own tally, or in a session, each
  // test's latest status (a rerun replaces its result rather than adding).
  function counts() {
    if (!session) return { passed: state.passedCount, failed: state.failedCount, skipped: state.skippedCount, aborted: 0 };
    const tally = { passed: 0, failed: 0, skipped: 0, aborted: 0 };
    for (const t of session.tests) if (t.status in tally) tally[t.status] += 1;
    return tally;
  }

  function countsText() {
    const c = counts();
    return `✓ ${c.passed} passed  ✖ ${c.failed} failed  - ${c.skipped} skipped${c.aborted ? `  ⊘ ${c.aborted} aborted` : ''}`;
  }

  // n/total: of the whole run, or in a session, of the current run's tests.
  function progressText() {
    if (session) {
      const ids = new Set(runSet);
      const started = session.tests.filter((t) => ids.has(t.id) && t.status !== 'pending').length;
      return `${started}/${ids.size}`;
    }
    const done = state.passedCount + state.failedCount + state.skippedCount;
    return `${Math.min(done + (current && current.status === 'running' ? 1 : 0), total)}/${total}`;
  }

  function headerLines(width) {
    const title = current ? `${file ? `${file} › ` : ''}${current.name}${current.retry ? ` (retry ${current.retry})` : ''}` : file;
    const elapsed = `test ${current ? seconds((current.end || now()) - current.start) : '-'}  total ${seconds(now() - runStart)}`;
    const paused = session && session.paused ? '   ⏸ PAUSED' : '';
    return [
      `${INVERSE}${BOLD}${fit(` RPGWright  ${title}`, width)}${RESET}`,
      `${DIM}${fit(` ${progressText()}   ${countsText()}   ${elapsed}${paused}`, width)}${RESET}`,
    ];
  }

  function footerLines(width) {
    const steps = current ? current.steps.map((s) => s.detail).join(' › ') : '';
    const action = current && current.lastAction;
    const mark = action ? (action.ok === true ? ' ✓' : action.ok === false ? ' ✖' : ' …') : '';
    const last = action ? `${action.type} ${action.detail}${mark}` : '-';
    const status = current ? current.status : 'running';
    const detail = current && current.error ? current.error.message.split('\n')[0] : `last: ${last}`;
    const lines = [
      fit(` step: ${steps || '-'}`, width),
      `${STATUS_COLOR[status]}${INVERSE}${BOLD} ${status.toUpperCase()} ${RESET}${fit(` ${detail}`, width - status.length - 2)}`,
    ];
    if (session) lines.push(`${DIM}${fit(` ${session.paused ? PAUSED_HINTS : RUN_HINTS}`, width)}${RESET}`);
    return lines;
  }

  // One list row: pointer, status glyph, title, and file:line + last
  // duration on the right (dropped first when the terminal is narrow).
  function testRow(t, isSelected, width) {
    const right = `${t.file}:${t.line}  ${duration(t.durationMs).padStart(7)}`;
    const rightWidth = Math.min(right.length, Math.max(0, width - 16));
    const titleWidth = Math.max(0, width - 5 - rightWidth);
    const title = isSelected ? `${INVERSE}${BOLD}${fit(t.title, titleWidth)}${RESET}` : fit(t.title, titleWidth);
    return `${isSelected ? '›' : ' '} ${STATUS_COLOR[t.status] || ''}${STATUS_GLYPH[t.status] || '?'}${RESET} ${title} ${DIM}${fit(right, rightWidth)}${RESET}`;
  }

  function hudLines(width, height) {
    const { tests } = session;
    const listRows = Math.max(1, height - HEADER_ROWS - DETAIL_ROWS);
    selected = Math.max(0, Math.min(selected, tests.length - 1));
    if (selected < top) top = selected;
    if (selected >= top + listRows) top = selected - listRows + 1;
    top = Math.max(0, Math.min(top, tests.length - listRows));
    const more = tests.length > listRows ? `   ${top + 1}-${Math.min(top + listRows, tests.length)} of ${tests.length}` : '';
    const lines = [
      `${INVERSE}${BOLD}${fit(` RPGWright  ${tests.length} test${tests.length === 1 ? '' : 's'}`, width)}${RESET}`,
      `${DIM}${fit(` ${countsText()}${more}`, width)}${RESET}`,
    ];
    if (tests.length === 0) lines.push(fit('  (no tests)', width));
    for (let i = top; i < Math.min(top + listRows, tests.length); i += 1) lines.push(testRow(tests[i], i === selected, width));
    while (lines.length < HEADER_ROWS + listRows) lines.push('');

    const t = tests[selected];
    const errorLines = t && t.error ? String(t.error.message || t.error).split('\n').slice(0, ERROR_LINES) : [];
    lines.push(`${DIM}${'─'.repeat(width)}${RESET}`);
    lines.push(t ? fit(` ${t.file}:${t.line}   ${t.status}${t.durationMs === null || t.durationMs === undefined ? '' : ` in ${duration(t.durationMs)}`}`, width) : '');
    for (let i = 0; i < ERROR_LINES; i += 1) {
      lines.push(errorLines[i] === undefined ? '' : `${STATUS_COLOR.failed}${fit(`   ${errorLines[i]}`, width)}${RESET}`);
    }
    lines.push(message ? `${BOLD}${fit(` ${message}`, width)}${RESET}` : '');
    lines.push(`${DIM}${fit(` ${HUD_HINTS}`, width)}${RESET}`);
    return lines;
  }

  // The whole frame as one string: every row positioned absolutely and
  // cleared to its end, everything below the last row cleared.
  function frame() {
    const width = stdout.columns || 80;
    const height = stdout.rows || 24;
    const lines = session && !running ? hudLines(width, height) : liveLines(width, height);
    const body = lines
      .slice(0, height)
      .map((line, i) => `\x1b[${i + 1};1H${line}\x1b[K`)
      .join('');
    return `${SYNC_BEGIN}${body}${RESET}\x1b[J${SYNC_END}`;
  }

  // The running test: header, its live screen framed at the app's size, footer.
  function liveLines(width, height) {
    const lines = headerLines(width);
    const footer = footerLines(width);
    const shown = screen();
    if (!shown) {
      lines.push('', fit(current ? '  (no app launched yet)' : '  (waiting for the first test)', width));
    } else {
      const cols = shown.grid.length ? shown.grid[0].length : 0;
      const rows = shown.grid.length;
      const visCols = Math.max(0, Math.min(cols, width - 2));
      const visRows = Math.max(0, Math.min(rows, height - HEADER_ROWS - footer.length - 2));
      const pad = ' '.repeat(Math.max(0, Math.floor((width - visCols - 2) / 2)));
      const clipped = visCols < cols || visRows < rows;
      const label = ` ${cols}×${rows}${clipped ? ` (showing ${visCols}×${visRows})` : ''} `;
      lines.push(`${pad}${DIM}┌${fit(label, visCols).replace(/ +$/, (m) => '─'.repeat(m.length))}┐${RESET}`);
      for (const row of renderScreenAnsi(clipGrid(shown.grid, visCols, visRows), shown.cursor)) {
        lines.push(`${pad}${DIM}│${RESET}${row}${DIM}│${RESET}`);
      }
      lines.push(`${pad}${DIM}└${'─'.repeat(visCols)}┘${RESET}`);
    }
    lines.push(...footer);
    return lines;
  }

  function draw() {
    timer = null;
    if (!started || closed) return;
    lastDraw = now();
    stdout.write(frame());
  }

  function onEvent(event) {
    if (!current) return;
    if (event.type === 'action') {
      const { action } = event;
      if (action.type === 'step') {
        const index = current.steps.indexOf(action);
        if (action.ok === null && index === -1) current.steps.push(action);
        else if (action.ok !== null && index !== -1) current.steps.splice(index, 1);
      } else {
        current.lastAction = action;
      }
    }
    schedule();
  }

  function endTest(status, error) {
    if (!current) return;
    current.status = status;
    current.error = error || null;
    current.end = now();
    if (current.subscription) current.subscription.dispose();
    current.subscription = null;
    schedule();
  }

  // Resolves interactive() once any run in progress has settled.
  function finish() {
    if (!resolveQuit) return;
    const resolve = resolveQuit;
    resolveQuit = null;
    Promise.resolve(running).then(() => resolve());
  }

  function runTests(ids) {
    if (ids.length === 0) return;
    runSet = ids;
    if (current && current.subscription) current.subscription.dispose();
    current = null;
    lastGrid = null;
    let run;
    try {
      run = Promise.resolve(session.run(ids));
    } catch (error) {
      run = Promise.reject(error);
    }
    running = run
      .catch((error) => {
        message = `Run failed: ${error && error.message ? error.message : error}`;
      })
      .then(() => {
        running = null;
        // Back on the last test that actually ran (later ones were cancelled by an abort).
        const ran = ids.filter((id) => session.tests.some((t) => t.id === id && t.status !== 'pending'));
        const index = session.tests.findIndex((t) => t.id === (ran.length ? ran[ran.length - 1] : ids[0]));
        if (index !== -1) selected = index;
        if (quitting) finish();
        schedule();
      });
    schedule();
  }

  function onHudKey(key) {
    const { tests } = session;
    const listRows = Math.max(1, (stdout.rows || 24) - HEADER_ROWS - DETAIL_ROWS);
    const moves = { up: -1, k: -1, down: 1, j: 1, pageup: -listRows, pagedown: listRows, home: -Infinity, end: Infinity };
    if (key in moves) {
      selected = Math.max(0, Math.min(tests.length - 1, selected + moves[key]));
    } else if (key === 'enter') {
      if (tests[selected]) runTests([tests[selected].id]);
    } else if (key === 'a') {
      runTests(tests.map((t) => t.id));
    } else if (key === 'f') {
      const failed = tests.filter((t) => t.status === 'failed' || t.status === 'aborted');
      if (failed.length) runTests(failed.map((t) => t.id));
      else message = 'No failed tests to run.';
    } else if (key === 'r') {
      if (runSet) runTests(runSet);
      else if (tests[selected]) runTests([tests[selected].id]);
    } else if (key === 'q') {
      finish();
    } else {
      return;
    }
    schedule();
  }

  function onRunKey(key) {
    if (key === 'space') {
      if (session.paused) session.resume();
      else session.pause();
    } else if (key === 'n') {
      if (session.paused) session.stepOnce();
    } else if (key === 'escape') {
      session.abort();
    } else if (key === 'q') {
      quitting = true;
      session.abort();
    } else {
      return;
    }
    schedule();
  }

  function onData(chunk) {
    for (const key of decodeKeys(chunk)) {
      if (closed) return;
      if (key === 'ctrl+c') {
        // Quit now: the terminal comes back at once (so a second Ctrl+C is
        // a real SIGINT), and interactive() resolves once the abort lands.
        quitting = true;
        if (running) session.abort();
        close();
        return;
      }
      if (quitting) continue;
      if (message) {
        message = '';
        schedule();
      }
      if (running) onRunKey(key);
      else onHudKey(key);
    }
  }

  function startReading() {
    if (reading) return;
    reading = true;
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.resume();
  }

  function stopReading() {
    if (!reading) return;
    reading = false;
    stdin.off('data', onData);
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
    stdin.pause();
  }

  function onSignal(signal) {
    close();
    // Nobody else handles it: die from it the way we would have.
    if (proc.listenerCount(signal) === 0) proc.kill(proc.pid, signal);
  }
  const signalHandlers = Object.fromEntries(Object.keys(SIGNALS).map((s) => [s, () => onSignal(s)]));

  function start() {
    if (started || closed) return;
    started = true;
    proc.on('exit', close);
    proc.on('uncaughtExceptionMonitor', close);
    for (const [signal, handler] of Object.entries(signalHandlers)) proc.on(signal, handler);
    if (typeof stdout.on === 'function') stdout.on('resize', schedule);
    for (const method of CONSOLE_METHODS) {
      originalConsole[method] = con[method];
      con[method] = (...args) => heldConsole.push([method, util.format(...args)]);
    }
    clock = setInterval(schedule, 1000);
    if (clock.unref) clock.unref();
    stdout.write(ENTER);
    draw();
  }

  /**
   * Leaves the alternate screen and restores the cursor, wrapping and
   * console, then prints whatever console output was held. Idempotent.
   */
  function close() {
    if (closed) return;
    closed = true;
    if (!started) return;
    clearTimeout(timer);
    clearInterval(clock);
    stopReading();
    finish();
    if (current && current.subscription) current.subscription.dispose();
    proc.off('exit', close);
    proc.off('uncaughtExceptionMonitor', close);
    for (const [signal, handler] of Object.entries(signalHandlers)) proc.off(signal, handler);
    if (typeof stdout.off === 'function') stdout.off('resize', schedule);
    stdout.write(LEAVE);
    Object.assign(con, originalConsole);
    for (const [method, text] of heldConsole.splice(0)) con[method](text);
  }

  return {
    start,
    close,
    /**
     * Runs the session's HUD until the user quits: resolves on `q` (after
     * aborting and settling a run in progress) or Ctrl+C. With `autoRun`,
     * runs every test first. Starts the ui if it isn't yet; the caller
     * still close()s it and prints the summary.
     */
    interactive(theSession, { autoRun = false } = {}) {
      if (closed) return Promise.resolve();
      session = theSession;
      start();
      startReading();
      const done = new Promise((resolve) => {
        resolveQuit = resolve;
      });
      if (autoRun) runTests(session.tests.map((t) => t.id));
      schedule();
      return done;
    },
    // Told about every process a test launches; the first is the one shown.
    onGame(game) {
      if (!current || current.game) return;
      current.game = game;
      current.subscription = game.observe(onEvent);
      schedule();
    },
    fileStarted(relativePath) {
      file = relativePath;
      schedule();
    },
    testStarted(name, meta, attempt = {}) {
      if (current && current.subscription) current.subscription.dispose();
      current = { name, retry: attempt.retry || 0, start: now(), status: 'running', error: null, game: null, subscription: null, steps: [], lastAction: null };
      lastGrid = null;
      schedule();
    },
    testPassed(name, durationMs, attempt) {
      recordPass(state, attempt);
      endTest('passed');
    },
    testFailed(name, durationMs, error) {
      state.failedCount += 1;
      state.failures.push({ name, error });
      endTest('failed', error);
    },
    testSkipped() {
      state.skippedCount += 1;
      schedule();
    },
    // In a session, the summary is each test's latest result, not every
    // run of it.
    summary(durationMs) {
      close();
      if (!session) return printSummary(state, durationMs, log);
      const { passed, failed, skipped, flaky } = session.results();
      const failures = session.tests.filter((t) => t.status === 'failed' && t.error).map((t) => ({ name: t.title, error: t.error }));
      return printSummary({ failures, passedCount: passed, failedCount: failed, skippedCount: skipped, flakyCount: flaky }, durationMs, log);
    },
  };
}

module.exports = { createUiReporter, clipGrid, decodeKeys, ENTER, LEAVE };
