'use strict';
/**
 * Unit tests for score.js — declared path coverage -> bestPath/minCost scoring.
 * Fidelity against the xlsx golden is pinned by `npm run verify`; this covers
 * the config-driven path iteration: which paths compete is `paths[].models`,
 * and the label comes from `paths[].name`. Run with `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildScores } = require('../src/roi-tracker/score.js');

/**
 * These fixtures carry `cachePrice: 0` (their costBlend weights cache at 0), so
 * score.js's registry-gap warning would print on every run. It is covered by
 * test/score-cost-blend.test.js; quiet it here.
 */
function quiet(t) {
  t.mock.method(console, 'warn', () => {});
}

const baseModel = {
  model: 'test-model',
  cachePrice: 0, inputPrice: 10, outputPrice: 30,
  gdpval: 0.5, tau3Banking: 0.5, apexAgents: 0.5, terminalBench: 0.5, sciCode: 0.5,
  aaLcr: 0.5, aaOmni: 0.5, hle: 0.5, gpqa: 0.5, critPt: 0.5,
};

const config = {
  profiles: { tax: { agents: 0.5, coding: 0.5, general: 0, scientific: 0 }, hobby: { agents: 0.5, coding: 0.5, general: 0, scientific: 0 } },
  costBlend: { cache: 0, input: 1, output: 0 },
  lambdaCostAversion: 0.3,
  tierThresholds: { frontier: 0.8, high: 0.6, mid: 0.4 },
  partitionMap: {
    agents: { gdpval: 0.5, tau3Banking: 0.5 },
    coding: { terminalBench: 1 },
    general: { aaLcr: 1 },
    scientific: { hle: 1 },
  },
  reconWeights: { gdpval: 1 },
  paths: [
    { id: 'openrouter', name: 'OpenRouter', models: ['test-model'] },
    { id: 'clinepass', name: 'Cline Pass', models: ['test-model'] },
  ],
};

test('every path covering the model competes for bestPath/minCost', (t) => {
  quiet(t);
  const effMults = { openrouter: 1, clinepass: 0.16 };

  const [row] = buildScores([baseModel], config, effMults);

  assert.equal(row.bestPath, 'Cline Pass', 'the cheaper path should win');
  assert.ok(row.minCost < row.costBlend, 'minCost should reflect the cheaper effMult, not list price');
  assert.ok('clinepass' in row.pathCost && 'openrouter' in row.pathCost);
});

test('a path that does not cover the model is not a candidate', (t) => {
  quiet(t);
  const cfg = { ...config, paths: [config.paths[0], { id: 'clinepass', name: 'Cline Pass', models: ['other-model'] }] };
  const effMults = { openrouter: 1, clinepass: 0.16 };

  const [row] = buildScores([baseModel], cfg, effMults);

  assert.equal(row.bestPath, 'OpenRouter');
  assert.deepEqual(Object.keys(row.pathCost), ['openrouter']);
});

test('a model no path covers has no minCost and an empty bestPath', (t) => {
  quiet(t);
  const cfg = { ...config, paths: [{ id: 'openrouter', name: 'OpenRouter', models: ['other-model'] }] };

  const [row] = buildScores([baseModel], cfg, { openrouter: 1 });

  assert.equal(row.minCost, null);
  assert.equal(row.bestPath, '');
  assert.equal(row.pathCost, undefined);
});

test('"*" covers every model in the registry', (t) => {
  quiet(t);
  const cfg = { ...config, paths: [{ id: 'openrouter', name: 'OpenRouter', models: ['*'] }] };
  const models = [baseModel, { ...baseModel, model: 'other/vendor-model' }];

  const rows = buildScores(models, cfg, { openrouter: 1 });

  for (const row of rows) {
    assert.equal(row.bestPath, 'OpenRouter');
    assert.ok(row.minCost != null, `${row.model} should be priced on the wildcard path`);
  }
});

test('coverage keys are matched through modelKey()', (t) => {
  quiet(t);
  // A registry name with a provider prefix and a dated variant still matches
  // the normalized key a `models` entry declares.
  const cfg = { ...config, paths: [{ id: 'openrouter', name: 'OpenRouter', models: ['Test.Model-20260101'] }] };
  const models = [{ ...baseModel, model: 'vendor/Test.Model-20260101' }];

  const [row] = buildScores(models, cfg, { openrouter: 1 });

  assert.equal(row.bestPath, 'OpenRouter');
});

test('a path with no config `name` falls back to its id', (t) => {
  quiet(t);
  const cfg = { ...config, paths: [{ id: 'mystery', name: undefined, models: ['test-model'] }] };

  const [row] = buildScores([baseModel], cfg, { mystery: 1 });

  assert.equal(row.bestPath, 'mystery');
});
