'use strict';

class TimeoutError extends Error {}

/**
 * Event-driven wait: resolves immediately if `predicate()` is already true,
 * otherwise re-checks only when `onUpdate` fires (never a setInterval poll).
 * Races against `exitPromise` so a process crash fails fast with a clear
 * reason instead of silently timing out. `onUpdate` follows the same
 * subscribe-and-dispose shape as pty.js's `onData`: it's called with a
 * listener and must return `{ dispose() }`.
 */
function waitUntil(onUpdate, predicate, { timeout = 10000, exitPromise } = {}) {
  return new Promise((resolve, reject) => {
    if (predicate()) {
      resolve();
      return;
    }

    let settled = false;
    let timer = null;
    const subscription = onUpdate(() => {
      if (!settled && predicate()) {
        settle(resolve);
      }
    });

    function cleanup() {
      clearTimeout(timer);
      subscription.dispose();
    }

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    }

    timer = setTimeout(() => {
      settle(reject, new TimeoutError(`Timed out after ${timeout}ms waiting for condition to become true`));
    }, timeout);

    if (exitPromise) {
      exitPromise.then((exitInfo) => {
        if (!settled && !predicate()) {
          settle(
            reject,
            new Error(
              `Process exited before condition became true (exit code ${exitInfo.exitCode}, signal ${exitInfo.signal || 'none'})`,
            ),
          );
        }
      });
    }
  });
}

/**
 * Resolves once `isPresent()` has been continuously false for `holdFor` ms
 * — a debounced confirmation window driven by the same `onUpdate` events
 * `waitUntil` uses, not a poll. Rejects if `isPresent()` is still true (or
 * flips true again mid-window) by the time `timeout` elapses.
 *
 * This deliberately does not fail fast just because `isPresent()` is true
 * at the moment of the call: expectNotText's most common real use is
 * "press something, confirm the text it's expected to replace is gone" —
 * and the old text is, by construction, still on screen the instant
 * press()/type() returns, since those resolve before the target process
 * has had any chance to react. Waiting it out here is what makes that
 * pattern actually work; a same-instant check would make expectNotText
 * fail on exactly the case it exists to handle.
 */
function waitUntilAbsent(onUpdate, isPresent, { timeout = 10000, holdFor = 500 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    let settled = false;
    let holdTimer = null;

    const overallTimer = setTimeout(() => {
      settle(
        reject,
        new TimeoutError(`Timed out after ${timeout}ms waiting for condition to stay absent for ${holdFor}ms`),
      );
    }, timeout);

    function cleanup() {
      clearTimeout(overallTimer);
      clearTimeout(holdTimer);
      subscription.dispose();
    }

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    }

    function reconsider() {
      if (settled) return;
      clearTimeout(holdTimer);
      if (isPresent()) return;
      const window = Math.min(holdFor, Math.max(0, deadline - Date.now()));
      holdTimer = setTimeout(() => {
        if (!isPresent()) settle(resolve);
      }, window);
    }

    const subscription = onUpdate(reconsider);
    reconsider();
  });
}

/**
 * Resolves once `onUpdate` has gone `quiet` ms without firing — "the screen
 * has stopped changing". Each update restarts the quiet window; the same
 * debounced-timer shape as waitUntilAbsent's hold window, with no predicate.
 * Rejects with TimeoutError if updates never stop for long enough before
 * `timeout` (e.g. a spinner that animates forever).
 */
function waitForQuiet(onUpdate, { quiet = 150, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let quietTimer = null;

    const overallTimer = setTimeout(() => {
      settle(reject, new TimeoutError(`Timed out after ${timeout}ms waiting for ${quiet}ms without a screen update`));
    }, timeout);

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      clearTimeout(quietTimer);
      subscription.dispose();
      fn(value);
    }

    function restart() {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => settle(resolve), quiet);
    }

    const subscription = onUpdate(restart);
    restart();
  });
}

/**
 * Polling-based wait for state RPGWright has no event source for (e.g. a
 * database read supplied via expectState's getState callback). This is the
 * one legitimate place a bounded interval sleep belongs: unlike terminal
 * screen updates, arbitrary external state has no update event to subscribe
 * to, so there is nothing for waitUntil's event-driven approach to hook
 * into.
 */
async function pollUntil(check, { timeout = 10000, pollInterval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new TimeoutError(`Timed out after ${timeout}ms waiting for condition to become true`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollInterval, remaining)));
  }
}

const NO_DIAGNOSTICS_HOOK_NOTE =
  'No diagnostics hook was configured for this launchGame() call. Note: this process ran in a real PTY, ' +
  'so stdout and stderr are already merged into one stream — see "Current screen" above for the process\'s actual output.';

function indent(text, spaces = 2) {
  const pad = ' '.repeat(spaces);
  return String(text)
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

function formatExitInfo(exitInfo) {
  if (!exitInfo) return 'still running';
  const parts = [`exit code ${exitInfo.exitCode}`];
  if (exitInfo.signal) parts.push(`signal ${exitInfo.signal}`);
  return parts.join(', ');
}

/**
 * A row-by-row diff of two screens (or any two multi-line texts): rows that
 * match are shown once, rows that differ as a "-" expected / "+" actual
 * pair followed by a caret line under the characters that changed.
 */
function formatScreenDiff(expected, actual) {
  const expectedRows = expected.split('\n');
  const actualRows = actual.split('\n');
  const lines = [];
  for (let i = 0; i < Math.max(expectedRows.length, actualRows.length); i += 1) {
    const want = expectedRows[i];
    const got = actualRows[i];
    if (want === got) {
      lines.push(`  ${want}`);
      continue;
    }
    if (want !== undefined) lines.push(`- ${want}`);
    if (got !== undefined) lines.push(`+ ${got}`);
    if (want !== undefined && got !== undefined) {
      const a = [...want];
      const b = [...got];
      let carets = '';
      for (let c = 0; c < Math.max(a.length, b.length); c += 1) carets += a[c] === b[c] ? ' ' : '^';
      lines.push(`  ${carets.replace(/\s+$/, '')}`);
    }
  }
  return lines.join('\n');
}

// A diff of two line lists where order carries no meaning (style spans):
// lines only in `expected` as "-", lines only in `actual` as "+".
function formatLineSetDiff(expected, actual) {
  const a = expected ? expected.split('\n') : [];
  const b = actual ? actual.split('\n') : [];
  const inB = new Set(b);
  const inA = new Set(a);
  return [...a.filter((l) => !inB.has(l)).map((l) => `- ${l}`), ...b.filter((l) => !inA.has(l)).map((l) => `+ ${l}`)].join('\n');
}

/**
 * Builds the exact failure-report block a failing expect* call throws as
 * its Error.message. `actions` is the full list to render (callers are
 * responsible for including a leading launchGame(...) entry, since
 * GameDriver.actions itself only tracks press/type/expect* calls).
 */
function formatFailureReport({
  scenarioName,
  viewport,
  actions = [],
  failedIndex,
  expected,
  screenText,
  exitInfo,
  extraDiagnostics,
  diff,
}) {
  const lastAction = actions[failedIndex] || actions[actions.length - 1];
  const lastActionLine = lastAction ? `${lastAction.type}(${lastAction.detail})` : '(none)';

  const actionLines = actions.map((action, index) => {
    const marker = index === failedIndex ? '  ← failed after this action' : '';
    const nesting = '  '.repeat(action.depth || 0);
    return `  ${nesting}${index + 1}. ${action.type}(${action.detail})${marker}`;
  });

  return [
    'E2E TEST FAILED',
    '────────────────────────────────',
    '',
    `Scenario: ${scenarioName || 'unnamed scenario'}`,
    ...(viewport ? [`Viewport: ${viewport.cols}x${viewport.rows}`] : []),
    '',
    'Last action:',
    `  ${lastActionLine}`,
    '',
    'Expected:',
    indent(expected),
    '',
    ...(diff ? ['Diff (- expected, + actual):', indent(diff), ''] : []),
    'Current screen:',
    indent(screenText),
    '',
    'PTY exit code:',
    `  ${formatExitInfo(exitInfo)}`,
    '',
    'Diagnostics:',
    indent(extraDiagnostics || NO_DIAGNOSTICS_HOOK_NOTE),
    '',
    'Actions:',
    ...actionLines,
  ].join('\n');
}

// How a text needle (a substring, or a RegExp) is shown in reports, and
// whether it matches: the one implementation every assertion shares.
function formatNeedle(needle) {
  return needle instanceof RegExp ? needle.toString() : JSON.stringify(needle);
}

function matchesNeedle(screenText, needle) {
  if (needle instanceof RegExp) {
    // Reset lastIndex before every check: a needle constructed with the
    // 'g' or 'y' flag otherwise carries match position across repeated
    // calls (waitUntil/waitUntilAbsent re-check the same needle on every
    // screen update), making "does this appear right now" depend on how
    // many times it's already been checked rather than the current screen.
    needle.lastIndex = 0;
    return needle.test(screenText);
  }
  return screenText.includes(needle);
}

module.exports = { TimeoutError, formatNeedle, matchesNeedle, waitUntil, waitUntilAbsent, waitForQuiet, pollUntil, formatFailureReport, formatScreenDiff, formatLineSetDiff, indent };
