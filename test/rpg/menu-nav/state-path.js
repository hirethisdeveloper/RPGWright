'use strict';

const path = require('node:path');
const os = require('node:os');

// Shared by rpgwright.config.js (sets STATE_FILE in the launched env) and
// the test files (read it back) -- one source of truth for the path.
module.exports = path.join(os.tmpdir(), 'rpgwright-dogfood-menu-nav-state.json');
