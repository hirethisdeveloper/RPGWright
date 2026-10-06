'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const snapshotsDir = path.join(os.tmpdir(), 'rpgwright-dogfood-term-probe-snapshots');
fs.rmSync(snapshotsDir, { recursive: true, force: true });

const PROBE = path.join(__dirname, '..', '..', '..', 'fixtures', 'term-probe', 'cli.js');

// Defaults to the probe's echo mode; individual describe blocks switch modes
// with test.use({ args: [PROBE, '<mode>'] }).
module.exports = {
  command: process.execPath,
  args: [PROBE, 'echo'],
  cols: 60,
  rows: 12,
  expectTimeout: 3000,
  snapshotsDir,
  PROBE,
};
