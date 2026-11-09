#!/usr/bin/env node
/**
 * Value-run collector — auto-fills data/value-run.json per access path.
 *
 * "Value run" = the list-$ value of the usage you pushed through a path. The
 * Paths economics (economics.js) turn that into Covered / Util / Eff.mult / ROI,
 * so this is the one input that was hand-pasted from ccusage into the xlsx.
 *
 * Attribution is the hard part: ccusage `daily` merges every agent that touched
 * a model on a day into one shared-cost row, so it can't be split per path. The
 * fix is ccusage's per-agent subcommands (`ccusage codex`, `ccusage claude`, …),
 * which read each agent's own logs in isolation. We sum each agent's totalCost
 * and route it to a path via config.agentPathMap. Two map cleanly
 * (codex->codex, claude->claudemax); opencode->go and pi->openrouter are
 * assumptions you can edit in the config.
 *
 * Usage:
 *   node src/collect-value-run.js                 # write data/value-run.json
 *   node src/collect-value-run.js --since 20260501
 *   node src/collect-value-run.js --dry-run       # print, don't write
 *   node src/collect-value-run.js --tokscale      # ONE tokscale scan (aggregate, date-less)
 *   node src/collect-value-run.js --tokscale --daily  # per-day tokscale graph (feeds Strategy A)
 * Env: VALUE_RUN_SOURCE=tokscale | tokscale-graph (same as the two flags)
 * Env speed knobs:
 *   CCUSAGE_CONCURRENCY=4                         # parallel per-agent scans
 *   CCUSAGE_AGENT_TIMEOUT_MS=180000               # per-agent ccusage timeout
 *   CCUSAGE_AGENTS=claude,codex,pi                # skip slow no-data agents
 */

const fs = require('fs');
const path = require('path');
const { agentqHome, homeDataPath, loadRoiConfig } = require('../../lib/home.js');
const { parseSinceArg: parseSince } = require('../../lib/since.js');
const { runCcusageJson, runCcusageJsonAsync } = require('../../lib/ccusage-runner.js');


/**
 * Load pricing data for model price aliases.
 */
function loadPricing() {
  const p = homeDataPath('pricing.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { models: {} }; }
}

function ccusageJsonArgs(command, since) {
  const args = [command, '--json'];
  // Default to offline for speed — live pricing is redundant since we collect
  // fresh pricing via collect/pricing.js and the pipeline uses that for ROI
  // scoring. Set CCUSAGE_OFFLINE=0 to force live pricing if needed.
  const offline = process.env.CCUSAGE_OFFLINE ?? '1';
  if (offline === '1') args.push('--offline');
  args.push('--since', since);
  return args;
}

/**
 * Get the effective per-token cost for a model given its breakdown row
 * and an optional price alias from config.
 */
function computeModelCost(mb, modelKey, aliases, pricingModels, costBlend, priceOverrides = {}) {
  // If ccusage already has a cost, use it
  if (mb.cost && mb.cost > 0) return mb.cost;

  // Exact-key price override wins (models models.dev/OpenRouter don't expose,
  // e.g. Fireworks router keys).
  const ov = priceOverrides[modelKey] || priceOverrides[modelKey.toLowerCase()];
  if (ov) {
    const inp = (mb.inputTokens || 0) * (ov.input || 0) / 1_000_000;
    const out = (mb.outputTokens || 0) * (ov.output || 0) / 1_000_000;
    const cache = (mb.cacheReadTokens || 0) * (ov.cache || ov.input || 0) / 1_000_000;
    const creation = (mb.cacheCreationTokens || 0) * (ov.input || 0) / 1_000_000;
    return inp + out + cache + creation;
  }

  // Try price alias (case-insensitive)
  const lowerKey = modelKey.toLowerCase();
  const aliasKey = Object.keys(aliases).find(k => k.toLowerCase() === lowerKey);
  const alias = aliasKey ? aliases[aliasKey] : null;
  if (!alias) return 0;

  const priceData = pricingModels[alias];
  if (!priceData) return 0;

  const p = priceData.openrouter || priceData.opencode;
  if (!p) return 0;

  const inp = (mb.inputTokens || 0) * (p.input || 0) / 1_000_000;
  const out = (mb.outputTokens || 0) * (p.output || 0) / 1_000_000;
  const cache = (mb.cacheReadTokens || 0) * (p.cache || p.input || 0) / 1_000_000;
  const creation = (mb.cacheCreationTokens || 0) * (p.input || 0) / 1_000_000;
  return inp + out + cache + creation;
}

/**
 * Split multi-provider agent costs using ccusage daily modelBreakdowns
 * and config.modelPathPatterns. Returns { perPath, perAgentCosts } where
 * perAgentCosts is { agent: totalCost } for the pattern-based agents.
 */
function collectModelPatternsFromRows(rows, config) {
  const patterns = config.modelPathPatterns || {};
  const patternAgents = Object.keys(patterns);
  if (!patternAgents.length) return { perPath: {}, perAgentCosts: {} };

  const aliases = config.modelPriceAliases || {};
  const pricingData = loadPricing();
  const pricingModels = pricingData.models || {};
  const costBlend = config.costBlend || {};
  const priceOverrides = config.priceOverrides || {};
  const perPath = {};         // pathId -> cost
  const perAgentCosts = {};   // agent -> totalCost

  for (const row of rows) {
    const mn = row.modelName || row.model || '';
    if (!mn) continue;

    // Check each agent that has patterns
    for (const agent of patternAgents) {
      const prefix = `[${agent}] `;
      if (!mn.startsWith(prefix)) continue;

      const stripped = mn.slice(prefix.length);
      const agentPatterns = patterns[agent];

      for (const p of agentPatterns) {
        if (stripped.includes(p.match)) {
          const cost = computeModelCost({
            ...row,
            // Raw ccusage rows call this cacheCreationTokens; usageRecords
            // normalize the same field to cacheWriteTokens.
            cacheCreationTokens: row.cacheCreationTokens ?? row.cacheWriteTokens,
          }, stripped, aliases, pricingModels, costBlend, priceOverrides);
          if (cost > 0) {
            perPath[p.path] = (perPath[p.path] || 0) + cost;
            perAgentCosts[agent] = (perAgentCosts[agent] || 0) + cost;
          }
          break;
        }
      }
      break;
    }
  }

  for (const [path, c] of Object.entries(perPath)) perPath[path] = Math.round(c * 100) / 100;
  for (const [agent, c] of Object.entries(perAgentCosts)) perAgentCosts[agent] = Math.round(c * 100) / 100;

  return { perPath, perAgentCosts };
}

function dailyRows(daily) {
  const rows = [];
  const days = Array.isArray(daily?.daily) ? daily.daily : [];
  for (const day of days) rows.push(...(day.modelBreakdowns || []));
  return rows;
}

function collectModelPatternsFromRecords(records, config) {
  return collectModelPatternsFromRows(records || [], config);
}

function collectModelPatterns(since, config) {
  const daily = runCcusageJson(ccusageJsonArgs('daily', since));
  return collectModelPatternsFromRows(dailyRows(daily), config);
}

async function collectModelPatternsAsync(since, config) {
  const daily = await runCcusageJsonAsync(ccusageJsonArgs('daily', since));
  return collectModelPatternsFromRows(dailyRows(daily), config);
}

/** Run `ccusage <agent> --json --since <date>`, return totalCost or null.
 *  Live pricing by default (offline undercounts ~2×); CCUSAGE_OFFLINE=1 opts out. */
function agentArgs(agent, since) {
  return ccusageJsonArgs(agent, since);
}

function costFromJson(j) {
  const t = j.totals || {};
  // codex names it costUSD; everyone else totalCost.
  const cost = t.totalCost ?? t.costUSD ?? t.cost ?? null;
  return { ok: cost != null, cost: cost == null ? 0 : Number(cost) };
}

function positiveNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function agentTimeoutMs() {
  return positiveNumberEnv('CCUSAGE_AGENT_TIMEOUT_MS', 180000);
}

function agentCost(agent, since) {
  try {
    return costFromJson(runCcusageJson(agentArgs(agent, since), { timeout: agentTimeoutMs() }));
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function agentCostAsync(agent, since) {
  const started = Date.now();
  try {
    const r = costFromJson(await runCcusageJsonAsync(agentArgs(agent, since), { timeout: agentTimeoutMs() }));
    return { ...r, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, error: e.message, ms: Date.now() - started };
  }
}

// Agents in agentPathMap that have no ccusage subcommand — scanning them
// wastes ~2s on npx fallback before failing. They are handled by the pi
// session scanner or other attribution paths instead.
const NO_CCUSAGE_SUBCOMMAND = new Set(['nan', 'antigravity-cli', 'cursor']);

function selectedAgentEntries(map) {
  const entries = Object.entries(map).filter(([agent]) => !NO_CCUSAGE_SUBCOMMAND.has(agent));
  const only = (process.env.CCUSAGE_AGENTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!only.length) return entries;
  const allow = new Set(only);
  return entries.filter(([agent]) => allow.has(agent));
}

function collect(since, config) {
  const map = config.agentPathMap || {};
  const patterns = config.modelPathPatterns || {};
  const patternAgents = new Set(Object.keys(patterns));
  const entries = selectedAgentEntries(map).filter(([agent]) => !patternAgents.has(agent));
  const perAgent = {};   // agent -> cost
  const perPath = {};    // pathId -> cost
  const errors = [];

  // 1. Single-provider agents: per-agent commands
  for (const [agent, pathId] of entries) {
    const r = agentCost(agent, since);
    if (!r.ok && r.error) { errors.push(`${agent}: ${r.error}`); continue; }
    if (!r.cost) continue;
    perAgent[agent] = r.cost;
    perPath[pathId] = (perPath[pathId] || 0) + r.cost;
  }

  // 2. Multi-provider agents: split via daily modelBreakdowns
  if (patternAgents.size) {
    const { perPath: patPath, perAgentCosts: patAgent } = collectModelPatterns(since, config);
    for (const [path, c] of Object.entries(patPath)) {
      perPath[path] = (perPath[path] || 0) + c;
    }
    for (const [agent, c] of Object.entries(patAgent)) {
      perAgent[agent] = (perAgent[agent] || 0) + c;
    }
  }

  return { perAgent, perPath, errors, timings: {}, attempted: entries.map(([agent]) => agent) };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function collectAsync(since, config, opts = {}) {
  // tokscale mode: ONE Rust scan replaces per-agent ccusage subcommands +
  // daily modelBreakdowns pattern split + the pi session scanner. Records are
  // routed by provider (providerPathMap) then client (agentPathMap).
  //   - 'tokscale'          aggregate over the range (date-less records)
  //   - 'tokscale-graph'    per-day records (feeds Strategy A + usageRecords)
  const source = opts.source || process.env.VALUE_RUN_SOURCE || 'ccusage';
  if (source === 'tokscale-graph') {
    const { collectTokscaleGraphValueRun } = require('./value-run-tokscale.js');
    console.error('  value-run: using tokscale graph (one Rust scan, per-day) instead of ccusage per-agent');
    return collectTokscaleGraphValueRun(since, config, opts);
  }
  if (source === 'tokscale') {
    const { collectTokscaleValueRun } = require('./value-run-tokscale.js');
    console.error('  value-run: using tokscale (single Rust scan) instead of ccusage per-agent');
    return collectTokscaleValueRun(since, config, opts);
  }

  const map = config.agentPathMap || {};
  const patterns = config.modelPathPatterns || {};
  const patternAgents = new Set(Object.keys(patterns));
  // Pi is handled by the session scanner (step 3), not by modelPathPatterns
  // or per-agent ccusage. Exclude it from both.
  const agentsToSkip = new Set([...patternAgents, 'pi']);
  const entries = selectedAgentEntries(map).filter(([agent]) => !agentsToSkip.has(agent));
  const perAgent = {};   // agent -> cost
  const perPath = {};    // pathId -> cost
  const errors = [];
  const timings = {};
  const concurrency = Math.max(1, Math.floor(positiveNumberEnv('CCUSAGE_CONCURRENCY', 3)));

  console.error(`  value-run: scanning ${entries.length} per-agent ccusage sources (concurrency ${concurrency})`);

  // 1. Single-provider agents: per-agent commands (fast)
  const results = await mapLimit(entries, concurrency, async ([agent, pathId]) => {
    console.error(`    → ccusage ${agent} started`);
    const r = await agentCostAsync(agent, since);
    const status = r.ok ? `$${Number(r.cost || 0).toFixed(2)}` : `skipped (${r.error || 'no data'})`;
    console.error(`    ✓ ccusage ${agent} done in ${(r.ms / 1000).toFixed(1)}s — ${status}`);
    return { agent, pathId, ...r };
  });

  for (const r of results) {
    timings[r.agent] = r.ms;
    if (!r.ok && r.error) { errors.push(`${r.agent}: ${r.error}`); continue; }
    if (!r.cost) continue;
    perAgent[r.agent] = r.cost;
    perPath[r.pathId] = (perPath[r.pathId] || 0) + r.cost;
  }

  // 2. Multi-provider agents: split via daily modelBreakdowns. collect-machine
  // shares its usage-by-model scan here so we don't run `ccusage daily` twice.
  if (patternAgents.size) {
    const patStart = Date.now();
    const shared = opts.usagePromise ? ' from shared usage-by-model records' : '';
    console.error(`  value-run: scanning daily modelBreakdowns for pattern agents (${[...patternAgents].join(', ')})${shared}`);
    try {
      let patternResult = null;
      if (opts.usagePromise) {
        const usage = await opts.usagePromise;
        if (usage?.available && Array.isArray(usage.records)) {
          patternResult = collectModelPatternsFromRecords(usage.records, config);
        } else if (usage?.error) {
          errors.push(`model-patterns: ${usage.error} (shared usage scan unavailable; skipped pattern attribution)`);
          patternResult = { perPath: {}, perAgentCosts: {} };
        }
      }
      if (!patternResult) patternResult = await collectModelPatternsAsync(since, config);

      const { perPath: patPath, perAgentCosts: patAgent } = patternResult;
      for (const [path, c] of Object.entries(patPath)) {
        perPath[path] = (perPath[path] || 0) + c;
      }
      for (const [agent, c] of Object.entries(patAgent)) {
        perAgent[agent] = (perAgent[agent] || 0) + c;
        timings[agent] = Date.now() - patStart;  // rough timing
      }
      console.error(`  pattern-matched ${Object.keys(patPath).length} paths from ${Object.keys(patAgent).length} agents (daily)`);
    } catch (e) {
      errors.push(`model-patterns: ${e.message}`);
    }
  }

  // 3. Pi session scanner: directly reads pi's session files for provider-level
  //    attribution. Pi is excluded from steps 1 (per-agent ccusage) and 2
  //    (modelPathPatterns) because ccusage daily's modelBreakdowns drop the
  //    provider field, making it impossible to distinguish openrouter from
  //    opencode-go from fireworks from cline-pass by model name alone.
  //
  //    Pi's own session files record the ACTUAL provider on every assistant
  //    message (e.g., "opencode-go", "fireworks", "openai-codex", "umans").
  //    We parse them directly for the per-provider cost breakdown.
  let piResult = null;
  if (config.agentPathMap?.pi) {
    try {
      console.error('  value-run: scanning pi session files');
      const { scanPiSessions } = require('../../lib/pi-session-scanner.js');
      const providerPathMap = config.providerPathMap || {};
      const modelPriceAliases = config.modelPriceAliases || {};
      const pricingData = loadPricing();
      const pricingModels = pricingData.models || {};
      piResult = scanPiSessions(since, providerPathMap, {
        modelPriceAliases,
        pricingModels,
      });

      if (piResult.totalEntries > 0 && piResult.totalCost > 0) {
        // The scanner provides the COMPLETE pi provider breakdown.
        // No modelPathPatterns entries for pi exist anymore, so no double-count.
        for (const [path, cost] of Object.entries(piResult.perPath)) {
          if (cost > 0) {
            perPath[path] = (perPath[path] || 0) + cost;
          }
        }

        perAgent.pi = (perAgent.pi || 0) + piResult.totalCost;
        timings.pi = 100;

        if (piResult.errors.length) {
          errors.push(...piResult.errors.map(e => `pi-scanner: ${e}`));
        }
        console.error(`  pi session scanner: ${piResult.totalEntries} entries, $${piResult.totalCost.toFixed(2)} across ${Object.keys(piResult.perPath).length} paths`);
      }
    } catch (e) {
      errors.push(`pi-scanner: ${e.message}`);
    }
  }

  return { perAgent, perPath, errors, timings, concurrency, attempted: entries.map(([agent]) => agent), piResult, source: 'ccusage' };
}

async function main() {
  const argv = process.argv.slice(2);
  const since = parseSince(argv);
  const dry = argv.includes('--dry-run');
  const config = loadRoiConfig();
  const started = Date.now();
  // tokscale modes: --tokscale (aggregate) or --tokscale --daily (per-day graph),
  // each also selectable via VALUE_RUN_SOURCE=tokscale / tokscale-graph.
  const envSource = process.env.VALUE_RUN_SOURCE;
  const useTokscale = argv.includes('--tokscale') || envSource === 'tokscale';
  const useGraph = useTokscale && (argv.includes('--daily') || envSource === 'tokscale-graph');

  const { perAgent, perPath, errors, timings, concurrency, attempted, source } =
    await collectAsync(since, config, { source: useGraph ? 'tokscale-graph' : (useTokscale ? 'tokscale' : undefined) });

  // value-run.json stays a flat { pathId: usd } so pipeline reads it directly;
  // provenance goes under _meta (pipeline ignores keys it doesn't recognize).
  const round = n => Math.round(n * 100) / 100;

  const patternAgents = Object.keys(config.modelPathPatterns || {});
  const srcForMeta = useGraph
    ? 'tokscale graph (per-day client,provider,model, routed via providerPathMap/agentPathMap)'
    : useTokscale
      ? 'tokscale (client,provider,model, routed via providerPathMap/agentPathMap)'
    : patternAgents.length
      ? `ccusage per-agent + daily modelBreakdowns (${patternAgents.join(', ')}) + pi session scanner`
      : 'ccusage per-agent subcommands + pi session scanner';

  const out = { _meta: { since, generatedAt: new Date().toISOString(), perAgent, source: srcForMeta } };
  for (const [id, c] of Object.entries(perPath)) out[id] = round(c);
  for (const k of Object.keys(perAgent)) perAgent[k] = round(perAgent[k]);

  console.error(`Value run since ${since} (source ${source}, ccusage concurrency ${concurrency}, agents ${attempted.length}/${Object.keys(config.agentPathMap || {}).length}):`);
  const patternSet = new Set(patternAgents);
  for (const [a, c] of Object.entries(perAgent).sort((x, y) => y[1] - x[1])) {
    const secs = timings[a] == null ? '' : `  ${(timings[a] / 1000).toFixed(1)}s`;
    const via = useTokscale
      ? ` -> ${config.agentPathMap[a] || '?'}`
      : patternSet.has(a) ? ' (split via modelPathPatterns)' : a === 'pi' ? ' (pi session scanner)' : ` -> ${config.agentPathMap[a]}`;
    console.error(`  ${a.padEnd(10)} $${c.toFixed(2).padStart(9)}${via}${secs}`);
  }
  const zeroOrSkipped = Object.keys(timings).filter(a => !(a in perAgent));
  if (zeroOrSkipped.length) {
    console.error('  zero/skipped timings:', zeroOrSkipped.map(a => `${a} ${(timings[a] / 1000).toFixed(1)}s`).join(', '));
  }
  console.error('paths:', Object.fromEntries(Object.entries(out).filter(([k]) => k !== '_meta')));
  if (errors.length) console.error('skipped:', errors.join('; '));
  console.error(`value-run ccusage wall time: ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (dry) { console.error('(dry-run — not written)'); return out; }
  const decision = resolveValueRunWrite(readPreviousPaths(), out);
  if (decision === 'keep') {
    console.error('refusing to overwrite data/value-run.json with an empty result — keeping last good data');
    process.exitCode = 1;
    return out;
  }
  const p = homeDataPath('value-run.json');
  fs.writeFileSync(p, JSON.stringify(out, null, 2) + '\n');
  console.error(`wrote ${path.relative(agentqHome(), p)}`);
  if (decision === 'empty') process.exitCode = 1;
  return out;
}

function readPreviousPaths() {
  try {
    const prev = JSON.parse(fs.readFileSync(homeDataPath('value-run.json'), 'utf8'));
    const { _meta, ...paths } = prev || {};
    return paths;
  } catch { return null; }
}

// Decide what a collection result may do to data/value-run.json. Same rule
// as pricing/quota: an all-failure run must never wipe last-known values
// (here: real per-path dollars supplementing stale machine imports).
// Returns 'write' (new data), 'keep' (empty result, previous exists), or
// 'empty' (empty result, nothing previous).
function resolveValueRunWrite(prevPaths, out) {
  const next = out ? Object.keys(out).filter(k => k !== '_meta') : [];
  if (next.length > 0) return 'write';
  const prevKeys = prevPaths ? Object.keys(prevPaths).length : 0;
  return prevKeys > 0 ? 'keep' : 'empty';
}

if (require.main === module) main().catch(err => { console.error(err.message); process.exit(1); });
module.exports = {
  collect,
  collectAsync,
  collectModelPatterns,
  collectModelPatternsAsync,
  collectModelPatternsFromRecords,
  agentCost,
  agentCostAsync,
  parseSince,
  resolveValueRunWrite,
};
