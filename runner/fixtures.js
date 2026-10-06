'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchGame } = require('../src/game');

const BUILTIN_FIXTURES = ['game', 'viewport', 'launch', 'tmpHome', 'testInfo'];

// Splits `text` on `separator` characters that aren't nested inside
// brackets, braces, parentheses or quotes.
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if ('([{'.includes(ch)) {
      depth += 1;
    } else if (')]}'.includes(ch)) {
      depth -= 1;
    } else if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * The fixture names a test, hook or fixture function destructures from its
 * first parameter, read from its source the way Playwright Test does:
 * `async ({ game, tmpHome }) => ...` -> ['game', 'tmpHome']. Returns null
 * when that can't be determined (a non-destructured or rest parameter), in
 * which case every fixture is provided.
 */
function requestedFixtures(fn) {
  const source = Function.prototype.toString.call(fn).replace(/^async\s*/, '');
  let params;
  if (source.startsWith('(') || /^function\b/.test(source) || /^[\w$]+\s*\(/.test(source)) {
    const open = source.indexOf('(');
    let depth = 0;
    let close = open;
    for (; close < source.length; close += 1) {
      if (source[close] === '(') depth += 1;
      if (source[close] === ')' && --depth === 0) break;
    }
    params = source.slice(open + 1, close);
  } else {
    // A bare single-parameter arrow (`fixtures => ...`): not destructured.
    return source.startsWith('=>') ? [] : null;
  }

  const first = splitTopLevel(params, ',')[0].trim();
  if (first === '') return [];
  if (!first.startsWith('{')) return null;
  const pattern = first.slice(1, first.lastIndexOf('}'));
  const names = [];
  for (const part of splitTopLevel(pattern, ',')) {
    const entry = part.trim();
    if (entry === '') continue;
    if (entry.startsWith('...')) return null;
    names.push(splitTopLevel(splitTopLevel(entry, '=')[0], ':')[0].trim());
  }
  return names;
}

/**
 * The fixtures for one test run: built-ins plus the test's own definitions
 * (from test.extend). Values are created on first request, each at most
 * once per test, dependencies first; teardown() undoes them in reverse.
 *
 * A definition is either a plain value or
 * `async ({ ...deps }, use, testInfo) => { setup; await use(value); cleanup }`.
 */
function createFixtureScope({ defs = {}, launchOptions, testInfo, onGame }) {
  const values = new Map();
  const pending = new Map();
  const teardowns = [];
  // Everything the run asked for, known before anything is created, so the
  // game can tell whether to launch with an isolated HOME regardless of the
  // order in which fixtures were destructured.
  const requested = new Set();

  function resolveAll(names) {
    const wanted = names === null ? [...BUILTIN_FIXTURES, ...Object.keys(defs)] : names;
    wanted.forEach((name) => requested.add(name));
    return Promise.all(wanted.map((name) => resolve(name, []))).then(() => {
      const out = {};
      for (const name of wanted) out[name] = values.get(name);
      return out;
    });
  }

  function resolve(name, chain) {
    if (values.has(name)) return Promise.resolve(values.get(name));
    if (chain.includes(name)) throw new Error(`Fixture cycle: ${[...chain, name].join(' -> ')}.`);
    if (!pending.has(name)) {
      const created = create(name, [...chain, name]).then((value) => {
        values.set(name, value);
        return value;
      });
      pending.set(name, created);
    }
    return pending.get(name);
  }

  async function homeDir() {
    // A homeFiles option implies an isolated HOME, seeded before launch.
    const wantsHome = launchOptions.homeFiles || requested.has('tmpHome') || pending.has('tmpHome');
    return wantsHome ? resolve('tmpHome', []) : null;
  }

  async function launch(options) {
    const home = await homeDir();
    const env = { ...(options.env || process.env), ...(home ? { HOME: home } : {}) };
    const game = await launchGame({ ...options, env });
    teardowns.push(() => game.stop().catch(() => {}));
    return game;
  }

  async function create(name, chain) {
    if (name in defs) return createUserFixture(name, defs[name], chain);
    switch (name) {
      case 'tmpHome': {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpgwright-home-'));
        teardowns.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        for (const [file, content] of Object.entries(launchOptions.homeFiles || {})) {
          fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
          fs.writeFileSync(path.join(dir, file), content);
        }
        return dir;
      }
      case 'game': {
        const game = await launch(launchOptions);
        if (onGame) onGame(game);
        return game;
      }
      case 'viewport': {
        if (testInfo.viewport) return testInfo.viewport;
        const size = (await resolve('game', chain)).getSize();
        return { name: `${size.cols}x${size.rows}`, ...size };
      }
      case 'launch':
        // Extra processes for this test (a second client, a server), each
        // stopped when the test ends.
        return (options = {}) => launch({ ...launchOptions, ...options });
      case 'testInfo':
        return testInfo;
      default:
        throw new Error(`Unknown fixture "${name}". Built-in fixtures: ${BUILTIN_FIXTURES.join(', ')}; define others with test.extend().`);
    }
  }

  async function createUserFixture(name, def, chain) {
    if (typeof def !== 'function') return def;
    const deps = {};
    for (const dep of requestedFixtures(def) || []) deps[dep] = await resolve(dep, chain);

    let provide;
    const provided = new Promise((r) => {
      provide = r;
    });
    let release;
    const released = new Promise((r) => {
      release = r;
    });
    const run = Promise.resolve().then(() =>
      def(deps, async (value) => {
        provide({ value });
        await released;
      }, testInfo),
    );
    const result = await Promise.race([
      provided,
      run.then(() => {
        throw new Error(`Fixture "${name}" finished without calling use(value).`);
      }),
    ]);
    teardowns.push(async () => {
      release();
      await run;
    });
    return result.value;
  }

  async function teardown() {
    let firstError = null;
    while (teardowns.length) {
      try {
        await teardowns.pop()();
      } catch (err) {
        if (!firstError) firstError = err;
      }
    }
    if (firstError) throw firstError;
  }

  return { resolveAll, teardown, get: (name) => values.get(name) };
}

module.exports = { BUILTIN_FIXTURES, requestedFixtures, splitTopLevel, createFixtureScope };
