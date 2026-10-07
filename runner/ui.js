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
const FOOTER_ROWS = 2;
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'];
const SIGNALS = { SIGINT: 130, SIGTERM: 143 };

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const INVERSE = '\x1b[7m';
const RESET = '\x1b[0m';
const STATUS_COLOR = { running: '\x1b[33m', passed: '\x1b[32m', failed: '\x1b[31m', skipped: '\x1b[2m' };

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
 * `stdout` and `proc` are injectable for tests.
 */
function createUiReporter({ stdout = process.stdout, proc = process, console: con = console, total = 0, now = Date.now } = {}) {
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

  function headerLines(width) {
    const done = state.passedCount + state.failedCount + state.skippedCount;
    const title = current ? `${file ? `${file} › ` : ''}${current.name}${current.retry ? ` (retry ${current.retry})` : ''}` : file;
    const progress = `${Math.min(done + (current && current.status === 'running' ? 1 : 0), total)}/${total}`;
    const counts = `✓ ${state.passedCount} passed  ✖ ${state.failedCount} failed  - ${state.skippedCount} skipped`;
    const elapsed = `test ${current ? seconds((current.end || now()) - current.start) : '-'}  total ${seconds(now() - runStart)}`;
    return [
      `${INVERSE}${BOLD}${fit(` RPGWright  ${title}`, width)}${RESET}`,
      `${DIM}${fit(` ${progress}   ${counts}   ${elapsed}`, width)}${RESET}`,
    ];
  }

  function footerLines(width) {
    const steps = current ? current.steps.map((s) => s.detail).join(' › ') : '';
    const action = current && current.lastAction;
    const mark = action ? (action.ok === true ? ' ✓' : action.ok === false ? ' ✖' : ' …') : '';
    const last = action ? `${action.type} ${action.detail}${mark}` : '-';
    const status = current ? current.status : 'running';
    const detail = current && current.error ? current.error.message.split('\n')[0] : `last: ${last}`;
    return [
      fit(` step: ${steps || '-'}`, width),
      `${STATUS_COLOR[status]}${INVERSE}${BOLD} ${status.toUpperCase()} ${RESET}${fit(` ${detail}`, width - status.length - 2)}`,
    ];
  }

  // The whole frame as one string: every row positioned absolutely and
  // cleared to its end, everything below the last row cleared.
  function frame() {
    const width = stdout.columns || 80;
    const height = stdout.rows || 24;
    const lines = headerLines(width);
    const shown = screen();
    if (!shown) {
      lines.push('', fit(current ? '  (no app launched yet)' : '  (waiting for the first test)', width));
    } else {
      const cols = shown.grid.length ? shown.grid[0].length : 0;
      const rows = shown.grid.length;
      const visCols = Math.max(0, Math.min(cols, width - 2));
      const visRows = Math.max(0, Math.min(rows, height - HEADER_ROWS - FOOTER_ROWS - 2));
      const pad = ' '.repeat(Math.max(0, Math.floor((width - visCols - 2) / 2)));
      const clipped = visCols < cols || visRows < rows;
      const label = ` ${cols}×${rows}${clipped ? ` (showing ${visCols}×${visRows})` : ''} `;
      lines.push(`${pad}${DIM}┌${fit(label, visCols).replace(/ +$/, (m) => '─'.repeat(m.length))}┐${RESET}`);
      for (const row of renderScreenAnsi(clipGrid(shown.grid, visCols, visRows), shown.cursor)) {
        lines.push(`${pad}${DIM}│${RESET}${row}${DIM}│${RESET}`);
      }
      lines.push(`${pad}${DIM}└${'─'.repeat(visCols)}┘${RESET}`);
    }
    lines.push(...footerLines(width));
    const body = lines
      .slice(0, height)
      .map((line, i) => `\x1b[${i + 1};1H${line}\x1b[K`)
      .join('');
    return `${SYNC_BEGIN}${body}${RESET}\x1b[J${SYNC_END}`;
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
    summary(durationMs) {
      close();
      return printSummary(state, durationMs, log);
    },
  };
}

module.exports = { createUiReporter, clipGrid, ENTER, LEAVE };
