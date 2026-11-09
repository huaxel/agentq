'use strict';
/**
 * Integration smoke test for the pipeline orchestrator. The scoring fidelity is
 * already pinned by `npm run verify` against the xlsx golden; this guards the
 * wiring — that run() joins config + benchmark inputs + machine usage into the
 * canonical output shape every renderer depends on. Reads committed data only
 * (optional pricing/quota files are absent in a fresh checkout). Run `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  run,
  buildRollup,
  isStaleSnapshot,
  readMachineData,
  subMonths,
  quotaWindowKind,
  quotaWindowMultiplier,
  unscorableModels,
  buildCoverage,
  findFreeScoredModels,
} = require('../src/roi-tracker/pipeline.js');
const { dateFilteredValueRun } = require('../src/roi-tracker/pipeline-machine.js');

const ROOT = path.join(__dirname, '..');
// run() reads the agentq home, never the checkout. Copy the complete
// synthetic fixture home to a temp directory so test writes stay isolated.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-pipeline-home-'));
fs.cpSync(path.join(ROOT, 'testdata', 'home'), HOME, { recursive: true });
process.env.AGENTQ_HOME = HOME;

test('findFreeScoredModels flags complete models with no list price', () => {
  const models = [
    { model: 'priced', complete: true, mtok: 2.5 },
    { model: 'free-scored', complete: true, mtok: 0 },
    { model: 'no-price-field', complete: true },
    { model: 'incomplete', complete: false, mtok: 0 },
  ];
  assert.deepEqual(findFreeScoredModels(models).map(m => m.model), ['free-scored', 'no-price-field']);
});

test('buildCoverage counts actionable unscored usage with spend', () => {
  const models = [
    { model: 'claude-opus-5', registered: true, complete: true },
    { model: 'openai/gpt-5.6-luna', registered: true, complete: true },
    { model: 'composer-2-5-fast', registered: false, usage: { cost: 54.16 } },
    { model: 'kilo-auto/free', registered: false, usage: { cost: 0 } },
    { model: 'unknown', registered: false, usage: { cost: 0 } },
  ];
  const cov = buildCoverage(models, { unscorableModels: ['free', 'default', 'auto'] });
  assert.equal(cov.scored, 2);
  assert.equal(cov.unscored, 3);
  assert.equal(cov.unscoredActionable, 1);
  assert.equal(cov.unscoredSpend, 54.16);
  assert.equal(cov.incomplete, 0);
});

test('buildCoverage counts registered-but-incomplete models', () => {
  const models = [
    { model: 'openai/gpt-5.3-codex', registered: true, complete: false },
    { model: 'anthropic/claude-opus-4.6', registered: true, complete: false },
    { model: 'anthropic/claude-opus-5', registered: true, complete: true },
  ];
  const cov = buildCoverage(models, { unscorableModels: [] });
  assert.equal(cov.scored, 1);
  assert.equal(cov.incomplete, 2);
});

test('unscorableModels folds config placeholders and virtual rollups', () => {
  const policy = new Set(unscorableModels({ unscorableModels: ['free', 'Default'] }));
  assert.ok(policy.has('free'));
  assert.ok(policy.has('default'));
  assert.ok(policy.has('unknown'));
  assert.ok(policy.has('<synthetic>'));
  assert.ok(!policy.has('gpt-5-5'));
});

test('run() emits the canonical output shape', () => {
  const out = run();

  assert.ok(typeof out.generatedAt === 'string', 'has a generatedAt timestamp');
  assert.deepEqual(out.profiles, ['tax', 'hobby']);

  // One economics row per configured path, each with a derived effMult.
  assert.ok(Array.isArray(out.economics) && out.economics.length > 0);
  for (const p of out.economics) {
    assert.ok(typeof p.id === 'string');
    assert.ok(typeof p.effMult === 'number');
  }

  // Models carry the renderer contract: id, completeness flag, and the
  // list/usage join slots (which may be null but must be present).
  assert.ok(Array.isArray(out.models) && out.models.length > 0);
  for (const m of out.models) {
    assert.ok(typeof m.model === 'string');
    assert.equal(typeof m.complete, 'boolean');
    assert.ok('list' in m && 'usage' in m);
  }

  // Complete models get a numeric capability under both profiles.
  for (const m of out.models.filter(x => x.complete)) {
    assert.equal(typeof m.capTax, 'number');
    assert.equal(typeof m.capHobby, 'number');
  }

  // Registered-but-incomplete models must say which partitions are missing.
  for (const m of out.models.filter(x => x.registered && !x.complete)) {
    assert.ok(Array.isArray(m.missingPartitions) && m.missingPartitions.length > 0);
    for (const p of m.missingPartitions) {
      assert.ok(['agents', 'coding', 'general', 'scientific'].includes(p));
    }
  }

  assert.ok(out.usage && typeof out.usage.total === 'number');
  const modelUsageTotal = out.models.reduce((sum, m) => sum + (m.usage?.cost || 0), 0);
  assert.ok(Math.abs(modelUsageTotal - out.usage.total) <= 0.01, `model sum ${modelUsageTotal} differs from total ${out.usage.total}`);
});

test('isStaleSnapshot is false when a machine collected data on the snapshot date', () => {
  const stale = isStaleSnapshot('2026-07-05', [{ host: 'a', generatedAt: '2026-07-05T09:00:00Z' }]);
  assert.equal(stale, false);
});

test('isStaleSnapshot is true when the freshest collection was on an earlier day', () => {
  const stale = isStaleSnapshot('2026-07-05', [{ host: 'a', generatedAt: '2026-07-03T13:37:00Z' }]);
  assert.equal(stale, true);
});

test('isStaleSnapshot is true when there is no usage source at all', () => {
  assert.equal(isStaleSnapshot('2026-07-05', []), true);
  assert.equal(isStaleSnapshot('2026-07-05', undefined), true);
});

test('isStaleSnapshot uses the freshest of multiple machines', () => {
  const machines = [
    { host: 'a', generatedAt: '2026-07-03T00:00:00Z' },
    { host: 'b', generatedAt: '2026-07-05T00:00:00Z' },
  ];
  assert.equal(isStaleSnapshot('2026-07-05', machines), false);
});

test('subMonths caps a future end date at the measurement time', () => {
  const now = Date.parse('2026-08-09T00:00:00Z');
  const months = subMonths({ startDate: '20260721', endDate: '20260821' }, 3, now);
  assert.ok(Math.abs(months - (19 / 30.44)) < 1e-9);
});

test('date filtering falls back to complete model records when provider attribution is partial', () => {
  const path = {
    id: 'claudemax',
    startDate: '20260610',
    endDate: '20260710',
    costModels: ['claude-'],
  };
  const value = dateFilteredValueRun(
    [
      { date: '2026-06-15', model: 'claude-opus-5', cost: 80 },
      { date: '2026-07-15', model: 'claude-opus-5', cost: 120 },
    ],
    // Only the post-window row has provider attribution. Using it alone would
    // incorrectly report zero value for the Max period.
    [{ pathId: 'claudemax', date: '2026-07-15', model: 'claude-opus-5', cost: 120 }],
    { 'claude-opus-5': { cost: 200 } },
    path,
    200,
  );
  assert.equal(value, 80);
});

test('date filtering ignores date-less usage records in the split ratio', () => {
  const path = {
    id: 'claudemax',
    startDate: '20260610',
    endDate: '20260710',
    costModels: ['claude-'],
  };
  // A date-less record must not inflate the denominator while never
  // matching the window — without the guard the split would be 80/1000.
  const value = dateFilteredValueRun(
    [
      { date: '2026-06-15', model: 'claude-opus-5', cost: 80 },
      { date: '2026-07-15', model: 'claude-opus-5', cost: 120 },
      { date: null, model: 'claude-opus-5', cost: 800 },
    ],
    [],
    { 'claude-opus-5': { cost: 1000 } },
    path,
    1000,
  );
  assert.equal(value, 400); // 1000 * 80/200, not 1000 * 80/1000
});

test('date filtering rejects non-ISO placeholder dates in both strategies', () => {
  const path = {
    id: 'claudemax',
    startDate: '20260610',
    endDate: '20260710',
    costModels: ['claude-'],
  };
  // 'unknown' collates above any window start ('u' > '2') — without the
  // shape guard it would count as in-window with no endDate, or inflate
  // the denominator with one.
  const datedOnly = dateFilteredValueRun(
    [
      { date: '2026-06-15', model: 'claude-opus-5', cost: 80 },
      { date: '2026-07-15', model: 'claude-opus-5', cost: 120 },
      { date: 'unknown', model: 'claude-opus-5', cost: 800 },
    ],
    [],
    { 'claude-opus-5': { cost: 1000 } },
    path,
    1000,
  );
  assert.equal(datedOnly, 400);
});

test('quota windows normalize labels and convert weekly value to monthly value', () => {
  assert.equal(quotaWindowKind('weekly (sub-1)'), 'weekly');
  assert.equal(quotaWindowKind('5h'), '5-hour');
  assert.equal(quotaWindowMultiplier('monthly'), 1);
  assert.ok(Math.abs(quotaWindowMultiplier('weekly') - 30.44 / 7) < 1e-9);
});

test('buildRollup converts a weekly quota projection to monthly ROI', () => {
  const now = Date.parse('2026-08-09T12:00:00Z');
  const [row] = buildRollup([
    {
      id: 'codex', name: 'Codex', type: 'Wallet', fee: 20, valueRun: 100,
      months: 1, startDate: '20260602', quota: {
        windows: [{ label: 'weekly', usedPercent: 50, resetsAt: '2026-08-15T20:00:00Z' }],
      },
    },
  ], [{ since: '20260801', generatedAt: '2026-08-09T00:00:00Z' }], [
    { pathId: 'codex', date: '2026-08-08', cost: 10 },
  ], now).subs;
  assert.equal(row.usedPct, 50);
  assert.ok(Math.abs(row.quotaValuePerMonth - (20 * 30.44 / 7)) < 0.01);
  assert.ok(Math.abs(row.quotaRoi - (30.44 / 7)) < 0.01);
});

test('buildRollup keeps monthly quota value aligned with the monthly fee', () => {
  const now = Date.parse('2026-08-09T12:00:00Z');
  const [row] = buildRollup([
    {
      id: 'go', name: 'Go', type: 'Wallet', fee: 20, valueRun: 100,
      months: 1, startDate: '20260731', quota: {
        windows: [{ label: 'monthly (sub-1)', usedPercent: 50 }],
      },
    },
  ], [{ since: '20260801', generatedAt: '2026-08-09T00:00:00Z' }], [
    { pathId: 'go', date: '2026-08-01', cost: 10 },
  ], now).subs;
  assert.equal(row.usedPct, 50);
  assert.equal(row.quotaValuePerMonth, 20);
  assert.equal(row.quotaRoi, 1);
});

test('buildRollup monthly quota fallback uses per-month value, not the full window', () => {
  const now = Date.parse('2026-08-09T12:00:00Z');
  // No startDate => currentPeriodRun returns null for a monthly window, so the
  // projection must fall back to valuePerMonth (90) rather than valueTotal (270,
  // a 3-month window), which would overstate the quota ROI.
  const [row] = buildRollup([
    {
      id: 'nodate', name: 'NoDate', type: 'Wallet', fee: 20, valueRun: 270,
      months: 3, quota: {
        windows: [{ label: 'monthly', usedPercent: 50 }],
      },
    },
  ], [{ since: '20260501', generatedAt: '2026-08-09T00:00:00Z' }], [], now).subs;
  assert.equal(row.quotaValuePerMonth, 180); // 90 / 0.5
  assert.equal(row.quotaRoi, 9);
});

test('readMachineData skips corrupt bundles and reports reconciliation errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-corrupt-bundle-'));
  try {
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not-json');
    fs.writeFileSync(path.join(dir, 'wrong-shape.json'), JSON.stringify({
      hostname: 'wrong-shape',
      valueRun: { go: 99 },
      usageRecords: { not: 'an array' },
    }));
    fs.writeFileSync(path.join(dir, 'bad-record.json'), JSON.stringify({
      hostname: 'bad-record',
      valueRun: { go: 50 },
      providerUsageRecords: [{ cost: 2 }],
    }));
    fs.writeFileSync(path.join(dir, 'valid.json'), JSON.stringify({
      usageSchemaVersion: 1,
      providerUsageSource: '__proto__',
      hostname: 'valid-host',
      generatedAt: '2026-08-09T00:00:00Z',
      since: '20260501',
      valueRun: { go: 2 },
      usageByModel: { model: { model: 'model', cost: 2, tokens: 10 } },
      usageRecords: [
        { recordId: 'duplicate-id', date: '2026-08-09', model: 'model', cost: 1 },
        { recordId: 'duplicate-id', date: '2026-08-09', model: 'model', cost: 1 },
      ],
      providerUsageRecords: [],
    }));
    const result = readMachineData(dir);
    assert.equal(result.valueRun.go, 2);
    assert.equal(result.machines.length, 1);
    assert.equal(result.reconciliation.bundleCount, 4);
    assert.equal(result.reconciliation.validBundleCount, 1);
    assert.equal(result.reconciliation.skippedBundleCount, 3);
    assert.equal(result.reconciliation.errors.length, 3);
    assert.deepEqual(result.reconciliation.errors.map(error => error.file).sort(), [
      'bad-record.json', 'broken.json', 'wrong-shape.json',
    ]);
    assert.deepEqual(result.reconciliation.usageRecordIds, { present: 2, missing: 0, duplicates: 1 });
    assert.equal(Object.hasOwn(result.reconciliation.providerSources, '__proto__'), true);
    assert.equal(Reflect.get(result.reconciliation.providerSources, '__proto__'), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readMachineData does not double-count tokscale-mode bundles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-usage-imports-'));
  try {
    // tokscale-mode bundle: usageByModel IS the tokscale scan's per-model
    // totals, and providerUsageRecords are the SAME scan (date-less records
    // routed to a path). Merging them additively would double count. Costs are
    // picked so the pipeline's reprice loop (MIN_PLAUSIBLE_BLEND) is a no-op:
    // $10 on 1200 tokens >> $0.10/Mtok.
    const tsBundle = {
      hostname: 'ts-box',
      since: '20260501',
      generatedAt: '2026-08-01T00:00:00Z',
      valueRun: { claudemax: 20, cursor: 3 },
      usageByModel: {
        'claude-opus-5': { model: 'claude-opus-5', cost: 20, tokens: 1200, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
        'composer-2-5': { model: 'composer-2.5', cost: 3, tokens: 300, inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      usageRecords: [],
      providerUsageSource: 'tokscale',
      providerUsageRecords: [
        // tokscale's own aggregate scan record — date-less, origin tokscale,
        // already in usageByModel, must NOT be re-merged.
        { date: null, pathId: 'claudemax', origin: 'tokscale', provider: 'anthropic', model: 'claude-opus-5', cost: 20, tokens: 1200, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
        // tokscale-graph mode emits DATED main-scan records — same origin, also
        // already in usageByModel, must NOT be re-merged either.
        { date: '2026-05-01', pathId: 'claudemax', origin: 'tokscale', provider: 'anthropic', model: 'claude-sonnet-5', cost: 15, tokens: 900, inputTokens: 700, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
        // Main Cursor record is already in usageByModel.
        { date: null, pathId: 'cursor', origin: 'tokscale', provider: 'cursor', model: 'composer-2.5', cost: 3, tokens: 300, inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
        // Legacy Cursor aggregate record — metadata casing varies in old
        // bundles, but it is still a duplicate and must not merge.
        { date: null, pathId: 'Cursor', origin: 'CURSOR', provider: 'cursor', model: 'composer-2.5', cost: 2, tokens: 300, inputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ],
    };
    // pi-mode bundle: providerUsageRecords (pi session scanner) are the
    // AUTHORITATIVE when its token coverage is comparable; ccusage-daily
    // usageByModel wins when provider records cover only a subset (gpt-5.5).
    // A model absent from provider records (claude-user) gets usageByModel.
    const piBundle = {
      hostname: 'pi-box',
      since: '20260501',
      generatedAt: '2026-08-01T00:00:00Z',
      valueRun: { openrouter: 5 },
      usageByModel: {
        'gpt-5-5': { model: 'gpt-5.5', cost: 10, tokens: 1200, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
        'claude-sonnet-4-6': { model: 'claude-sonnet-4-6', cost: 7, tokens: 900, inputTokens: 700, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
        // A provider record with no usable price must not suppress a valid
        // ccusage fallback for the same model.
        'claude-future-9': { model: 'claude-future-9', cost: 7, tokens: 12000, inputTokens: 10000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      usageRecords: [],
      providerUsageRecords: [
        { date: '2026-05-01', pathId: 'openrouter', provider: 'openai-codex', model: 'gpt-5.5', cost: 3, tokens: 300, inputTokens: 250, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        { date: '2026-05-01', pathId: 'claudemax', provider: 'claude', model: 'claude-future-9', cost: 0, tokens: 12000, inputTokens: 10000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ],
    };
    fs.writeFileSync(path.join(dir, 'ts-box.json'), JSON.stringify(tsBundle));
    fs.writeFileSync(path.join(dir, 'pi-box.json'), JSON.stringify(piBundle));

    const m = readMachineData(dir);
    // tokscale claude-opus-5 counted ONCE (20) — its own date-less record
    // (20 + 20 would be 40) is skipped.
    assert.equal(m.usageByModel['claude-opus-5'].cost, 20);
    // tokscale-graph dated claude-sonnet-5 counted ONCE (15 — set in
    // usageByModel? no: only claude-opus-5 is in this bundle's usageByModel, so
    // sonnet-5 must come through as absent — it's a main-scan record skipped
    // from merging, so it does NOT appear in usageByModel). Assert absent, since
    // a real graph bundle would set it in usageByModel too; skipping the merge
    // keeps it out here.
    assert.equal(m.usageByModel['claude-sonnet-5'], undefined);
    // Main Cursor usage remains at its original cost; legacy aggregate rows
    // are skipped in tokscale bundles.
    assert.equal(m.usageByModel['composer-2-5'].cost, 3);
    // pi-mode: the provider record covers only part of gpt-5.5's tokens, so
    // the more complete ccusage source wins rather than dropping that usage.
    assert.equal(m.usageByModel['gpt-5-5'].cost, 10);
    // pi-mode model ABSENT from provider records is gap-filled from usageByModel.
    assert.equal(m.usageByModel['claude-sonnet-4-6'].cost, 7);
    // An unpriced provider record does not hide valid usageByModel data.
    assert.equal(m.usageByModel['claude-future-9'].cost, 7);
    // Two distinct machines => valueRun merges additively across machines.
    assert.equal(m.valueRun.claudemax, 20);
    assert.equal(m.valueRun.openrouter, 5);
    assert.equal(m.valueRun.cursor, 3);
    // tokscale aggregate records (date null) go to pathModelUsage but NOT
    // pathUsageRecords (Strategy A needs dates). The dated graph record and
    // pi records do; the legacy Cursor duplicate is filtered entirely.
    // claude-sonnet-4-6 is usageByModel-only, so it appears in usageByModel
    // but not pathModelUsage.
    assert.equal(Object.keys(m.pathModelUsage).length, 5);
    assert.equal(m.pathModelUsage['cursor||composer-2.5'].cost, 3);
    assert.equal(m.pathUsageRecords.length, 3);
    const rpcIds = new Set(m.pathUsageRecords.map(r => r.pathId));
    assert.deepEqual([...rpcIds].sort(), ['claudemax', 'openrouter']);
    // tokscale per-path model breakdown keeps 20 for claudemax.
    assert.equal(m.pathModelUsage['claudemax||claude-opus-5'].cost, 20);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
