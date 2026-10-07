'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVirtualTerminal } = require('../src/terminal');
const { shouldWriteTrace, slugify, artifactPath, tracePath, buildTraceHtml, buildCast, writeTrace } = require('../runner/trace');

async function fakeTrace() {
  const term = createVirtualTerminal({ cols: 10, rows: 2 });
  await term.write('MENU');
  const screen = term.getScreenCells();
  term.dispose();
  return {
    command: 'node',
    args: ['app.js'],
    actions: [
      { type: 'step', detail: '"open"', ok: false, depth: 0, t: 0, screen, cursor: { x: 4, y: 0, visible: false } },
      { type: 'press', detail: '"Enter"', ok: true, depth: 1, t: 5, screen, cursor: null },
      { type: 'expectText', detail: '"SETTINGS"', ok: false, depth: 1, t: 6 },
    ],
    frames: [{ seq: 1, t: 1, text: 'MENU' }],
    final: { grid: screen, cursor: null },
  };
}

test('shouldWriteTrace: "on" always, "retain-on-failure" only on failure, "off" never', () => {
  assert.equal(shouldWriteTrace('on', false), true);
  assert.equal(shouldWriteTrace('retain-on-failure', false), false);
  assert.equal(shouldWriteTrace('retain-on-failure', true), true);
  assert.equal(shouldWriteTrace('off', true), false);
});

test('slugify / tracePath: a stable, filesystem-safe name per file and test', () => {
  assert.equal(slugify('Menu > opens Settings [80x24]'), 'menu-opens-settings-80x24');
  assert.equal(slugify('!!!'), 'test');
  assert.equal(tracePath('/out', '/x/menu.rpg.test.js', 'opens'), path.join('/out', 'menu-rpg-test--opens.trace.html'));
  // Every per-test file shares the naming, differing only in extension.
  assert.equal(artifactPath('/out', '/x/menu.rpg.test.js', 'opens', {}, '.run.json'), path.join('/out', 'menu-rpg-test--opens.run.json'));
});

test('tracePath: names stay unique within a run: the path under testDir, .ts stripped, and numbered collisions', () => {
  const naming = { testDir: '/x', taken: new Set() };
  assert.equal(tracePath('/out', '/x/a/menu.rpg.test.js', 'opens', naming), path.join('/out', 'a-menu-rpg-test--opens.trace.html'));
  assert.equal(tracePath('/out', '/x/b/menu.rpg.test.ts', 'opens', naming), path.join('/out', 'b-menu-rpg-test--opens.trace.html'));
  // A retry whose "(retry 1)" falls past the slug's cap would otherwise
  // overwrite the first attempt's trace.
  const long = 'x'.repeat(90);
  assert.equal(tracePath('/out', '/x/m.rpg.test.js', long, naming), path.join('/out', `m-rpg-test--${'x'.repeat(80)}.trace.html`));
  assert.equal(tracePath('/out', '/x/m.rpg.test.js', `${long} (retry 1)`, naming), path.join('/out', `m-rpg-test--${'x'.repeat(80)}-2.trace.html`));
});

test('buildTraceHtml: outcome, escaped failure report, nested actions with screens, the failed ones open', async () => {
  const html = buildTraceHtml({
    testName: 'opens <settings>',
    file: '/x/menu.rpg.test.js',
    passed: false,
    durationMs: 42,
    error: new Error('E2E TEST FAILED\nExpected: <thing>'),
    trace: await fakeTrace(),
  });
  assert.match(html, /<title>opens &lt;settings&gt; \(failed\)<\/title>/);
  assert.match(html, /<span class="badge failed">failed<\/span> menu\.rpg\.test\.js · 42ms · <code>node app\.js<\/code>/);
  assert.match(html, /<pre class="report">E2E TEST FAILED\nExpected: &lt;thing&gt;<\/pre>/);
  assert.match(html, /<details class="step failed" style="margin-left:0px" open>/);
  assert.match(html, /<details class="step ok" style="margin-left:20px">/);
  assert.match(html, /\(no screen captured\)/);
  assert.match(html, /1 screen update retained/);
  assert.equal((html.match(/rpgw-screen">MENU/g) || []).length, 3, 'two action screens and the final screen');
});

test('buildTraceHtml: a passing run has no failure section', async () => {
  const html = buildTraceHtml({ testName: 't', file: 'a.js', passed: true, durationMs: 1, error: null, trace: await fakeTrace() });
  assert.match(html, /badge passed/);
  assert.doesNotMatch(html, /<h2>Failure<\/h2>/);
});

test('writeTrace: creates the output directory and returns the written paths; no recording, no .cast', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-trace-')), 'nested');
  const written = writeTrace(dir, { testName: 't', file: 'a.rpg.test.js', passed: true, durationMs: 1, error: null, trace: await fakeTrace() });
  assert.deepEqual(written, { trace: path.join(dir, 'a-rpg-test--t.trace.html'), cast: null });
  assert.match(fs.readFileSync(written.trace, 'utf8'), /^<!doctype html>/);
});

test('buildCast / writeTrace: an asciinema v2 header line, then one [seconds, type, data] line per event', async () => {
  const recording = { cols: 40, rows: 10, startedAt: 1700000000500, events: [[0.0123456789, 'o', 'hi\r\n'], [0.5, 'i', 'q'], [0.75, 'r', '80x24']] };
  const lines = buildCast(recording, { title: 'demo' }).trimEnd().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], { version: 2, width: 40, height: 10, timestamp: 1700000000, title: 'demo' });
  assert.deepEqual(lines.slice(1), [[0.012346, 'o', 'hi\r\n'], [0.5, 'i', 'q'], [0.75, 'r', '80x24']]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-cast-'));
  const written = writeTrace(dir, { testName: 't', file: 'a.rpg.test.js', passed: true, durationMs: 1, error: null, trace: { ...(await fakeTrace()), recording } });
  assert.equal(written.cast, path.join(dir, 'a-rpg-test--t.cast'));
  assert.equal(fs.readFileSync(written.cast, 'utf8'), buildCast(recording, { title: 't' }));
});
