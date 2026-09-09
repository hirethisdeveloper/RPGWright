'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReporter } = require('../runner/reporter');

function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

function captureStdoutWrites(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    chunks.push(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

test('createReporter: defaults to the list style', () => {
  const reporter = createReporter();
  const lines = captureLogs(() => reporter.testPassed('reaches menu', 42));
  assert.ok(lines.some((line) => line.includes('reaches menu') && line.includes('✓')));
});

test('createReporter: throws a clear error for an unknown style', () => {
  assert.throws(() => createReporter('bogus'), /Unknown reporter "bogus"/);
});

test('list reporter: summary() returns accurate pass/fail/skip counts', () => {
  const reporter = createReporter('list');
  let summary;
  captureLogs(() => {
    reporter.testPassed('a', 10);
    reporter.testPassed('b', 20);
    reporter.testFailed('c', 30, new Error('boom'));
    reporter.testSkipped('d');
    summary = reporter.summary(60);
  });
  assert.deepEqual(summary, { passed: 2, failed: 1, skipped: 1 });
});

test('list reporter: prints a checkmark line for a pass and includes the test name', () => {
  const reporter = createReporter('list');
  const lines = captureLogs(() => reporter.testPassed('reaches menu', 42));
  assert.ok(lines.some((line) => line.includes('reaches menu') && line.includes('✓')));
});

test('list reporter: prints the failing test\'s full error message in the summary', () => {
  const reporter = createReporter('list');
  const lines = captureLogs(() => {
    reporter.testFailed('broken test', 5, new Error('E2E TEST FAILED\n details here'));
    reporter.summary(5);
  });
  assert.ok(lines.some((line) => line.includes('details here')));
});

test('list reporter: a fully passing run produces no failure entries', () => {
  const reporter = createReporter('list');
  const lines = captureLogs(() => {
    reporter.testPassed('ok', 1);
    reporter.summary(1);
  });
  assert.ok(!lines.some((line) => line.includes('✖')));
});

test('dot reporter: summary() returns accurate pass/fail/skip counts, same contract as list', () => {
  const reporter = createReporter('dot');
  let summary;
  captureStdoutWrites(() => {
    captureLogs(() => {
      reporter.testPassed('a', 10);
      reporter.testPassed('b', 20);
      reporter.testFailed('c', 30, new Error('boom'));
      reporter.testSkipped('d');
      summary = reporter.summary(60);
    });
  });
  assert.deepEqual(summary, { passed: 2, failed: 1, skipped: 1 });
});

test('dot reporter: writes one compact character per test instead of a line', () => {
  const reporter = createReporter('dot');
  const written = captureStdoutWrites(() => {
    reporter.testPassed('a', 1);
    reporter.testPassed('b', 1);
    reporter.testFailed('c', 1, new Error('boom'));
    reporter.testSkipped('d');
  });
  assert.equal(written.replace(/\x1b\[[0-9]*m/g, ''), '..F-');
});

test('dot reporter: still prints the failing test\'s full error message in the summary', () => {
  const reporter = createReporter('dot');
  let lines;
  captureStdoutWrites(() => {
    lines = captureLogs(() => {
      reporter.testFailed('broken test', 5, new Error('E2E TEST FAILED\n details here'));
      reporter.summary(5);
    });
  });
  assert.ok(lines.some((line) => line.includes('details here')));
});
