'use strict';

const path = require('node:path');

const FIXTURE_MINIMAL = path.join(__dirname, '..', 'fixtures', 'minimal-ink-app', 'cli.js');

/**
 * Resolves once `predicate(accumulatedOutput)` is true. Subscribes
 * synchronously (inside the Promise executor) so callers can safely trigger
 * the action that produces the awaited output right after calling this,
 * without a race against the subscription itself.
 */
function waitForData(ptyHandle, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error(`Timed out after ${timeout}ms waiting for PTY output. Buffer so far:\n${buf}`));
    }, timeout);
    const sub = ptyHandle.onData((chunk) => {
      buf += chunk;
      if (predicate(buf)) {
        clearTimeout(timer);
        sub.dispose();
        resolve(buf);
      }
    });
  });
}

module.exports = { FIXTURE_MINIMAL, waitForData };
