#!/usr/bin/env node
'use strict';

const USAGE = `Usage: rpgwright <command> [options]

Commands:
  init               Scaffold rpgwright.config.js and an example test in the current directory
  test [--config <path>]   Run the test suite

Run "rpgwright init" first if you don't have a rpgwright.config.js yet.`;

async function main() {
  const [, , command, ...rest] = process.argv;

  if (command === 'test') {
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
