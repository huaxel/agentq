'use strict';
/**
 * AA list prices: the registry mapping, the ROI blend parity, and the
 * "zero means unknown" rule that keeps an unpriced model from looking free.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { aaPrices, blendMtok, aaListCost } = require('../src/lib/aa-pricing.js');
const { buildScores } = require('../src/roi-tracker/score.js');
// The method keys live in the tracked defaults; the setup no longer does.
const config = require('../config/defaults/roi.json');

const AA_ROW = {
  slug: 'glm-5-3',
  pricing: {
    price_1m_input_tokens: 0.6,
    price_1m_output_tokens: 1.8,
    price_1m_cache_hit_tokens: 0.11,
    price_1m_cache_write_tokens: null,
  },
};

test('AA prices map onto the registry price columns', () => {
  assert.deepEqual(aaPrices(AA_ROW), { cachePrice: 0.11, inputPrice: 0.6, outputPrice: 1.8 });
  assert.deepEqual(aaPrices({ pricing: {} }), { cachePrice: null, inputPrice: null, outputPrice: null });
  assert.deepEqual(aaPrices(null), { cachePrice: null, inputPrice: null, outputPrice: null });
  // A cache *write* price is not the registry column and is ignored.
  assert.equal(aaPrices({ pricing: { price_1m_cache_write_tokens: 5 } }).cachePrice, null);
});

test('the blend is the ROI pipeline formula, not a new one', () => {
  const prices = aaPrices(AA_ROW);
  const expected = 0.9174 * 0.11 + 0.0781 * 0.6 + 0.044 * 1.8;
  assert.ok(Math.abs(blendMtok(prices, config.costBlend) - expected) < 1e-12);

  // Same inputs through the pipeline's own scorer produce the same mtok.
  const [scored] = buildScores(
    [{ model: 'provider/glm-5.3', ...prices }],
    config,
    {},
  );
  assert.ok(Math.abs(scored.costBlend - blendMtok(prices, config.costBlend)) < 1e-12);
  assert.equal(scored.costBlend, 0.226974);
});

test('the blend keeps the pipeline semantics for a missing price', (t) => {
  // score.js uses `price || 0`; the shared blend must match it exactly. The
  // pipeline warns about the free cache component, which is not this test's
  // subject.
  t.mock.method(console, 'warn', () => {});
  const [scored] = buildScores(
    [{ model: 'provider/x', cachePrice: null, inputPrice: 0.6, outputPrice: 1.8 }],
    config,
    {},
  );
  assert.equal(
    blendMtok({ cachePrice: null, inputPrice: 0.6, outputPrice: 1.8 }, config.costBlend),
    scored.costBlend,
  );
  assert.equal(blendMtok({ cachePrice: 1 }, null), null, 'no weights, no blend');
});

test('a zero AA price means unknown, not free', () => {
  assert.ok(aaListCost(AA_ROW, config.costBlend) > 0);
  for (const pricing of [
    { price_1m_cache_hit_tokens: 0, price_1m_input_tokens: 0.6, price_1m_output_tokens: 1.8 },
    { price_1m_cache_hit_tokens: 0.11, price_1m_input_tokens: 0, price_1m_output_tokens: 1.8 },
    { price_1m_cache_hit_tokens: 0.11, price_1m_input_tokens: 0.6, price_1m_output_tokens: 0 },
    { price_1m_cache_hit_tokens: 0.11, price_1m_input_tokens: -1, price_1m_output_tokens: 1.8 },
    { price_1m_cache_hit_tokens: 0.11, price_1m_output_tokens: 1.8 },
    { price_1m_cache_hit_tokens: 0.11, price_1m_input_tokens: 0.6 },
    {},
  ]) {
    assert.equal(aaListCost({ pricing }, config.costBlend), null, JSON.stringify(pricing));
  }
  assert.equal(aaListCost(AA_ROW, null), null, 'no blend weights, no price');
  assert.equal(aaListCost(null, config.costBlend), null);
});

test('a null cache price bills cache tokens at the input price', () => {
  // qwen3.5-27b shape: AA lists input/output but no cache-hit price, because
  // the model has no prompt caching. Those tokens cost the input price.
  const noCache = { pricing: { price_1m_input_tokens: 0.3, price_1m_output_tokens: 2.4, price_1m_cache_hit_tokens: null } };
  const expected = 0.9174 * 0.3 + 0.0781 * 0.3 + 0.044 * 2.4;
  assert.ok(Math.abs(aaListCost(noCache, config.costBlend) - expected) < 1e-12);
  assert.ok(aaListCost(noCache, config.costBlend) > 0, 'a missing cache price must not zero the cost');

  // Without the fallback the model would be priced as if cache were free:
  // far cheaper than the input-price substitution.
  const asFree = blendMtok({ cachePrice: 0, inputPrice: 0.3, outputPrice: 2.4 }, config.costBlend);
  assert.ok(aaListCost(noCache, config.costBlend) > asFree * 3);

  // An absent cache key is the same statement as a null one.
  assert.equal(
    aaListCost({ pricing: { price_1m_input_tokens: 0.3, price_1m_output_tokens: 2.4 } }, config.costBlend),
    aaListCost(noCache, config.costBlend),
  );

  // A zero cache price is still unknown, not "no caching".
  assert.equal(aaListCost({ pricing: { ...noCache.pricing, price_1m_cache_hit_tokens: 0 } }, config.costBlend), null);
});
