'use strict';

const { launchGame } = require('./game');
const { spawnPty, spawnPipe } = require('./pty');
const { createVirtualTerminal } = require('./terminal');
const { KEY_SEQUENCES, resolveKey, encodeMouse } = require('./keys');
const { renderScreenHtml } = require('./render');

module.exports = {
  launchGame,
  spawnPty,
  spawnPipe,
  createVirtualTerminal,
  KEY_SEQUENCES,
  resolveKey,
  encodeMouse,
  renderScreenHtml,
};
