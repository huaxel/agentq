#!/usr/bin/env node
/**
 * Pipeline orchestrator — the composable core.
 *
 *   collect (usage)  ->  economics (Paths)  ->  score (Score v2)  ->  canonical JSON
 *
 * Emits ONE canonical JSON that any renderer (html, gsheets, ...) consumes.
 * Stages are pure modules (economics.js, score.js); this wires them and does I/O.
 *
 * Value run per path (list-$ of usage you ran) is read from data/value-run.json
 * if present ({ "<pathId>": <usd>, ... }); otherwise wallets default to
 * Eff. mult 1 until you wire the usage collector. See docs/data-pipeline.md.
 *
 * Usage:
 *   node src/pipeline.js               # writes data/roi-output.json
 *   node src/pipeline.js --stdout      # also prints canonical JSON to stdout
 */

const fs = require('fs');
const path = require('path');
const { buildEconomics } = require('./economics.js');
const { buildScores } = require('./score.js');
const { buildValues } = require('./values.js');
const { modelKey } = require('../lib/model-key.js');
const { agentqHome, homeDataPath, homeLoad, homeLoadOptional, loadRequiredRoiConfig, loadRoiConfig } = require('../lib/home.js');
const { validateConfig, configWarnings } = require('../lib/validate-config.js');
const { underwaterAlerts, breakEven } = require('../lib/alerts.js');
const { parseDate8, date8, round2 } = require('./pipeline-util.js');
const {
  isLegacyCursorAggregate,
  mergeUsageModel,
  normalizeUsageByModel,
  readMachineData,
  dateFilteredValueRun,
} = require('./pipeline-machine.js');
const {
  quotaWindowKind,
  quotaWindowMultiplier,
  preferredQuotaWindow,
  windowMonths,
  subMonths,
  buildRollup,
} = require('./pipeline-rollup.js');

const load = homeLoad;
const loadOptional = homeLoadOptional;
const snapDir = () => homeDataPath('snapshots');

function run(configOverride) {
  // A missing user setup is the common first-run failure. Say which file is
  // missing and how to create it instead of printing the validator's list of
  // every key the method defaults would have supplied.
  const config = validateConfig(
    configOverride || loadRequiredRoiConfig(),
    'roi.config.json',
  );
  const inputs = load('data/benchmark-inputs.json').models;
  // A `models` entry the registry does not have covers nothing, which is a
  // warning (the registry can lag a new subscription) rather than a failure.
  for (const warning of configWarnings(config, inputs)) console.error(`  ⚠ ${warning}`);
  const machine = readMachineData();

  // Attach value run to each path, then derive economics + effMults.
  // Pass each path's own window (via startDate, falling back to the global
  // collection window) so economics normalises valueRun to monthly using the
  // SAME per-sub window buildRollup uses — otherwise a sub with a late
  // startDate gets diluted over the full collection window in economics.rows
  // (understating covered/roi) while the rollup, using the correct shorter
  // window, reports the opposite verdict for the same subscription.
  const globalMonths = windowMonths(machine.machines);
  let paths = config.paths.map(p => ({ ...p, valueRun: machine.valueRun[p.id] ?? null, months: subMonths(p, globalMonths) }));

  // For paths with startDate + costModels, recompute valueRun filtered by date
  // range so subscription changes (e.g. Claude Max → Pro) split usage correctly.
  const dateFiltered = {};
  for (const p of paths) {
    if (!p.startDate) continue;
    const filtered = dateFilteredValueRun(machine.usageRecords, machine.pathUsageRecords, machine.usageByModel, p, machine.valueRun[p.id]);
    if (filtered != null) dateFiltered[p.id] = filtered;
  }
  if (Object.keys(dateFiltered).length) {
    paths = paths.map(p => ({
      ...p,
      valueRun: dateFiltered[p.id] !== undefined ? dateFiltered[p.id] : p.valueRun,
    }));
    console.error(`  date-range valueRun applied for: ${Object.keys(dateFiltered).join(', ')}`);
  }
  const { rows: economics, effMults } = buildEconomics(paths);

  // Attach app-reported quota (rate-limit windows) and a break-even hint
  // (what it'd take to flip an underwater wallet) per path.
  const quota = loadOptional('data/quota.json');
  for (const row of economics) {
    row.quota = quota?.paths?.[row.id] ?? null;
    row.breakEven = breakEven(row);
  }

  // Per-subscription rollup — the "is this sub worth it?" summary.
  const subscriptions = buildRollup(economics, machine.machines, machine.pathUsageRecords);

  // Score models against the personalized effMults.
  const scored = buildScores(inputs, config, effMults);

  // Values view (cost-blind PERF vs COST) — independent of paths/profiles.
  let values = [];
  try {
    const vrows = load('data/values-inputs.json');
    values = buildValues(vrows, config.costBlend)
      .map(v => ({ model: v.model, perf: v.perf, cost: v.cost, speed: v.speed }));
  } catch { /* values-inputs.json optional */ }

  // Live list pricing joined per model on the shared key; usage is the merged
  // per-machine total.
  const pricing = loadOptional('data/pricing.json');
  const usageByModel = machine.usageByModel;

  // Trim to a renderer-friendly shape.
  const seenModelKeys = new Set();
  const usageShape = u => ({ cost: round2(u.cost || 0), tokens: u.tokens, inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, cacheReadTokens: u.cacheReadTokens || 0, cacheWriteTokens: u.cacheWriteTokens || 0 });
  // Resolve aliased pricing/usage keys (e.g. umans/* -> base model).
  const __aliases = loadRoiConfig().modelPriceAliases || {};
  function resolveKey(k) {
    const alias = Object.entries(__aliases).find(([ak]) => ak.toLowerCase() === k.toLowerCase())?.[1];
    return alias || k;
  }
  const models = scored.map(r => {
    const k = modelKey(r.model);
    seenModelKeys.add(k);
    // Also register any alias keys that point to this model key, so the
    // left-join below does not re-insert them as unregistered orphans.
    // Use modelKey() to normalize the alias key — otherwise dot vs dash
    // mismatches (qwen3.6 vs qwen3-6) cause orphans.
    for (const [ak, av] of Object.entries(__aliases)) {
      if (av.toLowerCase() === k.toLowerCase()) {
        seenModelKeys.add(ak);
        seenModelKeys.add(modelKey(ak));
      }
    }
    // Resolve pricing key and also check for usage under alias keys
    // (e.g. usage stored as 'umans-coder' but scored as 'claude-sonnet-4-6').
    const rk = resolveKey(k);
    const pp = pricing?.models?.[rk];
    let u = usageByModel[k];
    // Reverse-alias lookup: merge usage from ALL alias keys that point to this
    // scored model. A single find() is not enough because multiple aliases may
    // map to the same target (qwen3.6 -> qwen3-6-35b-a3b AND umans-flash ->
    // qwen3-6-35b-a3b), and the first match may have minimal usage while another
    // holds the bulk of the cost.
    const aliasEntries = Object.entries(__aliases).filter(([, av]) => av.toLowerCase() === k.toLowerCase());
    const seenAliasUsageKeys = new Set();
    for (const [rawKey] of aliasEntries) {
      // Identity aliases (e.g. claude-sonnet-5 -> claude-sonnet-5) point at
      // the same normalized usage key and must not add that usage a second
      // time. Multiple alias spellings can also normalize to one usage key.
      const aliasUsageKey = modelKey(rawKey);
      if (aliasUsageKey === k || seenAliasUsageKeys.has(aliasUsageKey)) continue;
      seenAliasUsageKeys.add(aliasUsageKey);
      // Try the raw alias key first, then the modelKey-normalized version.
      const aliasUsage = usageByModel[rawKey] || usageByModel[aliasUsageKey];
      if (aliasUsage) {
        if (!u) {
          u = aliasUsage;
        } else {
          // Merge alias usage into target (additive — no double-count)
          u = {
            ...u,
            cost: (u.cost || 0) + (aliasUsage.cost || 0),
            tokens: (u.tokens || 0) + (aliasUsage.tokens || 0),
            inputTokens: (u.inputTokens || 0) + (aliasUsage.inputTokens || 0),
            outputTokens: (u.outputTokens || 0) + (aliasUsage.outputTokens || 0),
            cacheReadTokens: (u.cacheReadTokens || 0) + (aliasUsage.cacheReadTokens || 0),
            cacheWriteTokens: (u.cacheWriteTokens || 0) + (aliasUsage.cacheWriteTokens || 0),
          };
        }
      }
    }
    return {
      model: r.model,
      registered: true,
      complete: r.complete,
      missingPartitions: r.complete
        ? []
        : ['agents', 'coding', 'general', 'scientific'].filter(p => r[p === 'scientific' ? 'sciRaw' : p + 'Raw'] == null),
      genIntel: r.genIntel,
      capTax: r.capTax ?? null,
      capHobby: r.capHobby ?? null,
      valTax: r.valTax ?? null,
      valHobby: r.valHobby ?? null,
      tierTax: r.tierTax ?? null,
      tierHobby: r.tierHobby ?? null,
      mtok: r.costBlend,             // blended list $/Mtok from the xlsx
      minCost: r.minCost ?? null,    // your effective $/Mtok via cheapest path
      bestPath: r.bestPath ?? '',
      speed: r.raw.speed ?? null,
      // "all my info" join: list price across sources + what you actually spent
      list: {
        xlsx: r.costBlend,
        openrouter: pp?.openrouter?.blend ?? null,
        opencode: pp?.opencode?.blend ?? null,
      },
      usage: u ? usageShape(u) : null,
    };
  });

  // Left-join usage onto the benchmark registry: keep usage whose normalized key
  // has no benchmark-input row so large unregistered/free/local models are visible
  // instead of being silently dropped from exports and spend checks.
  // Resolve aliases for pricing so umans/* models show list prices.
  //
  // Important: some usageByModel keys ARE alias keys (e.g. qwen3-6 -> qwen3-6-35b-a3b).
  // seenModelKeys registers alias keys too, so the raw key gets skipped. But the
  // target model may not exist yet if it has no benchmark entry and no direct usage.
  // In that case we create an entry under the target model name with the alias's usage.
  for (const [k, u] of Object.entries(usageByModel)) {
    if (seenModelKeys.has(k)) {
      // This key was skipped because it matches an alias. Check if the resolved
      // target is already in the output — if not, create it so the cost isn't lost.
      const rk = resolveKey(k);
      if (rk !== k && !seenModelKeys.has(rk)) {
        // Target model not in output — create unregistered entry under target name
        const pp = pricing?.models?.[rk];
        models.push({
          model: rk,
          registered: false,
          complete: false,
          genIntel: null,
          capTax: null,
          capHobby: null,
          valTax: null,
          valHobby: null,
          tierTax: null,
          tierHobby: null,
          mtok: null,
          minCost: null,
          bestPath: '',
          speed: null,
          list: {
            xlsx: null,
            openrouter: pp?.openrouter?.blend ?? null,
            opencode: pp?.opencode?.blend ?? null,
          },
          usage: usageShape(u),
        });
        seenModelKeys.add(rk);
      }
      continue;
    }
    const rk = resolveKey(k);
    const pp = pricing?.models?.[rk];
    models.push({
      model: u.model || k,
      registered: false,
      complete: false,
      genIntel: null,
      capTax: null,
      capHobby: null,
      valTax: null,
      valHobby: null,
      tierTax: null,
      tierHobby: null,
      mtok: null,
      minCost: null,
      bestPath: '',
      speed: null,
      list: {
        xlsx: null,
        openrouter: pp?.openrouter?.blend ?? null,
        opencode: pp?.opencode?.blend ?? null,
      },
      usage: usageShape(u),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    profiles: Object.keys(config.profiles),
    unscorable: unscorableModels(config),
    coverage: buildCoverage(models, config),
    subscriptions,
    economics,
    alerts: underwaterAlerts(economics, Object.fromEntries(subscriptions.subs.map(s => [s.id, s.roi]))),
    models,
    values,
    pricing: pricing ? { generatedAt: pricing.generatedAt, sources: pricing.sources } : null,
    usage: {
      machines: machine.machines,
      reconciliation: machine.reconciliation || null,
      total: Math.round(Object.values(usageByModel).reduce((s, u) => s + (u.cost || 0), 0) * 100) / 100,
    },
    // Per-path model breakdown from pi session provider records
    pathModelUsage: Object.values(machine.pathModelUsage || {})
      .map(e => ({ ...e, cost: round2(e.cost), tokens: Math.round(e.tokens) }))
      .sort((a, b) => b.cost - a.cost),
  };
}

// stale: no usage source was actually collected on `date` (e.g. the
// collectors failed or were skipped) — the totals for that day are
// yesterday's (or older) numbers wearing today's date. Recorded rather than
// hidden, so a poisoned "flat" day is distinguishable from a genuinely idle one.
function isStaleSnapshot(date, machines) {
  const freshestAt = (machines || [])
    .map(m => Date.parse(m.generatedAt || ''))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];
  return !Number.isFinite(freshestAt) || new Date(freshestAt).toISOString().slice(0, 10) !== date;
}

// Append today's compact snapshot (one per day, overwritten) and return the
// full trend series read back from disk — so the dashboard can chart spend/ROI
// over time while roi-output.json stays the single source the renderer reads.
function snapshotAndTrend(out) {
  const date = out.generatedAt.slice(0, 10);   // YYYY-MM-DD
  const stale = isStaleSnapshot(date, out.usage.machines);
  const snap = {
    date,
    generatedAt: out.generatedAt,
    totalSpend: out.usage.total,
    stale,
    paths: out.economics.map(p => ({ id: p.id, name: p.name, roi: p.roi, effMult: p.effMult, status: p.status })),
  };
  const dir = snapDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(snap, null, 2) + '\n');
  } catch (e) {
    console.error(`  ⚠ snapshot write failed: ${e.message}`);
  }
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { /* none */ }
  const trend = [];
  for (const f of files) {
    const s = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })();
    if (s) trend.push(s);
  }
  return trend;
}

// Usage models that are intentionally not scorable against the benchmark
// registry: config-registered placeholders (free tiers, synthetic rollups,
// unknown entries) or non-benchmarkable `model/free` aliases. Listed in the
// output so consumers can distinguish actionable registry gaps from expected
// unscored usage.
function unscorableModels(config = loadRoiConfig()) {
  const placeholders = new Set();
  for (const m of config.unscorableModels || []) {
    placeholders.add(modelKey(m));
  }
  placeholders.add(modelKey('unknown'));
  placeholders.add(modelKey('<synthetic>'));
  return [...placeholders];
}

// How much of the observed usage is actually ranked. Placeholder/free-tier
// names are excluded from the actionable count — they are expected noise.
function buildCoverage(models, config) {
  const unscored = models.filter(m => !m.registered && m.usage);
  const ignore = new Set(unscorableModels(config));
  const actionable = unscored.filter(m => !ignore.has(modelKey(m.model)));
  return {
    scored: models.filter(m => m.registered && m.complete).length,
    unscored: unscored.length,
    unscoredActionable: actionable.length,
    unscoredSpend: round2(actionable.reduce((s, m) => s + (m.usage?.cost || 0), 0)),
    incomplete: models.filter(m => m.registered && !m.complete).length,
  };
}

// Complete models with no list price score with minCost 0 and outrank
// everything on value. Prices are not part of `complete` (a local-only model
// is legitimately free at margin), so flag them loudly instead of silently
// ranking them as free.
function findFreeScoredModels(models) {
  return (models || []).filter(m => m.complete && (m.mtok == null || m.mtok === 0));
}

function main() {
  const out = run();
  const config = loadRoiConfig();
  out.trend = snapshotAndTrend(out);
  const outPath = homeDataPath('roi-output.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.error(`wrote ${path.relative(agentqHome(), outPath)} — ${out.models.length} models, ${out.economics.length} paths`);
  if (out.alerts.length) {
    console.error(`  ⚠ ${out.alerts.length} wallet(s) UNDERWATER: ${out.alerts.map(a => a.name).join(', ')}`);
  }
  const incomplete = out.models.filter(m => m.registered !== false && !m.complete);
  if (incomplete.length) {
    const detail = incomplete.map(m => {
      const missing = (m.missingPartitions || []).join('/');
      return missing ? `${m.model} (missing: ${missing})` : m.model;
    }).join(', ');
    console.error(`  ⚠ ${incomplete.length} registered model(s) incomplete (skipped in dashboard): ${detail}`);
  }
  const unregistered = out.models.filter(m => m.registered === false && m.usage);
  if (unregistered.length) {
    const ignore = new Set(unscorableModels(config));
    const actionable = unregistered.filter(m => !ignore.has(modelKey(m.model)));
    const covered = unregistered.length - actionable.length;
    if (actionable.length) {
      console.error(`  ⚠ ${actionable.length} usage model(s) not in benchmark registry (kept in exports, not scored): ${actionable.map(m => m.model).join(', ')}`);
    }
    if (covered) {
      console.error(`  ℹ ${covered} usage model(s) are unregistered placeholders/free tiers (kept in exports, not scored)`);
    }
  }
  const missingPricing = out.models.filter(m => m.complete && m.list.openrouter == null && m.list.opencode == null);
  if (missingPricing.length) {
    console.error(`  ⚠ ${missingPricing.length} active model(s) missing live list prices (no OpenRouter/OpenCode entry): ${missingPricing.map(m => m.model).join(', ')}`);
  }
  const freeScored = findFreeScoredModels(out.models);
  if (freeScored.length) {
    console.error(`  ⚠ ${freeScored.length} complete model(s) have no list price (scored as FREE — add prices to data/benchmark-inputs.json): ${freeScored.map(m => m.model).join(', ')}`);
  }
  if (process.argv.includes('--stdout')) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) main();
module.exports = {
  run,
  isStaleSnapshot,
  snapshotAndTrend,
  buildRollup,
  readMachineData,
  mergeUsageModel,
  normalizeUsageByModel,
  windowMonths,
  subMonths,
  quotaWindowKind,
  quotaWindowMultiplier,
  unscorableModels,
  buildCoverage,
  findFreeScoredModels,
  preferredQuotaWindow,
};
