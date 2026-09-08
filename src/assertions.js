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

function indent(text) {
  return String(text)
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

function formatExitInfo(exitInfo) {
  if (!exitInfo) return 'still running';
  const parts = [`exit code ${exitInfo.exitCode}`];
  if (exitInfo.signal) parts.push(`signal ${exitInfo.signal}`);
  return parts.join(', ');
}

/**
 * Builds the exact failure-report block a failing expect* call throws as
 * its Error.message. `actions` is the full list to render (callers are
 * responsible for including a leading launchGame(...) entry, since
 * GameDriver.actions itself only tracks press/type/expect* calls).
 */
function formatFailureReport({
  scenarioName,
  actions = [],
  failedIndex,
  expected,
  screenText,
  exitInfo,
  extraDiagnostics,
}) {
  const lastAction = actions[failedIndex] || actions[actions.length - 1];
  const lastActionLine = lastAction ? `${lastAction.type}(${lastAction.detail})` : '(none)';

  const actionLines = actions.map((action, index) => {
    const marker = index === failedIndex ? '  ← failed after this action' : '';
    return `  ${index + 1}. ${action.type}(${action.detail})${marker}`;
  });

  return [
    'E2E TEST FAILED',
    '────────────────────────────────',
    '',
    `Scenario: ${scenarioName || 'unnamed scenario'}`,
    '',
    'Last action:',
    `  ${lastActionLine}`,
    '',
    'Expected:',
    `  ${expected}`,
    '',
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

module.exports = { TimeoutError, waitUntil, waitUntilAbsent, pollUntil, formatFailureReport };
