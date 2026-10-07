'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUiReporter, clipGrid, ENTER, LEAVE } = require('../runner/ui');

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
