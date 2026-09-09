'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG_FILENAME = 'rpgwright.config.js';
const DEFAULT_TEST_MATCH = ['**/*.rpg.test.js'];
const DEFAULT_TEST_TIMEOUT = 30000;
const DEFAULT_REPORTER = 'list';

/**
 * Locates and loads rpgwright.config.js, then layers on runner-level
 * defaults (testDir/testMatch/timeout). Deliberately does NOT default
 * launchGame-specific fields (command, cols, killSignal, ...) here —
 * those stay whatever the config file says (undefined if omitted), and
 * launchGame's own defaults apply when a GameDriver is actually launched.
 * Duplicating those defaults here would be a second source of truth for
 * the same values already owned by src/game.js.
 */
function loadConfig({ configPath, cwd = process.cwd() } = {}) {
  const resolvedPath = configPath
    ? path.resolve(cwd, configPath)
    : path.join(cwd, DEFAULT_CONFIG_FILENAME);

  if (!fs.existsSync(resolvedPath)) {
    if (configPath) {
      throw new Error(`Config file not found at "${resolvedPath}".`);
    }
    throw new Error(
      `No ${DEFAULT_CONFIG_FILENAME} found in ${cwd}.\n` +
        `Run "npx rpgwright init" to scaffold one, or pass --config <path> to point at an existing config file.`,
    );
  }

  delete require.cache[require.resolve(resolvedPath)];
  const userConfig = require(resolvedPath);

  if (!userConfig.command) {
    throw new Error(`${resolvedPath} must export a "command" (the executable to launch for each test).`);
  }

  const testDir = userConfig.testDir ? path.resolve(path.dirname(resolvedPath), userConfig.testDir) : path.dirname(resolvedPath);

  return {
    ...userConfig,
    configPath: resolvedPath,
    testDir,
    testMatch: userConfig.testMatch || DEFAULT_TEST_MATCH,
    timeout: userConfig.timeout ?? DEFAULT_TEST_TIMEOUT,
    reporter: userConfig.reporter || DEFAULT_REPORTER,
  };
}

module.exports = { loadConfig, DEFAULT_CONFIG_FILENAME, DEFAULT_TEST_MATCH, DEFAULT_TEST_TIMEOUT, DEFAULT_REPORTER };
