'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { effectiveMonthlyFee, buildEconomics, scheduledCharges } = require('../src/roi-tracker/economics.js');

const go = {
  id: 'go', type: 'Wallet', fee: 20,
  startDate: '20260531',
  valueRun: 189.16, months: 2.14722489635044,
  // sub1: $5 prorated 05-31, $10 06-30, $10 07-31; sub2: $10 07-17
  charges: [
    { date: '2026-05-31', amount: 5 },
    { date: '2026-06-30', amount: 10 },
    { date: '2026-07-17', amount: 10 },
    { date: '2026-07-31', amount: 10 },
  ],
};

test('effectiveMonthlyFee = total charges / window months (wallet semantics)', () => {
  // $35 paid over 2.147 months → $16.30/mo, NOT the flat fee 20
  assert.ok(Math.abs(effectiveMonthlyFee(go, 2.14722489635044) - 35 / 2.14722489635044) < 1e-9);
  assert.equal(Math.round(effectiveMonthlyFee(go, 2.14722489635044) * 100) / 100, 16.30);
});

test('effectiveMonthlyFee excludes charges outside the window', () => {
  const p = {
    ...go,
    startDate: '20260601',
    charges: [
      { date: '2026-05-31', amount: 5 },   // before startDate — excluded
      { date: '2026-06-30', amount: 10 },
      { date: '2026-07-31', amount: 10 },
    ],
  };
  assert.equal(effectiveMonthlyFee(p, 2), 10); // 20/2
});

test('effectiveMonthlyFee honors endDate bound', () => {
  const p = { ...go, endDate: '20260701', charges: [
    { date: '2026-05-31', amount: 5 },
    { date: '2026-06-30', amount: 10 },
    { date: '2026-07-17', amount: 10 },  // after endDate — excluded
    { date: '2026-07-31', amount: 10 },  // after endDate — excluded
  ] };
  assert.equal(effectiveMonthlyFee(p, 1), 15); // 15/1
});

test('effectiveMonthlyFee falls back to flat fee when no charges', () => {
  assert.equal(effectiveMonthlyFee({ fee: 20 }, 2), 20);
  assert.equal(effectiveMonthlyFee({}, 2), 0);
});

test('scheduledCharges materializes monthly charges with month-end clamping and proration', () => {
  // Sub 1: $10/mo from 05-31, first charge $5 prorated; sub 2: $10/mo from 07-17.
  // Today = Aug 4 -> 08-31/08-17 charges not due yet.
  const p = {
    recurring: [
      { start: '2026-05-31', amount: 10, firstAmount: 5 },
      { start: '2026-07-17', amount: 10 },
    ],
  };
  const charges = scheduledCharges(p, '20260804');
  const byDate = Object.fromEntries(charges.map(c => [c.date, c.amount]));
  assert.deepEqual(Object.keys(byDate), ['20260531', '20260630', '20260717', '20260731']);
  assert.equal(byDate['20260531'], 5);  // prorated first charge
  assert.equal(byDate['20260630'], 10); // May 31 + 1mo clamps back to Jun 30
  assert.equal(byDate['20260731'], 10);
  assert.equal(byDate['20260717'], 10);
});

test('scheduledCharges stops at the today cutoff and honors endDate', () => {
  const p = { recurring: [{ start: '2026-05-31', amount: 10 }] };
  assert.equal(scheduledCharges(p, '20260615').length, 1);   // only May charge due
  const ended = { ...p, endDate: '20260630' };
  assert.equal(scheduledCharges(ended, '20260801').length, 2); // May + Jun, Jul excluded
});

test('effectiveMonthlyFee uses generated recurring charges', () => {
  const p = {
    fee: 20, startDate: '20260531', months: 2.14722489635044,
    endDate: '20260804',
    recurring: [
      { start: '2026-05-31', amount: 10, firstAmount: 5 },
      { start: '2026-07-17', amount: 10 },
    ],
  };
  const fee = effectiveMonthlyFee(p, p.months);
  assert.equal(Math.round(fee * 100) / 100, 16.30); // 35 / 2.147, same as explicit charges
});

test('wallet fees flow through buildEconomics: fee, roi, effMult consistent', () => {
  const { rows } = buildEconomics([go]);
  const row = rows[0];
  assert.equal(Math.round(row.fee * 100) / 100, 16.30);          // effective, not config 20
  assert.ok(Math.abs(row.roi - 88.09510374134929 / 16.30010906611982) < 1e-6);
  assert.equal(Math.round(row.effMult * 1000) / 1000, Math.round((16.30010906611982 / 88.09510374134929) * 1000) / 1000);
  assert.equal(row.status, 'paying off');
});
