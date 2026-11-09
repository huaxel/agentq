'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildRollup } = require('../src/roi-tracker/pipeline.js');

// Economics rows as buildEconomics produces them: { ...path, covered, util,
// effMult, roi, status } plus the computed valueRun/months the pipeline sets
// before buildRollup. endDate comes through via the path spread.
function sub(id, fee, valueRun, months, endDate) {
  return {
    id, name: id, type: 'Wallet', fee, valueRun, months, quota: {},
    endDate: endDate || null,
    roi: valueRun / months / fee,
  };
}

test('buildRollup marks past-endDate subs canceled and excludes them from totals', () => {
  const economics = [
    sub('claudemax', 200, 2400, 2, null),          // active, ROI 6
    sub('nan', 70, 210, 1, '20260803'),            // canceled Aug 3, ROI 3
    sub('umans', 20, 140, 1, '20260801'),          // canceled Aug 1, ROI 7
  ];
  const rollup = buildRollup(economics, [{ since: '20260501' }], []);

  const byId = Object.fromEntries(rollup.subs.map(s => [s.id, s]));
  assert.equal(byId.claudemax.verdict, 'keep');
  assert.equal(byId.claudemax.canceled, false);

  assert.equal(byId.nan.verdict, 'canceled');
  assert.equal(byId.nan.canceled, true);
  assert.equal(byId.nan.endDate, '20260803');
  assert.equal(byId.umans.verdict, 'canceled');

  // Canceled subs no longer count toward the monthly fee/value burden.
  assert.equal(rollup.totals.feePerMonth, 200);
  assert.equal(rollup.totals.valuePerMonth, 1200); // 2400/2
  assert.equal(rollup.totals.net, 1000);
});

test('buildRollup keeps future endDates active', () => {
  const economics = [
    sub('go', 60, 600, 2, '20261231'), // ends later this year — still active
  ];
  const rollup = buildRollup(economics, [{ since: '20260501' }], []);
  assert.equal(rollup.subs[0].verdict, 'keep');
  assert.equal(rollup.subs[0].canceled, false);
  assert.equal(rollup.totals.feePerMonth, 60);
});
