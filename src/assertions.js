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

module.exports = { TimeoutError, waitUntil, formatFailureReport };
