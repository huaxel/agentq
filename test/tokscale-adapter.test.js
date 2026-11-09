'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTokscaleJson,
  aggregateRecords,
  diffUsage,
  tokscaleArgs,
  toTokscaleDate,
} = require('../src/roi-tracker/tokscale-adapter.js');

// Shape mirroring `tokscale --json --group-by client,provider,model` (4.9.0).
const fixture = {
  groupBy: 'client,provider,model',
  entries: [
    {
      client: 'pi', mergedClients: null, model: 'gpt-5.5', provider: 'openai-codex',
      input: 1000, output: 500, cacheRead: 200, cacheWrite: 0, reasoning: 0,
      messageCount: 3, cost: 1.25,
    },
    {
      client: 'pi', mergedClients: null, model: 'gpt-5.5', provider: 'nan',
      input: 2000, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0,
      messageCount: 1, cost: 0.75,
    },
    {
      client: 'claude', mergedClients: null, model: 'claude-opus-4-8', provider: 'anthropic',
      input: 500, output: 250, cacheRead: 0, cacheWrite: 0, reasoning: 0,
      messageCount: 2, cost: 2.0,
    },
  ],
};

test('parseTokscaleJson normalizes entries with token/cost/provider fields', () => {
  const records = parseTokscaleJson(fixture);
  assert.equal(records.length, 3);
  const first = records[0];
  assert.equal(first.client, 'pi');
  assert.equal(first.provider, 'openai-codex');
  assert.equal(first.modelKey, 'gpt-5-5');
  assert.equal(first.inputTokens, 1000);
  assert.equal(first.outputTokens, 500);
  assert.equal(first.cacheReadTokens, 200);
  assert.equal(first.cost, 1.25);
});

test('parseTokscaleJson tolerates malformed/empty entries', () => {
  assert.deepEqual(parseTokscaleJson({}), []);
  assert.deepEqual(parseTokscaleJson({ entries: [null, { model: '' }, { model: 42 }] }), []);
});

test('aggregateRecords merges providers per model and sums tokens/cost', () => {
  const { models, totalCost, totalTokens, totalMessages } = aggregateRecords(parseTokscaleJson(fixture));
  const gpt = models['gpt-5-5'];
  assert.deepEqual(gpt.providers, ['nan', 'openai-codex']);
  assert.equal(gpt.cost, 2.0); // 1.25 + 0.75
  assert.equal(gpt.tokens, 3800); // 1000+500+200 + 2000+100
  assert.equal(gpt.messageCount, 4);
  assert.equal(models['claude-opus-4-8'].providers[0], 'anthropic');
  assert.equal(totalCost, 4.0);
  assert.equal(totalTokens, 4550);
  assert.equal(totalMessages, 6);
});

test('diffUsage aligns ccusage keys through modelKey even when stored raw', () => {
  // ccusage's usage-by-model.json stores keys like "[pi] gpt-5.5" (raw),
  // while tokscale keys are normalized ("gpt-5-5"). Both must land on one row.
  const tokscaleModels = aggregateRecords(parseTokscaleJson(fixture)).models;
  const ccusageModels = {
    '[pi] gpt-5.5': { model: '[pi] gpt-5.5', cost: 2.0, tokens: 3800, days: 1 },
    'claude-opus-4-8': { model: 'claude-opus-4-8', cost: 2.0, tokens: 750, days: 1 },
    '[pi] kimi-k2p6-turbo': { model: '[pi] accounts/fireworks/routers/kimi-k2p6-turbo', cost: 10, tokens: 1000, days: 1 },
  };
  const diff = diffUsage(tokscaleModels, ccusageModels);
  // gpt-5.5 matched by normalized key, not double-counted
  assert.equal(diff.perModel['gpt-5-5'].ccusageCost, 2.0);
  assert.equal(diff.perModel['gpt-5-5'].tokscaleCost, 2.0);
  assert.equal(diff.perModel['gpt-5-5'].pctDiff, 0);
  // kimi only in ccusage
  assert.ok(diff.modelsOnlyInCcusage.includes('kimi-k2-6'));
  assert.equal(diff.perModel['kimi-k2-6'].ccusageCost, 10);
  assert.equal(diff.perModel['kimi-k2-6'].tokscaleCost, 0);
  // totals
  assert.equal(diff.ccusageTotal, 14.0);
  assert.equal(diff.tokscaleTotal, 4.0);
  assert.equal(diff.pctDiff, -71.4);
});

test('diffUsage reports models only visible to one side', () => {
  const tokscaleModels = aggregateRecords(parseTokscaleJson(fixture)).models;
  const ccusageModels = {
    '[pi] gpt-5.5': { model: '[pi] gpt-5.5', cost: 1, tokens: 100, days: 1 },
  };
  const diff = diffUsage(tokscaleModels, ccusageModels);
  assert.deepEqual(diff.modelsOnlyInCcusage, []);
  assert.deepEqual(diff.modelsOnlyInTokscale, ['claude-opus-4-8']);
});

test('tokscaleArgs builds ISO dates, group-by, and client filter', () => {
  assert.deepEqual(tokscaleArgs('20260501'), ['--json', '--no-spinner', '--group-by', 'client,provider,model', '--since', '2026-05-01']);
  assert.deepEqual(tokscaleArgs('2026-05-01', { clients: ['pi', 'claude'] }), [
    '--json', '--no-spinner', '--group-by', 'client,provider,model',
    '--since', '2026-05-01', '--client', 'pi,claude',
  ]);
});

test('toTokscaleDate normalizes and validates', () => {
  assert.equal(toTokscaleDate('20260501'), '2026-05-01');
  assert.equal(toTokscaleDate('2026-05-01'), '2026-05-01');
  assert.throws(() => toTokscaleDate('bogus'), /Invalid date/);
  assert.throws(() => toTokscaleDate('20260230'), /Invalid date/);
  assert.throws(() => toTokscaleDate('2026-13-01'), /Invalid date/);
});
