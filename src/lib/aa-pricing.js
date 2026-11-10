'use strict';

/**
 * Artificial Analysis list prices → the registry's price columns, and the
 * blended $/MTok the ROI pipeline scores on.
 *
 * Two callers need this and must not drift apart:
 *
 *   - `src/roi-tracker/collect/aa-propose.js` proposes registry rows, using the
 *     same AA → `cachePrice`/`inputPrice`/`outputPrice` mapping the sheet
 *     importer (gscripts/model-catalogs.gs, AA_fetch) already writes.
 *   - `src/core/catalog.js` prices a runnable that is routed on an AA
 *     intelligence estimate, using the same blend the ROI pipeline computes as
 *     `mtok` (src/roi-tracker/score.js: `r.costBlend`).
 *
 * Because the core layer may only require the pure leaves listed in
 * test/layering.test.js, the mapping lives here rather than in either caller.
 *
 * Prices are USD per 1M tokens, exactly as AA reports them: no unit conversion.
 */

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The registry price columns for one AA snapshot row.
 *
 * `cachePrice` is AA's cache *hit* price, which is the one the registry column
 * ("Price / 1M Cache Hit ($)") carries; cache writes are not part of the blend.
 *
 * @param {{ pricing?: Record<string, any> }|null|undefined} row AA snapshot row
 * @returns {{ cachePrice: number|null, inputPrice: number|null, outputPrice: number|null }}
 */
function aaPrices(row) {
  const pricing = row && typeof row === 'object' ? row.pricing : null;
  const read = (key) => (pricing && typeof pricing === 'object' ? finite(pricing[key]) : null);
  return {
    cachePrice: read('price_1m_cache_hit_tokens'),
    inputPrice: read('price_1m_input_tokens'),
    outputPrice: read('price_1m_output_tokens'),
  };
}

/**
 * The weights a blend uses, from either shape callers hold:
 *
 *   - `costBlend` from `config/roi.config.json` (`cache`, `input`, `output`),
 *     which is what the ROI pipeline scores with;
 *   - an observed token mix (`cacheRead`, `cacheWrite`, `input`, `output`)
 *     from `src/core/token-mix.js`.
 *
 * `cache` is the cache-READ weight: it multiplies the registry's cache-hit
 * price. Cache writes are 0 unless the config sets `cacheWrite`, because the
 * pipeline never priced them.
 *
 * @param {Record<string, any>|null|undefined} weights
 * @returns {{ cacheRead: number, cacheWrite: number, input: number, output: number }|null}
 */
function blendWeights(weights) {
  if (!weights || typeof weights !== 'object') return null;
  const isMix = Object.hasOwn(weights, 'cacheRead') || Object.hasOwn(weights, 'cacheWrite');
  const cacheRead = finite(isMix ? weights.cacheRead : weights.cache);
  const input = finite(weights.input);
  const output = finite(weights.output);
  if (cacheRead === null || input === null || output === null) return null;
  const cacheWrite = finite(weights.cacheWrite) ?? 0;
  return { cacheRead, cacheWrite, input, output };
}

/**
 * The ROI pipeline's blended list price, `mtok`:
 *
 *   mtok = wc*cachePrice + wi*inputPrice + wo*outputPrice
 *
 * with the weights from `config/roi.config.json` `costBlend` (0.9174 / 0.0781
 * / 0.044 today) or from an observed token mix. There is no registry column
 * for cache writes, so a mix's cache-write share has nothing to multiply here;
 * `src/lib/path-prices.js` prices cache writes from the path's own table. A
 * missing price contributes 0 here, which is exactly what score.js does
 * (`costBlend.cache * (r.raw.cachePrice || 0) + ...`): the blend is a scoring
 * input, not a claim that the model is free.
 *
 * @param {{ cachePrice?: number|null, inputPrice?: number|null, outputPrice?: number|null }|null|undefined} prices
 * @param {Record<string, any>|null|undefined} weights costBlend or a token mix
 * @returns {number|null} null when no usable weights were supplied
 */
function blendMtok(prices, weights) {
  const usable = blendWeights(weights);
  if (!usable) return null;
  const cache = finite(prices?.cachePrice) ?? 0;
  const input = finite(prices?.inputPrice) ?? 0;
  const output = finite(prices?.outputPrice) ?? 0;
  return usable.cacheRead * cache + usable.input * input + usable.output * output;
}

/**
 * List cost for a model that has no registry row, from its AA prices.
 *
 * Stricter than the registry blend on purpose: AA reports 0 for "not measured",
 * not "free", and the cache weight dominates the blend (0.9174), so a zero
 * price would make a model look far cheaper than it is. Input and output must
 * be present and positive, and a zero cache price is unknown (null).
 *
 * A *null* cache price is different: AA simply does not list a cache-hit price
 * for a model without prompt caching, and those tokens are then billed at the
 * input price. The cache component therefore falls back to `inputPrice` (the
 * same substitution `aa-propose` makes when it proposes the registry's
 * `cachePrice`), instead of discarding the whole cost.
 *
 * @param {{ pricing?: Record<string, any> }|null|undefined} row AA snapshot row
 * @param {Record<string, any>|null|undefined} weights costBlend or an observed token mix
 *   (`src/core/token-mix.js`); the catalog passes the mix so the price reflects
 *   the tokens this model actually spends.
 * @returns {number|null}
 */
function aaListCost(row, weights) {
  const prices = aaPrices(row);
  const input = prices.inputPrice;
  const output = prices.outputPrice;
  if (input === null || input <= 0) return null;
  if (output === null || output <= 0) return null;
  let cache = prices.cachePrice;
  if (cache === null) cache = input;
  else if (cache <= 0) return null;
  const cost = blendMtok({ cachePrice: cache, inputPrice: input, outputPrice: output }, weights);
  if (cost === null || !Number.isFinite(cost) || cost <= 0) return null;
  return cost;
}

module.exports = { aaPrices, blendWeights, blendMtok, aaListCost };
