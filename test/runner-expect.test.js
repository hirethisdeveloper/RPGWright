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
