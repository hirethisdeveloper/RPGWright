'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONFIG_FILENAME = 'rpgwright.config.js';
const DEFAULT_TEST_MATCH = ['**/*.rpg.test.js', '**/*.rpg.test.ts'];
const DEFAULT_TEST_TIMEOUT = 30000;
const DEFAULT_REPORTER = 'list';
const DEFAULT_TRACE = 'off';
const TRACE_MODES = ['off', 'on', 'retain-on-failure'];

// Validates `viewports` and fills in each one's name ("80x24" by default).
function normalizeViewports(viewports, resolvedPath) {
  if (viewports === undefined) return undefined;
  if (!Array.isArray(viewports) || viewports.length === 0) {
    throw new Error(`${resolvedPath}: "viewports" must be a non-empty array of { cols, rows }.`);
  }
  return viewports.map((vp, index) => {
    const valid = vp && Number.isInteger(vp.cols) && vp.cols > 0 && Number.isInteger(vp.rows) && vp.rows > 0;
    if (!valid) {
      throw new Error(`${resolvedPath}: viewports[${index}] must have positive integer "cols" and "rows", got ${JSON.stringify(vp)}.`);
    }
    return { name: vp.name || `${vp.cols}x${vp.rows}`, cols: vp.cols, rows: vp.rows };
  });
}

// A timeout in ms, 0 meaning none. Anything else (a string like '30s')
// would become a NaN deadline that fires at once and fails every test.
function validateTimeout(ms, where) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    throw new Error(`${where}: "timeout" must be a non-negative number of milliseconds (0 for none), got ${JSON.stringify(ms)}.`);
  }
  return ms;
}

function validateRetries(retries, resolvedPath) {
  if (!Number.isInteger(retries) || retries < 0) {
    throw new Error(`${resolvedPath}: "retries" must be a non-negative integer, got ${JSON.stringify(retries)}.`);
  }
  return retries;
}

// Validates `services` and resolves each one's cwd against the config's
// directory (where relative commands and paths are written from).
function normalizeServices(services, configDir, resolvedPath) {
  if (services === undefined) return [];
  if (!Array.isArray(services)) throw new Error(`${resolvedPath}: "services" must be an array.`);
  return services.map((service, index) => {
    if (!service || typeof service.command !== 'string') {
      throw new Error(`${resolvedPath}: services[${index}] must have a "command".`);
    }
    return { ...service, cwd: path.resolve(configDir, service.cwd || '.') };
  });
}

function validateWorkers(workers, resolvedPath) {
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error(`${resolvedPath}: "workers" must be a positive integer, got ${JSON.stringify(workers)}.`);
  }
  return workers;
}

function validateTrace(mode, resolvedPath) {
  if (!TRACE_MODES.includes(mode)) {
    throw new Error(`${resolvedPath}: "trace" must be one of ${TRACE_MODES.join(', ')}, got ${JSON.stringify(mode)}.`);
  }
  return mode;
}

/**
 * Locates and loads rpgwright.config.js, then validates and defaults the
 * runner-level fields (testDir, testMatch, timeout, reporter, viewports,
 * trace, retries, workers, services, globalSetup/globalTeardown,
 * outputDir). Deliberately does NOT default
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
    timeout: validateTimeout(userConfig.timeout ?? DEFAULT_TEST_TIMEOUT, resolvedPath),
    reporter: userConfig.reporter || DEFAULT_REPORTER,
    viewports: normalizeViewports(userConfig.viewports, resolvedPath),
    trace: validateTrace(userConfig.trace ?? DEFAULT_TRACE, resolvedPath),
    retries: validateRetries(userConfig.retries ?? 0, resolvedPath),
    workers: validateWorkers(userConfig.workers ?? 1, resolvedPath),
    services: normalizeServices(userConfig.services, path.dirname(resolvedPath), resolvedPath),
    globalSetup: userConfig.globalSetup && path.resolve(path.dirname(resolvedPath), userConfig.globalSetup),
    globalTeardown: userConfig.globalTeardown && path.resolve(path.dirname(resolvedPath), userConfig.globalTeardown),
    outputDir: path.resolve(path.dirname(resolvedPath), userConfig.outputDir || 'test-results'),
  };
}

module.exports = {
  loadConfig,
  validateTrace,
  validateTimeout,
  DEFAULT_CONFIG_FILENAME,
  DEFAULT_TEST_MATCH,
  DEFAULT_TEST_TIMEOUT,
  DEFAULT_REPORTER,
};
