#!/usr/bin/env node
'use strict';

const USAGE = `Usage: rpgwright <command> [options]

Commands:
  init                     Scaffold rpgwright.config.js and an example test in the current directory
  test [options] [filter...]   Run the test suite

Test options:
  --config <path>          Use this config file instead of ./rpgwright.config.js
  --grep <regex>           Only run tests whose full name matches
  --grep-invert <regex>    Skip tests whose full name matches
  --list                   List the selected tests without running them
  --reporter <names>       Override the config's reporter (list, dot, json, junit, github; comma-separate several)
  --update-snapshots       Re-record every snapshot the run touches
  --max-failures <n>       Stop after n failures
  --trace <mode>           Write an HTML trace per test: on, off, retain-on-failure
  --retries <n>            Rerun a failed test up to n times
  --fail-on-flaky          Fail the run if a test only passed on a retry
  --repeat-each <n>        Run every selected test n times
  --workers <n>            Run up to n test files at once
  --watch                  Rerun when files change

Filters: a path substring selects matching test files; "file:line" selects
the test (or describe block) declared on that line.

Run "rpgwright init" first if you don't have a rpgwright.config.js yet.`;

async function main() {
  const [, , command, ...rest] = process.argv;

  if (command === 'test') {
    // Exit (rather than die from the signal) so process 'exit' cleanup runs:
    // background services and tty: false apps don't get the terminal's
    // Ctrl+C or hangup themselves.
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
      process.once(signal, () => process.exit(code));
    }
    const { runCli } = require('../runner/run');
    await runCli(rest);
    return;
  }

  if (command === 'init') {
    const { runInit } = require('../runner/init');
    await runInit(rest);
    return;
  }

  console.log(USAGE);
  process.exitCode = command ? 1 : 0;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
