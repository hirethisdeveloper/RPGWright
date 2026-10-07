'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUiReporter, clipGrid, decodeKeys, ENTER, LEAVE } = require('../runner/ui');

const FRAME_WAIT_MS = 40;
const wait = (ms = FRAME_WAIT_MS) => new Promise((resolve) => setTimeout(resolve, ms));
const strip = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

function fakeStdout({ columns = 80, rows = 24 } = {}) {
  const out = new EventEmitter();
  Object.assign(out, { columns, rows, isTTY: true, chunks: [] });
  out.write = (chunk) => {
    out.chunks.push(chunk);
    return true;
  };
  out.text = () => out.chunks.join('');
  return out;
}

function fakeProcess() {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.killed = [];
  proc.kill = (pid, signal) => proc.killed.push([pid, signal]);
  return proc;
}

function fakeConsole() {
  const lines = [];
  return { lines, log: (line) => lines.push(line), info() {}, warn() {}, error: (line) => lines.push(line), debug() {} };
}

const cell = (ch, extra = {}) => ({ ch, width: 1, fg: null, bg: null, ...extra });
const gridOf = (lines) => {
  const width = Math.max(...lines.map((line) => line.length));
  return lines.map((line) => [...line.padEnd(width)].map((ch) => cell(ch)));
};

function fakeGame(lines) {
  const game = { listener: null, disposed: false };
  game.getScreenCells = () => gridOf(lines);
  game.getCursor = () => ({ x: 0, y: 0, visible: false });
  game.observe = (listener) => {
    game.listener = listener;
    return { dispose: () => (game.disposed = true) };
  };
  return game;
}

function setup(options = {}) {
  const stdout = fakeStdout(options);
  const proc = fakeProcess();
  const con = fakeConsole();
  const ui = createUiReporter({ stdout, proc, console: con, total: 3 });
  return { stdout, proc, con, ui };
}

// The last complete frame written.
function lastFrame(stdout) {
  const frames = stdout.chunks.filter((c) => c.includes('\x1b[?2026h'));
  return frames[frames.length - 1];
}

test('ui: start enters the alternate screen and hides the cursor; summary leaves it before printing', () => {
  const { stdout, ui } = setup();
  ui.start();
  assert.ok(stdout.chunks[0].startsWith(ENTER));
  assert.ok(ENTER.includes('\x1b[?1049h') && ENTER.includes('\x1b[?25l'));

  ui.testStarted('reaches menu', { file: 'a.js', line: 1 });
  ui.testFailed('reaches menu', 5, new Error('boom'));
  const totals = ui.summary(12);
  assert.deepEqual(totals, { passed: 0, failed: 1, skipped: 0, flaky: 0 });

  const text = stdout.text();
  const leave = text.lastIndexOf(LEAVE);
  assert.ok(LEAVE.includes('\x1b[?1049l') && LEAVE.includes('\x1b[?25h'));
  assert.ok(leave > 0, 'left the alternate screen');
  const after = strip(text.slice(leave + LEAVE.length));
  assert.match(after, /1\) reaches menu\n\s+boom/);
  assert.match(after, /1 failed \(12ms\)/);
  assert.equal(text.indexOf(LEAVE), leave, 'left exactly once');
});

test('ui: close is idempotent and a never-started ui writes no terminal sequences', () => {
  const { stdout, ui } = setup();
  ui.close();
  ui.close();
  ui.summary(1);
  assert.ok(!stdout.text().includes('\x1b[?1049'));
  assert.match(strip(stdout.text()), /0 tests/);
});

test('ui: a frame shows the header, the framed live screen, and the footer', async () => {
  const { stdout, ui } = setup();
  ui.start();
  ui.fileStarted('menu.rpg.test.js');
  ui.testStarted('opens the menu', { file: 'menu.rpg.test.js', line: 3 });
  const game = fakeGame(['Hello   ', 'World   ']);
  ui.onGame(game, {});
  game.listener({ type: 'action', action: { type: 'step', detail: '"open"', ok: null } });
  game.listener({ type: 'action', action: { type: 'press', detail: '"Enter"', ok: true } });
  game.listener({ type: 'screen' });
  await wait();

  const frame = strip(lastFrame(stdout));
  assert.match(frame, /RPGWright {2}menu\.rpg\.test\.js › opens the menu/);
  assert.match(frame, /1\/3 {3}✓ 0 passed {2}✖ 0 failed {2}- 0 skipped/);
  assert.match(frame, /┌ 8×2─*┐/);
  assert.match(frame, /│Hello {3}│/);
  assert.match(frame, /│World {3}│/);
  assert.match(frame, /└─{8}┘/);
  assert.match(frame, /step: "open"/);
  assert.match(frame, /RUNNING {2}last: press "Enter" ✓/);
  // Every row is positioned absolutely, and the whole frame is one write.
  assert.match(lastFrame(stdout), /^\x1b\[\?2026h\x1b\[1;1H/);

  ui.testPassed('opens the menu', 10, {});
  await wait();
  assert.ok(game.disposed, 'unsubscribed when the test ended');
  assert.match(strip(lastFrame(stdout)), /PASSED/);
  ui.close();
});

test('ui: redraws are coalesced into one frame per tick', async () => {
  const { stdout, ui } = setup();
  ui.start();
  ui.testStarted('t', {});
  const game = fakeGame(['x']);
  ui.onGame(game, {});
  await wait();
  const before = stdout.chunks.length;
  for (let i = 0; i < 50; i += 1) game.listener({ type: 'screen' });
  await wait();
  assert.equal(stdout.chunks.length - before, 1);
  ui.close();
});

test('ui: a terminal smaller than the app clips the screen and says so, and re-lays out on resize', async () => {
  const { stdout, ui } = setup({ columns: 12, rows: 10 });
  ui.start();
  ui.testStarted('t', {});
  ui.onGame(fakeGame(['abcdefghijklmnopqrst', '1', '2', '3', '4', '5', '6', '7']), {});
  await wait();
  let frame = strip(lastFrame(stdout));
  // 12 columns leave 10 for the screen inside the box; 10 rows leave 4.
  assert.match(frame, /│abcdefghij│/);
  assert.doesNotMatch(frame, /k/);
  assert.equal((frame.match(/│/g) || []).length, 8);
  assert.match(frame, /┌ 20×8 \(sh…┐/);

  stdout.columns = 40;
  stdout.rows = 20;
  stdout.emit('resize');
  await wait();
  frame = strip(lastFrame(stdout));
  assert.match(frame, /│abcdefghijklmnopqrst│/);
  assert.match(frame, /┌ 20×8─*┐/);
  assert.match(frame, /│1 {19}│/);
  ui.close();
});

test('clipGrid: a wide character cut by the edge becomes a space', () => {
  const grid = [[cell('a'), cell('中', { width: 2 }), cell('', { width: 0 })]];
  const clipped = clipGrid(grid, 2, 5);
  assert.equal(clipped[0].length, 2);
  assert.deepEqual([clipped[0][1].ch, clipped[0][1].width], [' ', 1]);
});

test('ui: console output during the run is held and printed after leaving the alternate screen', () => {
  const { stdout, con, ui } = setup();
  const originalLog = con.log;
  ui.start();
  con.log('from a test %d', 7);
  assert.deepEqual(con.lines, []);
  ui.close();
  assert.equal(con.log, originalLog);
  assert.deepEqual(con.lines, ['from a test 7']);
  assert.ok(stdout.text().endsWith(LEAVE));
});

test('ui: SIGINT restores the terminal and re-raises the signal when nobody else handles it', () => {
  const { stdout, proc, ui } = setup();
  ui.start();
  proc.emit('SIGINT');
  assert.ok(stdout.text().endsWith(LEAVE));
  assert.deepEqual(proc.killed, [[4242, 'SIGINT']]);
  assert.equal(proc.listenerCount('SIGINT'), 0);
  assert.equal(proc.listenerCount('exit'), 0);
});

test('ui: SIGINT with another handler (the CLI exits with 130) only restores the terminal', () => {
  const { stdout, proc, ui } = setup();
  proc.on('SIGINT', () => {});
  ui.start();
  proc.emit('SIGINT');
  assert.ok(stdout.text().endsWith(LEAVE));
  assert.deepEqual(proc.killed, []);
});

test('ui: an uncaught exception or process exit restores the terminal', () => {
  for (const event of ['uncaughtExceptionMonitor', 'exit']) {
    const { stdout, proc, ui } = setup();
    ui.start();
    proc.emit(event, new Error('crash'));
    assert.ok(stdout.text().endsWith(LEAVE), event);
    assert.equal(stdout.text().split(LEAVE).length, 2);
  }
});

test('decodeKeys: arrows, paging keys, enter, a lone escape and Ctrl+C', () => {
  assert.deepEqual(decodeKeys('\x1b[A\x1b[B\x1bOA\x1bOB'), ['up', 'down', 'up', 'down']);
  assert.deepEqual(decodeKeys('\x1b[5~\x1b[6~\x1b[H\x1b[1~\x1b[F\x1b[4~'), ['pageup', 'pagedown', 'home', 'home', 'end', 'end']);
  assert.deepEqual(decodeKeys('\r'), ['enter']);
  assert.deepEqual(decodeKeys('\x1b'), ['escape']);
  assert.deepEqual(decodeKeys('\x1b\x1b[A'), ['escape', 'up']);
  assert.deepEqual(decodeKeys('\x1bq'), ['escape', 'q']);
  assert.deepEqual(decodeKeys('\x03 jk'), ['ctrl+c', 'space', 'j', 'k']);
  assert.deepEqual(decodeKeys(Buffer.from('\x1b[1;5C')), ['unknown']);
});

// --- Interactive session ----------------------------------------------------

function fakeStdin() {
  const stdin = new EventEmitter();
  Object.assign(stdin, { isRaw: false, flowing: false, rawCalls: [] });
  stdin.setRawMode = (on) => {
    stdin.isRaw = on;
    stdin.rawCalls.push(on);
  };
  stdin.resume = () => (stdin.flowing = true);
  stdin.pause = () => (stdin.flowing = false);
  stdin.send = (...keys) => keys.forEach((key) => stdin.emit('data', Buffer.from(key)));
  return stdin;
}

const KEY = { up: '\x1b[A', down: '\x1b[B', pageDown: '\x1b[6~', home: '\x1b[H', end: '\x1b[F', enter: '\r', esc: '\x1b', ctrlC: '\x03' };

// The session contract, with each run() settled by the test (or by abort()).
function fakeSession(specs) {
  const session = {
    tests: specs.map((spec, i) => ({ id: `t${i}`, title: `test ${i}`, file: 'a.rpg.test.js', line: i + 1, status: 'pending', durationMs: null, error: null, ...spec })),
    calls: [],
    runs: [],
    paused: false,
  };
  session.run = (ids) => {
    session.calls.push(['run', ids]);
    for (const id of ids) session.tests.find((t) => t.id === id).status = 'pending';
    return new Promise((resolve) => session.runs.push({ ids, resolve }));
  };
  // Settles the latest run, setting each listed test's status (default passed).
  session.finish = (statuses = {}) => {
    const { ids, resolve } = session.runs[session.runs.length - 1];
    for (const id of ids) Object.assign(session.tests.find((t) => t.id === id), { status: 'passed', durationMs: 5 }, statuses[id]);
    resolve();
  };
  session.abort = () => {
    session.calls.push(['abort']);
    const run = session.runs[session.runs.length - 1];
    if (run) {
      session.tests.find((t) => t.id === run.ids[0]).status = 'aborted';
      run.resolve();
    }
  };
  session.pause = () => {
    session.calls.push(['pause']);
    session.paused = true;
  };
  session.resume = () => {
    session.calls.push(['resume']);
    session.paused = false;
  };
  session.stepOnce = () => session.calls.push(['stepOnce']);
  session.results = () => {
    const count = (status) => session.tests.filter((t) => t.status === status).length;
    return { passed: count('passed'), failed: count('failed'), skipped: count('skipped'), flaky: 0 };
  };
  return session;
}

function setupSession(specs, options = {}) {
  const stdout = fakeStdout(options);
  const stdin = fakeStdin();
  const proc = fakeProcess();
  const ui = createUiReporter({ stdout, stdin, proc, console: fakeConsole() });
  const session = fakeSession(specs);
  const done = ui.interactive(session, options);
  let resolved = false;
  done.then(() => (resolved = true));
  const frame = () => strip(lastFrame(stdout));
  return { stdout, stdin, ui, session, done, frame, isResolved: () => resolved };
}

const runCalls = (session) => session.calls.filter(([name]) => name === 'run').map(([, ids]) => ids);

test('ui interactive: the HUD lists every test with its status, location and duration, plus a detail pane', async () => {
  const { stdin, ui, frame } = setupSession([
    { status: 'passed', durationMs: 12 },
    { status: 'failed', durationMs: 1500, error: new Error('expected "Menu"\nscreen was blank\nline 3\nline 4') },
    { status: 'skipped' },
    { status: 'aborted' },
    {},
  ]);
  await wait();
  let shown = frame();
  assert.match(shown, /RPGWright {2}5 tests/);
  assert.match(shown, /✓ 1 passed {2}✖ 1 failed {2}- 1 skipped {2}⊘ 1 aborted/);
  assert.match(shown, /› ✓ test 0 +a\.rpg\.test\.js:1 +12ms/);
  assert.match(shown, / {2}✖ test 1 +a\.rpg\.test\.js:2 +1\.5s/);
  assert.match(shown, / {2}- test 2 +a\.rpg\.test\.js:3/);
  assert.match(shown, / {2}⊘ test 3 +a\.rpg\.test\.js:4/);
  assert.match(shown, / {2}· test 4 +a\.rpg\.test\.js:5/);
  assert.match(shown, /a\.rpg\.test\.js:1 {3}passed in 12ms/);
  assert.match(shown, /enter run {2}a all {2}f failed {2}r rerun {2}q quit/);

  // The detail pane follows the selection, with the error's first lines.
  stdin.send(KEY.down);
  await wait();
  shown = frame();
  assert.match(shown, /› ✖ test 1/);
  assert.match(shown, /a\.rpg\.test\.js:2 {3}failed in 1\.5s/);
  assert.match(shown, /expected "Menu" +screen was blank +line 3 /);
  assert.doesNotMatch(shown, /line 4/);
  ui.close();
});

test('ui interactive: arrows, j/k and paging move the selection and the list scrolls to keep it visible', async () => {
  // 12 rows leave 3 for the list.
  const { stdin, ui, frame } = setupSession(Array.from({ length: 10 }, () => ({})), { rows: 12 });
  await wait();
  assert.match(frame(), /1-3 of 10/);
  assert.match(frame(), /› · test 0/);
  stdin.send('j', KEY.down);
  await wait();
  assert.match(frame(), /› · test 2/);
  stdin.send(KEY.down);
  await wait();
  assert.match(frame(), /› · test 3/);
  assert.match(frame(), /2-4 of 10/);
  assert.doesNotMatch(frame(), /test 0/);
  stdin.send('k', KEY.up, KEY.up, KEY.up, KEY.up);
  await wait();
  assert.match(frame(), /› · test 0/);
  stdin.send(KEY.end);
  await wait();
  assert.match(frame(), /› · test 9/);
  assert.match(frame(), /8-10 of 10/);
  stdin.send(KEY.home, KEY.pageDown);
  await wait();
  assert.match(frame(), /› · test 3/);
  ui.close();
});

test('ui interactive: enter runs the highlighted test, shows the live view, then returns to the HUD on it', async () => {
  const { stdin, ui, session, frame } = setupSession([{}, {}, {}]);
  stdin.send(KEY.down, KEY.enter);
  assert.deepEqual(runCalls(session), [['t1']]);
  ui.testStarted('test 1', { file: 'a.rpg.test.js', line: 2 });
  session.tests[1].status = 'running';
  ui.onGame(fakeGame(['Live']), {});
  await wait();
  assert.match(frame(), /│Live│/);
  assert.match(frame(), /1\/1/);
  assert.match(frame(), /space pause {2}esc abort {2}q quit/);

  // HUD keys don't apply while running.
  stdin.send('a', 'f', 'r', KEY.enter);
  assert.equal(runCalls(session).length, 1);

  ui.testPassed('test 1', 5, {});
  session.finish();
  await wait();
  assert.match(frame(), /› ✓ test 1/);
  assert.doesNotMatch(frame(), /│Live│/);
  ui.close();
});

test('ui interactive: a runs all, f runs failed and aborted, r reruns the last set', async () => {
  const { stdin, ui, session } = setupSession([{}, { status: 'failed' }, { status: 'aborted' }, { status: 'passed' }]);
  stdin.send('a');
  session.finish();
  await wait();
  stdin.send('r');
  session.finish({ t2: { status: 'failed' } });
  await wait();
  stdin.send('f');
  session.finish();
  await wait();
  assert.deepEqual(runCalls(session), [['t0', 't1', 't2', 't3'], ['t0', 't1', 't2', 't3'], ['t2']]);
  ui.close();
});

test('ui interactive: f with nothing failed says so, and r with no previous run runs the highlighted test', async () => {
  const { stdin, ui, session, frame } = setupSession([{}, {}]);
  stdin.send('f');
  await wait();
  assert.match(frame(), /No failed tests to run\./);
  assert.deepEqual(runCalls(session), []);
  stdin.send('j');
  await wait();
  assert.doesNotMatch(frame(), /No failed tests/, 'the message clears on the next key');
  stdin.send('r');
  assert.deepEqual(runCalls(session), [['t1']]);
  session.finish();
  ui.close();
});

test('ui interactive: space pauses and resumes, n steps only while paused', async () => {
  const { stdin, ui, session, frame } = setupSession([{}]);
  stdin.send(KEY.enter);
  ui.testStarted('test 0', {});
  stdin.send('n');
  assert.deepEqual(session.calls.slice(1), [], 'n does nothing while not paused');
  stdin.send(' ');
  await wait();
  assert.match(frame(), /⏸ PAUSED/);
  assert.match(frame(), /space resume {2}n step/);
  stdin.send('n', 'n', ' ');
  await wait();
  assert.doesNotMatch(frame(), /PAUSED/);
  assert.deepEqual(session.calls.slice(1), [['pause'], ['stepOnce'], ['stepOnce'], ['resume']]);
  session.finish();
  ui.close();
});

test('ui interactive: esc aborts the running test and returns to the HUD', async () => {
  const { stdin, ui, session, frame, isResolved } = setupSession([{}, {}]);
  stdin.send('a');
  ui.testStarted('test 0', {});
  stdin.send(KEY.esc);
  assert.deepEqual(session.calls[1], ['abort']);
  await wait();
  assert.match(frame(), /› ⊘ test 0/);
  assert.match(frame(), /⊘ 1 aborted/);
  assert.equal(isResolved(), false);
  ui.close();
});

test('ui interactive: q in the HUD resolves; the ui is still up until the runner closes it', async () => {
  const { stdout, stdin, ui, done } = setupSession([{}]);
  stdin.send('q');
  await done;
  assert.ok(!stdout.text().includes(LEAVE));
  assert.equal(stdin.isRaw, true);
  ui.close();
  assert.ok(stdout.text().endsWith(LEAVE));
  assert.equal(stdin.isRaw, false);
  assert.equal(stdin.flowing, false);
  assert.equal(stdin.listenerCount('data'), 0);
});

test('ui interactive: q while running aborts, then resolves once the run settles', async () => {
  const stdout = fakeStdout();
  const stdin = fakeStdin();
  const ui = createUiReporter({ stdout, stdin, proc: fakeProcess(), console: fakeConsole() });
  const session = fakeSession([{}, {}]);
  // An abort that takes a moment to land.
  session.abort = () => session.calls.push(['abort']);
  let resolved = false;
  const done = ui.interactive(session).then(() => (resolved = true));
  stdin.send('a', 'q');
  assert.deepEqual(session.calls[1], ['abort']);
  await wait();
  assert.equal(resolved, false);
  stdin.send('a', KEY.enter);
  assert.equal(runCalls(session).length, 1, 'no keys after q');
  session.finish({ t0: { status: 'aborted' }, t1: { status: 'pending' } });
  await done;
  ui.close();
});

test('ui interactive: Ctrl+C aborts, restores the terminal and raw mode, and resolves', async () => {
  const { stdout, stdin, session, done } = setupSession([{}]);
  stdin.send(KEY.enter);
  assert.equal(stdin.isRaw, true);
  assert.equal(stdin.flowing, true);
  stdin.send(KEY.ctrlC);
  await done;
  assert.deepEqual(session.calls[1], ['abort']);
  assert.ok(stdout.text().endsWith(LEAVE));
  assert.deepEqual(stdin.rawCalls, [true, false]);
  assert.equal(stdin.flowing, false);
  assert.equal(stdin.listenerCount('data'), 0);
});

test('ui interactive: Ctrl+C in the HUD quits too', async () => {
  const { stdout, stdin, session, done } = setupSession([{}]);
  stdin.send(KEY.ctrlC);
  await done;
  assert.deepEqual(session.calls, []);
  assert.ok(stdout.text().endsWith(LEAVE));
  assert.equal(stdin.isRaw, false);
});

test('ui interactive: autoRun runs every test, then waits in the HUD until q', async () => {
  const { stdin, ui, session, frame, done, isResolved } = setupSession([{}, {}, {}], { autoRun: true });
  assert.deepEqual(runCalls(session), [['t0', 't1', 't2']]);
  session.finish({ t1: { status: 'failed', error: new Error('nope') } });
  await wait();
  assert.equal(isResolved(), false);
  assert.match(frame(), /› ✓ test 2/);
  assert.match(frame(), /✓ 2 passed {2}✖ 1 failed/);
  stdin.send('q');
  await done;
  ui.close();
});

test('ui interactive: a resize redraws the HUD at the new size', async () => {
  const { stdout, ui, frame } = setupSession([{ title: 'a fairly long test title' }], { columns: 30 });
  await wait();
  assert.match(frame(), /─{30}/);
  const before = stdout.chunks.length;
  stdout.columns = 60;
  stdout.emit('resize');
  await wait();
  assert.equal(stdout.chunks.length - before, 1);
  assert.match(frame(), /─{60}/);
  assert.match(frame(), /a fairly long test title/);
  ui.close();
});

test('ui interactive: the summary counts each test once, by its latest result', async () => {
  const { stdout, stdin, ui, session, done } = setupSession([{}]);
  stdin.send(KEY.enter);
  ui.testStarted('test 0', {});
  ui.testFailed('test 0', 5, new Error('first try'));
  session.finish({ t0: { status: 'failed', error: new Error('first try') } });
  await wait();
  stdin.send('r');
  ui.testStarted('test 0', {});
  ui.testPassed('test 0', 5, {});
  session.finish();
  await wait();
  stdin.send('q');
  await done;
  assert.deepEqual(ui.summary(9), { passed: 1, failed: 0, skipped: 0, flaky: 0 });
  assert.doesNotMatch(strip(stdout.text().slice(stdout.text().lastIndexOf(LEAVE))), /first try/);
});
