'use strict';

/**
 * expect(...).toX() sugar over GameDriver's expect* methods — a thin
 * delegation layer, not a second assertion engine. Every matcher here
 * calls straight into the same assertions.js/waitUntil machinery
 * GameDriver's own methods already use.
 */
function expect(driver) {
  return {
    toHaveText(needle, opts) {
      return driver.expectText(needle, opts);
    },
    toMatchScreen(matcher, opts) {
      return driver.expectScreen(matcher, opts);
    },
    toMatchScreenSnapshot(name, opts) {
      return driver.expectScreen({ snapshot: name }, opts);
    },
    toHaveState(getState, matcher, opts) {
      return driver.expectState(getState, matcher, opts);
    },
    not: {
      toHaveText(needle, opts) {
        return driver.expectNotText(needle, opts);
      },
    },
  };
}

module.exports = { expect };
