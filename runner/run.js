'use strict';

const path = require('node:path');
const { loadConfig } = require('./config');
const { discoverTestFiles } = require('./discover');
const { createReporter } = require('./reporter');
const testModule = require('./test');
const { launchGame } = require('../src/game');

function parseArgs(args) {
  const opts = { configPath: null };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--config') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--config requires a path, e.g. --config ./rpgwright.config.js');
      }
      opts.configPath = value;
      i += 1;
    }
  }
  return opts;
}

function runWithTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Test exceeded its ${timeoutMs}ms timeout.`)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Discovers and runs every test file matching the resolved config, printing
 * results as it goes via the reporter. Each test gets its own freshly
 * launched GameDriver (the `game` fixture), auto-stopped in a finally block
 * regardless of pass/fail — this is the runner's whole reason to exist over
 * hand-rolled launch/try/finally-stop boilerplate per test file.
 */
async function runTests({ cwd = process.cwd(), configPath } = {}) {
  const config = loadConfig({ configPath, cwd });
  const files = discoverTestFiles({ testDir: config.testDir, testMatch: config.testMatch });
  const reporter = createReporter();
  const start = Date.now();

  if (files.length === 0) {
    console.log(`No test files matched ${JSON.stringify(config.testMatch)} under ${config.testDir}`);
  }

  for (const file of files) {
    reporter.fileStarted(path.relative(config.testDir, file));
    testModule._beginFile();
    delete require.cache[require.resolve(file)];
    require(file);
    const tests = testModule._collect();

    for (const t of tests) {
      if (t.skip) {
        reporter.testSkipped(t.name);
        continue;
      }

      const testStart = Date.now();
      let game = null;
      try {
        game = await launchGame({ ...config, scenarioName: t.name });
        await runWithTimeout(t.fn({ game }), config.timeout);
        reporter.testPassed(t.name, Date.now() - testStart);
      } catch (err) {
        reporter.testFailed(t.name, Date.now() - testStart, err);
      } finally {
        if (game) {
          await game.stop().catch(() => {});
        }
      }
    }
  }

  return reporter.summary(Date.now() - start);
}

async function runCli(args) {
  const { configPath } = parseArgs(args);
  const totals = await runTests({ configPath });
  process.exitCode = totals.failed > 0 ? 1 : 0;
}

module.exports = { runTests, runCli };
