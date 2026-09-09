'use strict';

const { indent } = require('../src/assertions');

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const GREEN = useColor ? '\x1b[32m' : '';
const RED = useColor ? '\x1b[31m' : '';
const DIM = useColor ? '\x1b[2m' : '';
const RESET = useColor ? '\x1b[0m' : '';

/**
 * A single Playwright-style list reporter: a running pass/fail/skip line
 * per test, then every failure's full §9 block, then a one-line summary.
 * Not a pluggable reporter registry — additional styles (dot, json, ...)
 * are a natural future extension of this same shape.
 */
function createReporter() {
  const failures = [];
  let passedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;

  return {
    fileStarted(relativePath) {
      console.log(`${DIM}${relativePath}${RESET}`);
    },
    testPassed(name, durationMs) {
      passedCount += 1;
      console.log(`  ${GREEN}✓${RESET} ${name} ${DIM}(${durationMs}ms)${RESET}`);
    },
    testFailed(name, durationMs, error) {
      failedCount += 1;
      failures.push({ name, error });
      console.log(`  ${RED}✖${RESET} ${name} ${DIM}(${durationMs}ms)${RESET}`);
    },
    testSkipped(name) {
      skippedCount += 1;
      console.log(`  ${DIM}- ${name} (skipped)${RESET}`);
    },
    summary(durationMs) {
      console.log('');
      for (const [index, failure] of failures.entries()) {
        console.log(`${RED}${index + 1}) ${failure.name}${RESET}`);
        console.log(indent(failure.error.message, 4));
        console.log('');
      }

      const parts = [];
      if (passedCount) parts.push(`${GREEN}${passedCount} passed${RESET}`);
      if (failedCount) parts.push(`${RED}${failedCount} failed${RESET}`);
      if (skippedCount) parts.push(`${DIM}${skippedCount} skipped${RESET}`);
      console.log(`${parts.join(', ') || '0 tests'} ${DIM}(${durationMs}ms)${RESET}`);

      return { passed: passedCount, failed: failedCount, skipped: skippedCount };
    },
  };
}

module.exports = { createReporter };
