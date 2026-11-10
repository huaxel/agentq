'use strict';
/**
 * CLI model table: an AA-derived value is marked `~` so it is never read as a
 * measurement, for both the intelligence estimate and its list price.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildModelRows,
  effectiveCostCell,
  formatModelRow,
  formatGapReport,
  formatModelTable,
  formatOptionsTable,
  paceCell,
  pathCell,
} = require('../src/interfaces/cli/format.js');

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

test('the options table shows pace-adjusted cost and pace instead of resets', () => {
  const table = formatOptionsTable([
    {
      id: 'a', path: 'codex', roles: ['cheapest'], intelligence: 50,
      costPerMTok: 1, costSource: 'roi', effectiveCostPerMTok: 0.25,
      pace: { state: 'behind', projectedPct: 30 }, headroomPct: 90, resetsAt: '2026-11-09T00:00:00Z',
    },
    {
      id: 'b', path: 'mistral', roles: ['smartest'], intelligence: 60,
      costPerMTok: 2, costSource: 'roi', effectiveCostPerMTok: 2.8,
      pace: { state: 'ahead', projectedPct: 140 }, headroomPct: 40, resetsAt: null,
    },
    {
      id: 'c', path: 'local', roles: ['alternative'], intelligence: 40,
      costPerMTok: 0.5, costSource: 'roi', effectiveCostPerMTok: 0.5,
      pace: null, headroomPct: 100, resetsAt: null,
    },
  ]);
  assert.match(table, /eff \$\/MTok/);
  assert.match(table, /behind 30%/);
  assert.match(table, /ahead 140%/);
  assert.match(table, /\$0\.25/);
  assert.doesNotMatch(table, /resets/);
  assert.equal(paceCell({ pace: null }), '—');
  assert.equal(effectiveCostCell({ effectiveCostPerMTok: null }), '—');
});

test('the path column shows the subscription name with the id in brackets', () => {
  assert.equal(pathCell({ path: 'claudemax', pathName: 'Claude Pro' }), 'Claude Pro (claudemax)');
  assert.equal(pathCell({ path: 'go', pathName: 'go' }), 'go', 'an id that is its own name is shown once');
  assert.equal(pathCell({ path: 'go' }), 'go', 'no name falls back to the id');
  assert.equal(pathCell({ path: '' }), '—');

  const table = formatOptionsTable([
    {
      id: 'a', path: 'claudemax', pathName: 'Claude Pro', roles: ['cheapest'], intelligence: 50,
      costPerMTok: 1, costSource: 'roi', effectiveCostPerMTok: 0.25,
      pace: null, headroomPct: 90, resetsAt: null,
    },
    {
      id: 'b', path: 'go', roles: ['alternative'], intelligence: 40,
      costPerMTok: 0.5, costSource: 'roi', effectiveCostPerMTok: 0.5,
      pace: null, headroomPct: 100, resetsAt: null,
    },
  ]);
  assert.match(table, /Claude Pro \(claudemax\)/);
  // The column is sized to the widest cell, so the rows stay aligned.
  const rows = table.split('\n').slice(2);
  assert.equal(rows[0].indexOf('cheapest'), rows[1].indexOf('alternative'));
});

test('a long subscription name is elided to 24 characters', () => {
  const long = 'An Extremely Long Subscription Name That Would Push The Row'; // 59 chars
  const cell = pathCell({ path: 'codex', pathName: long });
  const name = cell.slice(0, cell.indexOf(' (codex)'));
  assert.equal(name.length, 24);
  assert.equal(name, `${long.slice(0, 23)}…`);
  assert.match(cell, / \(codex\)$/);
});

// --- price-table gap report (W16) -------------------------------------------

test('the gap report names both lists, cheapest first', () => {
  const text = formatGapReport({
    paths: [{
      path: 'go',
      pathName: 'Orbit Go',
      fee: 10,
      missing: [
        { modelKey: 'atlas-nano', costPerMTok: 0.0002, reason: 'cost $0.0002/MTok (path price, peak)', expired: false },
        { modelKey: 'atlas-ultra', costPerMTok: 0.004, reason: 'cost $0.0040/MTok (path price, peak)', expired: false },
      ],
      unpriced: [{ id: 'opencode-go/o-mini', modelKey: 'o-mini' }],
    }],
  });
  const lines = text.split('\n');
  assert.equal(lines[0], 'path gaps — priced models with no runnable, cheapest first');
  assert.equal(lines[2], 'Orbit Go (go) — fee $10');
  assert.match(lines[3], /^ {2}missing {3}atlas-nano +\$0\.0002\/MTok {2}cost \$0\.0002\/MTok \(path price, peak\)$/);
  assert.match(lines[4], /atlas-ultra/);
  assert.match(lines[5], /^ {2}unpriced {2}opencode-go\/o-mini +— +no price entry \(falls back to roi or aa-price\)$/);
});

test('the gap report says when there is nothing to report', () => {
  assert.equal(formatGapReport({ paths: [] }), 'no priced paths: add a "prices" table to config.paths[]');
  const empty = formatGapReport({ paths: [{ path: 'go', pathName: 'go', fee: 0, missing: [], unpriced: [] }] });
  assert.match(empty, /\n\ngo — fee \$0\n {2}no gaps$/);
  assert.equal(formatGapReport(), 'no priced paths: add a "prices" table to config.paths[]');
});

test('an expired gap is marked expired instead of repeating its cost sentence', () => {
  const text = formatGapReport({
    paths: [{
      path: 'go',
      pathName: 'go',
      fee: 10,
      missing: [{ modelKey: 'atlas-mini', costPerMTok: 0, reason: 'cost $0/MTok (path price, free)', expired: true }],
      unpriced: [],
    }],
  });
  assert.match(text, /atlas-mini +\$0\/MTok +expired$/);
});
