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
 * The ROI pipeline's blended list price, `mtok`:
 *
 *   mtok = wc*cachePrice + wi*inputPrice + wo*outputPrice
 *
 * with `wc`/`wi`/`wo` from `config/roi.config.json` `costBlend` (0.9174 /
 * 0.0781 / 0.044 today). A missing price contributes 0 here, which is exactly
 * what score.js does (`costBlend.cache * (r.raw.cachePrice || 0) + ...`): the
 * blend is a scoring input, not a claim that the model is free.
 *
 * @param {{ cachePrice?: number|null, inputPrice?: number|null, outputPrice?: number|null }|null|undefined} prices
 * @param {{ cache?: number, input?: number, output?: number }|null|undefined} costBlend
 * @returns {number|null} null when no usable weights were supplied
 */
function blendMtok(prices, costBlend) {
  if (!costBlend || typeof costBlend !== 'object') return null;
  const wc = finite(costBlend.cache);
  const wi = finite(costBlend.input);
  const wo = finite(costBlend.output);
  if (wc === null || wi === null || wo === null) return null;
  const cache = finite(prices?.cachePrice) ?? 0;
  const input = finite(prices?.inputPrice) ?? 0;
  const output = finite(prices?.outputPrice) ?? 0;
  return wc * cache + wi * input + wo * output;
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
 * @param {{ cache?: number, input?: number, output?: number }|null|undefined} costBlend
 * @returns {number|null}
 */
function aaListCost(row, costBlend) {
  const prices = aaPrices(row);
  const input = prices.inputPrice;
  const output = prices.outputPrice;
  if (input === null || input <= 0) return null;
  if (output === null || output <= 0) return null;
  let cache = prices.cachePrice;
  if (cache === null) cache = input;
  else if (cache <= 0) return null;
  const cost = blendMtok({ cachePrice: cache, inputPrice: input, outputPrice: output }, costBlend);
  if (cost === null || !Number.isFinite(cost) || cost <= 0) return null;
  return cost;
}

module.exports = { aaPrices, blendMtok, aaListCost };
