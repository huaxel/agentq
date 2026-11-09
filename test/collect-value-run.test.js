'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  collectAsync,
  collectModelPatternsFromRecords,
} = require('../src/roi-tracker/collect/value-run.js');

const config = {
  agentPathMap: {},
  modelPathPatterns: {
    gemini: [
      { match: 'accounts/fireworks/', path: 'firepass' },
      { match: 'umans-', path: 'umans' },
    ],
  },
};

const records = [
  { model: '[gemini] accounts/fireworks/kimi-k2', cost: 1.25 },
  { model: '[gemini] umans-coder', cost: 2.5 },
  { model: '[claude] accounts/fireworks/ignored', cost: 99 },
];

test('collectModelPatternsFromRecords prices zero-cost records via priceOverrides', () => {
  const cfg = {
    ...config,
    modelPathPatterns: {
      gemini: [{ match: 'accounts/fireworks/', path: 'firepass' }],
    },
    priceOverrides: {
      'accounts/fireworks/routers/kimi-k2p6-turbo': { input: 2.0, output: 8.0, cache: 0.3 },
    },
  };
  // Fireworks record has NO cost (fallback): should be priced at $2/$8.
  const recs = [
    { model: '[gemini] accounts/fireworks/routers/kimi-k2p6-turbo', cost: 0, inputTokens: 1000000, outputTokens: 1000000 },
  ];
  const result = collectModelPatternsFromRecords(recs, cfg);
  // 1M in @$2 + 1M out @$8 = $10
  assert.deepEqual(result.perPath, { firepass: 10 });
});

test('collectModelPatternsFromRecords prefers record cost over priceOverrides', () => {
  const cfg = {
    ...config,
    modelPathPatterns: { gemini: [{ match: 'accounts/fireworks/', path: 'firepass' }] },
    priceOverrides: { 'accounts/fireworks/routers/kimi-k2p6-turbo': { input: 2.0, output: 8.0 } },
  };
  const recs = [
    { model: '[gemini] accounts/fireworks/routers/kimi-k2p6-turbo', cost: 25, inputTokens: 1000000, outputTokens: 1000000 },
  ];
  const result = collectModelPatternsFromRecords(recs, cfg);
  assert.deepEqual(result.perPath, { firepass: 25 });
});


test('collectAsync reuses usage records for pattern agents without a second daily scan', async () => {
  const result = await collectAsync('20260601', config, {
    usagePromise: Promise.resolve({ available: true, records }),
  });

  assert.deepEqual(result.perPath, { firepass: 1.25, umans: 2.5 });
  assert.deepEqual(result.perAgent, { gemini: 3.75 });
  assert.deepEqual(result.errors, []);
});

test('explicit ccusage source wins over a tokscale-graph environment', async () => {
  // The graph-to-ccusage fallback pins source: 'ccusage' so a
  // VALUE_RUN_SOURCE=tokscale-graph environment cannot reselect the failed
  // graph collector for the retry.
  const prev = process.env.VALUE_RUN_SOURCE;
  process.env.VALUE_RUN_SOURCE = 'tokscale-graph';
  try {
    const result = await collectAsync('20260601', config, {
      source: 'ccusage',
      usagePromise: Promise.resolve({ available: true, records }),
    });
    assert.deepEqual(result.perPath, { firepass: 1.25, umans: 2.5 });
  } finally {
    if (prev === undefined) delete process.env.VALUE_RUN_SOURCE;
    else process.env.VALUE_RUN_SOURCE = prev;
  }
});

test('collectAsync reports shared usage scan errors without a duplicate fallback scan', async () => {
  const result = await collectAsync('20260601', config, {
    usagePromise: Promise.resolve({ available: false, error: 'ccusage unavailable' }),
  });

  assert.deepEqual(result.perPath, {});
  assert.deepEqual(result.perAgent, {});
  assert.match(result.errors[0], /shared usage scan unavailable/);
});

test('resolveValueRunWrite writes when paths were collected', () => {
  const { resolveValueRunWrite } = require('../src/roi-tracker/collect/value-run.js');
  assert.equal(resolveValueRunWrite({ go: 1 }, { _meta: {}, go: 2 }), 'write');
  assert.equal(resolveValueRunWrite(null, { go: 2 }), 'write');
});

test('resolveValueRunWrite keeps last good data on an empty result', () => {
  const { resolveValueRunWrite } = require('../src/roi-tracker/collect/value-run.js');
  assert.equal(resolveValueRunWrite({ go: 1 }, { _meta: {} }), 'keep');
  assert.equal(resolveValueRunWrite({ go: 1 }, null), 'keep');
});

test('resolveValueRunWrite flags first-run emptiness instead of silently stubbing', () => {
  const { resolveValueRunWrite } = require('../src/roi-tracker/collect/value-run.js');
  assert.equal(resolveValueRunWrite(null, { _meta: {} }), 'empty');
  assert.equal(resolveValueRunWrite(null, null), 'empty');
});
