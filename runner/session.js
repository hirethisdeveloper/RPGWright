'use strict';

const path = require('node:path');

/**
 * An interactive test session: the selected tests, each runnable on demand
 * any number of times in one process, for `rpgwright test --ui`.
 *
 *   tests     one entry per selected test, in plan order, mutated in place:
 *             { id, title, file, line, status, durationMs, error, flaky }
 *   run(ids)  runs those tests one after another (fresh fixtures each time,
 *             beforeAll/afterAll around them as runFile does); reporter
 *             events still reach `reporter`. Resolves when done; rejects only
 *             on misuse (an unknown id, a run already in progress).
 *   abort()   aborts the running test (status 'aborted'; its afterEach
 *             hooks and fixture teardown still run) and cancels the rest of
 *             the run() call. Also resumes a paused session.
 *   pause() / resume() / stepOnce() / paused
 *             the pause gate: while paused, the next game action waits;
 *             stepOnce lets exactly one action through and stays paused.
 *   results() { passed, failed, skipped, flaky } over each run test's
 *             latest result (aborted counts as failed), plus any afterAll
 *             failure from the latest run().
 *
 * `runFile(tests, reporter, control, budget)` runs one file's tests; the
 * session hands it a reporter that tracks statuses and a run `control`:
 *   gate()          the game's launch-option gate (no-op unless paused)
 *   track(deadline) registers { hold, release } so a paused test's
 *                   timeout clock stops; returns an untrack function
 *   aborted         the current run()'s abort error, once abort() is called
 *   aborting        a promise that rejects with it, to race against
 */
function createSession({ plan, testDir, reporter, maxFailures, runFile }) {
  const tests = [];
  const byId = new Map();
  for (const { file, tests: fileTests } of plan) {
    for (const t of fileTests) {
      const rel = path.relative(testDir, file);
      let id = `${rel}:${t.line} › ${t.name}`;
      for (let n = 2; byId.has(id); n += 1) id = `${rel}:${t.line} › ${t.name} #${n}`;
      const entry = { id, title: t.name, file: rel, line: t.line, status: 'pending', durationMs: null, error: null, flaky: false };
      tests.push(entry);
      byId.set(id, { entry, test: t, file });
    }
  }

  let running = false;
  let hookFailures = [];

  // The pause gate. Waiters are game actions held while paused; while any
  // are held, every tracked deadline is held too.
  let paused = false;
  let allowance = 0;
  let waiters = [];
  const deadlines = new Set();

  function releaseWaiters(count) {
    const released = waiters.splice(0, count);
    released.forEach((w) => w.resolve());
    if (released.length && waiters.length === 0) deadlines.forEach((d) => d.release());
  }

  const control = {
    aborted: null,
    aborting: null,
    reject: null,
    gate() {
      if (!paused) return undefined;
      if (allowance > 0) {
        allowance -= 1;
        return undefined;
      }
      return new Promise((resolve, reject) => {
        if (waiters.length === 0) deadlines.forEach((d) => d.hold());
        waiters.push({ resolve, reject });
      });
    },
    track(deadline) {
      deadlines.add(deadline);
      if (waiters.length) deadline.hold();
      return () => deadlines.delete(deadline);
    },
  };

  // Rejects every held action (an aborted or abandoned test's) with `error`.
  function rejectWaiters(error) {
    const rejected = waiters.splice(0);
    rejected.forEach((w) => w.reject(error));
    deadlines.forEach((d) => d.release());
  }

  // Forwards to `reporter`, keeping each entry's status current. runFile
  // reports a group's tests in order, one result each; a testFailed without
  // meta is an afterAll failure, not a test's.
  function trackingReporter(queue) {
    return {
      fileStarted: (...args) => reporter.fileStarted(...args),
      testStarted(name, meta, attempt) {
        if (queue[0]) Object.assign(queue[0], { status: 'running', error: null });
        if (reporter.testStarted) reporter.testStarted(name, meta, attempt);
      },
      testPassed(name, durationMs, attempt = {}, meta) {
        const entry = queue.shift();
        if (entry) Object.assign(entry, { status: 'passed', durationMs, error: null, flaky: attempt.retry > 0 });
        reporter.testPassed(name, durationMs, attempt, meta);
      },
      testFailed(name, durationMs, error, attempt, meta) {
        if (!meta) {
          hookFailures.push({ name, error });
        } else {
          const entry = queue.shift();
          const status = error === control.aborted ? 'aborted' : 'failed';
          if (entry) Object.assign(entry, { status, durationMs, error, flaky: false });
        }
        reporter.testFailed(name, durationMs, error, attempt, meta);
      },
      testSkipped(name, meta) {
        const entry = queue.shift();
        if (entry) Object.assign(entry, { status: 'skipped', durationMs: 0, error: null, flaky: false });
        reporter.testSkipped(name, meta);
      },
    };
  }

  async function run(ids) {
    if (running) throw new Error('session.run(): a run is already in progress.');
    const wanted = ids.map((id) => {
      if (!byId.has(id)) throw new Error(`session.run(): unknown test id ${JSON.stringify(id)}.`);
      return byId.get(id);
    });
    running = true;
    hookFailures = [];
    control.aborted = null;
    control.aborting = new Promise((_, reject) => {
      control.reject = reject;
    });
    control.aborting.catch(() => {});
    const budget = { failures: 0, max: maxFailures ?? Infinity };
    try {
      // Consecutive tests from one file run as one runFile call, so a
      // describe's beforeAll/afterAll run once around them.
      const groups = [];
      for (const item of wanted) {
        const last = groups[groups.length - 1];
        if (last && last.file === item.file) last.items.push(item);
        else groups.push({ file: item.file, items: [item] });
      }
      for (const { file, items } of groups) {
        if (control.aborted || budget.failures >= budget.max) break;
        reporter.fileStarted(path.relative(testDir, file));
        await runFile(
          items.map((item) => item.test),
          trackingReporter(items.map((item) => item.entry)),
          control,
          budget,
        );
      }
    } finally {
      // Actions still held belong to tests that are over (abandoned after a
      // timeout): fail them rather than leave them for a later resume().
      if (waiters.length) rejectWaiters(new Error('This test already finished, so its held action was cancelled.'));
      running = false;
    }
  }

  return {
    tests,
    run,
    abort() {
      if (!running || control.aborted) return;
      const error = new Error('Aborted from the UI.');
      error.name = 'AbortError';
      control.aborted = error;
      paused = false;
      allowance = 0;
      rejectWaiters(error);
      control.reject(error);
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      allowance = 0;
      releaseWaiters(waiters.length);
    },
    stepOnce() {
      paused = true;
      if (waiters.length) releaseWaiters(1);
      else allowance += 1;
    },
    get paused() {
      return paused;
    },
    results() {
      const totals = { passed: 0, failed: hookFailures.length, skipped: 0, flaky: 0 };
      for (const t of tests) {
        if (t.status === 'passed') totals.passed += 1;
        if (t.status === 'failed' || t.status === 'aborted') totals.failed += 1;
        if (t.status === 'skipped') totals.skipped += 1;
        if (t.status === 'passed' && t.flaky) totals.flaky += 1;
      }
      return totals;
    },
  };
}

module.exports = { createSession };
