'use strict';

const { createVirtualTerminal } = require('../src/terminal');
const { createFullscreen, screenLines, titleBar, infoBar, statusBar, errorLine, actionText, fit, seconds, STATUS_GLYPH } = require('./ui');

const USAGE = 'Usage: rpgwright play <file.run.json> [--session <n>]';
const REAL_CLOCK = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};
const ERROR_LINES = 3;
// Float slack when comparing a recorded time against the clock's position.
const EPSILON = 1e-9;

/**
 * Replays `events` ([seconds, ...rest], in recorded order) on their own
 * timeline: start() applies everything at time 0 at once, then each event
 * via `apply(event)` once its recorded time is reached, with one timer set
 * for the next event and nothing polling in between. `onTick(position)`
 * runs after each batch; `onDone()` once the last event is applied.
 *
 * Recorded time maps to wall time through `speed` (2 = twice as fast),
 * anchored at the last rebase: position = anchor + elapsed wall time ×
 * speed. Changing speed and pausing both rebase first, so the position
 * never jumps; a paused playback's position stays put.
 *
 * `clock` ({ now() in ms, setTimeout, clearTimeout }) is injectable so
 * tests can drive it by hand.
 */
function createPlayback({ events, apply, clock = REAL_CLOCK, speed = 1, onTick, onDone }) {
  const duration = events.length ? events[events.length - 1][0] : 0;
  let anchor = { wall: clock.now(), position: 0 };
  let index = 0;
  let playing = false;
  let done = false;
  let timer = null;

  function position() {
    if (!playing) return anchor.position;
    return Math.min(duration, anchor.position + ((clock.now() - anchor.wall) / 1000) * speed);
  }

  // Re-anchors the mapping at the current position and wall time.
  function rebase() {
    anchor = { wall: clock.now(), position: position() };
  }

  function cancel() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }

  function step() {
    timer = null;
    if (!playing) return;
    const now = position();
    let applied = false;
    while (index < events.length && events[index][0] <= now + EPSILON) {
      apply(events[index]);
      index += 1;
      applied = true;
    }
    if (index >= events.length) {
      playing = false;
      done = true;
      anchor = { wall: clock.now(), position: duration };
      if (onTick) onTick(duration);
      if (onDone) onDone();
      return;
    }
    if (applied && onTick) onTick(now);
    timer = clock.setTimeout(step, Math.max(0, ((events[index][0] - now) / speed) * 1000));
  }

  function resume() {
    if (playing || done) return;
    playing = true;
    anchor = { wall: clock.now(), position: anchor.position };
    step();
  }

  return {
    start: resume,
    resume,
    pause() {
      if (!playing) return;
      rebase();
      playing = false;
      cancel();
    },
    // Takes effect from the current position; the next timer is re-aimed.
    setSpeed(value) {
      if (!(value > 0)) throw new Error(`Playback speed must be a positive number, got ${value}.`);
      rebase();
      speed = value;
      if (playing) {
        cancel();
        step();
      }
    },
    stop() {
      cancel();
      if (playing) rebase();
      playing = false;
    },
    get position() {
      return position();
    },
    get duration() {
      return duration;
    },
    get speed() {
      return speed;
    },
    get playing() {
      return playing;
    },
    get done() {
      return done;
    },
  };
}

/**
 * The open steps and the last other action as of `position` (seconds), from
 * a recorded action list (each { type, detail, ok, depth, t }). An action at
 * depth d is inside the d steps before it, so it closes any deeper ones.
 */
function stepsAt(actions, position) {
  const steps = [];
  let last = null;
  for (const action of actions) {
    if (action.t > position + EPSILON) continue;
    steps.length = Math.min(steps.length, action.depth || 0);
    if (action.type === 'step') steps.push(action);
    else last = action;
  }
  return { steps, last };
}

/**
 * The lines of a recorded failure worth showing once playback finishes.
 * A GameDriver failure report's first line is only its banner, and its
 * screen is what was just replayed, so for one of those: the banner, what
 * was expected and the last action. Anything else: its first few lines.
 */
function failureLines(error) {
  if (!error) return [];
  const lines = String(error.report || error.message).split('\n');
  const section = (heading) => {
    const index = lines.indexOf(heading);
    return index === -1 || lines[index + 1] === undefined ? null : lines[index + 1].trim();
  };
  const expected = section('Expected:');
  if (lines[0] === 'E2E TEST FAILED' && expected !== null) {
    const last = section('Last action:');
    return [lines[0], `Expected: ${expected}`, ...(last ? [`Last action: ${last}`] : [])];
  }
  return lines.map((line) => line.trim()).filter(Boolean).slice(0, ERROR_LINES);
}

function parsePlayArgs(args) {
  let file = null;
  let session = 1;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--session') {
      const value = args[i + 1];
      const n = Number(value);
      if (value === undefined || !/^\d+$/.test(value) || n < 1) throw new Error('--session requires a positive integer (1 is the first session).');
      session = n;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option "${arg}". ${USAGE}`);
    } else if (file === null) {
      file = arg;
    } else {
      throw new Error(`Expected one run file, got "${file}" and "${arg}". ${USAGE}`);
    }
  }
  if (file === null) throw new Error(`Missing the run file to play. ${USAGE}`);
  return { file, session };
}

/**
 * `rpgwright play`: replays one session of a saved run in the full-screen
 * UI. Only the recorded output is replayed into a fresh virtual terminal;
 * nothing is launched and no test code is loaded. Resolves when the user
 * quits (q or Ctrl+C), whether or not playback has finished.
 *
 * `stdout`, `stdin`, `proc`, `console`, `clock` and `readRunFile` are
 * injectable for tests.
 */
async function runPlay(args, options = {}) {
  const {
    stdout = process.stdout,
    stdin = process.stdin,
    proc = process,
    console: con = console,
    clock = REAL_CLOCK,
    readRunFile = require('./runfile').readRunFile,
  } = options;
  const opts = parsePlayArgs(args);
  const run = readRunFile(opts.file);
  const total = run.sessions.length;
  if (total === 0) throw new Error(`${opts.file} has no recorded sessions: the test didn't launch an app, so there is nothing to play.`);
  if (opts.session > total) {
    throw new Error(`--session ${opts.session}: ${opts.file} has ${total === 1 ? 'only 1 session' : `${total} sessions (1-${total})`}.`);
  }
  if (!stdout.isTTY || !stdin.isTTY) {
    throw new Error('rpgwright play needs an interactive terminal, but stdin or stdout is not a TTY (is it piped or redirected?).');
  }

  const recorded = run.sessions[opts.session - 1];
  const actions = recorded.actions || [];
  const terminal = createVirtualTerminal({ cols: recorded.cols, rows: recorded.rows });
  // Output and resizes in recorded order: a resize must not overtake output
  // still being parsed, so every change waits for the one before it.
  let parsed = Promise.resolve();
  const enqueue = (change) => {
    parsed = parsed.then(change);
    parsed.then(() => display.schedule());
  };
  // Actions join the timeline only to redraw the footer at their time.
  const timeline = [...recorded.events, ...actions.map((action) => [action.t, 'a', action])].sort((a, b) => a[0] - b[0]);

  let finished = false;
  let resolveQuit;
  const quit = new Promise((resolve) => {
    resolveQuit = resolve;
  });

  const playback = createPlayback({
    events: timeline,
    clock,
    apply([, type, data]) {
      if (type === 'o') {
        enqueue(() => terminal.write(data));
      } else if (type === 'r') {
        const [cols, rows] = String(data).split('x').map(Number);
        if (cols > 0 && rows > 0) enqueue(() => terminal.resize(cols, rows));
      }
    },
    onTick: () => display.schedule(),
    onDone() {
      parsed.then(() => {
        finished = true;
        display.schedule();
      });
    },
  });

  const { test, result } = run;
  const where = [test.file && `${test.file}${test.line ? `:${test.line}` : ''}`, test.title].filter(Boolean).join(' › ');

  function headerLines(width) {
    const outcome = `recorded ${STATUS_GLYPH[result.status] || ''} ${result.status}${typeof result.durationMs === 'number' ? ` in ${seconds(result.durationMs)}` : ''}`;
    const sessionText = total > 1 ? `   session ${opts.session}/${total}` : '';
    const clockText = `${finished ? '■' : '▶'} ${seconds(playback.position * 1000)} / ${seconds(playback.duration * 1000)}`;
    return [titleBar(`RPGWright  REPLAY  ${where}`, width), infoBar(`${outcome}${sessionText}   ${clockText}`, width)];
  }

  function footerLines(width) {
    const { steps, last } = stepsAt(actions, playback.position);
    const lines = [fit(` step: ${steps.map((s) => s.detail || s.type).join(' › ') || '-'}`, width)];
    if (!finished) {
      lines.push(statusBar('running', 'PLAYING', `last: ${actionText(last)}`, width));
    } else {
      lines.push(statusBar(result.status, result.status.toUpperCase(), 'Playback finished', width));
      for (const line of failureLines(result.error)) lines.push(errorLine(line, width));
    }
    lines.push(infoBar('q quit', width));
    return lines;
  }

  const display = createFullscreen({
    stdout,
    stdin,
    proc,
    console: con,
    now: Date.now,
    render: (width, height) =>
      screenLines({
        width,
        height,
        header: headerLines(width),
        footer: footerLines(width),
        screen: { grid: terminal.getScreenCells(), cursor: finished ? null : terminal.getCursor() },
      }),
    onKey(key) {
      if (key === 'q' || key === 'ctrl+c') display.close();
    },
    onClose() {
      playback.stop();
      resolveQuit();
    },
  });

  display.start();
  display.startReading();
  playback.start();
  try {
    await quit;
  } finally {
    display.close();
    await parsed;
    terminal.dispose();
  }
}

module.exports = { createPlayback, stepsAt, failureLines, parsePlayArgs, runPlay };
