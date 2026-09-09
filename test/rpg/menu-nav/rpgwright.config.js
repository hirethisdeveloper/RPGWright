'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const stateFile = require('./state-path');

const snapshotsDir = path.join(os.tmpdir(), 'rpgwright-dogfood-menu-nav-snapshots');
// Reset once per `rpgwright test` invocation (this file is require()'d once
// per run, not per-test) so the "records on first run" test behaves the
// same way on every run, rather than only the very first one ever.
fs.rmSync(snapshotsDir, { recursive: true, force: true });

module.exports = {
  command: process.execPath,
  args: [path.join(__dirname, '..', '..', '..', 'fixtures', 'menu-nav-ink-app', 'cli.js')],
  cols: 40,
  rows: 12,
  env: { ...process.env, STATE_FILE: stateFile },
  snapshotsDir,
};
