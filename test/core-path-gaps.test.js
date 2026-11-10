'use strict';
/**
 * Unit tests for src/core/path-gaps.js: priced models with no runnable on their
 * quota path, and runnables the price table does not cover.
 * Synthetic config, fixed `now`. Run with `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { pathGaps } = require('../src/core/path-gaps.js');
const { mixIndex } = require('../src/core/token-mix.js');

const NOW = Date.parse('2026-11-08T12:00:00Z');
const COST_BLEND = { cache: 0.9174, input: 0.0781, output: 0.044 };

const PRICES = {
  'atlas-flash': { input: 0.15, output: 0.6, cacheRead: 0.003, monthlyLimit: 100 },
  'atlas-mini': { input: 0.05, output: 0.2, cacheRead: 0.001, monthlyLimit: 100 },
  'atlas-ultra': { input: 0.6, output: 2.4, cacheRead: 0.012, monthlyLimit: 100 },
  'atlas-nano': { input: 0.01, output: 0.04, cacheRead: 0.0005, monthlyLimit: 100 },
};

const SUBSCRIPTIONS = [{
  id: 'go',
  name: 'Orbit Go',
  type: 'Wallet',
  fee: 10,
  startDate: '20260101',
  models: ['atlas-flash', 'atlas-mini', 'atlas-ultra', 'atlas-nano'],
  prices: PRICES,
}];

const RUNNABLES = [
  { id: 'opencode-go/atlas-flash', path: 'go', modelKey: 'atlas-flash', harness: 'pi' },
  { id: 'opencode-go/o-mini', path: 'go', modelKey: 'o-mini', harness: 'pi' },
  { id: 'acme/atlas-large', path: 'claudemax', modelKey: 'atlas-large', harness: 'claude' },
];

const ROWS = [
  { model_key: 'atlas-flash', path_id: 'go', input: 600000, output: 240000, cache_write: 0, cache_read: 11160000 },
];

test('the report names the priced models with no runnable, cheapest first', () => {
  const report = pathGaps({
    subscriptions: SUBSCRIPTIONS,
    runnables: RUNNABLES,
    mixIndex: mixIndex(ROWS),
    costBlend: COST_BLEND,
    now: NOW,
  });
  assert.equal(report.paths.length, 1, 'only paths that declare prices are reported');
  const [go] = report.paths;
  assert.equal(go.path, 'go');
  assert.equal(go.pathName, 'Orbit Go');
  assert.equal(go.fee, 10);
  assert.deepEqual(go.missing.map((gap) => gap.modelKey), ['atlas-nano', 'atlas-mini', 'atlas-ultra']);
  for (const gap of go.missing) {
    assert.equal(typeof gap.costPerMTok, 'number');
    assert.match(gap.reason, /^cost \$/);
    assert.equal(gap.expired, false);
  }
  // cheapest first
  const costs = go.missing.map((gap) => gap.costPerMTok);
  assert.deepEqual(costs, [...costs].sort((a, b) => a - b));
});

test('the report names the runnables the price table does not cover', () => {
  const report = pathGaps({
    subscriptions: SUBSCRIPTIONS,
    runnables: RUNNABLES,
    mixIndex: mixIndex(ROWS),
    costBlend: COST_BLEND,
    now: NOW,
  });
  assert.deepEqual(report.paths[0].unpriced, [{ id: 'opencode-go/o-mini', modelKey: 'o-mini' }]);
});

test('a runnable elsewhere is neither missing nor unpriced for this path', () => {
  const report = pathGaps({
    subscriptions: SUBSCRIPTIONS,
    runnables: RUNNABLES,
    mixIndex: mixIndex(ROWS),
    costBlend: COST_BLEND,
    now: NOW,
  });
  const keys = report.paths[0].missing.map((gap) => gap.modelKey);
  assert.ok(!keys.includes('atlas-large'), 'a runnable on another path is not a gap here');
  assert.ok(!report.paths[0].unpriced.some((gap) => gap.id === 'acme/atlas-large'));
});

test('an alias entry funding the same quota path contributes its prices', () => {
  const report = pathGaps({
    subscriptions: [
      { id: 'go', name: 'Orbit Go', type: 'Wallet', fee: 10, startDate: '20260101', models: ['atlas-flash'] },
      {
        id: 'gosingle',
        sourcePath: 'go',
        name: 'Orbit Go single',
        type: 'Wallet',
        fee: 5,
        startDate: '20260101',
        models: ['atlas-flash'],
        prices: { 'atlas-ultra': PRICES['atlas-ultra'] },
      },
    ],
    runnables: [{ id: 'opencode-go/atlas-flash', path: 'go', modelKey: 'atlas-flash', harness: 'pi' }],
    mixIndex: mixIndex(ROWS),
    costBlend: COST_BLEND,
    now: NOW,
  });
  assert.equal(report.paths.length, 1, 'one quota path, one report');
  assert.equal(report.paths[0].pathName, 'Orbit Go + Orbit Go single');
  assert.equal(report.paths[0].fee, 15);
  assert.deepEqual(report.paths[0].missing.map((gap) => gap.modelKey), ['atlas-ultra']);
});

test('an ended plan funding the same path does not count toward the fee', () => {
  const report = pathGaps({
    subscriptions: [
      { id: 'go', name: 'Orbit Go x2', type: 'Wallet', fee: 20, startDate: '20260101', endDate: '20260831', models: ['atlas-flash'] },
      { ...SUBSCRIPTIONS[0], id: 'gosingle', sourcePath: 'go', startDate: '20260906' },
    ],
    runnables: RUNNABLES,
    mixIndex: mixIndex(ROWS),
    costBlend: COST_BLEND,
    now: NOW,
  });
  assert.equal(report.paths[0].fee, 10, 'only active funding entries, the fee pricing scales by');
});

test('a runnable without a declared modelKey is matched by the key derived from its id', () => {
  const report = pathGaps({
    subscriptions: SUBSCRIPTIONS,
    runnables: [
      { id: 'opencode-go/atlas-flash', path: 'go', modelKey: 'atlas-flash', harness: 'pi' },
      { id: 'opencode-go/atlas-mini', path: 'go', modelKey: null, harness: 'pi' },
    ],
    mixIndex: mixIndex(ROWS),
    costBlend: COST_BLEND,
    now: NOW,
  });
  const keys = report.paths[0].missing.map((gap) => gap.modelKey);
  assert.ok(!keys.includes('atlas-mini'), 'a wired runnable is not a gap just because its modelKey is null');
  assert.deepEqual(keys, ['atlas-nano', 'atlas-ultra']);
});

test('an expired entry is reported as expired, and an unpriced gap sorts last', () => {
  const subscriptions = [{
    ...SUBSCRIPTIONS[0],
    prices: {
      'atlas-flash': PRICES['atlas-flash'],
      'atlas-ultra': { ...PRICES['atlas-ultra'], until: '2026-01-01' },
    },
  }];
  const report = pathGaps({
    subscriptions, runnables: RUNNABLES, mixIndex: mixIndex(ROWS), costBlend: COST_BLEND, now: NOW,
  });
  assert.equal(report.paths[0].missing[0].expired, true);

  // No cost blend → no mix → no computed cost; the row still appears, last.
  const noMix = pathGaps({
    subscriptions,
    runnables: RUNNABLES,
    mixIndex: null,
    costBlend: null,
    now: NOW,
  });
  assert.deepEqual(noMix.paths[0].missing.map((gap) => gap.costPerMTok), [null]);
});

test('a config with no price tables reports nothing', () => {
  const report = pathGaps({
    subscriptions: [{ id: 'go', type: 'Wallet', fee: 10, models: ['atlas-flash'] }],
    runnables: RUNNABLES,
    mixIndex: null,
    costBlend: COST_BLEND,
    now: NOW,
  });
  assert.deepEqual(report.paths, []);
  assert.deepEqual(pathGaps().paths, []);
});
