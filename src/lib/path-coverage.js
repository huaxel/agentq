'use strict';

/**
 * Path coverage: which models a subscription path offers.
 *
 * Coverage is a fact about the user's setup ("this subscription serves this
 * model"), so it lives on `config.paths[].models`, not on the model registry.
 * The registry stays public facts about a model (prices, benchmarks); adding a
 * subscription no longer means adding a column to every registry row.
 *
 * Coverage is NOT the same as `config/runnables.json`. A runnable says "I have
 * wired this model for dispatch on this path"; coverage says "this path offers
 * the model at all". Scoring needs coverage, so a model can be covered by a
 * path without being runnable on it.
 *
 * `models` entries are normalized with modelKey(), so `openrouter/anthropic/
 * claude-opus-4.8` and `claude-opus-4-8` name the same model. The single entry
 * `"*"` means every model in the registry — use it for metered pay-per-token
 * paths, which serve whatever the registry lists. No other wildcard exists.
 * A missing or empty `models` means the path covers nothing.
 */

const { modelKey } = require('./model-key.js');

/** The one wildcard: every model in the registry. */
const ALL_MODELS = '*';

/**
 * The normalized coverage a path declares.
 *
 * @param {Record<string, any>|null|undefined} pathEntry one `config.paths[]` entry
 * @returns {{ all: boolean, keys: Set<string> }} `all` when the path declares `"*"`
 */
function pathCoverage(pathEntry) {
  const declared = Array.isArray(pathEntry?.models) ? pathEntry.models : [];
  const keys = new Set();
  let all = false;
  for (const entry of declared) {
    if (typeof entry !== 'string') continue;
    const key = modelKey(entry);
    if (!key) continue;
    if (key === ALL_MODELS) all = true;
    else keys.add(key);
  }
  return { all, keys };
}

/**
 * True when the path offers the model. The model may be given as a registry
 * `model` name or as an already-normalized key; both fold to the same key.
 *
 * @param {Record<string, any>|null|undefined} pathEntry
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
function pathCovers(pathEntry, model) {
  if (model == null || model === '') return false;
  const { all, keys } = pathCoverage(pathEntry);
  return all || keys.has(modelKey(model));
}

/**
 * The label scoring shows for a path: the configured `name`, else the id.
 *
 * @param {Record<string, any>|null|undefined} pathEntry
 * @returns {string}
 */
function pathLabel(pathEntry) {
  return pathEntry?.name || pathEntry?.id || '';
}

/**
 * Errors: a runnable whose path does not cover the runnable's modelKey. A
 * runnable on a path that is not configured at all is reported the same way —
 * an unknown path covers nothing.
 *
 * Runnables with a null modelKey carry no registry identity (unscorable by
 * design), so they are skipped.
 *
 * @param {Record<string, any>} config parsed config/roi.config.json
 * @param {{ runnables?: Array<Record<string, any>> }} [input]
 * @returns {string[]} problems (empty when every runnable is covered)
 */
function coverageProblems(config, { runnables = [] } = {}) {
  const byId = new Map();
  for (const entry of config?.paths || []) if (entry?.id) byId.set(entry.id, entry);
  const problems = [];
  for (const runnable of runnables || []) {
    if (!runnable || runnable.modelKey == null || runnable.modelKey === '') continue;
    if (pathCovers(byId.get(runnable.path), runnable.modelKey)) continue;
    problems.push(`runnable ${runnable.id}: path ${runnable.path} does not cover ${runnable.modelKey}`);
  }
  return problems;
}

/**
 * Warnings: a declared model key that no registry row provides. A typo in
 * `models` silently removes a path from scoring, so it is surfaced — but a
 * registry that lags a new subscription is not a config error.
 *
 * @param {Record<string, any>} config parsed config/roi.config.json
 * @param {Array<Record<string, any>|string>|null|undefined} registryModels registry rows (or model names)
 * @returns {string[]} warnings (empty when every declared key is known)
 */
function coverageWarnings(config, registryModels) {
  if (registryModels == null) return [];
  const known = new Set();
  for (const row of registryModels) {
    const name = typeof row === 'string' ? row : row?.model;
    const key = name == null ? '' : modelKey(name);
    if (key) known.add(key);
  }
  const warnings = [];
  for (const entry of config?.paths || []) {
    const { all, keys } = pathCoverage(entry);
    if (all) continue;
    for (const key of keys) {
      if (!known.has(key)) warnings.push(`path ${entry.id}: model ${key} is not in the registry`);
    }
  }
  return warnings;
}

module.exports = { ALL_MODELS, pathCoverage, pathCovers, pathLabel, coverageProblems, coverageWarnings };
