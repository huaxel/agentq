/**
 * Tokscale-backed value-run — one Rust scan replaces the ccusage value-run
 * dance (per-agent subcommands + daily modelBreakdowns pattern split + the
 * pi session scanner).
 *
 * Routing: every tokscale record carries a `provider` (ccusage's
 * modelBreakdowns drop it). We route provider → pathId via
 * config.providerPathMap, reusing pi-session-scanner.js provider aliasing
 * (e.g. openai-codex → codex), then fall back to client → pathId via
 * config.agentPathMap (claude → claudemax, pi → openrouter, …).
 *
 * Two modes:
 *
 *   'tokscale'          — `tokscale --json --group-by client,provider,model`, AGGREGATE
 *                         over the range (records are date-less).
 *   'tokscale-graph'    — `tokscale graph --json`, per-DAY records (see
 *                         tokscale-graph-adapter.js). Dated providerRecords feed
 *                         pipeline Strategy A date-filtering and usageRecords → CSV.
 *
 * Enable with VALUE_RUN_SOURCE=tokscale (or --tokscale) / tokscale-graph (or
 * --tokscale --daily) and compare value-run.json against the ccusage default
 * before trusting it — tokscale sees Claude Code sessions that pinned-offline
 * ccusage misses, so totals WILL differ (usually higher).
 */
const { getTokscaleUsageAsync, aggregateRecords } = require('../tokscale-adapter.js');
const { getTokscaleGraphAsync } = require('../tokscale-graph-adapter.js');
const { normalizeProvider } = require('../../lib/pi-session-scanner.js');

/**
 * Pick the pathId for one tokscale record.
 *
 * Order: clients listed in config.clientPrecedence route by client FIRST
 * (agentPathMap) — the antigravity CLI is its own product whose sessions all
 * belong to the antigravity path, regardless of the provider behind the model
 * (the antigravity-scanner hardcodes pathId 'antigravity' for them). Other
 * records route provider → providerPathMap (aliased) first, then client →
 * agentPathMap. Tolerates tokscale's joined provider lists
 * ("github-copilot, openai-codex").
 */
function pathIdForRecord(r, config) {
  const providerPathMap = config.providerPathMap || {};
  const agentPathMap = config.agentPathMap || {};
  const precedence = new Set(config.clientPrecedence || []);
  if (precedence.has(r.client) && agentPathMap[r.client]) return agentPathMap[r.client];
  const providers = String(r.provider || '')
    .split(',')
    .map(s => normalizeProvider(s.trim()))
    .filter(Boolean);
  for (const p of providers) {
    if (providerPathMap[p]) return providerPathMap[p];
  }
  return agentPathMap[r.client] || null;
}

/**
 * Route normalized tokscale records (from the adapter) to per-agent and
 * per-path totals. Pure — no I/O, fully testable.
 * @param {Array} records  adapter-normalized records (client, provider, model, cost, …)
 * @param {object} config  roi.config.json
 * @returns {{ perAgent: Object, perPath: Object, unmapped: Array, totalCost: number }}
 */
function routeRecords(records, config) {
  const perAgent = {};
  const perPath = {};
  const unmapped = [];
  let totalCost = 0;
  for (const r of records) {
    const cost = r.cost || 0;
    totalCost += cost;
    perAgent[r.client] = (perAgent[r.client] || 0) + cost;
    const pathId = pathIdForRecord(r, config);
    if (pathId) perPath[pathId] = (perPath[pathId] || 0) + cost;
    else unmapped.push(r);
  }
  for (const [k, v] of Object.entries(perPath)) perPath[k] = Math.round(v * 100) / 100;
  for (const [k, v] of Object.entries(perAgent)) perAgent[k] = Math.round(v * 100) / 100;
  return { perAgent, perPath, unmapped, totalCost: Math.round(totalCost * 100) / 100 };
}

/**
 * Fill in cost for zero-cost tokscale records using config priceOverrides.
 *
 * tokscale has no pricing for some keys (notably the Fireworks router paths,
 * e.g. "accounts/fireworks/routers/kimi-k2p6-turbo") so it reports those rows
 * at $0.00 despite millions of tokens — the reason tokscale's firepass path
 * showed $0 vs ccusage's $1780 in the A/B. Our priceOverrides carry the real
 * rates ($2/$8/$0.3 per Mtok for that router), so we attach a computed cost
 * BEFORE routing, making valueRun and usageByModel agree. Pure: mutates nothing,
 * returns a new array with cost filled on zero-cost rows that match an override.
 * @param {Array} records  adapter-normalized records
 * @param {object} config  roi.config.json (uses priceOverrides)
 * @returns {Array} records with cost filled where an override applies
 */
function repriceZeroCost(records, config) {
  const overrides = config.priceOverrides || {};
  return records.map(r => {
    if ((r.cost || 0) > 0) return r;
    const ov = overrides[r.model] || overrides[r.model?.toLowerCase()];
    if (!ov) return r;
    const inp = r.inputTokens || 0, out = r.outputTokens || 0;
    const cr = r.cacheReadTokens || 0, cw = r.cacheWriteTokens || 0;
    const cost = (inp * (ov.input || 0) + out * (ov.output || 0) + cr * (ov.cache || ov.input || 0) + cw * (ov.input || 0)) / 1e6;
    return cost > 0 ? { ...r, cost } : r;
  });
}

/**
 * Provider-attributed records for machine bundles (pipeline per-path merge).
 * In aggregate ('tokscale') mode `date` is null (no per-day granularity); in
 * daily ('tokscale-graph') mode each record carries its real `date`.
 */
function providerRecordsFrom(records, config) {
  return records.map(r => ({
    date: r.date ?? null,
    pathId: pathIdForRecord(r, config),
    origin: 'tokscale',
    provider: r.provider || 'unknown',
    model: r.model,
    cost: r.cost || 0,
    tokens: (r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheWriteTokens || 0),
    inputTokens: r.inputTokens || 0,
    outputTokens: r.outputTokens || 0,
    cacheReadTokens: r.cacheReadTokens || 0,
    cacheWriteTokens: r.cacheWriteTokens || 0,
  }));
}

/**
 * One tokscale scan → value-run attribution. Injectable adapter for tests.
 * @param {string} since   YYYYMMDD or YYYY-MM-DD
 * @param {object} config  roi.config.json
 * @param {object} [opts]  { adapter?: async (since, opts) => adapter result, tokscaleOpts?: {} }
 * @returns {Promise<{perAgent, perPath, errors, timings, attempted, records,
 *   providerRecords, models, totalCost, source, concurrency}>}
 */
async function collectTokscaleValueRun(since, config, opts = {}) {
  const started = Date.now();
  const adapter = opts.adapter || getTokscaleUsageAsync;
  const errors = [];
  let result;
  try {
    result = await adapter(since, opts.tokscaleOpts || {});
  } catch (e) {
    errors.push(`tokscale: ${e.message}`);
  }
  const ms = Date.now() - started;
  if (!result || !result.available || !Array.isArray(result.records)) {
    if (result?.error) errors.push(`tokscale: ${result.error}`);
    else if (!result) errors.push('tokscale: no result from adapter');
    return {
      perAgent: {}, perPath: {}, errors, timings: { tokscale: ms },
      attempted: [], records: [], providerRecords: [], models: {}, totalCost: 0,
      source: 'tokscale', concurrency: 1,
    };
  }
  const resp = repriceZeroCost(result.records, config);
  const { perAgent, perPath, unmapped, totalCost } = routeRecords(resp, config);
  if (unmapped.length) {
    const first = unmapped[0];
    errors.push(`tokscale: ${unmapped.length} records unmapped to a path (e.g. ${first.model} via provider '${first.provider || '?'}' client '${first.client || '?'}')`);
  }
  // Per-model aggregate from the SAME scan, shaped like usage.js aggregateRecords
  // (models keyed by modelKey with model/cost/tokens/…). In tokscale mode this
  // replaces ccusage-daily's usageByModel as the single model-total source —
  // tokscale and ccusage daily price the same local logs, so folding both into
  // one total would double count every overlapping model.
  const models = aggregateRecords(resp).models;
  return {
    perAgent,
    perPath,
    errors,
    timings: { tokscale: ms },
    attempted: Object.keys(perAgent),
    records: resp,
    providerRecords: providerRecordsFrom(resp, config),
    models,
    totalCost,
    source: 'tokscale',
    concurrency: 1,
  };
}

module.exports = { collectTokscaleValueRun, collectTokscaleGraphValueRun, routeRecords, providerRecordsFrom, pathIdForRecord, repriceZeroCost };

/**
 * Per-DAY tokscale graph scan → value-run attribution. Dated records feed
 * the pipeline's Strategy A date-filtering and usageRecords (CSV). Inject the
 * adapter for tests.
 * @param {string} since   YYYYMMDD or YYYY-MM-DD
 * @param {object} config  roi.config.json
 * @param {object} [opts]  { adapter?: async (since, opts) => adapter result, tokscaleOpts?: {} }
 * @returns {Promise<{perAgent, perPath, errors, timings, attempted, records,
 *   providerRecords, models, totalCost, source, concurrency}>}
 */
async function collectTokscaleGraphValueRun(since, config, opts = {}) {
  const started = Date.now();
  const adapter = opts.adapter || getTokscaleGraphAsync;
  const errors = [];
  let result;
  try {
    result = await adapter(since, opts.tokscaleOpts || {});
  } catch (e) {
    errors.push(`tokscale-graph: ${e.message}`);
  }
  const ms = Date.now() - started;
  if (!result || !result.available || !Array.isArray(result.records)) {
    if (result?.error) errors.push(`tokscale-graph: ${result.error}`);
    else if (!result) errors.push('tokscale-graph: no result from adapter');
    return {
      perAgent: {}, perPath: {}, errors, timings: { tokscale: ms },
      attempted: [], records: [], providerRecords: [], models: {}, totalCost: 0,
      source: 'tokscale-graph', concurrency: 1,
    };
  }
  const resp = repriceZeroCost(result.records, config);
  const { perAgent, perPath, unmapped, totalCost } = routeRecords(resp, config);
  if (unmapped.length) {
    const first = unmapped[0];
    errors.push(`tokscale-graph: ${unmapped.length} records unmapped to a path (e.g. ${first.model} via provider '${first.provider || '?'}' client '${first.client || '?'}')`);
  }
  const models = aggregateRecords(resp).models;
  return {
    perAgent,
    perPath,
    errors,
    timings: { tokscale: ms },
    attempted: Object.keys(perAgent),
    records: resp,
    providerRecords: providerRecordsFrom(resp, config),
    models,
    totalCost,
    source: 'tokscale-graph',
    concurrency: 1,
  };
}
