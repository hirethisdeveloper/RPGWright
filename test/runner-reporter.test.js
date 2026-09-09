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

test('reporter: summary() returns accurate pass/fail/skip counts', () => {
  const reporter = createReporter();
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

test('reporter: prints a checkmark line for a pass and includes the test name', () => {
  const reporter = createReporter();
  const lines = captureLogs(() => reporter.testPassed('reaches menu', 42));
  assert.ok(lines.some((line) => line.includes('reaches menu') && line.includes('✓')));
});

test('reporter: prints the failing test\'s full error message in the summary', () => {
  const reporter = createReporter();
  const lines = captureLogs(() => {
    reporter.testFailed('broken test', 5, new Error('E2E TEST FAILED\n details here'));
    reporter.summary(5);
  });
  assert.ok(lines.some((line) => line.includes('details here')));
});

test('reporter: a fully passing run produces no failure entries', () => {
  const reporter = createReporter();
  const lines = captureLogs(() => {
    reporter.testPassed('ok', 1);
    reporter.summary(1);
  });
  assert.ok(!lines.some((line) => line.includes('✖')));
});
