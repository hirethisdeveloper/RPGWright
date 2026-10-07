'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVirtualTerminal } = require('../src/terminal');
const { buildRunFile, writeRunFile, readRunFile, RUN_FILE_VERSION } = require('../runner/runfile');
const { version } = require('../package.json');

// What game.getTrace() returns for a recorded session: action `t` in ms
// since launch, recording events in seconds since the same launch.
async function fakeTrace({ record = true } = {}) {
  const term = createVirtualTerminal({ cols: 10, rows: 2 });
  await term.write('MENU');
  const grid = term.getScreenCells();
  term.dispose();
  return {
    command: 'node',
    args: ['app.js'],
    actions: [
      { type: 'press', detail: '"Enter"', ok: true, depth: 0, t: 250, frame: 1, bells: 0, screen: grid, cursor: null },
      { type: 'resize', detail: '20, 4', ok: true, depth: 1, t: 1500, frame: 2 },
    ],
    frames: [],
    final: { grid, cursor: null },
    exitInfo: null,
    recording: record
      ? { cols: 10, rows: 2, startedAt: 1700000000000, events: [[0.1, 'o', 'MENU'], [0.25, 'i', '\r'], [1.5, 'r', '20x4']] }
      : null,
  };
}

function details(traces, extra = {}) {
  return {
    title: 'menu > opens',
    file: '/proj/tests/menu.rpg.test.js',
    line: 7,
    testDir: '/proj',
    status: 'passed',
    durationMs: 1234,
    error: null,
    traces,
    recordedAt: '2026-01-02T03:04:05.000Z',
    ...extra,
  };
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-runfile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('buildRunFile: the header, test, result and one session per trace, in order', async () => {
  const run = buildRunFile(details([await fakeTrace(), await fakeTrace()]));
  assert.deepEqual(Object.keys(run), ['format', 'version', 'rpgwright', 'recordedAt', 'test', 'result', 'sessions']);
  assert.equal(run.format, 'rpgwright-run');
  assert.equal(run.version, RUN_FILE_VERSION);
  assert.equal(run.version, 1);
  assert.equal(run.rpgwright, version);
  assert.equal(run.recordedAt, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(run.test, { title: 'menu > opens', file: path.join('tests', 'menu.rpg.test.js'), line: 7 });
  assert.deepEqual(run.result, { status: 'passed', durationMs: 1234, error: null });
  assert.equal(run.sessions.length, 2);
  const [session] = run.sessions;
  assert.deepEqual(Object.keys(session), ['command', 'args', 'cols', 'rows', 'events', 'actions']);
  assert.deepEqual([session.command, session.args, session.cols, session.rows], ['node', ['app.js'], 10, 2]);
  assert.deepEqual(session.events, [[0.1, 'o', 'MENU'], [0.25, 'i', '\r'], [1.5, 'r', '20x4']]);
});

test('buildRunFile: action times move from ms to seconds on the events\' clock, and drop their screens', async () => {
  const [session] = buildRunFile(details([await fakeTrace()])).sessions;
  assert.deepEqual(session.actions, [
    { type: 'press', detail: '"Enter"', ok: true, depth: 0, t: 0.25 },
    { type: 'resize', detail: '20, 4', ok: true, depth: 1, t: 1.5 },
  ]);
  // The press and its input event, the resize and its 'r' event, line up.
  assert.equal(session.actions[0].t, session.events[1][0]);
  assert.equal(session.actions[1].t, session.events[2][0]);
});

test('buildRunFile: a failure keeps its first line and the whole report, without ANSI; file falls back to the basename', async () => {
  const error = new Error('E2E TEST FAILED\n\x1b[31mExpected:\x1b[0m\n  "x"\x1b]8;;http://a\x07link\x1b]8;;\x07');
  const run = buildRunFile(details([await fakeTrace()], { status: 'failed', error, testDir: undefined }));
  assert.deepEqual(run.result.error, { message: 'E2E TEST FAILED', report: 'E2E TEST FAILED\nExpected:\n  "x"link' });
  assert.equal(run.test.file, 'menu.rpg.test.js');
});

test('buildRunFile: a session launched without recording has no events and takes its size from the final screen', async () => {
  const [session] = buildRunFile(details([await fakeTrace({ record: false })])).sessions;
  assert.deepEqual([session.cols, session.rows, session.events], [10, 2, []]);
});

test('writeRunFile / readRunFile: round-trips, named like the trace with .run.json', async (t) => {
  const dir = tempDir(t);
  const taken = new Set();
  const { recordedAt, testDir, ...rest } = details([await fakeTrace()]);
  const file = writeRunFile(dir, rest, { testDir, taken });
  assert.equal(file, path.join(dir, 'tests-menu-rpg-test--menu-opens.run.json'));
  const run = readRunFile(file);
  assert.deepEqual(run, buildRunFile({ ...rest, testDir, recordedAt: run.recordedAt }));
  assert.ok(!Number.isNaN(Date.parse(run.recordedAt)));
  // A second file for the same name in one run is numbered, not overwritten.
  assert.equal(writeRunFile(dir, rest, { testDir, taken }), path.join(dir, 'tests-menu-rpg-test--menu-opens-2.run.json'));
});

test('readRunFile: clear errors for an unreadable file, bad JSON, the wrong format and an unsupported version', (t) => {
  const dir = tempDir(t);
  const write = (name, content) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };
  assert.throws(() => readRunFile(path.join(dir, 'missing.run.json')), /Can't read run file .*missing\.run\.json: ENOENT/);
  assert.throws(() => readRunFile(write('bad.json', '{ nope')), /bad\.json is not valid JSON/);
  assert.throws(() => readRunFile(write('array.json', '[]')), /is not an RPGWright run file \(expected "format": "rpgwright-run", got no format\)/);
  assert.throws(() => readRunFile(write('other.json', { format: 'asciicast' })), /got "asciicast"/);
  assert.throws(
    () => readRunFile(write('old.json', { format: 'rpgwright-run', version: 0 })),
    /old\.json is run file version 0, but this RPGWright \(.+\) only supports version 1/,
  );
  assert.throws(() => readRunFile(write('noversion.json', { format: 'rpgwright-run' })), /version undefined, .* only supports version 1/);
});

test('readRunFile: names a missing or malformed required field', async (t) => {
  const dir = tempDir(t);
  const valid = buildRunFile(details([await fakeTrace()]));
  const check = (mutate, pattern) => {
    const run = structuredClone(valid);
    mutate(run);
    const file = path.join(dir, 'case.run.json');
    fs.writeFileSync(file, JSON.stringify(run));
    assert.throws(() => readRunFile(file), pattern);
  };
  check((r) => delete r.rpgwright, /missing the required field "rpgwright"/);
  check((r) => delete r.recordedAt, /missing the required field "recordedAt"/);
  check((r) => delete r.test, /missing the required field "test"/);
  check((r) => delete r.test.title, /missing the required field "test\.title"/);
  check((r) => (r.test.line = '7'), /"test\.line" must be a number/);
  check((r) => delete r.result.status, /missing the required field "result\.status"/);
  check((r) => (r.result.status = 'skipped'), /"result\.status" must be one of passed, failed, aborted/);
  check((r) => delete r.result.durationMs, /"result\.durationMs"/);
  check((r) => (r.result.error = { message: 'x' }), /"result\.error" must be null or \{ message, report \}/);
  check((r) => delete r.sessions, /missing the required field "sessions"/);
  check((r) => (r.sessions = [42]), /"sessions\[0\]" must be an object/);
  check((r) => delete r.sessions[0].command, /missing the required field "sessions\[0\]\.command"/);
  check((r) => (r.sessions[0].cols = 0), /"sessions\[0\]\.cols" must be a positive integer/);
  check((r) => (r.sessions[0].events = [[0, 'x', 'data']]), /"sessions\[0\]\.events" must be an array of \[seconds/);
  check((r) => (r.sessions[0].actions = [{ type: 'press' }]), /"sessions\[0\]\.actions" must be an array/);
});
