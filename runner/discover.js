'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ALWAYS_SKIPPED_DIRS = new Set(['node_modules', '.git', '__snapshots__']);

/**
 * Minimal glob-to-RegExp conversion covering what testMatch patterns
 * actually need: a double-star segment (any depth, including none), a
 * single star (any run of non-separator characters), '?' (one
 * non-separator character), and literal segments. Not a general-purpose
 * minimatch — RPGWright has no dependency on one, and testMatch's default
 * (double-star slash star dot rpg dot test dot js) plus simple variants
 * are all this needs to handle correctly.
 */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (ALWAYS_SKIPPED_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), onFile);
    } else if (entry.isFile()) {
      onFile(path.join(dir, entry.name));
    }
  }
}

/**
 * Discovers test files under `testDir` matching any of `testMatch`
 * (a glob string or array of globs, matched against the path relative to
 * `testDir`). Returns absolute paths, sorted for deterministic run order.
 */
function discoverTestFiles({ testDir, testMatch }) {
  const patterns = (Array.isArray(testMatch) ? testMatch : [testMatch]).map(globToRegExp);
  const matches = [];

  if (fs.existsSync(testDir)) {
    walk(testDir, (filePath) => {
      const relative = path.relative(testDir, filePath).split(path.sep).join('/');
      if (patterns.some((re) => re.test(relative))) {
        matches.push(filePath);
      }
    });
  }

  return matches.sort();
}

module.exports = { discoverTestFiles, globToRegExp };
