'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUsage } = require('../src/lib/usage-normalize.js');

test('normalizeUsage accepts camelCase and snake_case usage shapes', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 1, outputTokens: 2, cacheTokens: 3, totalCost: 0.5 }), {
    inputTokens: 1, outputTokens: 2, cacheTokens: 3, totalCost: 0.5,
  });
  assert.deepEqual(normalizeUsage({ input_tokens: 1, output_tokens: 2, cache_tokens: 3, cost: 0.5 }), {
    inputTokens: 1, outputTokens: 2, cacheTokens: 3, totalCost: 0.5,
  });
});

test('normalizeUsage combines cache read + write when no explicit total is present', () => {
  assert.deepEqual(normalizeUsage({ cacheReadTokens: 33, cacheWriteTokens: 4 }), {
    inputTokens: 0, outputTokens: 0, cacheTokens: 37, totalCost: 0,
  });
  assert.deepEqual(normalizeUsage({ cache_read_tokens: 30 }), {
    inputTokens: 0, outputTokens: 0, cacheTokens: 30, totalCost: 0,
  });
});

test('normalizeUsage reads Claude Code\'s native cache field names', () => {
  // A raw `claude -p --output-format json` usage object names the cache fields
  // cache_read_input_tokens / cache_creation_input_tokens; dropping them would
  // silently under-report the spend of every Claude Code job.
  assert.deepEqual(normalizeUsage({
    input_tokens: 1200,
    output_tokens: 340,
    cache_read_input_tokens: 5600,
    cache_creation_input_tokens: 700,
    total_cost_usd: 0.4321,
  }), {
    inputTokens: 1200, outputTokens: 340, cacheTokens: 6300, totalCost: 0.4321,
  });
  assert.equal(normalizeUsage({ cache_read_input_tokens: 5600, cache_creation_input_tokens: 700 }).cacheTokens, 6300);
});

test('normalizeUsage prefers an explicit cacheTokens total over read + write', () => {
  const u = normalizeUsage({ cacheTokens: 9, cacheReadTokens: 30, cacheWriteTokens: 7 });
  assert.equal(u.cacheTokens, 9);
});

test('normalizeUsage reads nested pi cost breakdowns and session token names', () => {
  // Pi sessions nest the money at usage.cost.total with short token names;
  // a raw object would coerce to NaN ($0) without the unwrap below.
  assert.deepEqual(normalizeUsage({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: 0.05 } }), {
    inputTokens: 100, outputTokens: 50, cacheTokens: 15, totalCost: 0.05,
  });
});

test('normalizeUsage accepts JSON strings and rejects malformed input', () => {
  assert.deepEqual(normalizeUsage('{"inputTokens":5,"totalCost":0.1}'), {
    inputTokens: 5, outputTokens: 0, cacheTokens: 0, totalCost: 0.1,
  });
  assert.equal(normalizeUsage('not json'), null);
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage(42), null);
});

test('normalizeUsage coerces numeric strings and guards NaN/Infinity', () => {
  const u = normalizeUsage({ inputTokens: '100', outputTokens: 'oops', totalCost: Infinity });
  assert.equal(u.inputTokens, 100);
  assert.equal(u.outputTokens, 0);
  assert.equal(u.totalCost, 0);
});