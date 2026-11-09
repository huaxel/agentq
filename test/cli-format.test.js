'use strict';
/**
 * CLI model table: an AA-derived value is marked `~` so it is never read as a
 * measurement, for both the intelligence estimate and its list price.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { buildModelRows, formatModelRow, formatModelTable } = require('../src/interfaces/cli/format.js');

const CAPACITY = new Map([['go', { path: 'go', state: 'available', headroomPct: 90, resetsAt: null, observedAt: null, stale: false, reason: null }]]);

function entry(overrides = {}) {
  return { id: 'm', path: 'go', harness: 'pi', modelKey: null, intelligence: 50, intelligenceSource: 'roi', aaIndex: null, calibration: null, costPerMTok: 1, costSource: 'roi', tier: null, speed: null, scored: true, subscription: null, ...overrides };
}

test('an AA-priced estimate shows ~ on both the score and the cost', () => {
  const row = formatModelRow(buildModelRows({
    catalog: [entry({ intelligence: 53.91, intelligenceSource: 'aa-estimate', costPerMTok: 0.1234, costSource: 'aa-price', scored: false })],
    capacity: CAPACITY,
  })[0], 1);
  assert.match(row, /~53\.9/);
  assert.match(row, /~\$0\.12/);
});

test('a measured score and an ROI price carry no marker', () => {
  const row = formatModelRow(buildModelRows({
    catalog: [entry({ intelligence: 53.91, costPerMTok: 1.5 })],
    capacity: CAPACITY,
  })[0], 1);
  assert.match(row, /53\.9/);
  assert.doesNotMatch(row, /~/);
  assert.match(row, /\$1\.50/);
});

test('an unknown cost stays a dash', () => {
  const row = formatModelRow(buildModelRows({
    catalog: [entry({ intelligence: null, intelligenceSource: null, costPerMTok: null, costSource: null, scored: false })],
    capacity: CAPACITY,
  })[0], 1);
  assert.match(row, /—/);
});

test('the table renders one row per catalog entry', () => {
  const table = formatModelTable({ catalog: [entry(), entry({ id: 'n' })], capacity: CAPACITY, title: 'models' });
  assert.match(table, /^models — auto = cheapest eligible first/);
  assert.equal(table.split('\n').length, 5, 'title, blank, header and one row per entry');
});
