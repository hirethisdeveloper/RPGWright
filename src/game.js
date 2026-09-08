'use strict';

const { EventEmitter } = require('node:events');
const { spawnPty } = require('./pty');
const { createVirtualTerminal } = require('./terminal');
const { waitUntil, formatFailureReport } = require('./assertions');
const { KEY_SEQUENCES } = require('./keys');

const UPDATE_EVENT = 'update';

function formatNeedle(needle) {
  return needle instanceof RegExp ? needle.toString() : JSON.stringify(needle);
}

function matchesNeedle(screenText, needle) {
  return needle instanceof RegExp ? needle.test(screenText) : screenText.includes(needle);
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
    stop,
    getScreenText,
    actions,
  };
}

module.exports = { launchGame };
