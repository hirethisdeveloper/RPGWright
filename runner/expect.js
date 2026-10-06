'use strict';

/**
 * expect(...).toX() sugar over GameDriver's expect* methods — a thin
 * delegation layer, not a second assertion engine. Every matcher here
 * calls straight into the same assertions.js/waitUntil machinery
 * GameDriver's own methods already use.
 *
 * expect(game) gets the screen-level matchers; expect(game.locator(...))
 * gets the region-level ones, which all go through GameDriver.expectLayout
 * (the checks themselves live in src/layout.js).
 */

// Locator matcher name -> how its arguments split into layout-check args
// and the options object that may carry { timeout }.
const LAYOUT_MATCHERS = {
  toHaveBox: (box, opts) => [[box, opts], opts],
  toBeWithinScreen: (opts) => [[], opts],
  toBeWithin: (other, opts) => [[other], opts],
  toOverlap: (other, opts) => [[other], opts],
  toBeLeftOf: (other, opts) => [[other], opts],
  toBeRightOf: (other, opts) => [[other], opts],
  toBeAbove: (other, opts) => [[other], opts],
  toBeBelow: (other, opts) => [[other], opts],
  toHaveGap: (other, opts) => [[other, opts], opts],
  toBeAligned: (edge, opts) => [[edge, opts], opts],
  toFitWithoutClipping: (opts) => [[], opts],
  toHaveText: (needle, opts) => [[needle], opts],
  toHaveStyle: (style, opts) => [[style], opts],
  toBeFocused: (opts) => [[focusIndicators(opts)], opts],
};

// The focus indicators given in an assertion's options, if any; otherwise
// undefined, so launchGame's `focus` option (or the default) applies.
function focusIndicators(opts = {}) {
  const given = ['marker', 'style', 'cursor'].filter((k) => opts[k] !== undefined);
  return given.length ? Object.fromEntries(given.map((k) => [k, opts[k]])) : undefined;
}

function locatorMatchers(locator, negate) {
  const { driver } = locator.source;
  const matchers = {};
  for (const [name, split] of Object.entries(LAYOUT_MATCHERS)) {
    matchers[name] = (...args) => {
      const [checkArgs, opts = {}] = split(...args);
      return driver.expectLayout(locator, name, checkArgs, { ...opts, not: negate });
    };
  }
  matchers.toBeAt = (x, y, opts) => matchers.toHaveBox({ x, y }, opts);
  matchers.toHaveCount = (count, opts) => driver.expectCount(locator, count, opts);
  // Visible means exactly one match (locators are strict); not visible
  // means no match at all.
  matchers.toBeVisible = (opts) => driver.expectCount(locator, negate ? 0 : 1, opts);
  matchers.toHaveExactlyOneFocused = (opts) => driver.expectFocusGroup(locator, focusIndicators(opts), opts);
  return matchers;
}

// expect(game) matchers backed by GameDriver.expectTerminal (terminal
// modes, title, bell, hyperlinks, clipboard, scrollback). Each takes its
// arguments and then an options object that may carry { timeout }.
const TERMINAL_MATCHERS = {
  toBeInAltScreen: 0,
  toHaveTitle: 1,
  toHaveBell: 0,
  toHaveMouseTracking: 1,
  toHaveBracketedPaste: 0,
  toHaveHyperlink: 2,
  toHaveCopied: 1,
  toHaveScrollbackText: 1,
};

function terminalMatchers(driver, negate) {
  const matchers = {};
  for (const [name, arity] of Object.entries(TERMINAL_MATCHERS)) {
    matchers[name] = (...args) => {
      // toHaveHyperlink(uri, { text, timeout }) passes its options through.
      const opts = (name === 'toHaveHyperlink' ? args[1] : args[arity]) || {};
      return driver.expectTerminal(name, args.slice(0, arity), { ...opts, not: negate });
    };
  }
  return matchers;
}

function gameMatchers(driver) {
  return {
    ...terminalMatchers(driver, false),
    toHaveExited(want, opts) {
      return driver.expectExit(want, opts);
    },
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
    // toHaveCursorAt(x, y, opts) or toHaveCursorAt(locator, opts)
    toHaveCursorAt(xOrLocator, y, opts) {
      if (xOrLocator && xOrLocator._isLocator) return driver.expectCursorAt(xOrLocator, y);
      return driver.expectCursorAt({ x: xOrLocator, y }, opts);
    },
    toHaveCursorVisible(opts) {
      return driver.expectCursorVisible(true, opts);
    },
    not: {
      ...terminalMatchers(driver, true),
      toHaveText(needle, opts) {
        return driver.expectNotText(needle, opts);
      },
      toHaveCursorVisible(opts) {
        return driver.expectCursorVisible(false, opts);
      },
    },
  };
}

function expect(subject) {
  if (subject && subject._isLocator) {
    const matchers = locatorMatchers(subject, false);
    const negated = locatorMatchers(subject, true);
    // Negating a count is meaningless; not.toBeVisible covers "absent".
    delete negated.toHaveCount;
    delete negated.toHaveExactlyOneFocused;
    return { ...matchers, not: negated };
  }
  return gameMatchers(subject);
}

module.exports = { expect };
