'use strict';

const { indent } = require('../src/assertions');

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const GREEN = useColor ? '\x1b[32m' : '';
const RED = useColor ? '\x1b[31m' : '';
const DIM = useColor ? '\x1b[2m' : '';
const RESET = useColor ? '\x1b[0m' : '';

function createState() {
  return { failures: [], passedCount: 0, failedCount: 0, skippedCount: 0 };
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
  if (state.failedCount) parts.push(`${RED}${state.failedCount} failed${RESET}`);
  if (state.skippedCount) parts.push(`${DIM}${state.skippedCount} skipped${RESET}`);
  console.log(`${parts.join(', ') || '0 tests'} ${DIM}(${durationMs}ms)${RESET}`);

  return { passed: state.passedCount, failed: state.failedCount, skipped: state.skippedCount };
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
    testPassed(name, durationMs) {
      state.passedCount += 1;
      console.log(`  ${GREEN}✓${RESET} ${name} ${DIM}(${durationMs}ms)${RESET}`);
    },
    testFailed(name, durationMs, error) {
      state.failedCount += 1;
      state.failures.push({ name, error });
      console.log(`  ${RED}✖${RESET} ${name} ${DIM}(${durationMs}ms)${RESET}`);
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
 * Mocha-style compact progress: one character per test, no per-file
 * grouping, all on a single running line until the summary breaks it.
 */
function createDotReporter() {
  const state = createState();
  return {
    fileStarted() {},
    testPassed(name, durationMs) {
      state.passedCount += 1;
      process.stdout.write(`${GREEN}.${RESET}`);
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

const REPORTERS = { list: createListReporter, dot: createDotReporter };

function createReporter(style = 'list') {
  const factory = REPORTERS[style];
  if (!factory) {
    throw new Error(`Unknown reporter "${style}". Supported: ${Object.keys(REPORTERS).join(', ')}.`);
  }
  return factory();
}

module.exports = { createReporter };
