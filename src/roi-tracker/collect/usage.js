#!/usr/bin/env node
/**
 * Usage-by-model collector — what you ACTUALLY spent per model this period.
 *
 * Reads ccusage's daily breakdown (via ccusage-adapter) and aggregates by the
 * shared model key. ccusage `daily` is already the de-duplicated aggregate
 * across every agent, so summing its per-model breakdowns gives true per-model
 * spend with no pi double-count (we're using it as the sole source here, not
 * folding it on top of a native pi parse). Writes data/usage-by-model.json.
 *
 * Usage:  node src/collect-usage.js [--since YYYYMMDD] [--dry-run]
 */
const fs = require('fs');
const { getCcusageUsage, getCcusageUsageAsync } = require('../ccusage-adapter.js');
const { modelKey } = require('../../lib/model-key.js');
const { parseSinceArg: parseSince } = require('../../lib/since.js');

const { homeDataPath } = require('../../lib/home.js');

function aggregateRecords(records) {
  const models = {};
  let total = 0;
  for (const r of records) {
    const key = modelKey(r.model);
    const inp = r.inputTokens || 0;
    const out = r.outputTokens || 0;
    const cr = r.cacheReadTokens || 0;
    const cw = r.cacheWriteTokens || 0;
    const tokens = inp + out + cr + cw;
    const m = (models[key] ??= { model: r.model, cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, days: new Set() });
    m.cost += r.cost || 0;
    m.tokens += tokens;
    m.inputTokens += inp;
    m.outputTokens += out;
    m.cacheReadTokens += cr;
    m.cacheWriteTokens += cw;
    m.days.add(r.date);
    total += r.cost || 0;
  }
  for (const m of Object.values(models)) {
    m.cost = Math.round(m.cost * 100) / 100;
    m.days = m.days.size;
  }
  return { models, total: Math.round(total * 100) / 100 };
}

function foldFetchResult(since, cc) {
  if (!cc.available) return { available: false, error: cc.error, since, records: [], models: {}, total: 0 };
  const { models, total } = aggregateRecords(cc.records);
  return { available: true, since, records: cc.records, total, models };
}

function fetchAndAggregate(since) {
  return foldFetchResult(since, getCcusageUsage(since));
}

async function fetchAndAggregateAsync(since) {
  return foldFetchResult(since, await getCcusageUsageAsync(since));
}

function run(since) {
  const r = fetchAndAggregate(since);
  if (!r.available) return { available: false, error: r.error, since, models: {} };
  return { available: true, since, total: r.total, models: r.models };
}

function main() {
  const since = parseSince(process.argv.slice(2));
  const result = { generatedAt: new Date().toISOString(), ...run(since) };
  if (!result.available) { console.error('ccusage unavailable:', result.error); }
  else {
    const top = Object.values(result.models).sort((a, b) => b.cost - a.cost).slice(0, 8);
    console.error(`usage since ${since}: $${result.total} across ${Object.keys(result.models).length} models`);
    for (const m of top) {
      const tok = `${(m.tokens / 1e6).toFixed(1)}M`;
      console.error(`  ${m.model.padEnd(30)} $${m.cost.toFixed(2).padStart(9)} ${tok.padStart(8)} (${m.days}d)`);
    }
  }
  if (process.argv.includes('--dry-run')) return result;
  fs.writeFileSync(homeDataPath('usage-by-model.json'), JSON.stringify(result, null, 2) + '\n');
  console.error('wrote data/usage-by-model.json');
  return result;
}

if (require.main === module) main();
module.exports = { run, fetchAndAggregate, fetchAndAggregateAsync, aggregateRecords };
