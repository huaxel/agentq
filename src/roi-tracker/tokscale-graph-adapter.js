/**
 * tokscale graph adapter — per-DAY provider attribution.
 *
 * The base tokscale adapter uses `tokscale --json --group-by client,provider,model`
 * which AGGREGATES over the whole date range (no per-day `date`). That's why the
 * tokscale daisytine path can't feed Strategy A date-filtering or `usageRecords`.
 *
 * tokscale `graph --json` is different: it exports the contribution-graph data
 * with per-DAY records carrying client/provider/model/token/cost. This is the
 * same shape ccusage `daily` provides, PLUS the `provider` field ccusage's
 * modelBreakdowns drop. So this adapter unlocks the full pipeline (dated
 * usageByModel, dated providerRecords → Strategy A, dated usageRecords → CSV).
 *
 * entry shape (verified 4.9.0 `graph --json`):
 *   contributions: [ { date, totals, intensity, tokenBreakdown, clients, activeTimeMs } ]
 *   clients: [ { client, modelId, providerId, tokens:{input,output,cacheRead,cacheWrite,reasoning}, cost, messages } ]
 */
const { runTokscaleJson, runTokscaleJsonAsync } = require('../lib/tokscale-runner.js');
const { modelKey } = require('../lib/model-key.js');
const { toTokscaleDate } = require('./tokscale-adapter.js');

/**
 * @param {string} [since]  YYYYMMDD or YYYY-MM-DD lower bound (inclusive).
 * @param {object} [opts]   { clients?: string[] }
 * @returns {string[]} CLI args for `tokscale graph`.
 */
function graphArgs(since, opts = {}) {
  // NOTE: `graph` does NOT accept the top-level --json flag (it always emits
  // JSON); passing it makes tokscale error with "unexpected argument '--json'".
  const args = ['graph', '--no-spinner'];
  if (since) args.push('--since', toTokscaleDate(since));
  const clients = opts.clients;
  if (clients && clients.length) args.push('--client', clients.join(','));
  return args;
}

/**
 * Parse an already-loaded `tokscale graph --json` object into dated records.
 * @param {object} json
 * @returns {Array<{date, client, provider, model, modelKey, inputTokens,
 *   outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens,
 *   messageCount, cost}>}
 */
function parseGraphJson(json) {
  const records = [];
  const days = Array.isArray(json?.contributions) ? json.contributions : [];
  for (const day of days) {
    const date = day.date;
    if (!date) continue;
    const clients = Array.isArray(day.clients) ? day.clients : [];
    for (const e of clients) {
      if (!e || typeof e.modelId !== 'string' || !e.modelId) continue;
      const t = e.tokens || {};
      records.push({
        date,
        client: e.client || 'unknown',
        provider: e.providerId || 'unknown',
        model: e.modelId,
        modelKey: modelKey(e.modelId),
        inputTokens: t.input || 0,
        outputTokens: t.output || 0,
        cacheReadTokens: t.cacheRead || 0,
        cacheWriteTokens: t.cacheWrite || 0,
        reasoningTokens: t.reasoning || 0,
        messageCount: e.messages || 0,
        cost: e.cost || 0,
      });
    }
  }
  return records;
}

/**
 * Aggregate dated records into per-model totals (keyed by modelKey), shaped like
 * usage.js aggregateRecords (models with model/cost/tokens/input/output/cache).
 * `days` is a count of distinct dates the model appeared on.
 * @returns {Object<string, {model, cost, tokens, inputTokens, outputTokens,
 *   cacheReadTokens, cacheWriteTokens, days: number}>}
 */
function aggregateDatedModels(records) {
  const models = {};
  for (const r of records) {
    const inp = r.inputTokens || 0, out = r.outputTokens || 0;
    const cr = r.cacheReadTokens || 0, cw = r.cacheWriteTokens || 0;
    const tokens = inp + out + cr + cw;
    const m = (models[r.modelKey] ??= {
      model: r.model,
      cost: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      days: new Set(),
    });
    m.cost += r.cost || 0;
    m.tokens += tokens;
    m.inputTokens += inp;
    m.outputTokens += out;
    m.cacheReadTokens += cr;
    m.cacheWriteTokens += cw;
    m.days.add(r.date);
  }
  for (const m of Object.values(models)) {
    m.cost = Math.round(m.cost * 100) / 100;
    m.days = m.days.size;
  }
  return models;
}

/**
 * @param {string} [since]  YYYYMMDD or YYYY-MM-DD.
 * @param {object} [opts]   { clients?: string[] }
 * @returns {{ available: boolean, records: Array, models: Object, totalCost: number, error?: string }}
 *   records are dated per-day/client/provider/model rows.
 *   models are aged per-model totals with a `days` count.
 */
function getTokscaleGraph(since, opts = {}) {
  let json;
  try {
    json = runTokscaleJson(graphArgs(since, opts));
  } catch (err) {
    return { available: false, records: [], models: {}, totalCost: 0, error: err.message };
  }
  const records = parseGraphJson(json);
  return {
    available: true,
    records,
    models: aggregateDatedModels(records),
    totalCost: Math.round(records.reduce((s, r) => s + (r.cost || 0), 0) * 100) / 100,
  };
}

async function getTokscaleGraphAsync(since, opts = {}) {
  let json;
  try {
    json = await runTokscaleJsonAsync(graphArgs(since, opts));
  } catch (err) {
    return { available: false, records: [], models: {}, totalCost: 0, error: err.message };
  }
  const records = parseGraphJson(json);
  return {
    available: true,
    records,
    models: aggregateDatedModels(records),
    totalCost: Math.round(records.reduce((s, r) => s + (r.cost || 0), 0) * 100) / 100,
  };
}

module.exports = { getTokscaleGraph, getTokscaleGraphAsync, parseGraphJson, aggregateDatedModels, graphArgs };