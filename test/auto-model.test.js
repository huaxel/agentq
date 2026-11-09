'use strict';

/**
 * Auto-model policy tests: 'auto' resolves through the routing core, explicit
 * models pass through, and an unroutable 'auto' throws instead of falling back.
 * Every test uses fixture data, never the real data/ files.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_TIER,
  normalizeTier,
  resolveAutoModel,
  summarizeRejections,
} = require('../src/core/auto-model.js');
const {
  CHEAP_MODEL,
  STRONG_MODEL,
  quotaFixture,
  writeRoutingFixture,
} = require('./helpers/routing-fixture.js');

function options(fixture, extra = {}) {
  return {
    runnablesPath: fixture.runnablesPath,
    roiOutputPath: fixture.roiOutputPath,
    quotaPath: fixture.quotaPath,
    roiConfigPath: fixture.roiConfigPath,
    now: fixture.now,
    ...extra,
  };
}

test('auto picks the cheapest eligible runnable for the tier', () => {
  const fixture = writeRoutingFixture();
  const resolved = resolveAutoModel('auto', options(fixture));

  assert.equal(resolved.model, CHEAP_MODEL);
  assert.equal(resolved.provider, 'mistral');
  assert.equal(resolved.tier, 'medium');
  assert.equal(resolved.explicit, false);
  assert.equal(resolved.choice.costPerMTok, 0.1);
});

test('the tier floor changes which runnable is eligible', () => {
  const fixture = writeRoutingFixture();

  // medium floor 38: the 40-intelligence cheap model is eligible.
  assert.equal(resolveAutoModel('auto', options(fixture, { tier: 'medium' })).model, CHEAP_MODEL);
  // big floor 45: only the 60-intelligence model clears it.
  assert.equal(resolveAutoModel('auto', options(fixture, { tier: 'big' })).model, STRONG_MODEL);
});

test('a saturated cheap path falls through to the next eligible runnable', () => {
  const fixture = writeRoutingFixture({ quota: quotaFixture({ mistral: 95 }) });
  const resolved = resolveAutoModel('auto', options(fixture));
  assert.equal(resolved.model, STRONG_MODEL);
  assert.equal(resolved.provider, 'codex');
});

test('unknown capacity is never treated as available, so auto throws with the reasons', () => {
  const fixture = writeRoutingFixture({ quota: { generatedAt: new Date().toISOString(), paths: {} } });

  assert.throws(
    () => resolveAutoModel('auto', options(fixture)),
    (error) => {
      assert.match(error.message, /^No model available for auto routing \(tier medium\): /);
      assert.match(error.message, new RegExp(`${CHEAP_MODEL.replace(/[/.]/g, '\\$&')}: capacity unknown`));
      assert.match(error.message, new RegExp(`${STRONG_MODEL.replace(/[/.]/g, '\\$&')}: capacity unknown`));
      // At most three rejections are reported.
      assert.ok(error.message.split(', ').length <= 3, error.message);
      return true;
    },
  );
});

test('unscored runnables are reported as unscored, not as free capacity', () => {
  const fixture = writeRoutingFixture({ roi: { models: [] } });
  assert.throws(
    () => resolveAutoModel('auto', options(fixture)),
    /No model available for auto routing \(tier medium\): .*unscored/,
  );
});

test('stale quota is unknown, not available', () => {
  const fixture = writeRoutingFixture();
  fixture.writeQuota({
    generatedAt: new Date(fixture.now - 48 * 3600_000).toISOString(),
    paths: {
      mistral: {
        updatedAt: new Date(fixture.now - 48 * 3600_000).toISOString(),
        windows: [{ label: 'weekly', usedPercent: 0, resetsAt: new Date(fixture.now + 3600_000).toISOString() }],
      },
    },
  });
  assert.throws(
    () => resolveAutoModel('auto', options(fixture)),
    /capacity unknown: quota data stale/,
  );
});

test('an explicit model passes through unchanged without reading routing data', () => {
  const resolved = resolveAutoModel('some/explicit-model', {
    runnablesPath: '/nonexistent/runnables.json',
    roiOutputPath: '/nonexistent/roi.json',
    quotaPath: '/nonexistent/quota.json',
  });
  assert.deepEqual(resolved, {
    model: 'some/explicit-model',
    provider: null,
    tier: null,
    explicit: true,
  });
});

test('an explicit model is attributed to its quota path when a config is supplied', () => {
  const resolved = resolveAutoModel('cursor/composer-2.5', {
    config: { providerPathMap: { cursor: 'cursor' }, modelPathPatterns: {}, agentPathMap: {} },
  });
  assert.equal(resolved.provider, 'cursor');
  assert.equal(resolved.explicit, true);
});

test('tier names are validated, with medium as the default', () => {
  assert.equal(DEFAULT_TIER, 'medium');
  assert.equal(normalizeTier(undefined), 'medium');
  assert.equal(normalizeTier('big'), 'big');
  assert.throws(() => normalizeTier('huge'), /Unknown tier: huge \(expected small\|medium\|big\)/);
  assert.throws(() => normalizeTier('constructor'), /Unknown tier/);
  assert.throws(() => resolveAutoModel('auto', { tier: 'huge' }), /Unknown tier: huge/);
});

test('summarizeRejections reports the disqualifying reason per model', () => {
  const summary = summarizeRejections([
    { id: 'a', reasons: ['intelligence 60 >= floor 38', 'capacity saturated: 5% headroom'] },
    { id: 'b', reasons: ['unscored: no ROI score row'] },
    { id: 'c', reasons: ['capacity unknown: no quota data'] },
    { id: 'd', reasons: ['intelligence 10 below floor 38'] },
  ]);
  assert.equal(
    summary,
    'a: capacity saturated: 5% headroom, b: unscored: no ROI score row, c: capacity unknown: no quota data',
  );
});
