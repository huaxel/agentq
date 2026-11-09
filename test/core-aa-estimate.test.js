'use strict';
/**
 * AA intelligence estimates: the OLS calibration, the conservative estimate,
 * and the exact-identity rule that decides which models may calibrate at all.
 *
 * The six pairs are the real ones from data/roi-output.json against
 * data/aa-snapshot.json (complete ROI score + exact AA row), so the fit is
 * pinned to the data the dispatcher actually runs on.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ESTIMATE_SOURCE,
  MIN_PAIRS,
  SCORE_SOURCE,
  aaIndexFor,
  buildAaIndex,
  buildCalibration,
  calibrate,
  calibrationPairs,
  estimate,
} = require('../src/core/aa-estimate.js');

/** Real pairs: complete ROI models with an exact AA row (2026-11 snapshot). */
const REAL_PAIRS = [
  { model: 'thinkingmachines/inkling', aa: 12.5, genIntel: 42.756756756756765 },
  { model: 'minimax/minimax-m3', aa: 18.9, genIntel: 39.29459459459459 },
  { model: 'deepseek/deepseek-v4-pro', aa: 23.1, genIntel: 46.18108108108109 },
  { model: 'openai/gpt-5.6-luna', aa: 23.8, genIntel: 45.88999999999999 },
  { model: 'openai/gpt-5.6-terra', aa: 32.3, genIntel: 52.891891891891895 },
  { model: 'anthropic/claude-opus-5', aa: 44.2, genIntel: 65.97 },
];

function close(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} ± ${tolerance}, got ${actual}`,
  );
}

function aaRow(slug, index, extra = {}) {
  return { slug, evaluations: { artificial_analysis_intelligence_index: index }, ...extra };
}

test('the real six pairs reproduce the documented fit', () => {
  const cal = calibrate(REAL_PAIRS, { snapshotVersion: 'v3' });
  assert.equal(cal.disabled, undefined);
  assert.equal(cal.n, 6);
  close(cal.a, 27.85, 0.01, 'intercept');
  close(cal.b, 0.813, 0.001, 'slope');
  close(cal.r, 0.948, 0.001, 'correlation');
  // Sample residual standard error, sqrt(SSE / (n - 2)).
  close(cal.rmse, 3.393, 0.001, 'rmse');
  close(cal.minGen, 39.29459459459459, 1e-9, 'minGen');
  close(cal.maxGen, 65.97, 1e-9, 'maxGen');
  assert.equal(cal.minAa, 12.5);
  assert.equal(cal.maxAa, 44.2);
  assert.equal(cal.snapshotVersion, 'v3');
});

test('the estimate is the fit minus one residual error, capped and never lifted', () => {
  const cal = calibrate(REAL_PAIRS);
  // Inside the range: raw fit minus the residual standard error.
  close(estimate(cal, 26.1), 45.68, 0.01, 'mid-range estimate');
  close(estimate(cal, 35.5), 53.32, 0.01, 'grok-4.7 estimate');
  // Above the top AA value the fit would exceed the best scored model.
  assert.equal(estimate(cal, 54.5), cal.maxGen);
  assert.equal(estimate(cal, 99), cal.maxGen);
  // Below the calibration range there is no estimate (no downward
  // extrapolation, and never a lift to the weakest scored model).
  assert.equal(estimate(cal, 12.4), null);
  assert.equal(estimate(cal, 0), null);
  // At the bottom of the range the estimate may sit below every scored model.
  close(estimate(cal, 12.5), 34.62, 0.01, 'bottom-of-range estimate');
  // Every estimate is at most the raw fit and never above the best score.
  for (const pair of REAL_PAIRS) {
    const raw = cal.a + cal.b * pair.aa;
    const value = estimate(cal, pair.aa);
    assert.ok(value <= cal.maxGen, `estimate above the cap for ${pair.model}`);
    assert.ok(value < raw, `estimate must be below the raw fit for ${pair.model}`);
  }
});

test('an unusable calibration or AA value yields no estimate', () => {
  assert.equal(estimate(null, 30), null);
  assert.equal(estimate({ disabled: 'too few exact pairs (n=2, need 5)' }, 30), null);
  const cal = calibrate(REAL_PAIRS);
  assert.equal(estimate(cal, null), null);
  assert.equal(estimate(cal, undefined), null);
  assert.equal(estimate(cal, Number.NaN), null);
  assert.equal(estimate(cal, '35.5'), null);
});

test('fewer than five exact pairs disables estimates', () => {
  const cal = calibrate(REAL_PAIRS.slice(0, MIN_PAIRS - 1));
  assert.match(cal.disabled, /too few exact pairs \(n=4, need 5\)/);
  assert.equal(estimate(cal, 30), null);
});

test('a weak correlation disables estimates', () => {
  const noisy = [
    { aa: 10, genIntel: 40 },
    { aa: 20, genIntel: 60 },
    { aa: 30, genIntel: 42 },
    { aa: 40, genIntel: 62 },
    { aa: 50, genIntel: 44 },
  ];
  const cal = calibrate(noisy);
  assert.match(cal.disabled, /weak correlation \(r=0\.\d+ < 0\.85\)/);
});

test('a non-positive slope disables estimates', () => {
  const falling = [
    { aa: 10, genIntel: 60 },
    { aa: 20, genIntel: 55 },
    { aa: 30, genIntel: 50 },
    { aa: 40, genIntel: 45 },
    { aa: 50, genIntel: 40 },
  ];
  const cal = calibrate(falling);
  assert.match(cal.disabled, /non-positive slope/);
});

test('no spread in either axis disables estimates instead of dividing by zero', () => {
  const flatAa = Array.from({ length: 5 }, (_, i) => ({ aa: 20, genIntel: 40 + i }));
  assert.match(calibrate(flatAa).disabled, /no AA spread/);
  const flatScore = Array.from({ length: 5 }, (_, i) => ({ aa: 10 + i, genIntel: 40 }));
  assert.match(calibrate(flatScore).disabled, /no genIntel spread/);
});

test('non-finite pairs are ignored rather than poisoning the fit', () => {
  const withJunk = [...REAL_PAIRS, { aa: Number.NaN, genIntel: 50 }, { aa: 30, genIntel: null }, null];
  const cal = calibrate(withJunk);
  assert.equal(cal.n, 6);
  close(cal.b, 0.813, 0.001, 'slope is unchanged by the junk rows');
});

test('an exact AA row is required: folded and ambiguous slugs never match', () => {
  const snapshot = {
    models: [
      aaRow('grok-4-7', 35.5),
      aaRow('grok-4-7-thinking', 36.9),
      aaRow('claude-sonnet-5-5', 54.5),
      aaRow('claude-sonnet-5-5', 55.1),
      aaRow('mistral-large-4', null),
    ],
  };
  const index = buildAaIndex(snapshot);
  assert.equal(aaIndexFor(index, 'grok-4-7'), 35.5);
  // A folded variant is a different slug and must not answer for the model.
  assert.equal(aaIndexFor(index, 'grok-4-7-thinking'), 36.9);
  // Two rows claiming one slug are ambiguous: neither is used.
  assert.equal(aaIndexFor(index, 'claude-sonnet-5-5'), null);
  // A row with no index value is not an estimate source.
  assert.equal(aaIndexFor(index, 'mistral-large-4'), null);
  assert.equal(aaIndexFor(index, 'not-in-snapshot'), null);
  assert.equal(aaIndexFor(index, ''), null);
});

test('calibration pairs need a complete score and an exact AA row', () => {
  const roiModels = [
    { model: 'openai/gpt-5.6-terra', genIntel: 52.89, complete: true },
    { model: 'anthropic/claude-opus-5', genIntel: 65.97, complete: true },
    { model: 'openai/gpt-5.6-sol', genIntel: 59.32, complete: true },
    { model: 'openai/gpt-5.3-codex', genIntel: null, complete: false },
    { model: 'moonshotai/kimi-k2.6', genIntel: 42.6, complete: true },
  ];
  const registryRows = [
    { model: 'openai/gpt-5.6-terra', aaSlug: 'gpt-5-6-terra' },
    { model: 'openai/gpt-5.6-sol', aaSlug: 'gpt-5-6-sol' },
    // A pinned slug that differs from the model key is the only way such a
    // model can match at all.
    { model: 'moonshotai/kimi-k2.6', aaSlug: 'kimi-k2-6-official' },
  ];
  const snapshot = {
    models: [aaRow('gpt-5-6-terra', 32.3), aaRow('gpt-5-6-sol', null), aaRow('kimi-k2-6', 30), aaRow('kimi-k2-6-official', 31)],
  };

  const { pairs, skipped } = calibrationPairs({ roiModels, registryRows, snapshot });
  assert.deepEqual(pairs.map((p) => p.model), ['openai/gpt-5.6-terra', 'moonshotai/kimi-k2.6']);
  assert.equal(pairs[1].aa, 31, 'the pinned slug wins over the key match');
  const reasons = new Map(skipped.map((s) => [s.model, s.reason]));
  assert.match(reasons.get('anthropic/claude-opus-5'), /no exact AA row/);
  assert.match(reasons.get('openai/gpt-5.6-sol'), /pinned aaSlug "gpt-5-6-sol" has no index value/);
  assert.equal(reasons.has('openai/gpt-5.3-codex'), false, 'incomplete rows are not even considered');
});

test('buildCalibration reports the disabled reason and carries the snapshot version', () => {
  const snapshot = { intelligenceIndexVersion: 'v3', models: [] };
  const disabled = buildCalibration({ roiModels: [], registryRows: [], snapshot });
  assert.match(disabled.disabled, /too few exact pairs/);

  const models = [];
  const roiModels = [];
  REAL_PAIRS.forEach((pair, i) => {
    models.push(aaRow(`m-${i}`, pair.aa));
    roiModels.push({ model: `provider/m-${i}`, genIntel: pair.genIntel, complete: true });
  });
  const cal = buildCalibration({ roiModels, registryRows: [], snapshot: { intelligenceIndexVersion: 'v3', models } });
  assert.equal(cal.n, 6);
  assert.equal(cal.pairs, 6);
  assert.equal(cal.snapshotVersion, 'v3');
  assert.deepEqual(cal.skipped, []);
  close(cal.b, 0.813, 0.001, 'slope');
});

test('the source markers stay distinct', () => {
  assert.equal(SCORE_SOURCE, 'roi');
  assert.equal(ESTIMATE_SOURCE, 'aa-estimate');
});
