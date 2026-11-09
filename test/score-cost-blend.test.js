'use strict';
/**
 * The cost blend's failure modes: a broken `costBlend` config must stop the
 * run instead of scoring a priced model as free, and a registry row without a
 * cache price is reported because the blend treats those tokens as free.
 */
const assert = require('node:assert/strict');
const test = require('node:test');

const { buildScores } = require('../src/roi-tracker/score.js');
// The method keys live in the tracked defaults; the setup no longer does.
const config = require('../config/defaults/roi.json');

const PRICED = { model: 'provider/x', cachePrice: 0.11, inputPrice: 0.6, outputPrice: 1.8 };

test('a missing or non-numeric costBlend fails loudly instead of pricing as free', () => {
  for (const costBlend of [undefined, null, {}, { cache: 0.9 }, { cache: 0.9, input: 'x', output: 0.04 }]) {
    assert.throws(
      () => buildScores([PRICED], { ...config, costBlend }, {}),
      (err) => {
        assert.match(err.message, /config\.costBlend/);
        assert.match(err.message, /refusing to score provider\/x as free/);
        return true;
      },
      JSON.stringify(costBlend),
    );
  }
});

test('a row with no prices at all does not need blend weights', (t) => {
  // Nothing to price: the blend is 0 either way, so this is not a config error.
  // The registry-gap warning is expected here; keep the run output clean.
  t.mock.method(console, 'warn', () => {});
  const [row] = buildScores([{ model: 'provider/free' }], { ...config, costBlend: undefined }, {});
  assert.equal(row.costBlend, null);
});

test('the shipped config still blends every priced row', () => {
  const [row] = buildScores([PRICED], config, {});
  assert.equal(row.costBlend, 0.226974);
});

test('a registry row without a cache price is reported once', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  buildScores([
    { model: 'provider/no-cache', cachePrice: null, inputPrice: 1, outputPrice: 2 },
    { model: 'provider/zero-cache', cachePrice: 0, inputPrice: 1, outputPrice: 2 },
    { model: 'provider/ok', cachePrice: 0.5, inputPrice: 1, outputPrice: 2 },
  ], config, {});

  assert.equal(warn.mock.callCount(), 2, 'one warning per affected model, none for a priced cache');
  const messages = warn.mock.calls.map((call) => call.arguments[0]);
  assert.equal(
    messages[0],
    '[score] provider/no-cache: registry cachePrice is missing; the cost blend treats cached tokens as free (cache weight 0.9174).',
  );
  assert.match(messages[1], /provider\/zero-cache: registry cachePrice is 0;/);
});

test('the warning is diagnostic only: the blend is unchanged', (t) => {
  t.mock.method(console, 'warn', () => {});
  const [row] = buildScores([{ model: 'provider/no-cache', cachePrice: null, inputPrice: 1, outputPrice: 2 }], config, {});
  assert.equal(row.costBlend, 0.0781 * 1 + 0.044 * 2);
});
