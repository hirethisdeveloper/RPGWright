'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { waitUntil, formatFailureReport, TimeoutError } = require('../src/assertions');

function makeEmitter() {
  const ee = new EventEmitter();
  return {
    onUpdate(listener) {
      ee.on('update', listener);
      return { dispose: () => ee.off('update', listener) };
    },
    fire() {
      ee.emit('update');
    },
  };
}

test('waitUntil: resolves immediately if the predicate is already true', async () => {
  const { onUpdate } = makeEmitter();
  await waitUntil(onUpdate, () => true, { timeout: 1000 });
});

test('waitUntil: resolves once the predicate becomes true on a later update', async () => {
  const { onUpdate, fire } = makeEmitter();
  let ready = false;
  setTimeout(() => {
    ready = true;
    fire();
  }, 20);
  await waitUntil(onUpdate, () => ready, { timeout: 1000 });
});

test('waitUntil: re-checks on every update and ignores ones where the predicate is still false', async () => {
  const { onUpdate, fire } = makeEmitter();
  let calls = 0;
  const predicate = () => {
    calls += 1;
    return calls > 3;
  };
  setTimeout(() => {
    fire();
    fire();
    fire();
    fire();
  }, 10);
  await waitUntil(onUpdate, predicate, { timeout: 1000 });
  assert.ok(calls >= 4, `expected the predicate to be re-checked on updates, got ${calls} calls`);
});

test('waitUntil: rejects with TimeoutError when the predicate never becomes true', async () => {
  const { onUpdate } = makeEmitter();
  await assert.rejects(waitUntil(onUpdate, () => false, { timeout: 50 }), TimeoutError);
});

test('waitUntil: rejects when exitPromise settles before the predicate becomes true', async () => {
  const { onUpdate } = makeEmitter();
  const exitPromise = Promise.resolve({ exitCode: 1, signal: null });
  await assert.rejects(
    waitUntil(onUpdate, () => false, { timeout: 1000, exitPromise }),
    /Process exited before condition became true/,
  );
});

test('waitUntil: does not reject on exit if the predicate is already true by then', async () => {
  const { onUpdate } = makeEmitter();
  const exitPromise = Promise.resolve({ exitCode: 0, signal: null });
  await waitUntil(onUpdate, () => true, { timeout: 1000, exitPromise });
});

test('waitUntil: disposes its subscription once settled, leaving no dangling listener', async () => {
  const ee = new EventEmitter();
  const onUpdate = (listener) => {
    ee.on('update', listener);
    return { dispose: () => ee.off('update', listener) };
  };
  await waitUntil(onUpdate, () => true, { timeout: 1000 });
  assert.equal(ee.listenerCount('update'), 0);
});

test('formatFailureReport: renders the full §9 block with the failed action marked', () => {
  const actions = [
    { type: 'launchGame', detail: '{"command":"node"}' },
    { type: 'expectText', detail: '"Main Menu"' },
    { type: 'press', detail: '"ENTER"' },
    { type: 'expectText', detail: '"Settings"' },
  ];
  const report = formatFailureReport({
    scenarioName: 'reaches settings',
    actions,
    failedIndex: 3,
    expected: '"Settings"',
    screenText: 'MAIN MENU\n1. Play\n2. Settings',
    exitInfo: null,
    extraDiagnostics: null,
  });

  assert.match(report, /^E2E TEST FAILED/);
  assert.match(report, /Scenario: reaches settings/);
  assert.match(report, /Last action:\n {2}expectText\("Settings"\)/);
  assert.match(report, /Expected:\n {2}"Settings"/);
  assert.match(report, /Current screen:\n {2}MAIN MENU\n {2}1\. Play\n {2}2\. Settings/);
  assert.match(report, /PTY exit code:\n {2}still running/);
  assert.match(report, /No diagnostics hook was configured/);
  assert.match(report, /1\. launchGame\(\{"command":"node"\}\)/);
  assert.match(report, /4\. expectText\("Settings"\) {2}← failed after this action/);
});

test('formatFailureReport: falls back to "unnamed scenario" when none is given', () => {
  const report = formatFailureReport({ actions: [], failedIndex: -1, expected: 'x', screenText: '', exitInfo: null });
  assert.match(report, /Scenario: unnamed scenario/);
});

test('formatFailureReport: formats a real exit code/signal instead of "still running"', () => {
  const report = formatFailureReport({
    actions: [],
    failedIndex: -1,
    expected: 'x',
    screenText: '',
    exitInfo: { exitCode: 1, signal: null },
  });
  assert.match(report, /PTY exit code:\n {2}exit code 1/);
});

test('formatFailureReport: uses the provided diagnostics text instead of the no-hook note', () => {
  const report = formatFailureReport({
    actions: [],
    failedIndex: -1,
    expected: 'x',
    screenText: '',
    exitInfo: null,
    extraDiagnostics: 'custom diagnostics text',
  });
  assert.match(report, /Diagnostics:\n {2}custom diagnostics text/);
});
