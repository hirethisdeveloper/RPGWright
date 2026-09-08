'use strict';

const { launchGame } = require('./game');
const { spawnPty } = require('./pty');
const { createVirtualTerminal } = require('./terminal');
const { KEY_SEQUENCES } = require('./keys');

module.exports = { launchGame, spawnPty, createVirtualTerminal, KEY_SEQUENCES };
