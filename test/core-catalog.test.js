'use strict';
/**
 * Catalog tests: config validation, the ROI join, and the guarantee that the
 * synthetic runnables fixture points at generated ROI rows.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildCatalog, loadRunnables } = require('../src/core/catalog.js');
const { subscriptionStatus } = require('../src/lib/subscriptions.js');
const { modelKey } = require('../src/lib/model-key.js');

const ROOT = path.join(__dirname, '..');
const FIXTURE_HOME = path.join(ROOT, 'testdata', 'home');
const FIXTURE_RUNNABLES = path.join(FIXTURE_HOME, 'config', 'runnables.json');

function writeTemp(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-runnables-'));
  const file = path.join(dir, 'runnables.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
}

test('synthetic runnables load with the expected shape', () => {
  const runnables = loadRunnables(FIXTURE_RUNNABLES);
  assert.ok(runnables.length > 0);
  for (const runnable of runnables) {
    assert.equal(typeof runnable.id, 'string');
    assert.ok(runnable.id.length > 0);
    assert.equal(typeof runnable.path, 'string');
    assert.ok(runnable.path.length > 0);
    assert.equal(typeof runnable.harness, 'string');
    assert.ok(runnable.modelKey === null || typeof runnable.modelKey === 'string');
  }
  const ids = new Set(runnables.map((r) => r.id));
  assert.equal(ids.size, runnables.length, 'runnable ids must be unique');
});

test('every go-path runnable is a pi model in the opencode-go namespace', () => {
  const goRunnables = loadRunnables(FIXTURE_RUNNABLES).filter((runnable) => runnable.path === 'go');
  assert.ok(goRunnables.length > 0, 'the go path must keep at least one runnable');
  for (const runnable of goRunnables) {
    // The go path is served by the pi provider only: a claude-harness entry
    // would name a model Claude Code cannot launch on this subscription.
    assert.equal(runnable.harness, 'pi', `${runnable.id} must run on the pi harness`);
    assert.match(runnable.id, /^opencode-go\/[^/]+$/, `${runnable.id} must be opencode-go/<model>`);
  }
});

test('no go-path runnable points at a free, contributor, preview or alpha tier', () => {
  // Those tiers are not the subscription's quota, so routing must never spend
  // a go window on them.
  const offenders = loadRunnables(FIXTURE_RUNNABLES)
    .filter((runnable) => runnable.path === 'go')
    .filter((runnable) => /-(free|contributor|preview|alpha)$/.test(runnable.id))
    .map((runnable) => runnable.id);
  assert.deepEqual(offenders, []);
});

test('runnables file rejects a wrong schema version', () => {
  const file = writeTemp({ schemaVersion: 2, runnables: [] });
  assert.throws(() => loadRunnables(file), /schemaVersion/);
});

test('runnables file rejects entries without an id or path', () => {
  const missingId = writeTemp({ schemaVersion: 1, runnables: [{ path: 'codex' }] });
  assert.throws(() => loadRunnables(missingId), /missing id/);
  const missingPath = writeTemp({ schemaVersion: 1, runnables: [{ id: 'x', path: '' }] });
  assert.throws(() => loadRunnables(missingPath), /missing path/);
});

test('runnables file rejects duplicate ids', () => {
  const file = writeTemp({
    schemaVersion: 1,
    runnables: [
      { id: 'a', path: 'codex' },
      { id: 'a', path: 'codex' },
    ],
  });
  assert.throws(() => loadRunnables(file), /duplicate id/);
});

test('catalog joins ROI rows by modelKey and leaves unmatched entries unscored', () => {
  const runnables = [
    { id: 'commandcode/deepseek/deepseek-v4-flash', path: 'commandcode', harness: 'pi', modelKey: 'deepseek-v4-flash' },
    { id: 'cursor/composer-2.5', path: 'cursor', harness: 'pi', modelKey: null },
    { id: 'ghost-model', path: 'codex', harness: 'pi', modelKey: 'no-such-model' },
  ];
  const roiModels = [
    { model: 'deepseek/deepseek-v4-flash', genIntel: 41.5, mtok: 0.12, tierHobby: 'Workhorse', speed: 90 },
  ];

  const catalog = buildCatalog({ runnables, roiModels });

  assert.deepEqual(catalog[0], {
    id: 'commandcode/deepseek/deepseek-v4-flash',
    path: 'commandcode',
    harness: 'pi',
    modelKey: 'deepseek-v4-flash',
    aaIndex: null,
    intelligence: 41.5,
    intelligenceSource: 'roi',
    calibration: null,
    costPerMTok: 0.12,
    costSource: 'roi',
    tier: 'Workhorse',
    speed: 90,
    scored: true,
    subscription: null,
  });
  for (const entry of catalog.slice(1)) {
    assert.equal(entry.scored, false);
    assert.equal(entry.intelligence, null);
    assert.equal(entry.costPerMTok, null);
    assert.equal(entry.tier, null);
    assert.equal(entry.speed, null);
  }
});

test('catalog treats a non-numeric score field as unknown, not zero', () => {
  const catalog = buildCatalog({
    runnables: [{ id: 'm', path: 'codex', harness: 'pi', modelKey: 'm' }],
    roiModels: [{ model: 'm', genIntel: null, mtok: 'free', tierHobby: null }],
  });
  // A row without a usable score is not a score: it is unscored (and may still
  // receive an AA estimate when a calibration and an exact AA row exist).
  assert.equal(catalog[0].scored, false);
  assert.equal(catalog[0].intelligence, null);
  assert.equal(catalog[0].intelligenceSource, null);
  assert.equal(catalog[0].costPerMTok, null);
});

test('the first ROI row wins when two rows fold to the same modelKey', () => {
  const catalog = buildCatalog({
    runnables: [{ id: 'm', path: 'codex', harness: 'pi', modelKey: 'model-one' }],
    roiModels: [
      { model: 'provider/model-one', genIntel: 10, mtok: 1 },
      { model: 'provider/model-one-fast', genIntel: 99, mtok: 9 },
    ],
  });
  assert.equal(catalog[0].intelligence, 10);
  assert.equal(catalog[0].costPerMTok, 1);
});

test('every non-null fixture modelKey matches a generated ROI row', () => {
  const childProcess = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-catalog-home-'));
  fs.cpSync(FIXTURE_HOME, home, { recursive: true });
  childProcess.execFileSync(process.execPath, [path.join(ROOT, 'src', 'roi-tracker', 'pipeline.js')], {
    env: { ...process.env, AGENTQ_HOME: home },
    stdio: 'pipe',
  });
  const roiFile = path.join(home, 'data', 'roi-output.json');
  const roi = JSON.parse(fs.readFileSync(roiFile, 'utf8'));
  const keys = new Set((roi.models || []).map((row) => modelKey(row.model)));
  const unmatched = loadRunnables(FIXTURE_RUNNABLES)
    .filter((runnable) => runnable.modelKey !== null && !keys.has(runnable.modelKey))
    .map((runnable) => `${runnable.id} (${runnable.modelKey})`);
  assert.deepEqual(unmatched, []);
});

const CALIBRATION = {
  n: 6,
  a: 27.851847352379963,
  b: 0.8131346266798746,
  r: 0.9478884888361071,
  rmse: 2.7706407696590007,
  minGen: 39.29459459459459,
  maxGen: 65.97,
  minAa: 12.5,
  maxAa: 44.2,
  snapshotVersion: 'v3',
};

function aaRow(slug, index) {
  return { slug, evaluations: { artificial_analysis_intelligence_index: index } };
}

test('an unscored runnable with an exact AA row gets a marked estimate', () => {
  const catalog = buildCatalog({
    runnables: [
      { id: 'xai/grok-4.7', path: 'xai', harness: 'pi', modelKey: null },
      { id: 'claude/claude-opus-5-5', path: 'claudemax', harness: 'claude', modelKey: null },
      { id: 'mistral/deepseek-v4-1-flash-1017', path: 'mistral', harness: 'pi', modelKey: 'deepseek-v4-1-flash' },
    ],
    roiModels: [{ model: 'deepseek/deepseek-v4-1-flash', genIntel: null, mtok: null }],
    aaSnapshot: { models: [aaRow('grok-4-7', 35.5), aaRow('claude-opus-5-5', 59.1), aaRow('deepseek-v4-1-flash', null)] },
    calibration: CALIBRATION,
  });

  const grok = catalog[0];
  assert.equal(grok.intelligenceSource, 'aa-estimate');
  assert.equal(grok.scored, false, 'an estimate is never a score');
  assert.equal(grok.aaIndex, 35.5);
  assert.ok(Math.abs(grok.intelligence - 53.95) < 0.01);
  assert.deepEqual(grok.calibration, {
    n: 6, r: CALIBRATION.r, rmse: CALIBRATION.rmse, snapshotVersion: CALIBRATION.snapshotVersion, generatedAt: null,
  });
  assert.equal(grok.costPerMTok, null, 'an estimated model without a price keeps the missing-cost behaviour');

  // An AA value above the calibrated range is capped at the best scored model.
  assert.equal(catalog[1].intelligence, CALIBRATION.maxGen);

  // The hosted runnable matches the model it hosts, not the host prefix; its
  // AA row exists but carries no index, so it stays unscored.
  assert.equal(catalog[2].aaIndex, null);
  assert.equal(catalog[2].intelligence, null);
  assert.equal(catalog[2].intelligenceSource, null);
});

test('an estimated entry with no ROI price is priced from its AA row', () => {
  const costBlend = { cache: 0.9174, input: 0.0781, output: 0.044 };
  const prices = { price_1m_input_tokens: 0.6, price_1m_output_tokens: 1.8, price_1m_cache_hit_tokens: 0.11 };
  const catalog = buildCatalog({
    runnables: [
      { id: 'opencode-go/glm-5.3', path: 'go', harness: 'pi', modelKey: null },
      { id: 'opencode-go/glm-5.2', path: 'go', harness: 'pi', modelKey: 'glm-5-2' },
    ],
    roiModels: [{ model: 'z-ai/glm-5.2', genIntel: 40, mtok: 0.54 }],
    aaSnapshot: { models: [{ slug: 'glm-5-3', pricing: prices, evaluations: { artificial_analysis_intelligence_index: 31.7 } }] },
    calibration: CALIBRATION,
    costBlend,
  });

  const estimated = catalog[0];
  assert.equal(estimated.intelligenceSource, 'aa-estimate');
  assert.equal(estimated.costSource, 'aa-price');
  assert.ok(Math.abs(estimated.costPerMTok - (0.9174 * 0.11 + 0.0781 * 0.6 + 0.044 * 1.8)) < 1e-12);
  assert.ok(estimated.costPerMTok > 0);

  const scored = catalog[1];
  assert.equal(scored.costSource, 'roi');
  assert.equal(scored.costPerMTok, 0.54, 'a registry price is never replaced by an AA one');
});

test('an estimated entry keeps a null cost when its AA prices are unusable', () => {
  const costBlend = { cache: 0.9174, input: 0.0781, output: 0.044 };
  for (const pricing of [
    { price_1m_input_tokens: 0.6, price_1m_output_tokens: 1.8, price_1m_cache_hit_tokens: 0 },
    { price_1m_input_tokens: 0, price_1m_output_tokens: 1.8, price_1m_cache_hit_tokens: 0.11 },
    { price_1m_input_tokens: 0.6, price_1m_output_tokens: 0, price_1m_cache_hit_tokens: 0.11 },
    undefined,
  ]) {
    const [entry] = buildCatalog({
      runnables: [{ id: 'opencode-go/glm-5.3', path: 'go', harness: 'pi', modelKey: null }],
      roiModels: [],
      aaSnapshot: { models: [{ slug: 'glm-5-3', pricing, evaluations: { artificial_analysis_intelligence_index: 31.7 } }] },
      calibration: CALIBRATION,
      costBlend,
    });
    assert.equal(entry.intelligenceSource, 'aa-estimate', JSON.stringify(pricing));
    assert.equal(entry.costPerMTok, null, JSON.stringify(pricing));
    assert.equal(entry.costSource, null);
  }
});

test('an estimated entry with no cache price is priced at the input price', () => {
  const costBlend = { cache: 0.9174, input: 0.0781, output: 0.044 };
  const [entry] = buildCatalog({
    runnables: [{ id: 'opencode-go/qwen3.5-27b', path: 'go', harness: 'pi', modelKey: null }],
    roiModels: [],
    aaSnapshot: {
      models: [{
        slug: 'qwen3-5-27b',
        // AA lists no cache-hit price for a model without prompt caching.
        pricing: { price_1m_input_tokens: 0.3, price_1m_output_tokens: 2.4, price_1m_cache_hit_tokens: null },
        evaluations: { artificial_analysis_intelligence_index: 30 },
      }],
    },
    calibration: CALIBRATION,
    costBlend,
  });
  assert.equal(entry.costSource, 'aa-price');
  assert.ok(Math.abs(entry.costPerMTok - (0.9174 * 0.3 + 0.0781 * 0.3 + 0.044 * 2.4)) < 1e-12);
});

test('an unscored entry with no estimate is never priced from AA', () => {
  const [entry] = buildCatalog({
    runnables: [{ id: 'opencode-go/no-index', path: 'go', harness: 'pi', modelKey: null }],
    roiModels: [],
    aaSnapshot: { models: [{ slug: 'no-index', pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 2, price_1m_cache_hit_tokens: 0.5 } }] },
    calibration: CALIBRATION,
    costBlend: { cache: 0.9174, input: 0.0781, output: 0.044 },
  });
  assert.equal(entry.intelligence, null);
  assert.equal(entry.costPerMTok, null);
  assert.equal(entry.costSource, null);
});

test('an exact ROI score always wins over an estimate', () => {
  const catalog = buildCatalog({
    runnables: [{ id: 'openai-codex/gpt-5.6-terra', path: 'codex', harness: 'pi', modelKey: 'gpt-5-6-terra' }],
    roiModels: [{ model: 'openai/gpt-5.6-terra', genIntel: 52.89, mtok: 1.08 }],
    aaSnapshot: { models: [aaRow('gpt-5-6-terra', 32.3)] },
    calibration: CALIBRATION,
  });
  assert.equal(catalog[0].intelligence, 52.89);
  assert.equal(catalog[0].intelligenceSource, 'roi');
  assert.equal(catalog[0].scored, true);
  assert.equal(catalog[0].calibration, null);
  assert.equal(catalog[0].aaIndex, 32.3, 'the AA value is still reported for cross-checking');
});

test('no calibration, no snapshot, or no exact AA row leaves a runnable unscored', () => {
  const runnables = [{ id: 'xai/grok-4.7', path: 'xai', harness: 'pi', modelKey: null }];
  const snapshot = { models: [aaRow('grok-4-7', 35.5), aaRow('grok-4-7-thinking', 36.9)] };

  for (const input of [
    { aaSnapshot: snapshot, calibration: null },
    { aaSnapshot: snapshot, calibration: { disabled: 'too few exact pairs (n=2, need 5)' } },
    { aaSnapshot: null, calibration: CALIBRATION },
    { aaSnapshot: { models: [aaRow('grok-4-7-thinking', 36.9)] }, calibration: CALIBRATION },
  ]) {
    const [entry] = buildCatalog({ runnables, roiModels: [], ...input });
    assert.equal(entry.intelligence, null, JSON.stringify(input));
    assert.equal(entry.intelligenceSource, null);
    assert.equal(entry.scored, false);
  }
});

test('subscription status follows the roi.config paths that fund a quota path', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  const subscriptions = [
    { id: 'codex', startDate: '20260101', endDate: '20260910' },
    { id: 'codexprolite', sourcePath: 'codex', startDate: '20260910' },
    { id: 'commandcode', startDate: '20260721', endDate: '20260821' },
    { id: 'later', startDate: '20270101' },
    { id: 'today', startDate: '20261108', endDate: '20261108' },
  ];
  assert.deepEqual(subscriptionStatus(subscriptions, 'codex', now), { state: 'active', ids: ['codexprolite'], endDate: null });
  assert.deepEqual(subscriptionStatus(subscriptions, 'commandcode', now), { state: 'ended', ids: ['commandcode'], endDate: '20260821' });
  assert.equal(subscriptionStatus(subscriptions, 'later', now).state, 'not-started');
  assert.equal(subscriptionStatus(subscriptions, 'today', now).state, 'active', 'start and end dates are inclusive');
  assert.deepEqual(subscriptionStatus(subscriptions, 'nowhere', now), { state: 'unconfigured', ids: [], endDate: null });

  const catalog = buildCatalog({
    runnables: [{ id: 'm', path: 'commandcode', harness: 'pi', modelKey: null }],
    subscriptions,
    now,
  });
  assert.equal(catalog[0].subscription?.state, 'ended');
});

test('a registry-pinned aaSlug decides the AA row for a runnable, not its key', () => {
  const catalog = buildCatalog({
    runnables: [{ id: 'xai/grok-4.7', path: 'xai', harness: 'pi', modelKey: null }],
    registryRows: [{ model: 'x-ai/grok-4.7', aaSlug: 'grok-4-7-reasoning' }],
    aaSnapshot: { models: [aaRow('grok-4-7', 20), aaRow('grok-4-7-reasoning', 35.5)] },
    calibration: CALIBRATION,
  });
  assert.equal(catalog[0].aaIndex, 35.5, 'the pinned slug wins over the key match');
  assert.equal(catalog[0].intelligenceSource, 'aa-estimate');
});
