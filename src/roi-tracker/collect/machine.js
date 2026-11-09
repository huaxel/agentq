#!/usr/bin/env node
/**
 * Per-machine usage exporter — run this on EACH machine (laptop, desktop, …).
 *
 * ccusage reads only the local logs of the box it runs on, so no single machine
 * sees your whole footprint. This bundles THIS machine's per-path value runs and
 * per-model spend into data/usage-imports/<hostname>.json. Sync that folder
 * across machines (git / Syncthing / Dropbox) and the pipeline sums the bundles
 * into an account-wide-ish total. Each machine has distinct session logs, so
 * summing doesn't double-count.
 *
 * CAVEAT: this still can't see CLOUD / web-app sessions (those logs live on the
 * provider, not any machine). For flat-rate, rate-limited subs (Claude Max,
 * Codex) the account-wide signal is the codexbar quota % (collect-quota), which
 * DOES include cloud usage. Use $ value runs as a floor; quota % as the truth.
 *
 * Usage (on each machine): node src/roi-tracker/collect/machine.js [options]
 *   --tokscale      use ONE tokscale scan instead of ccusage for value-run +
 *                    model totals (env VALUE_RUN_SOURCE=tokscale also works)
 *   --tokscale --daily  per-day tokscale graph — dated usage/model/CSV rows
 *                    feed pipeline Strategy A (VALUE_RUN_SOURCE=tokscale-graph)
 *   --max-age-min N  reuse this host's existing bundle if it is fresh enough
 *   --sync-git       commit and push this host's bundle after collection
 *   --no-git         deprecated compatibility flag; syncing is off by default
 * Env speed knobs: CCUSAGE_CONCURRENCY=3, CCUSAGE_AGENT_TIMEOUT_MS=180000,
 *                  CCUSAGE_AGENTS=claude,codex,pi,
 *                  USAGE_BUNDLE_MAX_AGE_MINUTES=15
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const { collectAsync } = require('./value-run.js');
const { fetchAndAggregateAsync } = require('./usage.js');
const { agentqHome, homeDataPath, loadRoiConfig } = require('../../lib/home.js');
const { parseSinceArg: parseSince } = require('../../lib/since.js');


const HELP = `Usage: npm run collect -- [options]

Collect this machine's usage into data/usage-imports/<hostname>.json.

Options:
  --since YYYY-MM-DD  Set the usage window start
  --tokscale          Use a single tokscale scan
  --daily             Preserve dated tokscale graph records
  --max-age-min N     Reuse a matching recent bundle
  --sync-git          Commit and push the resulting bundle
  --no-git            Deprecated; collection is already local-only by default
  -h, --help          Show this help

Git synchronization is off by default.`;

// Commit & push ONLY this host's bundle, so machines never clobber each other.
// Pull --rebase first so concurrent pushes integrate (each edits its own file).
// Every step fails soft — offline / no-remote just skips, never throws.
function git(args, cwd = agentqHome()) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
}
function syncToGit(relFile, cwd = agentqHome()) {
  try { git(['rev-parse', '--is-inside-work-tree'], cwd); }
  catch { console.error('  (not a git repo — skipping sync)'); return; }
  try {
    git(['add', '--', relFile], cwd);
    const staged = (() => { try { git(['diff', '--cached', '--quiet', '--', relFile], cwd); return false; } catch { return true; } })();
    if (!staged) { console.error('  git: bundle unchanged, nothing to commit'); return; }
    git(['commit', '-m', `usage: ${os.hostname()}`, '--', relFile], cwd);
    console.error('  git: committed bundle');
    let hasRemote = true;
    try { git(['remote', 'get-url', 'origin'], cwd); } catch { hasRemote = false; }
    if (!hasRemote) { console.error('  git: no origin remote — commit only'); return; }
    try {
      git(['pull', '--rebase', '--autostash'], cwd);
    } catch (e) {
      console.error('  git: pull --rebase failed:', e.message.split('\n')[0]);
      // A conflicting or killed (timeout) rebase leaves .git/rebase-merge
      // behind, wedging every future sync. Best-effort abort restores the
      // pre-pull state. Then fall back to a regular merge pull so the commit
      // still reaches the remote this cycle instead of being stranded locally.
      try { git(['rebase', '--abort'], cwd); console.error('  git: aborted the failed rebase'); }
      catch { /* nothing to abort, or the failure wasn't rebase-related */ }
      try {
        console.error('  git: retrying with merge pull...');
        git(['pull', '--no-rebase', '--no-edit'], cwd);
        console.error('  git: merge pull succeeded');
      } catch (e2) {
        console.error('  git: merge pull also failed:', e2.message.split('\n')[0]);
        // Abort the failed merge so git isn't left in a conflicted state.
        try { git(['merge', '--abort'], cwd); console.error('  git: aborted the failed merge'); }
        catch { /* nothing to abort */ }
        console.error('  git: commit is safe locally; will retry on next sync');
        return;
      }
    }
    git(['push'], cwd);
    console.error('  git: pushed ✓');
  } catch (e) {
    console.error('  git: sync failed (commit/push) —', e.message.split('\n')[0]);
  }
}

function shouldSyncGit(argv) {
  return argv.includes('--sync-git') && !argv.includes('--no-git');
}

function recordFingerprint(hostname, source, record) {
  return JSON.stringify([
    hostname,
    source,
    record.origin || '',
    record.date || '',
    record.pathId || '',
    record.provider || '',
    record.agent || record.client || '',
    record.model || '',
    record.inputTokens || 0,
    record.outputTokens || 0,
    record.cacheReadTokens || 0,
    record.cacheWriteTokens || 0,
    record.cost || 0,
  ]);
}

function assignRecordIds(hostname, records, sourceFor) {
  const occurrences = new Map();
  return records.map(record => {
    if (typeof record.recordId === 'string' && record.recordId) return { ...record };
    const fingerprint = recordFingerprint(hostname, sourceFor(record), record);
    const occurrence = occurrences.get(fingerprint) || 0;
    occurrences.set(fingerprint, occurrence + 1);
    const recordId = crypto.createHash('sha256')
      .update(`${fingerprint}\n${occurrence}`)
      .digest('hex')
      .slice(0, 24);
    return { ...record, recordId };
  });
}

function collectionMode(argv, env = process.env) {
  const source = env.VALUE_RUN_SOURCE;
  const tokscale = argv.includes('--tokscale') || source === 'tokscale' || source === 'tokscale-graph';
  const graph = tokscale && (argv.includes('--daily') || source === 'tokscale-graph');
  return { tokscale, graph };
}

function hasUsableGraphResult(result) {
  return Boolean(
    result?.models && Object.keys(result.models).length > 0 &&
    result?.records?.some(record => record.date),
  );
}

function maxAgeMinutes(argv) {
  const idx = argv.indexOf('--max-age-min');
  const raw = idx !== -1 ? argv[idx + 1] : process.env.USAGE_BUNDLE_MAX_AGE_MINUTES;
  const n = raw == null ? 0 : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function freshEnough(bundlePath, maxAgeMin, since) {
  if (!maxAgeMin) return false;
  let d;
  try { d = JSON.parse(fs.readFileSync(bundlePath, 'utf8')); }
  catch { return false; }
  // A bundle collected for a different --since window isn't "fresh" for this
  // run even if it was just written — its totals cover the wrong date range.
  if (d.since !== since) return false;
  const t = Date.parse(d.generatedAt || '');
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= maxAgeMin * 60_000;
}

function reuseFreshBundle(argv, { bundlePath, maxAgeMin, since, rel, sync = syncToGit }) {
  if (!freshEnough(bundlePath, maxAgeMin, since)) return false;
  console.error(`reusing fresh ${rel} (<= ${maxAgeMin} min old) — skipping collection`);
  if (shouldSyncGit(argv)) sync(rel);
  return true;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }

  const since = parseSince(argv);
  const config = loadRoiConfig();
  const hostname = os.hostname();

  const dir = homeDataPath('usage-imports');
  fs.mkdirSync(dir, { recursive: true });
  const rel = path.join('data', 'usage-imports', `${hostname.replace(/[^\w.-]/g, '_')}.json`);
  const bundlePath = homeDataPath('usage-imports', `${hostname.replace(/[^\w.-]/g, '_')}.json`);
  const maxAgeMin = maxAgeMinutes(argv);
  if (reuseFreshBundle(argv, { bundlePath, maxAgeMin, since, rel })) return;

  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  const { tokscale: useTokscale, graph: useGraph } = collectionMode(argv);
  console.error(`collect-machine: host=${hostname} since=${since}`);
  console.error(`  output: ${rel}`);
  console.error(useGraph
    ? '  starting one dated tokscale graph scan...'
    : '  starting value-run + dated ccusage scans in parallel...');

  // Aggregate modes retain ccusage's dated rows for daily exports. The
  // recommended tokscale graph mode already has dated model/provider records,
  // so launching ccusage as well would only rescan the same local stores. Keep
  // ccusage as a lazy fallback: if the graph scan returns nothing usable, the
  // fallback below re-runs the FULL ccusage collection (not just daily rows)
  // so the bundle stays coherent.
  const fetchDatedUsage = () => fetchAndAggregateAsync(since).then(r => {
    const summary = r.available ? `${Object.keys(r.models).length} models, ${r.records.length} records` : `unavailable: ${r.error}`;
    console.error(`  ✓ usage-by-model scan done in ${elapsed()} (${summary})`);
    return r;
  });
  const usagePromise = useGraph ? null : fetchDatedUsage();
  // tokscale mode (--tokscale or VALUE_RUN_SOURCE=tokscale): ONE Rust scan
  // replaces the ccusage value-run dance; usageByModel also comes from that
  // scan (below) so the pipeline never merges two scans of the same logs.
  // Add --daily (or VALUE_RUN_SOURCE=tokscale-graph) to use the per-day
  // `tokscale graph` reader instead of the aggregate adapter — dated records
  // then feed Strategy A and usageRecords.
  const valuePromise = collectAsync(since, config, { usagePromise, source: useGraph ? 'tokscale-graph' : (useTokscale ? 'tokscale' : undefined) })
    .then(r => { console.error(`  ✓ value-run scan done in ${elapsed()} (${Object.keys(r.perPath).length} paths)`); return r; });
  let valueResult = await valuePromise;
  let usage = { available: false, models: {}, records: [] };
  // A requested graph scan that returns nothing usable must not produce a
  // half-ccusage bundle (ccusage daily rows + empty value-run + skipped
  // supplements = silently collapsed wallets). Redo the value run in ccusage
  // mode so perPath, pi attribution, and the supplements below stay coherent.
  let effectiveTokscale = useTokscale;
  if (useGraph && !hasUsableGraphResult(valueResult)) {
    console.error('  ⚠ tokscale graph returned no dated model data; falling back to full ccusage collection');
    effectiveTokscale = false;
    usage = await fetchDatedUsage();
    // Pin the source: without this, VALUE_RUN_SOURCE=tokscale-graph would
    // reselect the failed graph collector instead of the ccusage fallback.
    valueResult = await collectAsync(since, config, { usagePromise: Promise.resolve(usage), source: 'ccusage' })
      .then(r => { console.error(`  ✓ ccusage fallback value-run done in ${elapsed()} (${Object.keys(r.perPath).length} paths)`); return r; });
  } else if (!useGraph) {
    usage = await usagePromise;
  }
  let {
    perPath,
    piResult,
    providerRecords: tsProviderRecords,
    records: tsRecords,
    models: tsModels,
    source: valueSource,
  } = valueResult;
  let usageByModel = usage.available ? usage.models : {};

  // Reuse pi provider records from the value-run scan — avoids a second
  // expensive walk of ~/.pi/agent/sessions/. In tokscale mode there is no
  // piResult: the single tokscale scan's own provider records carry the
  // attribution (provider + client per record) and its per-model aggregate
  // becomes usageByModel (see below).
  let providerUsageRecords = [];
  let bundleProviderSource = null;
  if (piResult?.providerRecords?.length) {
    providerUsageRecords = piResult.providerRecords;
    console.error(`  ✓ pi provider attribution (from value-run): ${providerUsageRecords.length} provider/model/day rows`);
  } else if (valueSource === 'tokscale' || valueSource === 'tokscale-graph') {
    // tokscale mode has no piResult: provider attribution comes from the SAME
    // tokscale scan (data/tokscale-by-provider.json is the standalone A/B
    // artifact; the bundle carries the routed records directly). Aggregate
    // ('tokscale') records are date-less; per-day ('tokscale-graph') records
    // carry dates, so pipeline Strategy A date-filtering and usageRecords
    // work only in --daily mode. Both feed pathModelUsage + usageByModel.
    if (tsProviderRecords?.length) {
      providerUsageRecords = tsProviderRecords;
      console.error(`  ✓ tokscale provider attribution (from value-run): ${tsProviderRecords.length} provider/model rows (${valueSource === 'tokscale-graph' ? 'dated' : 'date-less'})`);
      bundleProviderSource = 'tokscale';
    } else {
      console.error('  ⚠ tokscale value-run mode: no provider records from scan');
    }
    // tokscale and ccusage daily price the SAME local logs (claude-opus-4-8 is
    // ~$615 in both), so folding both into one usageByModel would double count
    // every overlapping model. In tokscale mode the tokscale aggregate is the
    // single source; ccusage daily still feeds dated usageRecords below.
    if (tsModels && Object.keys(tsModels).length) {
      usageByModel = tsModels;
      console.error(`  ✓ usage-by-model from tokscale scan: ${Object.keys(tsModels).length} models (replaces ccusage daily — no double count)`);
    }
  } else {
    console.error(`  ⚠ pi provider attribution: no records from value-run scan`);
  }

  // Antigravity brain session scan: parses agy CLI / IDE / Core brain
  // transcripts for session-level usage data separate from pi session files.
  // SKIPPED in tokscale modes: tokscale's local scan already covers the
  // antigravity-cli client (~$170 here, provider-attributed), so running the
  // brain scan on top would double count antigravity spend. ccusage mode needs
  // it (ccusage's per-agent path excludes antigravity).
  if (!effectiveTokscale) {
  try {
    const { scanAntigravitySessions } = require('../../lib/antigravity-scanner.js');
    let pricingData;
    try {
      pricingData = JSON.parse(fs.readFileSync(homeDataPath('pricing.json'), 'utf8'));
    } catch { pricingData = { models: {} }; }
    const agResult = scanAntigravitySessions(since, {
      modelPriceAliases: config.modelPriceAliases || {},
      pricingModels: pricingData.models || {},
    });
    if (agResult.providerRecords.length) {
      providerUsageRecords.push(...agResult.providerRecords);
      const logInfo = agResult.usageLogEntries ? `, ${agResult.usageLogEntries} proxy-captured calls` : '';
      console.error(`  ✓ antigravity brain scan: ${agResult.totalSessions} sessions across ${agResult.providerRecords.length} days (model: ${agResult.model}${logInfo})`);
    } else {
      const logInfo = agResult.usageLogEntries ? ` (${agResult.usageLogEntries} proxy-captured calls)` : '';
      console.error(`  ✓ antigravity brain scan: no sessions found since ${since}${logInfo}`);
    }
  } catch (e) {
    console.error(`  ⚠ antigravity brain scan: ${e.message}`);
  }

  // Claude Code CLI transcripts (~/.claude/projects): standalone Claude Code
  // usage the pi session scanner can't see (its logs live in ~/.claude, not the
  // pi session store). tokscale reads them; this makes the DEFAULT pipeline
  // capture them too. Skipped in tokscale modes (tokscale already scans ~/.claude).
  try {
    const { scanClaudeSessions } = require('../../lib/claude-scanner.js');
    let pricingData;
    try {
      pricingData = JSON.parse(fs.readFileSync(homeDataPath('pricing.json'), 'utf8'));
    } catch { pricingData = { models: {} }; }
    const cc = scanClaudeSessions(since, config.providerPathMap || {}, {
      modelPriceAliases: config.modelPriceAliases || {},
      pricingModels: pricingData.models || {},
    });
    if (cc.providerRecords.length) {
      providerUsageRecords.push(...cc.providerRecords);
      console.error(`  ✓ claude code scan: ${cc.totalEntries} turns $${cc.totalCost.toFixed(2)} across ${cc.providerRecords.length} model rows (path: ${Object.keys(cc.perPath).join(',')})`);
    } else {
      console.error('  ✓ claude code scan: no sessions found since ' + since);
    }
  } catch (e) {
    console.error(`  ⚠ claude code scan: ${e.message}`);
  }
  } // end if (!effectiveTokscale) — supplements run in ccusage mode (incl. graph fallback)

  // Cursor: in ccusage/pi mode, prefer tokscale's Cursor API usage (REAL
  // token/cost billing data from cursor.com's export-usage-events CSV, synced
  // via `bunx tokscale cursor login` + `cursor sync`) over the edit-count
  // ai-code-tracking.db estimate. In tok-scale mode the main all-client scan
  // already includes Cursor, so a second Cursor scan would duplicate it.
  let cursorRecords = [];
  let cursorSource = 'none';
  if (!effectiveTokscale) {
  try {
    const { getTokscaleUsageAsync } = require('../tokscale-adapter.js');
    const ts = await getTokscaleUsageAsync(since, { clients: ['cursor'] });
    if (ts.available && ts.records.length) {
      cursorRecords = ts.records.map(r => ({
        date: null, // tokscale JSON has no per-day dates (cursor path has no startDate, so no Strategy A impact)
        pathId: 'cursor',
        origin: 'cursor',
        provider: r.provider || 'cursor',
        model: r.model,
        cost: r.cost || 0,
        tokens: (r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheWriteTokens || 0),
        inputTokens: r.inputTokens || 0,
        outputTokens: r.outputTokens || 0,
        cacheReadTokens: r.cacheReadTokens || 0,
        cacheWriteTokens: r.cacheWriteTokens || 0,
      }));
      cursorSource = 'tokscale';
      const est = cursorRecords.reduce((s, r) => s + r.cost, 0);
      console.error(`  ✓ cursor usage (tokscale API, real billing): ${ts.records.length} model rows, $${est.toFixed(2)}`);
    }
  } catch (e) {
    console.error(`  ⚠ tokscale cursor unavailable (${e.message}); falling back to edit-count scanner`);
  }

  if (!cursorRecords.length) {
    try {
      const { scanCursorUsage } = require('../../lib/cursor-scanner.js');
      let pricingData;
      try {
        pricingData = JSON.parse(fs.readFileSync(homeDataPath('pricing.json'), 'utf8'));
      } catch { pricingData = { models: {} }; }
      const cursorResult = scanCursorUsage(since, {
        modelPriceAliases: config.modelPriceAliases || {},
        pricingModels: pricingData.models || {},
        providerPathMap: config.providerPathMap || {},
      });
      if (cursorResult.providerRecords.length) {
        cursorRecords = cursorResult.providerRecords.map(r => ({ ...r, origin: r.origin || 'cursor' }));
        cursorSource = 'edit-count';
        console.error(`  ✓ cursor AI tracking scan: ${cursorResult.totalEdits} edits across ${cursorResult.providerRecords.length} days (models: ${Object.keys(cursorResult.modelSummary).join(', ')})`);
        const estimatedCost = cursorResult.providerRecords.reduce((s, r) => s + r.cost, 0);
        if (estimatedCost > 0) {
          console.error(`  cursor estimated cost: $${estimatedCost.toFixed(2)} (from pricing config — not actual billing)`);
        }
      }
    } catch (e) {
      console.error(`  ⚠ cursor AI tracking scan: ${e.message}`);
    }
  }
  }
  if (cursorRecords.length) {
    providerUsageRecords.push(...cursorRecords);
  } else {
    console.error('  ✓ cursor: no usage found since ' + since);
  }

  // Preserve raw daily rows for downstream CSV exports. Keeps each host's
  // local view so multi-machine merges don't double-count. In per-day
  // tokscale-graph mode the dated graph records ARE the daily rows (toksScale
  // sees sessions ccusage's daily misses), so use them; otherwise ccusage daily.
  const useGraphUsageRecords = valueSource === 'tokscale-graph' && Array.isArray(tsRecords) && tsRecords.length && tsRecords.some(r => r.date);
  const usageRecords = useGraphUsageRecords ? tsRecords.map(r => ({
    date: r.date,
    model: r.model,
    agent: r.client || r.agent || '',
    inputTokens: r.inputTokens || 0,
    outputTokens: r.outputTokens || 0,
    cacheReadTokens: r.cacheReadTokens || 0,
    cacheWriteTokens: r.cacheWriteTokens || 0,
    cost: r.cost || 0,
  })) : (usage.available ? usage.records.map(r => ({
    date: r.date,
    model: r.model,
    agent: r.agent,
    inputTokens: r.inputTokens || 0,
    outputTokens: r.outputTokens || 0,
    cacheReadTokens: r.cacheReadTokens || 0,
    cacheWriteTokens: r.cacheWriteTokens || 0,
    cost: r.cost || 0,
  })) : []);

  const round2 = n => Math.round(n * 100) / 100;
  const canonicalUsageRecords = assignRecordIds(
    hostname,
    usageRecords,
    () => valueSource || 'usage',
  );
  const canonicalProviderRecords = assignRecordIds(
    hostname,
    providerUsageRecords,
    record => record.origin || bundleProviderSource || 'provider',
  );
  const valueRun = {};
  for (const [k, v] of Object.entries(perPath)) valueRun[k] = round2(v);

  const bundle = {
    usageSchemaVersion: 1,
    hostname,
    generatedAt: new Date().toISOString(),
    since,
    valueRun,
    usageByModel,
    usageRecords: canonicalUsageRecords,
    providerUsageRecords: canonicalProviderRecords,
  };
  // Mark tokscale-mode bundles so the pipeline knows providerUsageRecords are
  // the same scan as usageByModel (skip the additive merge — no double count).
  if (bundleProviderSource) bundle.providerUsageSource = bundleProviderSource;

  fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + '\n');
  console.error(`wrote ${rel} — host ${hostname}, ` +
    `${Object.keys(perPath).length} paths, ${Object.keys(usageByModel).length} models`);

  // Git history is an external side effect, so collection is local by default.
  // Multi-machine users can opt in explicitly after reviewing the bundle.
  if (shouldSyncGit(argv)) syncToGit(rel);
  else console.error('  git: local only (pass --sync-git to commit and push this bundle)');
}

if (require.main === module) main().catch(err => { console.error(err.message); process.exit(1); });
module.exports = {
  main,
  syncToGit,
  freshEnough,
  reuseFreshBundle,
  shouldSyncGit,
  collectionMode,
  hasUsableGraphResult,
  assignRecordIds,
};
