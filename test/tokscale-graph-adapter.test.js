'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseGraphJson,
  aggregateDatedModels,
  graphArgs,
} = require('../src/roi-tracker/tokscale-graph-adapter.js');

// Shape mirroring `tokscale graph --json` (4.9.0) contributions.
const graph = {
  meta: { version: '4.9.0' },
  summary: { totalCost: 3.25 },
  contributions: [
    {
      date: '2026-05-06',
      clients: [
        { client: 'pi', modelId: 'gpt-5.5', providerId: 'openai-codex', tokens: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0, reasoning: 0 }, cost: 1.25, messages: 3 },
        { client: 'claude', modelId: 'claude-opus-4-8', providerId: 'anthropic', tokens: { input: 500, output: 250, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 2.0, messages: 2 },
      ],
    },
    {
      date: '2026-05-07',
      clients: [
        { client: 'pi', modelId: 'gpt-5.5', providerId: 'nan', tokens: { input: 2000, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0.75, messages: 1 },
      ],
    },
  ],
};

test('parseGraphJson emits dated per-day/provider/model records', () => {
  const records = parseGraphJson(graph);
  assert.equal(records.length, 3);
  const first = records[0];
  assert.equal(first.date, '2026-05-06');
  assert.equal(first.client, 'pi');
  assert.equal(first.provider, 'openai-codex');
  assert.equal(first.modelKey, 'gpt-5-5');
  assert.equal(first.inputTokens, 1000);
  assert.equal(first.cacheReadTokens, 200);
  assert.equal(first.cost, 1.25);
  // DATED — the key difference from the aggregate adapter (which is date-less).
  assert.ok(first.date, 'graph records must carry a date');
});

test('parseGraphJson tolerates malformed/empty input', () => {
  assert.deepEqual(parseGraphJson({}), []);
  assert.deepEqual(parseGraphJson({ contributions: [{ date: 'x', clients: [null, { modelId: '' }, { modelId: 5 }] }, {}] }), []);
  // a day with no clients array is fine
  assert.deepEqual(parseGraphJson({ contributions: [{ date: '2026-05-06' }] }), []);
});

test('aggregateDatedModels merges per-model totals with a day count', () => {
  const models = aggregateDatedModels(parseGraphJson(graph));
  const gpt = models['gpt-5-5'];
  assert.equal(gpt.cost, 2.0); // 1.25 + 0.75
  assert.equal(gpt.tokens, 3800); // 1000+500+200 + 2000+100
  assert.equal(gpt.days, 2); // appeared on both days
  assert.equal(models['claude-opus-4-8'].days, 1);
});

test('graphArgs builds --since with ISO date and client filter', () => {
  // NOTE: `graph` rejects the top-level --json flag; it always emits JSON.
  assert.deepEqual(graphArgs('20260501'), ['graph', '--no-spinner', '--since', '2026-05-01']);
  assert.deepEqual(
    graphArgs('2026-05-01', { clients: ['pi', 'claude'] }),
    ['graph', '--no-spinner', '--since', '2026-05-01', '--client', 'pi,claude'],
  );
});