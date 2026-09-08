'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnPty } = require('./pty');
const { createVirtualTerminal } = require('./terminal');
const { waitUntil, waitUntilAbsent, pollUntil, formatFailureReport } = require('./assertions');
const { KEY_SEQUENCES } = require('./keys');

const UPDATE_EVENT = 'update';

function formatNeedle(needle) {
  return needle instanceof RegExp ? needle.toString() : JSON.stringify(needle);
}

function matchesNeedle(screenText, needle) {
  return needle instanceof RegExp ? needle.test(screenText) : screenText.includes(needle);
}

function isSnapshotMatcher(matcher) {
  return Boolean(matcher) && typeof matcher === 'object' && typeof matcher.snapshot === 'string';
}

function formatScreenMatcher(matcher) {
  if (isSnapshotMatcher(matcher)) return `snapshot "${matcher.snapshot}"`;
  if (matcher instanceof RegExp) return matcher.toString();
  return `${JSON.stringify(matcher)} (exact screen match)`;
}

async function launchGame({
  command,
  args = [],
  cwd = process.cwd(),
  env = process.env,
  cols = 120,
  rows = 40,
  expectTimeout = 10000,
  killSignal = 'SIGTERM',
  killTimeout = 3000,
  getDiagnostics = null,
  scenarioName = null,
  keys = {},
  snapshotsDir = path.join(cwd, '__snapshots__'),
} = {}) {
  const keySequences = { ...KEY_SEQUENCES, ...keys };
  const ptyHandle = spawnPty({ command, args, cols, rows, cwd, env });
  const terminal = createVirtualTerminal({ cols, rows });
  const updates = new EventEmitter();
  const actions = [];
  let stopped = false;

  ptyHandle.onData((chunk) => {
    terminal.write(chunk).then(() => updates.emit(UPDATE_EVENT));
  });

  function onUpdate(listener) {
    updates.on(UPDATE_EVENT, listener);
    return { dispose: () => updates.off(UPDATE_EVENT, listener) };
  }

  function recordAction(type, detail, ok = null) {
    const record = { type, detail, ok };
    actions.push(record);
    return record;
  }

  async function buildFailureMessage(expected, failedRecord) {
    let diagnostics = null;
    if (getDiagnostics) {
      try {
        diagnostics = await getDiagnostics();
      } catch (err) {
        diagnostics = `(getDiagnostics threw: ${err.message})`;
      }
    }
    const launchEntry = { type: 'launchGame', detail: JSON.stringify({ command, args }) };
    const fullActions = [launchEntry, ...actions];
    const failedIndex = fullActions.indexOf(failedRecord);
    return formatFailureReport({
      scenarioName,
      actions: fullActions,
      failedIndex,
      expected,
      screenText: terminal.getScreenText(),
      exitInfo: ptyHandle.getExitInfo(),
      extraDiagnostics: diagnostics,
    });
  }

  async function press(key) {
    const sequence = keySequences[key];
    if (sequence === undefined) {
      throw new Error(
        `Unknown key "${key}". Use press.raw(bytes) to send a literal byte sequence, or pass it via launchGame's "keys" option to extend the table.`,
      );
    }
    ptyHandle.write(sequence);
    recordAction('press', JSON.stringify(key), true);
  }

  press.raw = async function pressRaw(bytes) {
    ptyHandle.write(bytes);
    recordAction('press', JSON.stringify(bytes), true);
  };

  async function type(text) {
    ptyHandle.write(text);
    recordAction('type', JSON.stringify(text), true);
  }

  async function expectText(needle, opts = {}) {
    const record = recordAction('expectText', formatNeedle(needle), null);
    try {
      await waitUntil(onUpdate, () => matchesNeedle(terminal.getScreenText(), needle), {
        timeout: opts.timeout ?? expectTimeout,
        exitPromise: ptyHandle.waitForExit(),
      });
      record.ok = true;
    } catch (err) {
      record.ok = false;
      throw new Error(await buildFailureMessage(formatNeedle(needle), record));
    }
  }

  async function expectNotText(needle, opts = {}) {
    const holdFor = opts.holdFor ?? 500;
    const timeout = opts.timeout ?? expectTimeout;
    const expected = `${formatNeedle(needle)} to not appear (held for ${holdFor}ms)`;
    const record = recordAction('expectNotText', formatNeedle(needle), null);

    try {
      await waitUntilAbsent(onUpdate, () => matchesNeedle(terminal.getScreenText(), needle), {
        timeout,
        holdFor,
      });
      record.ok = true;
    } catch (err) {
      record.ok = false;
      throw new Error(await buildFailureMessage(expected, record));
    }
  }

  async function expectScreen(matcher, opts = {}) {
    const record = recordAction('expectScreen', formatScreenMatcher(matcher), null);
    try {
      if (isSnapshotMatcher(matcher)) {
        await matchSnapshot(matcher.snapshot, opts);
      } else {
        const predicate =
          matcher instanceof RegExp
            ? () => matcher.test(terminal.getScreenText())
            : () => terminal.getScreenText() === matcher;
        await waitUntil(onUpdate, predicate, {
          timeout: opts.timeout ?? expectTimeout,
          exitPromise: ptyHandle.waitForExit(),
        });
      }
      record.ok = true;
    } catch (err) {
      record.ok = false;
      throw new Error(await buildFailureMessage(formatScreenMatcher(matcher), record));
    }
  }

  async function matchSnapshot(name, opts) {
    const snapshotPath = path.join(snapshotsDir, `${name}.snap`);
    const shouldRecord = opts.updateSnapshot ?? process.env.RPGWRIGHT_UPDATE_SNAPSHOTS === '1';

    if (shouldRecord || !fs.existsSync(snapshotPath)) {
      fs.mkdirSync(snapshotsDir, { recursive: true });
      fs.writeFileSync(snapshotPath, terminal.getScreenText(), 'utf8');
      return;
    }

    const expectedText = fs.readFileSync(snapshotPath, 'utf8');
    await waitUntil(onUpdate, () => terminal.getScreenText() === expectedText, {
      timeout: opts.timeout ?? expectTimeout,
      exitPromise: ptyHandle.waitForExit(),
    });
  }

  async function expectState(getState, matcher, opts = {}) {
    const record = recordAction('expectState', 'getState()', null);
    try {
      await pollUntil(async () => matcher(await getState()), {
        timeout: opts.timeout ?? expectTimeout,
        pollInterval: opts.pollInterval,
      });
      record.ok = true;
    } catch (err) {
      record.ok = false;
      throw new Error(await buildFailureMessage('state to satisfy the provided matcher', record));
    }
  }

  async function resize(cols, rows) {
    ptyHandle.resize(cols, rows);
    terminal.resize(cols, rows);
    recordAction('resize', `${cols}, ${rows}`, true);
  }

  async function stop(opts = {}) {
    if (stopped) return ptyHandle.getExitInfo();
    stopped = true;

    const timeout = opts.timeout ?? killTimeout;
    ptyHandle.kill(killSignal);

    let exitInfo = await Promise.race([
      ptyHandle.waitForExit(),
      new Promise((resolve) => setTimeout(() => resolve(null), timeout)),
    ]);

    if (!exitInfo) {
      ptyHandle.kill('SIGKILL');
      exitInfo = await ptyHandle.waitForExit();
    }

    terminal.dispose();
    return exitInfo;
  }

  function getScreenText() {
    return terminal.getScreenText();
  }

  return {
    press,
    type,
    expectText,
    expectNotText,
    expectScreen,
    expectState,
    resize,
    stop,
    getScreenText,
    actions,
  };
}

module.exports = { launchGame };
