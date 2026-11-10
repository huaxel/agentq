/**
 * Config validation — fail fast and clearly at the top of the pipeline instead
 * of crashing deep inside scoring with an opaque `undefined is not iterable`.
 * Checks the keys the economics + score stages actually dereference.
 */

const { coverageProblems, coverageWarnings } = require('./path-coverage.js');
const { priceProblems, priceWarnings } = require('./path-prices.js');

/**
 * @param {object} config  parsed config/roi.config.json
 * @param {{ runnables?: Array<Record<string, any>> }} [input] runnables to check
 *   against path coverage; omit when the caller has none loaded.
 * @returns {string[]} a list of problems (empty when the config is well-formed).
 */
function configProblems(config, { runnables = [] } = {}) {
  const problems = [];
  if (!config || typeof config !== 'object') return ['config is not an object'];

  // paths: array of { id, type, fee } the economics stage iterates.
  if (!Array.isArray(config.paths) || config.paths.length === 0) {
    problems.push('paths: expected a non-empty array');
  } else {
    const VALID_TYPES = new Set(['Local', 'Metered', 'Wallet']);
    config.paths.forEach((p, i) => {
      if (!p || typeof p.id !== 'string') problems.push(`paths[${i}]: missing string "id"`);
      if (!p || typeof p.type !== 'string') problems.push(`paths[${i}] (${p?.id ?? '?'}): missing string "type"`);
      // economics divides by fee and the renderer calls fee.toFixed — a missing
      // or non-numeric fee silently NaNs the whole path and crashes the page.
      if (!p || typeof p.fee !== 'number') problems.push(`paths[${i}] (${p?.id ?? '?'}): missing numeric "fee"`);
      if (p && typeof p.type === 'string' && !VALID_TYPES.has(p.type)) {
        problems.push(`paths[${i}] (${p.id}): unknown type "${p.type}" — expected one of ${[...VALID_TYPES].join(', ')}`);
      }
      // `quotaWindows` decides whether the path's quota windows bind together
      // (`all`, the default) or fail over (`any`). Anything else would silently
      // fall back to a default, so it is an error (src/core/capacity.js).
      if (p && p.quotaWindows != null && p.quotaWindows !== 'all' && p.quotaWindows !== 'any') {
        problems.push(`paths[${i}] (${p.id}): "quotaWindows" must be "all" or "any"`);
      }
      // `models` is the path's model coverage (see lib/path-coverage.js). A
      // missing or empty list is legal and means the path covers nothing; a
      // non-array or a non-string entry silently drops coverage, so it fails.
      if (p && p.models != null) {
        if (!Array.isArray(p.models)) {
          problems.push(`paths[${i}] (${p.id}): "models" must be an array of model keys`);
        } else {
          p.models.forEach((model, j) => {
            if (typeof model !== 'string' || !model.trim()) {
              problems.push(`paths[${i}] (${p.id}): models[${j}] must be a non-empty string`);
            }
          });
        }
      }
    });
  }

  // A runnable on a path that does not cover its model is unrunnable in
  // practice: routing would offer a model the subscription does not serve.
  // Only checked when the caller loaded runnables too.
  problems.push(...coverageProblems(config, { runnables }));

  // `paths[].prices` / `offPeakHours` (src/lib/path-prices.js). A silently
  // ignored price would route on the registry's blended list price while the
  // operator believes the subscription's own list applies.
  problems.push(...priceProblems(config));

  // profiles: tax + hobby, each weighting the four partitions the scorer reads.
  const partitions = ['agents', 'coding', 'general', 'scientific'];
  for (const name of ['tax', 'hobby']) {
    const prof = config.profiles?.[name];
    if (!prof || typeof prof !== 'object') { problems.push(`profiles.${name}: missing`); continue; }
    for (const k of partitions) {
      if (typeof prof[k] !== 'number') problems.push(`profiles.${name}.${k}: expected a number`);
    }
  }

  // Objects the scorer dereferences for sub-indices.
  for (const k of ['partitionMap', 'reconWeights', 'tierThresholds', 'costBlend']) {
    if (!config[k] || typeof config[k] !== 'object') problems.push(`${k}: missing object`);
  }
  for (const k of ['cache', 'input', 'output']) {
    if (config.costBlend && typeof config.costBlend[k] !== 'number') {
      problems.push(`costBlend.${k}: expected a number`);
    }
  }
  if (typeof config.lambdaCostAversion !== 'number') {
    problems.push('lambdaCostAversion: expected a number');
  }

  // Model aliases join observed usage/pricing keys to benchmark models. A
  // malformed entry otherwise gets ignored or fails much later in the
  // pipeline, making attribution gaps hard to diagnose.
  if (config.modelPriceAliases != null) {
    if (!config.modelPriceAliases || typeof config.modelPriceAliases !== 'object' || Array.isArray(config.modelPriceAliases)) {
      problems.push('modelPriceAliases: expected an object');
    } else {
      for (const [alias, target] of Object.entries(config.modelPriceAliases)) {
        if (!alias.trim()) problems.push('modelPriceAliases: alias keys must be non-empty strings');
        if (typeof target !== 'string' || !target.trim()) {
          problems.push(`modelPriceAliases.${alias}: expected a non-empty string target`);
        }
      }
    }
  }

  // Every reconWeights key must have a matching entry in partitionMap —
  // otherwise that weight is silently ignored by scoring. The reverse is NOT
  // required: benchmarks can contribute to a partition sub-index (agents,
  // coding, ...) without being in reconWeights (general intelligence).
  const rw = config.reconWeights;
  const pm = config.partitionMap;
  if (rw && pm) {
    const rwKeys = Object.keys(rw);
    const pmKeys = new Set(Object.values(pm).flatMap(v => Object.keys(v || {})));
    const missing = rwKeys.filter(k => !pmKeys.has(k));
    if (missing.length) problems.push(`reconWeights has keys missing from partitionMap: ${missing.join(', ')}`);
  }

  return problems;
}

/**
 * Warnings that must not fail a run: a declared model key the registry does not
 * have, and a price entry for a model the path's coverage does not list. A
 * registry that lags a new subscription is normal; a typo in `models` or a
 * price filed under the wrong key is not, and both look the same here.
 *
 * @param {object} config parsed config/roi.config.json
 * @param {Array<Record<string, any>|string>|null|undefined} registryModels registry rows, or null when unknown
 * @returns {string[]}
 */
function configWarnings(config, registryModels) {
  return [...coverageWarnings(config, registryModels), ...priceWarnings(config)];
}

/** Throw with all problems listed at once, or return the config unchanged. */
function validateConfig(config, source = 'config', input = {}) {
  const problems = configProblems(config, input);
  if (problems.length) {
    throw new Error(`invalid ${source}:\n  - ${problems.join('\n  - ')}`);
  }
  return config;
}

module.exports = { configProblems, configWarnings, validateConfig };
