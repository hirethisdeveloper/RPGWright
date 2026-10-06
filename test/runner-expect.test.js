'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { expect } = require('../runner/expect');

function fakeDriver() {
  const calls = [];
  return {
    calls,
    expectText: (...args) => calls.push(['expectText', ...args]),
    expectNotText: (...args) => calls.push(['expectNotText', ...args]),
    expectScreen: (...args) => calls.push(['expectScreen', ...args]),
    expectState: (...args) => calls.push(['expectState', ...args]),
  };
}

test('expect().toHaveText delegates straight to expectText with the same arguments', () => {
  const driver = fakeDriver();
  expect(driver).toHaveText('hi', { timeout: 5 });
  assert.deepEqual(driver.calls, [['expectText', 'hi', { timeout: 5 }]]);
});

test('expect().not.toHaveText delegates to expectNotText, not a negated expectText', () => {
  const driver = fakeDriver();
  expect(driver).not.toHaveText('bye', { holdFor: 10 });
  assert.deepEqual(driver.calls, [['expectNotText', 'bye', { holdFor: 10 }]]);
});

test('expect().toMatchScreen delegates to expectScreen with the raw matcher', () => {
  const driver = fakeDriver();
  const re = /abc/;
  expect(driver).toMatchScreen(re);
  assert.deepEqual(driver.calls, [['expectScreen', re, undefined]]);
});

test('expect().toMatchScreenSnapshot wraps the name in a { snapshot } matcher for expectScreen', () => {
  const driver = fakeDriver();
  expect(driver).toMatchScreenSnapshot('my-snap', { timeout: 5 });
  assert.deepEqual(driver.calls, [['expectScreen', { snapshot: 'my-snap' }, { timeout: 5 }]]);
});

test('expect().toHaveState delegates to expectState with getState and the matcher', () => {
  const driver = fakeDriver();
  const getState = async () => ({});
  const matcher = () => true;
  expect(driver).toHaveState(getState, matcher);
  assert.deepEqual(driver.calls, [['expectState', getState, matcher, undefined]]);
});

function fakeLocator() {
  const calls = [];
  const driver = {
    expectLayout: (...args) => calls.push(['expectLayout', ...args]),
    expectCount: (...args) => calls.push(['expectCount', ...args]),
  };
  const locator = { _isLocator: true, source: { driver } };
  return { locator, calls };
}

test('expect(locator) layout matchers delegate to expectLayout with check args and options', () => {
  const { locator, calls } = fakeLocator();
  const other = { _isLocator: true };
  expect(locator).toBeLeftOf(other, { timeout: 50 });
  expect(locator).toHaveGap(other, { min: 1, max: 2 });
  expect(locator).toHaveBox({ x: 3 }, { tolerance: 1 });
  expect(locator).toBeAligned('center');
  expect(locator).toBeWithinScreen();
  assert.deepEqual(calls, [
    ['expectLayout', locator, 'toBeLeftOf', [other], { timeout: 50, not: false }],
    ['expectLayout', locator, 'toHaveGap', [other, { min: 1, max: 2 }], { min: 1, max: 2, not: false }],
    ['expectLayout', locator, 'toHaveBox', [{ x: 3 }, { tolerance: 1 }], { tolerance: 1, not: false }],
    ['expectLayout', locator, 'toBeAligned', ['center', undefined], { not: false }],
    ['expectLayout', locator, 'toBeWithinScreen', [], { not: false }],
  ]);
});

test('expect(locator).not negates layout matchers through the same expectLayout call', () => {
  const { locator, calls } = fakeLocator();
  const other = { _isLocator: true };
  expect(locator).not.toOverlap(other);
  assert.deepEqual(calls, [['expectLayout', locator, 'toOverlap', [other], { not: true }]]);
});

test('expect(locator): toBeAt is toHaveBox({ x, y }); toBeVisible/not.toBeVisible/toHaveCount use expectCount', () => {
  const { locator, calls } = fakeLocator();
  expect(locator).toBeAt(2, 5);
  expect(locator).toBeVisible();
  expect(locator).not.toBeVisible({ timeout: 10 });
  expect(locator).toHaveCount(3);
  assert.deepEqual(calls, [
    ['expectLayout', locator, 'toHaveBox', [{ x: 2, y: 5 }, undefined], { not: false }],
    ['expectCount', locator, 1, undefined],
    ['expectCount', locator, 0, { timeout: 10 }],
    ['expectCount', locator, 3, undefined],
  ]);
  assert.equal(expect(locator).not.toHaveCount, undefined);
});

test('expect(locator): toHaveStyle/toBeFocused go through expectLayout; focus options become indicators', () => {
  const { locator, calls } = fakeLocator();
  expect(locator).toHaveStyle({ inverse: true }, { timeout: 5 });
  expect(locator).toBeFocused();
  expect(locator).not.toBeFocused({ marker: '> ', timeout: 5 });
  assert.deepEqual(calls, [
    ['expectLayout', locator, 'toHaveStyle', [{ inverse: true }], { timeout: 5, not: false }],
    ['expectLayout', locator, 'toBeFocused', [undefined], { not: false }],
    ['expectLayout', locator, 'toBeFocused', [{ marker: '> ' }], { marker: '> ', timeout: 5, not: true }],
  ]);
});

test('expect(locator).toHaveExactlyOneFocused delegates to expectFocusGroup and has no negated form', () => {
  const calls = [];
  const driver = { expectFocusGroup: (...args) => calls.push(args) };
  const locator = { _isLocator: true, source: { driver } };
  expect(locator).toHaveExactlyOneFocused({ style: { bold: true } });
  assert.deepEqual(calls, [[locator, { style: { bold: true } }, { style: { bold: true } }]]);
  assert.equal(expect(locator).not.toHaveExactlyOneFocused, undefined);
});

test('expect(game): cursor matchers delegate to expectCursorAt / expectCursorVisible', () => {
  const calls = [];
  const driver = {
    expectCursorAt: (...args) => calls.push(['expectCursorAt', ...args]),
    expectCursorVisible: (...args) => calls.push(['expectCursorVisible', ...args]),
  };
  const locator = { _isLocator: true };
  expect(driver).toHaveCursorAt(3, 4, { timeout: 1 });
  expect(driver).toHaveCursorAt(locator, { timeout: 2 });
  expect(driver).toHaveCursorVisible();
  expect(driver).not.toHaveCursorVisible({ timeout: 3 });
  assert.deepEqual(calls, [
    ['expectCursorAt', { x: 3, y: 4 }, { timeout: 1 }],
    ['expectCursorAt', locator, { timeout: 2 }],
    ['expectCursorVisible', true, undefined],
    ['expectCursorVisible', false, { timeout: 3 }],
  ]);
});

test('expect(game): terminal-state matchers delegate to expectTerminal, with not; toHaveExited to expectExit', () => {
  const calls = [];
  const driver = {
    expectTerminal: (...args) => calls.push(['expectTerminal', ...args]),
    expectExit: (...args) => calls.push(['expectExit', ...args]),
  };
  expect(driver).toBeInAltScreen({ timeout: 1 });
  expect(driver).toHaveTitle(/App/);
  expect(driver).toHaveHyperlink('https://x', { text: 'x', timeout: 2 });
  expect(driver).not.toHaveBell();
  expect(driver).toHaveScrollbackText('line 1');
  expect(driver).toHaveExited({ code: 0 }, { timeout: 3 });
  assert.deepEqual(calls, [
    ['expectTerminal', 'toBeInAltScreen', [], { timeout: 1, not: false }],
    ['expectTerminal', 'toHaveTitle', [/App/], { not: false }],
    ['expectTerminal', 'toHaveHyperlink', ['https://x', { text: 'x', timeout: 2 }], { text: 'x', timeout: 2, not: false }],
    ['expectTerminal', 'toHaveBell', [], { not: true }],
    ['expectTerminal', 'toHaveScrollbackText', ['line 1'], { not: false }],
    ['expectExit', { code: 0 }, { timeout: 3 }],
  ]);
});
