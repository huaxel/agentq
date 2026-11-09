/**
 * tokscale adapter
 *
 * Reads token usage via the `tokscale` CLI (JSON output) and normalizes it
 * into per-model-per-provider records. Unlike ccusage's modelBreakdowns —
 * which drop the provider field entirely (the reason pi-session-scanner.js
 * exists) — tokscale reports `provider` per entry, so this is the provider-
 * attribution source and a second opinion on per-model spend.
 *
 * IMPORTANT: tokscale `--json` aggregates over the whole date range — there
 * is NO per-day `date` field (the TUI has a Daily view, the CLI JSON doesn't).
 * That means these records cannot feed `days` counting (usage.js) or the
 * per-date value-run strategies (pipeline dateFilteredValueRun). Keep ccusage
 * for daily-granular numbers; use this for provider/aggregate views and diffs.
 *
 * tokscale entry shape (verified 4.9.0):
 *   { client, mergedClients, model, provider, input, output, cacheRead,
 *     cacheWrite, reasoning, messageCount, cost, performance }
 */

const { runTokscaleJson, runTokscaleJsonAsync } = require('../lib/tokscale-runner.js');
const { modelKey } = require('../lib/model-key.js');

// tokscale accepts YYYY-MM-DD (and we verified it); normalize from the repo's
// dash-free convention (20260501) to the dash form.
function toTokscaleDate(since) {
  const clean = String(since).replace(/-/g, '');
  if (!/^\d{8}$/.test(clean)) throw new Error(`Invalid date for tokscale --since: "${since}"`);
  const year = Number(clean.slice(0, 4));
  const month = Number(clean.slice(4, 6));
  const day = Number(clean.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`Invalid date for tokscale --since: "${since}"`);
  }
  return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
}

function tokscaleArgs(since, opts = {}) {
  const groupBy = opts.groupBy || 'client,provider,model';
  const args = ['--json', '--no-spinner', '--group-by', groupBy];
  if (since) args.push('--since', toTokscaleDate(since));
  const clients = opts.clients;
  if (clients && clients.length) args.push('--client', clients.join(','));
  return args;
}

/**
 * Parse an already-loaded tokscale JSON object into normalized records.
 * @param {object} json  from `tokscale --json` (groupBy client,provider,model)
 * @returns {Array<{client, provider, model, modelKey, inputTokens, outputTokens,
 *   cacheReadTokens, cacheWriteTokens, reasoningTokens, messageCount, cost}>}
 */
function parseTokscaleJson(json) {
  const entries = Array.isArray(json?.entries) ? json.entries : [];
  const records = [];
  for (const e of entries) {
    if (!e || typeof e.model !== 'string' || !e.model) continue;
    records.push({
      client: e.client || 'unknown',
      provider: e.provider || 'unknown',
      model: e.model,
      modelKey: modelKey(e.model),
      inputTokens: e.input || 0,
      outputTokens: e.output || 0,
      cacheReadTokens: e.cacheRead || 0,
      cacheWriteTokens: e.cacheWrite || 0,
      reasoningTokens: e.reasoning || 0,
      messageCount: e.messageCount || 0,
      cost: e.cost || 0,
    });
  }
  return records;
}

/**
 * Aggregate records per model (keyed by modelKey, providers merged).
 * @returns {Object<string, {model, providers: string[], cost, tokens,
 *   inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
 *   messageCount}>}
 */
function aggregateRecords(records) {
  const models = {};
  let totalCost = 0;
  let totalTokens = 0;
  let totalMessages = 0;
  for (const r of records) {
    const inp = r.inputTokens || 0;
    const out = r.outputTokens || 0;
    const cr = r.cacheReadTokens || 0;
    const cw = r.cacheWriteTokens || 0;
    const tokens = inp + out + cr + cw;
    // Prefer the record's own modelKey (parseTokscaleJson sets it); fall back to
    // re-deriving so callers can pass raw/synthetic records without the field.
    const key = r.modelKey || modelKey(r.model);
    const m = (models[key] ??= {
      model: r.model,
      providers: new Set(),
      cost: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      messageCount: 0,
    });
    m.providers.add(r.provider);
    m.cost += r.cost || 0;
    m.tokens += tokens;
    m.inputTokens += inp;
    m.outputTokens += out;
    m.cacheReadTokens += cr;
    m.cacheWriteTokens += cw;
    m.messageCount += r.messageCount || 0;
    totalCost += r.cost || 0;
    totalTokens += tokens;
    totalMessages += r.messageCount || 0;
  }
  for (const m of Object.values(models)) {
    m.providers = [...m.providers].sort();
    m.cost = Math.round(m.cost * 100) / 100;
  }
  return { models, totalCost: Math.round(totalCost * 100) / 100, totalTokens, totalMessages };
}

/**
 * Diff tokscale aggregate vs ccusage's usage-by-model.
 *
 * ccusage's stored object keys are not reliably modelKey-normalized (the
 * machine bundle may key by raw model string, e.g. "[pi] gpt-5.5" or
 * "kimi-k2p5"), so both sides are re-keyed through modelKey() from their
 * `model` field before comparing. Same model served by different providers
 * sums into one comparison row.
 *
 * @param {Object} tokscaleModels  from aggregateRecords(models)
 * @param {Object} ccusageModels   data/usage-by-model.json `models` map
 * @returns {{ccusageTotal: number, tokscaleTotal: number, pctDiff: number|null,
 *   modelsOnlyInCcusage: string[], modelsOnlyInTokscale: string[],
 *   perModel: Object<string, {ccusageCost, tokscaleCost, pctDiff, ccusageTokens, tokscaleTokens}>}}
 */
function diffUsage(tokscaleModels, ccusageModels) {
  const perModel = {};
  const tsKeys = new Set(Object.keys(tokscaleModels || {}));
  let ccusageTotal = 0;
  let tokscaleTotal = 0;

  // Re-key ccusage entries through modelKey(model) for apples-to-apples keys.
  const ccNormalized = {};
  for (const v of Object.values(ccusageModels || {})) {
    if (!v || typeof v.model !== 'string' || !v.model) continue;
    const k = modelKey(v.model);
    const e = (ccNormalized[k] ??= { cost: 0, tokens: 0 });
    e.cost += v.cost || 0;
    e.tokens += v.tokens || 0;
  }

  const ccKeys = new Set(Object.keys(ccNormalized));
  for (const [k, v] of Object.entries(ccNormalized)) {
    ccusageTotal += v.cost;
    const tv = tokscaleModels?.[k];
    const tc = tv?.cost ?? 0;
    perModel[k] = {
      ccusageCost: Math.round(v.cost * 100) / 100,
      tokscaleCost: Math.round(tc * 100) / 100,
      pctDiff: v.cost > 0 ? Math.round(((tc - v.cost) / v.cost) * 1000) / 10 : null,
      ccusageTokens: v.tokens,
      tokscaleTokens: tv?.tokens ?? 0,
    };
  }
  for (const [k, v] of Object.entries(tokscaleModels || {})) {
    tokscaleTotal += v.cost || 0;
    if (!perModel[k]) {
      perModel[k] = {
        ccusageCost: 0,
        tokscaleCost: Math.round((v.cost || 0) * 100) / 100,
        pctDiff: null,
        ccusageTokens: 0,
        tokscaleTokens: v.tokens || 0,
      };
    }
  }
  const onlyCc = [...ccKeys].filter(k => !tsKeys.has(k)).sort();
  const onlyTs = [...tsKeys].filter(k => !ccKeys.has(k)).sort();
  return {
    ccusageTotal: Math.round(ccusageTotal * 100) / 100,
    tokscaleTotal: Math.round(tokscaleTotal * 100) / 100,
    pctDiff: ccusageTotal > 0 ? Math.round(((tokscaleTotal - ccusageTotal) / ccusageTotal) * 1000) / 10 : null,
    modelsOnlyInCcusage: onlyCc,
    modelsOnlyInTokscale: onlyTs,
    perModel,
  };
}

/**
 * @param {string} [since]  ISO date (YYYY-MM-DD) or YYYYMMDD lower bound.
 * @param {object} [opts]   { clients?: string[], groupBy?: string }
 * @returns {{ available: boolean, records: Array, models: Object, totals: Object, error?: string }}
 */
function getTokscaleUsage(since, opts = {}) {
  let json;
  try {
    json = runTokscaleJson(tokscaleArgs(since, opts));
  } catch (err) {
    return { available: false, records: [], models: {}, totals: {}, error: err.message };
  }
  const records = parseTokscaleJson(json);
  const { models, totalCost, totalTokens, totalMessages } = aggregateRecords(records);
  return {
    available: true,
    records,
    models,
    totals: {
      cost: totalCost,
      tokens: totalTokens,
      messages: totalMessages,
      inputTokens: sum(records, 'inputTokens'),
      outputTokens: sum(records, 'outputTokens'),
      cacheReadTokens: sum(records, 'cacheReadTokens'),
      cacheWriteTokens: sum(records, 'cacheWriteTokens'),
      reasoningTokens: sum(records, 'reasoningTokens'),
    },
  };
}

async function getTokscaleUsageAsync(since, opts = {}) {
  let json;
  try {
    json = await runTokscaleJsonAsync(tokscaleArgs(since, opts));
  } catch (err) {
    return { available: false, records: [], models: {}, totals: {}, error: err.message };
  }
  const records = parseTokscaleJson(json);
  const { models, totalCost, totalTokens, totalMessages } = aggregateRecords(records);
  return {
    available: true,
    records,
    models,
    totals: {
      cost: totalCost,
      tokens: totalTokens,
      messages: totalMessages,
      inputTokens: sum(records, 'inputTokens'),
      outputTokens: sum(records, 'outputTokens'),
      cacheReadTokens: sum(records, 'cacheReadTokens'),
      cacheWriteTokens: sum(records, 'cacheWriteTokens'),
      reasoningTokens: sum(records, 'reasoningTokens'),
    },
  };
}

function sum(records, field) {
  return records.reduce((acc, r) => acc + (r[field] || 0), 0);
}

module.exports = {
  getTokscaleUsage,
  getTokscaleUsageAsync,
  parseTokscaleJson,
  aggregateRecords,
  diffUsage,
  tokscaleArgs,
  toTokscaleDate,
};
