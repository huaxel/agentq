'use strict';
/**
 * Unit tests for economics.js — the Paths ROI port. Covers each path type
 * (Local / Metered / Wallet), the allowance cap, underwater detection, and the
 * effMults map buildEconomics hands to the scorer. Run with `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computePath, buildEconomics } = require('../src/roi-tracker/economics.js');

test('Local path is free at the margin (effMult 0, sunk cost)', () => {
  const r = computePath({ id: 'local', type: 'Local', fee: 0 });
  assert.equal(r.effMult, 0);
  assert.equal(r.roi, 'sunk');
  assert.match(r.status, /free at margin/);
});

test('Metered path pays per token at list (effMult 1)', () => {
  const r = computePath({ id: 'openrouter', type: 'Metered', fee: 0 });
  assert.equal(r.effMult, 1);
  assert.equal(r.roi, 'n/a');
});

test('Wallet with no value run stays inert (effMult 1, asks for input)', () => {
  const r = computePath({ id: 'max', type: 'Wallet', fee: 200, allowance: null, valueRun: null });
  assert.equal(r.covered, null);
  assert.equal(r.effMult, 1);
  assert.equal(r.roi, null);
  assert.match(r.status, /enter Value run/);
});

test('Wallet underwater: paid more than the list value run (ROI < 1)', () => {
  const r = computePath({ id: 'max', type: 'Wallet', fee: 200, allowance: null, valueRun: 100 });
  assert.equal(r.covered, 100);
  assert.equal(r.effMult, 2);      // fee / covered = 200 / 100
  assert.equal(r.roi, 0.5);
  assert.match(r.status, /UNDERWATER/);
});

test('Wallet paying off: value run exceeds the fee (ROI > 1, effMult < 1)', () => {
  const r = computePath({ id: 'max', type: 'Wallet', fee: 100, allowance: null, valueRun: 300 });
  assert.equal(r.covered, 300);
  assert.ok(Math.abs(r.effMult - 1 / 3) < 1e-9);   // 100 / 300
  assert.equal(r.roi, 3);
  assert.match(r.status, /paying off/);
});

test('Wallet with zero fee has no ROI ratio to compute (covered/0), not Infinity or a false "paying off"', () => {
  const r = computePath({ id: 'firepass', type: 'Wallet', fee: 0, allowance: null, valueRun: 1646.68 });
  assert.equal(typeof r.roi, 'string');
  assert.notEqual(r.roi, Infinity);
  assert.match(r.status, /free/);
});

test('Wallet with zero fee and zero value run is not NaN and does not read "paying off"', () => {
  const r = computePath({ id: 'firepass', type: 'Wallet', fee: 0, allowance: null, valueRun: 0 });
  assert.notEqual(r.status, 'paying off');
});

test('Wallet allowance caps covered and yields utilization', () => {
  const r = computePath({ id: 'max', type: 'Wallet', fee: 100, allowance: 200, valueRun: 500 });
  assert.equal(r.covered, 200);    // min(valueRun, allowance)
  assert.equal(r.util, 1);         // covered / allowance
  assert.equal(r.effMult, 0.5);    // fee / covered = 100 / 200
  assert.equal(r.roi, 2);
});

test('buildEconomics returns a row per path and an id→effMult map', () => {
  const { rows, effMults } = buildEconomics([
    { id: 'local', type: 'Local', fee: 0 },
    { id: 'max', type: 'Wallet', fee: 200, allowance: null, valueRun: 100 },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(effMults.local, 0);
  assert.equal(effMults.max, 2);
});

test('months parameter annualizes valueRun so ROI is comparable to monthly fee', () => {
  // 6 months of $600 usage on a $200/mo sub → $100/mo avg, ROI = 0.5
  const r = computePath({ id: 'max', type: 'Wallet', fee: 200, valueRun: 600, months: 6 });
  assert.equal(r.covered, 100);
  assert.equal(r.roi, 0.5);
  assert.equal(r.effMult, 2);
});

test('months=1 (no window) behaves identically to before', () => {
  const r1 = computePath({ id: 'x', type: 'Wallet', fee: 100, valueRun: 300 });
  const r2 = computePath({ id: 'x', type: 'Wallet', fee: 100, valueRun: 300, months: 1 });
  assert.equal(r1.covered, r2.covered);
  assert.equal(r1.roi, r2.roi);
  assert.equal(r1.effMult, r2.effMult);
});
