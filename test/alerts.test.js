'use strict';
/**
 * Unit tests for lib/alerts.js — underwater detection and break-even hints.
 * Run with `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isUnderwater, breakEven, underwaterAlerts } = require('../src/lib/alerts.js');

test('isUnderwater is true only for a numeric ROI below 1', () => {
  assert.equal(isUnderwater({ roi: 0.5 }), true);
  assert.equal(isUnderwater({ roi: 1 }), false);
  assert.equal(isUnderwater({ roi: 2 }), false);
  assert.equal(isUnderwater({ roi: 'sunk' }), false);   // Local
  assert.equal(isUnderwater({ roi: 'n/a' }), false);    // Metered
  assert.equal(isUnderwater({ roi: null }), false);     // no value run
});

test('breakEven returns null for a healthy wallet', () => {
  assert.equal(breakEven({ roi: 2, fee: 100, covered: 200 }), null);
});

test('breakEven quantifies the gap for an underwater wallet', () => {
  // fee 200, covered 100 → need $100 more (=100% more usage).
  const be = breakEven({ type: 'Wallet', roi: 0.5, fee: 200, covered: 100, allowance: null });
  assert.equal(be.needUsd, 100);
  assert.equal(be.needPct, 100);
  assert.equal(be.reachable, true);
});

test('breakEven never shows a misleading +0% for a tiny but real gap', () => {
  // covered 199.90, fee 200 → ~0.05% short, but still underwater.
  const be = breakEven({ type: 'Wallet', roi: 0.9995, fee: 200, covered: 199.9, allowance: null });
  assert.equal(be.needPct, 1);
  assert.ok(be.needUsd > 0);
});

test('breakEven flags an allowance cap that volume can not overcome', () => {
  // allowance 80 < fee 200: covered can never reach the fee.
  const be = breakEven({ type: 'Wallet', roi: 0.4, fee: 200, covered: 80, allowance: 80 });
  assert.equal(be.reachable, false);
});

test('underwaterAlerts lists only underwater rows with hints', () => {
  const rows = [
    { id: 'local', name: 'Local', roi: 'sunk', fee: 0 },
    { id: 'max', name: 'Claude Max', type: 'Wallet', roi: 0.5, fee: 200, covered: 100, allowance: null },
    { id: 'go', name: 'OpenCode Go', type: 'Wallet', roi: 3, fee: 100, covered: 300, allowance: null },
  ];
  const alerts = underwaterAlerts(rows);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].id, 'max');
  assert.equal(alerts[0].breakEven.needUsd, 100);
});
