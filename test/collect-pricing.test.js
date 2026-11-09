'use strict';
/**
 * The pricing collector must never replace good data with an all-failure
 * stub: a transient outage would otherwise wipe last-known prices and every
 * downstream consumer would silently reprice to fallback/zero. Run with
 * `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolvePricingWrite } = require('../src/roi-tracker/collect/pricing.js');

test('resolvePricingWrite writes when the scan returned models', () => {
  assert.equal(resolvePricingWrite({ a: {} }, { a: {}, b: {} }), 'write');
  assert.equal(resolvePricingWrite(null, { a: {} }), 'write');
});

test('resolvePricingWrite keeps last good data on an empty result', () => {
  assert.equal(resolvePricingWrite({ a: {} }, {}), 'keep');
  assert.equal(resolvePricingWrite({ a: {} }, null), 'keep');
});

test('resolvePricingWrite flags first-run emptiness instead of silently stubbing', () => {
  assert.equal(resolvePricingWrite(null, {}), 'empty');
  assert.equal(resolvePricingWrite(null, null), 'empty');
});