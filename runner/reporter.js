'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { indent } = require('../src/assertions');

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const GREEN = useColor ? '\x1b[32m' : '';
const RED = useColor ? '\x1b[31m' : '';
const YELLOW = useColor ? '\x1b[33m' : '';
const DIM = useColor ? '\x1b[2m' : '';
const RESET = useColor ? '\x1b[0m' : '';

function createState() {
  return { failures: [], passedCount: 0, failedCount: 0, skippedCount: 0, flakyCount: 0 };
}

// Shared by every reporter style: the failure-block dump and final summary
// line are identical regardless of how per-test progress was printed.
function printSummary(state, durationMs) {
  console.log('');
  for (const [index, failure] of state.failures.entries()) {
    console.log(`${RED}${index + 1}) ${failure.name}${RESET}`);
    console.log(indent(failure.error.message, 4));
    console.log('');
  }

  const parts = [];
  if (state.passedCount) parts.push(`${GREEN}${state.passedCount} passed${RESET}`);
  if (state.flakyCount) parts.push(`${YELLOW}${state.flakyCount} flaky${RESET}`);
  if (state.failedCount) parts.push(`${RED}${state.failedCount} failed${RESET}`);
  if (state.skippedCount) parts.push(`${DIM}${state.skippedCount} skipped${RESET}`);
  console.log(`${parts.join(', ') || '0 tests'} ${DIM}(${durationMs}ms)${RESET}`);

  return { passed: state.passedCount, failed: state.failedCount, skipped: state.skippedCount, flaky: state.flakyCount };
}

// Shared bookkeeping for a pass: a pass after one or more retries is
// flaky, and still counts as passed.
function recordPass(state, attempt = {}) {
  state.passedCount += 1;
  const flaky = attempt.retry > 0;
  if (flaky) state.flakyCount += 1;
  return flaky;
}

function retryNote(attempt = {}) {
  if (!attempt.retry) return '';
  return `, after ${attempt.retry} retr${attempt.retry === 1 ? 'y' : 'ies'}`;
}

/**
 * A running pass/fail/skip line per test, grouped under each file.
 */
function createListReporter() {
  const state = createState();
  return {
    fileStarted(relativePath) {
      console.log(`${DIM}${relativePath}${RESET}`);
    },
    testPassed(name, durationMs, attempt) {
      if (recordPass(state, attempt)) {
        console.log(`  ${YELLOW}✓${RESET} ${name} ${YELLOW}(flaky: passed on retry ${attempt.retry})${RESET} ${DIM}(${durationMs}ms)${RESET}`);
      } else {
        console.log(`  ${GREEN}✓${RESET} ${name} ${DIM}(${durationMs}ms)${RESET}`);
      }
    },
    testFailed(name, durationMs, error, attempt) {
      state.failedCount += 1;
      state.failures.push({ name, error });
      console.log(`  ${RED}✖${RESET} ${name} ${DIM}(${durationMs}ms${retryNote(attempt)})${RESET}`);
    },
    testSkipped(name) {
      state.skippedCount += 1;
      console.log(`  ${DIM}- ${name} (skipped)${RESET}`);
    },
    summary(durationMs) {
      return printSummary(state, durationMs);
    },
  };
}

/**
 * Mocha-style compact progress: one character per test (. pass, ± flaky,
 * F fail, - skip), no per-file grouping, all on a single running line
 * until the summary breaks it.
 */
function createDotReporter() {
  const state = createState();
  return {
    fileStarted() {},
    testPassed(name, durationMs, attempt) {
      process.stdout.write(recordPass(state, attempt) ? `${YELLOW}±${RESET}` : `${GREEN}.${RESET}`);
    },
    testFailed(name, durationMs, error) {
      state.failedCount += 1;
      state.failures.push({ name, error });
      process.stdout.write(`${RED}F${RESET}`);
    },
    testSkipped(name) {
      state.skippedCount += 1;
      process.stdout.write(`${DIM}-${RESET}`);
    },
    summary(durationMs) {
      return printSummary(state, durationMs);
    },
  };
}

// Every reporter receives the same events. `attempt` is { retry }; `meta`
// is { file, line } for the test (absent for afterAll failures).
//   fileStarted(relativePath)
//   testPassed(name, durationMs, attempt, meta)
//   testFailed(name, durationMs, error, attempt, meta)
//   testSkipped(name, meta)
//   summary(durationMs) -> { passed, failed, skipped, flaky }

/**
 * Collects every result for the machine-readable reporters, which write
 * their output once, at summary time.
 */
function createCollector() {
  const state = createState();
  const results = [];
  let currentFile = null;
  return {
    state,
    results,
    fileStarted(relativePath) {
      currentFile = relativePath;
    },
    testPassed(name, durationMs, attempt = {}, meta = {}) {
      const flaky = recordPass(state, attempt);
      results.push({ name, file: currentFile, line: meta.line ?? null, status: 'passed', flaky, retry: attempt.retry || 0, durationMs });
    },
    testFailed(name, durationMs, error, attempt = {}, meta = {}) {
      state.failedCount += 1;
      results.push({ name, file: currentFile, line: meta.line ?? null, status: 'failed', retry: attempt.retry || 0, durationMs, error: error.message });
    },
    testSkipped(name, meta = {}) {
      state.skippedCount += 1;
      results.push({ name, file: currentFile, line: meta.line ?? null, status: 'skipped', durationMs: 0 });
    },
    totals() {
      return { passed: state.passedCount, failed: state.failedCount, skipped: state.skippedCount, flaky: state.flakyCount };
    },
  };
}

function writeReport(outputFile, content, label) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, content, 'utf8');
  console.log(`${label} report written to ${outputFile}`);
}

/**
 * Every result as JSON: { stats, tests: [{ name, file, line, status,
 * flaky?, retry, durationMs, error? }] }, written to `outputFile`.
 */
function createJsonReporter({ outputFile }) {
  const collector = createCollector();
  return {
    ...collector,
    summary(durationMs) {
      const stats = { ...collector.totals(), durationMs };
      writeReport(outputFile, `${JSON.stringify({ stats, tests: collector.results }, null, 2)}\n`, 'JSON');
      return collector.totals();
    },
  };
}

// XML 1.0 can't contain most control characters at all, escaped or not;
// ANSI escapes (ESC) in a failure message are one of them.
function xml(text) {
  return String(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

/**
 * JUnit XML, the format most CI systems read: one <testsuite> per test
 * file, one <testcase> per test, written to `outputFile`.
 */
function createJunitReporter({ outputFile }) {
  const collector = createCollector();
  return {
    ...collector,
    summary(durationMs) {
      const byFile = new Map();
      for (const r of collector.results) {
        if (!byFile.has(r.file)) byFile.set(r.file, []);
        byFile.get(r.file).push(r);
      }
      const seconds = (ms) => (ms / 1000).toFixed(3);
      const suites = [...byFile].map(([file, results]) => {
        const cases = results.map((r) => {
          let body = '';
          if (r.status === 'failed') body = `<failure message="${xml(r.error.split('\n')[0])}">${xml(r.error)}</failure>`;
          if (r.status === 'skipped') body = '<skipped/>';
          return `    <testcase name="${xml(r.name)}" classname="${xml(file)}" time="${seconds(r.durationMs)}">${body}</testcase>`;
        });
        const count = (status) => results.filter((r) => r.status === status).length;
        const time = seconds(results.reduce((sum, r) => sum + r.durationMs, 0));
        return `  <testsuite name="${xml(file)}" tests="${results.length}" failures="${count('failed')}" skipped="${count('skipped')}" time="${time}">\n${cases.join('\n')}\n  </testsuite>`;
      });
      const t = collector.totals();
      const total = t.passed + t.failed + t.skipped;
      writeReport(
        outputFile,
        `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="rpgwright" tests="${total}" failures="${t.failed}" skipped="${t.skipped}" time="${seconds(durationMs)}">\n${suites.join('\n')}\n</testsuites>\n`,
        'JUnit',
      );
      return t;
    },
  };
}

// GitHub Actions workflow-command escaping for a property and a message.
function ghProperty(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function ghMessage(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * GitHub Actions annotations: each failure (and flaky pass) becomes an
 * ::error / ::warning line that GitHub shows on the test's source line.
 * Prints nothing else, so pair it with a console reporter.
 */
function createGithubReporter({ cwd }) {
  const collector = createCollector();
  const location = (meta = {}) => {
    if (!meta.file) return '';
    const parts = [`file=${ghProperty(path.relative(cwd, meta.file))}`];
    if (meta.line) parts.push(`line=${meta.line}`);
    return `${parts.join(',')},`;
  };
  return {
    ...collector,
    testPassed(name, durationMs, attempt = {}, meta = {}) {
      collector.testPassed(name, durationMs, attempt, meta);
      if (attempt.retry > 0) console.log(`::warning ${location(meta)}title=${ghProperty(`Flaky: ${name}`)}::${ghMessage(`Passed on retry ${attempt.retry}.`)}`);
    },
    testFailed(name, durationMs, error, attempt = {}, meta = {}) {
      collector.testFailed(name, durationMs, error, attempt, meta);
      console.log(`::error ${location(meta)}title=${ghProperty(name)}::${ghMessage(error.message)}`);
    },
    summary() {
      return collector.totals();
    },
  };
}

const REPORTERS = {
  list: createListReporter,
  dot: createDotReporter,
  json: createJsonReporter,
  junit: createJunitReporter,
  github: createGithubReporter,
};

const DEFAULT_OUTPUT_FILES = { json: 'results.json', junit: 'results.xml' };

/**
 * `spec` is a reporter name, or a list of names and [name, options] pairs:
 *   'list'   or   ['list', ['junit', { outputFile: 'junit.xml' }]]
 * json and junit write to `outputFile` (default results.json/results.xml
 * in outputDir). With several reporters, every event goes to each, and the
 * first one's totals are returned.
 */
function createReporter(spec = 'list', { outputDir = path.resolve('test-results'), cwd = process.cwd() } = {}) {
  const entries = (Array.isArray(spec) ? spec : [spec]).map((entry) => (Array.isArray(entry) ? entry : [entry, {}]));
  const reporters = entries.map(([name, options = {}]) => {
    const factory = REPORTERS[name];
    if (!factory) {
      throw new Error(`Unknown reporter "${name}". Supported: ${Object.keys(REPORTERS).join(', ')}.`);
    }
    const outputFile = options.outputFile
      ? path.resolve(cwd, options.outputFile)
      : DEFAULT_OUTPUT_FILES[name] && path.join(outputDir, DEFAULT_OUTPUT_FILES[name]);
    return factory({ ...options, outputFile, cwd });
  });
  if (reporters.length === 1) return reporters[0];

  const forward = (method) => (...args) => {
    let result;
    reporters.forEach((r, i) => {
      const value = r[method](...args);
      if (i === 0) result = value;
    });
    return result;
  };
  return Object.fromEntries(['fileStarted', 'testPassed', 'testFailed', 'testSkipped', 'summary'].map((m) => [m, forward(m)]));
}

module.exports = { createReporter, REPORTERS };
