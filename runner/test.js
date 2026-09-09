'use strict';

const { expect } = require('./expect');

// Set by run.js before require()-ing each test file, and read back after —
// registration (this module) and execution (run.js) are deliberately
// separate: test files run synchronously top-to-bottom to populate this
// registry, then run.js executes what was collected, launching/stopping a
// GameDriver around each one.
let suite = null;

function _beginFile() {
  suite = { describePath: [], tests: [] };
}

function _collect() {
  const collected = suite ? suite.tests : [];
  suite = null;
  return collected;
}

function assertInSuite(fnName) {
  if (!suite) {
    throw new Error(`${fnName}() was called outside of a running test file — run test files through "rpgwright test", not directly with node.`);
  }
}

function fullName(name) {
  return suite.describePath.concat(name).join(' > ');
}

function test(name, fn) {
  assertInSuite('test');
  suite.tests.push({ name: fullName(name), fn, skip: false });
}

test.skip = function skip(name, fn) {
  assertInSuite('test.skip');
  suite.tests.push({ name: fullName(name), fn, skip: true });
};

function describe(name, fn) {
  assertInSuite('describe');
  suite.describePath.push(name);
  try {
    fn();
  } finally {
    suite.describePath.pop();
  }
}

module.exports = { test, describe, expect, _beginFile, _collect };
