'use strict';

const path = require('node:path');

module.exports = {
  command: process.execPath,
  args: [path.join(__dirname, '..', '..', '..', 'fixtures', 'minimal-ink-app', 'cli.js')],
  cols: 40,
  rows: 10,
};
