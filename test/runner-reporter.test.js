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
  assert.deepEqual(summary, { passed: 2, failed: 1, skipped: 1, flaky: 0 });
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
  assert.deepEqual(summary, { passed: 2, failed: 1, skipped: 1, flaky: 0 });
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

test('list reporter: a pass after retries is counted as passed and flaky, and labeled', () => {
  const reporter = createReporter('list');
  const lines = captureLogs(() => {
    reporter.testPassed('steady', 5, { retry: 0 });
    reporter.testPassed('wobbly', 5, { retry: 2 });
    reporter.testFailed('broken', 5, new Error('boom'), { retry: 2 });
  });
  assert.match(lines[1], /wobbly .*flaky: passed on retry 2/);
  assert.match(lines[2], /broken .*after 2 retries/);
  let summary;
  captureLogs(() => {
    summary = reporter.summary(10);
  });
  assert.deepEqual(summary, { passed: 2, failed: 1, skipped: 0, flaky: 1 });
});

test('dot reporter: a flaky pass is a ±', () => {
  const reporter = createReporter('dot');
  const out = captureStdoutWrites(() => {
    reporter.testPassed('a', 1, { retry: 1 });
    reporter.testPassed('b', 1);
  });
  assert.equal(out.replace(/\x1b\[[0-9]*m/g, ''), '±.');
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function quietly(fn) {
  return captureLogs(fn);
}

test('createReporter: accepts a list of names and [name, options]; unknown names in a list fail too', () => {
  assert.throws(() => createReporter(['list', 'nope']), /Unknown reporter "nope"\. Supported: list, dot, json, junit, github\./);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-rep-'));
  const reporter = createReporter(['list', ['json', { outputFile: 'out.json' }]], { cwd: dir, outputDir: dir });
  const lines = quietly(() => {
    reporter.fileStarted('a.rpg.test.js');
    reporter.testPassed('one', 3, { retry: 0 }, { file: '/x/a.rpg.test.js', line: 2 });
  });
  assert.match(lines.join('\n'), /✓ one/, 'events reach the console reporter');
  let totals;
  quietly(() => {
    totals = reporter.summary(10);
  });
  assert.deepEqual(totals, { passed: 1, failed: 0, skipped: 0, flaky: 0 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'out.json'), 'utf8')).tests[0].name, 'one', 'and the json reporter');
});

test('json reporter: stats plus one entry per test, flaky and retries included, at outputDir/results.json by default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-rep-'));
  const reporter = createReporter('json', { outputDir: dir, cwd: dir });
  quietly(() => {
    reporter.fileStarted('a.rpg.test.js');
    reporter.testPassed('wobbly', 5, { retry: 1 }, { line: 4 });
    reporter.testFailed('bad', 6, new Error('nope'), { retry: 0 }, { line: 9 });
    reporter.summary(20);
  });
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8'));
  assert.deepEqual(report.stats, { passed: 1, failed: 1, skipped: 0, flaky: 1, durationMs: 20 });
  assert.deepEqual(report.tests, [
    { name: 'wobbly', file: 'a.rpg.test.js', line: 4, status: 'passed', flaky: true, retry: 1, durationMs: 5 },
    { name: 'bad', file: 'a.rpg.test.js', line: 9, status: 'failed', retry: 0, durationMs: 6, error: 'nope' },
  ]);
});

test('junit reporter: one testsuite per file, escaped names and messages, control characters dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-rep-'));
  const reporter = createReporter('junit', { outputDir: dir, cwd: dir });
  quietly(() => {
    reporter.fileStarted('a.rpg.test.js');
    reporter.testPassed('a & b', 1500, {});
    reporter.fileStarted('b.rpg.test.js');
    reporter.testFailed('<c>', 10, new Error('first "line"\n\x1b[31msecond\x1b[0m'), {});
    reporter.testSkipped('d');
    reporter.summary(2000);
  });
  const xml = fs.readFileSync(path.join(dir, 'results.xml'), 'utf8');
  assert.match(xml, /<testsuites name="rpgwright" tests="3" failures="1" skipped="1" time="2\.000">/);
  assert.match(xml, /<testsuite name="a.rpg.test.js" tests="1" failures="0" skipped="0" time="1\.500">\n    <testcase name="a &amp; b" classname="a.rpg.test.js" time="1\.500"><\/testcase>/);
  assert.match(xml, /<testcase name="&lt;c&gt;" classname="b.rpg.test.js" time="0\.010"><failure message="first &quot;line&quot;">first &quot;line&quot;\n\[31msecond\[0m<\/failure><\/testcase>/);
  assert.match(xml, /<testcase name="d" classname="b.rpg.test.js" time="0\.000"><skipped\/><\/testcase>/);
});

test('github reporter: ::error for failures and ::warning for flaky passes, escaped, located relative to cwd', () => {
  const reporter = createReporter('github', { cwd: '/repo' });
  const lines = quietly(() => {
    reporter.testPassed('fine', 1, { retry: 0 }, { file: '/repo/e2e/a.rpg.test.js', line: 3 });
    reporter.testPassed('wobbly', 1, { retry: 2 }, { file: '/repo/e2e/a.rpg.test.js', line: 5 });
    reporter.testFailed('a: b, c', 1, new Error('50% done\nthen failed'), {}, { file: '/repo/e2e/a.rpg.test.js', line: 7 });
    reporter.testFailed('afterAll', 1, new Error('x'), {});
  });
  assert.deepEqual(lines, [
    '::warning file=e2e/a.rpg.test.js,line=5,title=Flaky%3A wobbly::Passed on retry 2.',
    '::error file=e2e/a.rpg.test.js,line=7,title=a%3A b%2C c::50%25 done%0Athen failed',
    '::error title=afterAll::x',
  ]);
});
