'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { createPlayback, stepsAt, failureLines, parsePlayArgs, runPlay } = require('../runner/play');
const { LEAVE } = require('../runner/ui');

const REPO_ROOT = path.join(__dirname, '..');
const CLI = path.join(REPO_ROOT, 'bin', 'rpgwright.js');
const strip = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

// A clock driven by hand: advance(ms) fires due timers in time order, each
// with now() set to its own due time.
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = [];
  return {
    timers,
    now: () => now,
    setTimeout(fn, ms) {
      const timer = { id: nextId++, at: now + ms, fn };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout(id) {
      const index = timers.findIndex((t) => t.id === id);
      if (index !== -1) timers.splice(index, 1);
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        now = due.at;
        due.fn();
      }
      now = end;
    },
  };
}

function playbackOf(events, options = {}) {
  const clock = fakeClock();
  const applied = [];
  const ticks = [];
  let doneCalls = 0;
  const playback = createPlayback({
    events,
    clock,
    apply: (event) => applied.push([clock.now(), event[1], event[2]]),
    onTick: (position) => ticks.push(position),
    onDone: () => (doneCalls += 1),
    ...options,
  });
  return { clock, applied, ticks, playback, doneCalls: () => doneCalls };
}

const EVENTS = [
  [0, 'o', 'a'],
  [0.5, 'o', 'b'],
  [0.5, 'r', '10x5'],
  [1.25, 'o', 'c'],
];

// --- Scheduler ---------------------------------------------------------------

test('playback: applies each event exactly at its recorded time, in order, resizes included', () => {
  const { clock, applied, playback, doneCalls } = playbackOf(EVENTS);
  playback.start();
  assert.deepEqual(applied, [[0, 'o', 'a']], 'time-0 events apply at once');
  clock.advance(499);
  assert.equal(applied.length, 1);
  clock.advance(1);
  assert.deepEqual(applied.slice(1), [[500, 'o', 'b'], [500, 'r', '10x5']]);
  assert.equal(playback.done, false);
  clock.advance(749);
  assert.equal(applied.length, 3);
  clock.advance(1);
  assert.deepEqual(applied[3], [1250, 'o', 'c']);
  assert.equal(playback.done, true);
  assert.equal(playback.playing, false);
  assert.equal(doneCalls(), 1);
  assert.equal(playback.position, 1.25);
  assert.equal(playback.duration, 1.25);
});

test('playback: one timer at a time, aimed at the next event, none once done', () => {
  const { clock, playback } = playbackOf(EVENTS);
  assert.equal(clock.timers.length, 0, 'nothing scheduled before start');
  playback.start();
  assert.deepEqual(clock.timers.map((t) => t.at), [500]);
  clock.advance(500);
  assert.deepEqual(clock.timers.map((t) => t.at), [1250]);
  clock.advance(750);
  assert.equal(clock.timers.length, 0);
});

test('playback: position follows the clock between events and onTick reports each batch', () => {
  const { clock, ticks, playback } = playbackOf(EVENTS);
  playback.start();
  clock.advance(200);
  assert.equal(playback.position, 0.2);
  clock.advance(800);
  assert.equal(playback.position, 1);
  clock.advance(1000);
  assert.equal(playback.position, 1.25, 'never past the end');
  assert.deepEqual(ticks, [0, 0.5, 1.25]);
});

test('playback: no events finishes at once', () => {
  const { playback, doneCalls } = playbackOf([]);
  playback.start();
  assert.equal(playback.done, true);
  assert.equal(doneCalls(), 1);
  assert.equal(playback.duration, 0);
});

test('playback: speed maps recorded time to wall time', () => {
  for (const [speed, wallMs] of [[0.25, 4000], [0.5, 2000], [1, 1000], [1.5, 1000 / 1.5], [2, 500]]) {
    const { clock, applied, playback } = playbackOf([[0, 'o', 'a'], [1, 'o', 'b']], { speed });
    playback.start();
    assert.equal(playback.speed, speed);
    clock.advance(wallMs - 1);
    assert.equal(applied.length, 1, `speed ${speed}: not yet`);
    clock.advance(1);
    assert.equal(applied.length, 2, `speed ${speed}: at ${wallMs}ms`);
    assert.equal(applied[1][0], wallMs);
  }
});

test('playback: changing speed mid-playback rebases, so the position does not jump', () => {
  const { clock, applied, playback } = playbackOf([[0, 'o', 'a'], [1, 'o', 'b']]);
  playback.start();
  clock.advance(400);
  playback.setSpeed(2);
  assert.equal(playback.position, 0.4);
  clock.advance(100);
  assert.ok(Math.abs(playback.position - 0.6) < 1e-9, String(playback.position));
  // The remaining 0.6s of recording takes 300ms at 2x.
  clock.advance(199);
  assert.equal(applied.length, 1);
  clock.advance(1);
  assert.deepEqual(applied[1], [700, 'o', 'b']);
  assert.equal(clock.timers.length, 0, 'the old timer was cancelled');
  assert.throws(() => playback.setSpeed(0), /positive number/);
});

test('playback: pause freezes the position and schedules nothing; resume carries on', () => {
  const { clock, applied, playback } = playbackOf([[0, 'o', 'a'], [1, 'o', 'b']]);
  playback.start();
  clock.advance(300);
  playback.pause();
  assert.equal(playback.playing, false);
  assert.equal(clock.timers.length, 0);
  clock.advance(5000);
  assert.equal(playback.position, 0.3);
  assert.equal(applied.length, 1);
  playback.setSpeed(0.5);
  assert.equal(playback.position, 0.3, 'a speed change while paused stays put');
  playback.resume();
  clock.advance(1399);
  assert.equal(applied.length, 1);
  clock.advance(1);
  assert.deepEqual(applied[1], [6700, 'o', 'b']);
});

test('playback: stop cancels the pending timer', () => {
  const { clock, applied, playback } = playbackOf(EVENTS);
  playback.start();
  playback.stop();
  assert.equal(clock.timers.length, 0);
  clock.advance(5000);
  assert.equal(applied.length, 1);
  assert.equal(playback.done, false);
});

// --- Current step ------------------------------------------------------------

test('stepsAt: open steps and the last action as of a position, honouring depth', () => {
  const actions = [
    { type: 'step', detail: 'open menu', ok: true, depth: 0, t: 1 },
    { type: 'press', detail: '"Enter"', ok: true, depth: 1, t: 1.5 },
    { type: 'step', detail: 'inner', ok: true, depth: 1, t: 2 },
    { type: 'expectText', detail: '"Menu"', ok: false, depth: 2, t: 2.5 },
    { type: 'press', detail: '"q"', ok: true, depth: 0, t: 4 },
  ];
  const at = (position) => {
    const { steps, last } = stepsAt(actions, position);
    return [steps.map((s) => s.detail), last && last.detail];
  };
  assert.deepEqual(at(0), [[], null]);
  assert.deepEqual(at(1), [['open menu'], null]);
  assert.deepEqual(at(1.5), [['open menu'], '"Enter"']);
  assert.deepEqual(at(2.7), [['open menu', 'inner'], '"Menu"']);
  assert.deepEqual(at(4), [[], '"q"']);
  // A later sibling step replaces the one before it at the same depth.
  const siblings = [
    { type: 'step', detail: 'one', depth: 0, t: 0 },
    { type: 'step', detail: 'two', depth: 0, t: 1 },
  ];
  assert.deepEqual(stepsAt(siblings, 1).steps.map((s) => s.detail), ['two']);
});

test('failureLines: a GameDriver report shows what was expected after which action; anything else its first lines', () => {
  const report = ['E2E TEST FAILED', '────', '', 'Scenario: opens', '', 'Last action:', '  press(Enter)', '', 'Expected:', '  "Menu" on screen', '', 'Current screen:', '  blank'].join('\n');
  assert.deepEqual(failureLines({ message: 'E2E TEST FAILED', report }), ['E2E TEST FAILED', 'Expected: "Menu" on screen', 'Last action: press(Enter)']);
  assert.deepEqual(failureLines({ message: 'boom', report: 'boom\n\n  at one\n  at two\n  at three' }), ['boom', 'at one', 'at two']);
  assert.deepEqual(failureLines({ message: 'Aborted from the UI.', report: 'Aborted from the UI.' }), ['Aborted from the UI.']);
  assert.deepEqual(failureLines(null), []);
});

// --- Arguments ---------------------------------------------------------------

test('parsePlayArgs: a file and an optional 1-based --session', () => {
  assert.deepEqual(parsePlayArgs(['a.run.json']), { file: 'a.run.json', session: 1 });
  assert.deepEqual(parsePlayArgs(['--session', '2', 'a.run.json']), { file: 'a.run.json', session: 2 });
  assert.throws(() => parsePlayArgs([]), /Missing the run file to play\. Usage: rpgwright play/);
  assert.throws(() => parsePlayArgs(['a', 'b']), /Expected one run file/);
  assert.throws(() => parsePlayArgs(['a', '--speed', '2']), /Unknown option "--speed"/);
  for (const bad of [[], ['0'], ['x'], ['1.5'], ['-1']]) {
    assert.throws(() => parsePlayArgs(['a', '--session', ...bad]), /--session requires a positive integer/, bad.join());
  }
});

// --- runPlay against fakes ---------------------------------------------------

function runFile({ status = 'passed', error = null, sessions } = {}) {
  return {
    format: 'rpgwright-run',
    version: 1,
    rpgwright: '0.2.0',
    recordedAt: '2026-10-07T12:00:00.000Z',
    test: { title: 'opens the menu', file: 'menu.rpg.test.js', line: 7 },
    result: { status, durationMs: 1234, error },
    sessions: sessions || [
      {
        command: 'node',
        args: ['app.js'],
        cols: 20,
        rows: 4,
        events: [
          [0, 'o', 'Hello from the\r\nrecording'],
          [0.05, 'i', 'x'],
          [0.1, 'o', '\x1b[2J\x1b[HSecond frame'],
        ],
        actions: [
          { type: 'step', detail: 'look around', ok: true, depth: 0, t: 0 },
          { type: 'press', detail: '"x"', ok: true, depth: 1, t: 0.05 },
          { type: 'stop', ok: true, depth: 0, t: 0.1 },
        ],
      },
    ],
  };
}

function fakeTty() {
  const stdout = new EventEmitter();
  Object.assign(stdout, { columns: 60, rows: 16, isTTY: true, chunks: [] });
  stdout.write = (chunk) => stdout.chunks.push(chunk);
  stdout.frame = () => {
    const frames = stdout.chunks.filter((c) => c.includes('\x1b[?2026h'));
    return strip(frames[frames.length - 1] || '');
  };
  const stdin = new EventEmitter();
  Object.assign(stdin, { isTTY: true, isRaw: false });
  stdin.setRawMode = (on) => (stdin.isRaw = on);
  stdin.resume = () => {};
  stdin.pause = () => {};
  const proc = new EventEmitter();
  proc.pid = 1;
  proc.kill = () => {};
  const con = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  return { stdout, stdin, proc, console: con };
}

function play(run, args = ['x.run.json'], extra = {}) {
  const tty = { ...fakeTty(), ...extra };
  const clock = fakeClock();
  const done = runPlay(args, { ...tty, clock, readRunFile: () => run });
  return { ...tty, clock, done };
}

test('runPlay: replays the recorded screens with the header, footer and finish state', async () => {
  const report = 'E2E TEST FAILED\n────\n\nLast action:\n  press(x)\n\nExpected:\n  "Menu" on screen\n\nCurrent screen:\n  Second frame';
  const { stdout, stdin, clock, done } = play(runFile({ status: 'failed', error: { message: 'E2E TEST FAILED', report } }));
  await wait();
  let frame = stdout.frame();
  assert.match(frame, /RPGWright {2}REPLAY {2}menu\.rpg\.test\.js:7 › opens the menu/);
  assert.match(frame, /recorded ✖ failed in 1\.2s {3}▶ 0\.0s \/ 0\.1s/);
  assert.doesNotMatch(frame, /session/, 'no session count for a single session');
  assert.match(frame, /┌ 20×4─*┐/);
  assert.match(frame, /│Hello from the {6}│/);
  assert.match(frame, /│recording {11}│/);
  assert.match(frame, /step: look around/);
  assert.match(frame, /PLAYING {2}last: -/);

  clock.advance(50);
  await wait();
  assert.match(stdout.frame(), /PLAYING {2}last: press "x" ✓/);

  clock.advance(50);
  await wait();
  frame = stdout.frame();
  assert.match(frame, /│Second frame {8}│/);
  assert.doesNotMatch(frame, /Hello/);
  assert.match(frame, /■ 0\.1s \/ 0\.1s/);
  assert.match(frame, /FAILED {2}Playback finished/);
  assert.match(frame, /step: -/, 'an action without a detail closes the step');
  assert.match(frame, /E2E TEST FAILED +Expected: "Menu" on screen +Last action: press\(x\)/);
  assert.match(frame, /q quit/);

  assert.equal(stdin.isRaw, true);
  stdin.emit('data', Buffer.from('q'));
  await done;
  assert.ok(stdout.chunks.join('').endsWith(LEAVE));
  assert.equal(stdin.isRaw, false);
  assert.equal(stdin.listenerCount('data'), 0);
});

test('runPlay: resize events resize the replayed screen', async () => {
  const run = runFile();
  run.sessions[0].events = [
    [0, 'o', 'abc'],
    [0.2, 'r', '30x6'],
    [0.2, 'o', '\r\nafter'],
  ];
  const { stdout, stdin, clock, done } = play(run);
  await wait();
  assert.match(stdout.frame(), /┌ 20×4─*┐/);
  clock.advance(250);
  await wait();
  assert.match(stdout.frame(), /┌ 30×6─*┐/);
  assert.match(stdout.frame(), /│after {25}│/);
  stdin.emit('data', Buffer.from('\x03'));
  await done;
});

test('runPlay: --session picks a session and the header counts them', async () => {
  const run = runFile();
  run.sessions.push({ command: 'node', args: [], cols: 12, rows: 2, events: [[0, 'o', 'second app']], actions: [] });
  const { stdout, stdin, done } = play(run, ['x.run.json', '--session', '2']);
  await wait();
  assert.match(stdout.frame(), /session 2\/2/);
  assert.match(stdout.frame(), /│second app {2}│/);
  stdin.emit('data', Buffer.from('q'));
  await done;
});

test('runPlay: a session past the end, no sessions, or no terminal fail before taking over the screen', async () => {
  const run = runFile();
  await assert.rejects(play(run, ['x.run.json', '--session', '2']).done, /--session 2: x\.run\.json has only 1 session\./);
  run.sessions.push(run.sessions[0]);
  await assert.rejects(play(run, ['x.run.json', '--session', '3']).done, /--session 3: x\.run\.json has 2 sessions \(1-2\)\./);
  await assert.rejects(play(runFile({ sessions: [] })).done, /has no recorded sessions/);
  const notTty = fakeTty();
  notTty.stdout.isTTY = false;
  const attempt = play(runFile(), ['x.run.json'], { stdout: notTty.stdout });
  await assert.rejects(attempt.done, /rpgwright play needs an interactive terminal/);
  assert.equal(notTty.stdout.chunks.length, 0);
});

// --- CLI ---------------------------------------------------------------------

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 90000, ...options });
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRun(dir, run, name = 'demo.run.json') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof run === 'string' ? run : JSON.stringify(run));
  return file;
}

test('rpgwright play: clear errors, exit 1 and no stack for a bad file, a bad --session or no terminal', () => {
  const dir = tempDir('rpgwright-play-cli-');
  try {
    const good = writeRun(dir, runFile());
    const cases = [
      [['play'], /Missing the run file to play/],
      [['play', path.join(dir, 'missing.run.json')], /Can't read run file .*missing\.run\.json/],
      [['play', writeRun(dir, '{not json', 'bad.run.json')], /is not valid JSON/],
      [['play', writeRun(dir, { format: 'something-else' }, 'other.run.json')], /is not an RPGWright run file/],
      [['play', good, '--session', '0'], /--session requires a positive integer/],
      [['play', good, '--session', '2'], /has only 1 session/],
      [['play', good], /rpgwright play needs an interactive terminal/],
    ];
    for (const [args, pattern] of cases) {
      const result = runCli(args, { cwd: dir });
      assert.equal(result.status, 1, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, pattern);
      assert.doesNotMatch(result.stderr, /^\s+at /m, 'no stack trace');
      assert.doesNotMatch(result.stdout, /\x1b\[\?1049h/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Runs `rpgwright play` in a real terminal, driven by RPGWright itself.
function launchPlay(args) {
  const { launchGame } = require('../src/game');
  return launchGame({ command: process.execPath, args: [CLI, 'play', ...args], cwd: REPO_ROOT, cols: 100, rows: 30, expectTimeout: 30000 });
}

test('rpgwright play: replays a run file full-screen, finishes, and q exits 0 leaving the alternate screen', async () => {
  const dir = tempDir('rpgwright-play-e2e-');
  const file = writeRun(dir, runFile({ status: 'failed', error: { message: 'the door stayed shut', report: 'the door stayed shut' } }));
  const ui = await launchPlay([file]);
  try {
    await ui.expectTerminal('toBeInAltScreen');
    await ui.expectText('REPLAY');
    await ui.expectText('Second frame');
    await ui.expectText('Playback finished');
    await ui.expectText('the door stayed shut');
    await ui.press('q');
    await ui.expectExit({ code: 0 });
    await ui.expectTerminal('toBeInAltScreen', [], { not: true });
    await ui.expectCursorVisible(true);
  } finally {
    await ui.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rpgwright play: a run saved with --save-run plays back the app\'s final screen', async () => {
  const dir = tempDir('rpgwright-play-roundtrip-');
  const menuNav = path.join(REPO_ROOT, 'test', 'rpg', 'menu-nav');
  const config = path.join(dir, 'rpgwright.config.js');
  fs.writeFileSync(
    config,
    `module.exports = { ...require(${JSON.stringify(path.join(menuNav, 'rpgwright.config.js'))}), testDir: ${JSON.stringify(menuNav)}, outputDir: ${JSON.stringify(path.join(dir, 'out'))} };\n`,
  );
  try {
    const result = runCli(['test', '--config', config, '--save-run', '--grep', 'expectNotText fails if the text is still present'], { cwd: REPO_ROOT });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const saved = fs.readdirSync(path.join(dir, 'out')).filter((name) => name.endsWith('.run.json'));
    assert.equal(saved.length, 1, saved.join());

    const ui = await launchPlay([path.join(dir, 'out', saved[0])]);
    try {
      await ui.expectText('expectNotText fails if the text is still present');
      await ui.expectText('Playback finished');
      await ui.expectText('Sound: ON');
      await ui.press('q');
      await ui.expectExit({ code: 0 });
      await ui.expectTerminal('toBeInAltScreen', [], { not: true });
    } finally {
      await ui.stop();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
