#!/usr/bin/env node
/**
 * Tokscale collector — provider-attributed per-model spend + diff vs ccusage.
 *
 * Runs tokscale `--json --group-by client,provider,model` (Rust core, reads
 * every local agent's logs: pi, claude, codex, opencode, …) and writes
 * data/tokscale-by-provider.json. The records carry a `provider` field that
 * ccusage's modelBreakdowns drop, so this is the provider-attribution source
 * and a second opinion on per-model cost. A diff against the ccusage-derived
 * data/usage-by-model.json makes pricing/coverage gaps visible before you
 * trust tokscale numbers downstream.
 *
 * LIMITATION: tokscale `--json` has no per-day dates (aggregated over the
 * range), so this file does NOT feed `days` counts or per-date value-run
 * strategies — keep ccusage for those.
 *
 * Usage:  node src/roi-tracker/collect/tokscale.js [--since YYYYMMDD] [--dry-run]
 *   --clients pi,claude   restrict to clients (default: all detected)
 * Env:  TOKSCALE_CLIENTS=pi,claude  (same as --clients)
 */
const fs = require('fs');
const { getTokscaleUsage } = require('../tokscale-adapter.js');
const { diffUsage } = require('../tokscale-adapter.js');
const { parseSinceArg: parseSince } = require('../../lib/since.js');

const { homeDataPath } = require('../../lib/home.js');

function parseClients(argv) {
  const i = argv.indexOf('--clients');
  const next = (i !== -1 && argv[i + 1]) ? argv[i + 1] : '';
  // A following flag is not a value: '--clients --daily' must mean "all
  // clients", not a client literally named '--daily' (which would silently
  // return no data).
  const flagVal = next.startsWith('-') ? '' : next;
  const envVal = process.env.TOKSCALE_CLIENTS || '';
  const raw = flagVal || envVal || '';
  const clients = raw.split(',').map(s => s.trim()).filter(Boolean);
  return clients;
}

function loadCcusageModels() {
  try {
    const d = JSON.parse(fs.readFileSync(homeDataPath('usage-by-model.json'), 'utf8'));
    if (!d.available || !d.models) return null;
    return { models: d.models, total: d.total, since: d.since };
  } catch {
    return null;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const since = parseSince(argv);
  const clients = parseClients(argv);
  const dryRun = argv.includes('--dry-run');

  const cc = loadCcusageModels();
  const r = getTokscaleUsage(since, clients.length ? { clients } : {});

  if (!r.available) {
    console.error('tokscale unavailable:', r.error);
    console.error('  (is tokscale on PATH? fallback: npx -y tokscale@<pinned> in lib/tokscale-runner.js)');
    process.exitCode = 1;
    return;
  }

  const diff = cc ? diffUsage(r.models, cc.models) : null;
  const result = {
    generatedAt: new Date().toISOString(),
    available: true,
    since,
    clients: clients.length ? clients : 'all',
    groupBy: 'client,provider,model',
    totals: r.totals,
    records: r.records,
    models: r.models,
    diffVsCcusage: diff,
    ccusageBaseline: cc ? { since: cc.since, totalCost: cc.total } : null,
  };

  // Console summary
  const top = Object.values(r.models).sort((a, b) => b.cost - a.cost).slice(0, 8);
  console.error(`tokscale since ${since}: $${r.totals.cost.toFixed(2)} across ${Object.keys(r.models).length} models / ${r.records.length} provider-model rows`);
  for (const m of top) {
    const tok = `${(m.tokens / 1e6).toFixed(1)}M`;
    console.error(`  ${m.model.padEnd(34)} $${m.cost.toFixed(2).padStart(9)} ${tok.padStart(8)} [${m.providers.join(',')}]`);
  }
  if (diff) {
    const pct = diff.pctDiff === null ? 'n/a' : `${diff.pctDiff > 0 ? '+' : ''}${diff.pctDiff}%`;
    console.error(`\nccusage baseline (since ${cc.since}): $${diff.ccusageTotal.toFixed(2)}  tokscale: $${diff.tokscaleTotal.toFixed(2)}  (${pct})`);
    if (diff.modelsOnlyInTokscale.length) {
      console.error(`  only in tokscale (${diff.modelsOnlyInTokscale.length}): ${diff.modelsOnlyInTokscale.slice(0, 10).join(', ')}`);
    }
    if (diff.modelsOnlyInCcusage.length) {
      console.error(`  only in ccusage (${diff.modelsOnlyInCcusage.length}): ${diff.modelsOnlyInCcusage.slice(0, 10).join(', ')}`);
    }
  }

  if (dryRun) return result;
  fs.writeFileSync(homeDataPath('tokscale-by-provider.json'), JSON.stringify(result, null, 2) + '\n');
  console.error('wrote data/tokscale-by-provider.json');
  return result;
}

if (require.main === module) main();
module.exports = { main, parseClients };
