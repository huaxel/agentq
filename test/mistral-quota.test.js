'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { fetchMistralQuotaEntry } = require('../src/lib/provider-usage.js');
const { resolveAutoModel } = require('../src/core/auto-model.js');
const { buildCatalog } = require('../src/core/catalog.js');
const { CHEAP_MODEL, STRONG_MODEL, writeRoutingFixture } = require('./helpers/routing-fixture.js');

test('an installed fetcher without fetchMistralUsage reports that instead of a window', async () => {
  const result = await fetchMistralQuotaEntry({ load: async () => ({}) });
  assert.match(result.error ?? '', /needs >= 0\.3\.6/);
  assert.equal(result.windows, undefined);
});

test('mistral allowance windows map onto quota entries', async () => {
  const fetchedAt = Date.parse('2026-11-08T12:00:00Z');
  const result = await fetchMistralQuotaEntry({
    load: async () => ({
      fetchMistralUsage: async () => ({
        provider: 'Mistral',
        fetchedAt,
        windows: [
          { label: 'Month', usedPercent: 0, resetsAt: '2026-12-01T00:00:00.000Z', resetDescription: 'EUR 0 / 12.75' },
          { label: 'Vibe', usedPercent: 140, resetsIn: '22d' },
        ],
      }),
    }),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.updatedAt, new Date(fetchedAt).toISOString());
  assert.deepEqual(result.windows.map((w) => [w.label, w.usedPercent]), [['Month', 0], ['Vibe', 100]]);
  assert.equal(result.windows[1].resetsAt, null);
  assert.equal(result.windows[1].resetDescription, '22d');
  // Both windows come from the monthly billing budget, so the period carries
  // the duration their labels do not name.
  assert.deepEqual(result.windows.map((w) => w.period), ['monthly', 'monthly']);
});

test('a fetcher error or an empty allowance is an error, not a window', async () => {
  const failing = await fetchMistralQuotaEntry({
    load: async () => ({ fetchMistralUsage: async () => ({ windows: [], error: 'allowance-not-exposed', fetchedAt: 0 }) }),
  });
  assert.equal(failing.error, 'allowance-not-exposed');
  const empty = await fetchMistralQuotaEntry({
    load: async () => ({ fetchMistralUsage: async () => ({ windows: [], fetchedAt: 0 }) }),
  });
  assert.match(empty.error ?? '', /no windows/);
});

test('resolveAutoModel honours an injected roiConfigPath', () => {
  const fixture = writeRoutingFixture();
  const base = {
    tier: 'big',
    quotaPath: fixture.quotaPath,
    roiOutputPath: fixture.roiOutputPath,
    runnablesPath: fixture.runnablesPath,
    now: fixture.now,
  };
  assert.equal(resolveAutoModel('auto', { ...base, roiConfigPath: fixture.roiConfigPath }).model, STRONG_MODEL);

  const ended = path.join(fixture.root, 'config', 'ended.json');
  fs.writeFileSync(ended, JSON.stringify({ paths: [
    { id: 'mistral', type: 'Wallet', fee: 1, startDate: '20260101' },
    { id: 'codex', type: 'Wallet', fee: 1, startDate: '20260101', endDate: '20260201' },
  ] }));
  // With codex ended, big tier has no eligible model (the cheap one is below the floor).
  assert.throws(() => resolveAutoModel('auto', { ...base, roiConfigPath: ended }), /subscription ended/);
  assert.equal(resolveAutoModel('auto', { ...base, tier: 'small', roiConfigPath: ended }).model, CHEAP_MODEL);
});

test('a malformed subscription date fails loudly instead of comparing lexically', () => {
  assert.throws(
    () => buildCatalog({
      runnables: [{ id: 'm', path: 'codex', harness: 'pi', modelKey: null }],
      subscriptions: [{ id: 'codex', startDate: '2026-9-10' }],
    }),
    /invalid date "2026-9-10"/,
  );
});
