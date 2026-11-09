#!/usr/bin/env node
/**
 * One-shot refresh: collect everything -> run pipeline -> render HTML.
 *
 * Collectors (skippable with --no-collect):
 *   collect-pricing    live list prices (OpenRouter + OpenCode)
 *   collect-usage      your actual per-model spend (ccusage)
 *   collect-value-run  per-path value runs (ccusage per-agent)
 * then pipeline (join + score) -> render.
 *
 *   node src/refresh.js                 # collect if bundle is >15 min old, score, render
 *   node src/refresh.js --since 20260501
 *   node src/refresh.js --max-age-min 60 # override fresh bundle reuse window
 *   node src/refresh.js --fresh          # force usage collection now
 *   node src/refresh.js --no-collect     # reuse existing data, just re-score/render
 *   node src/refresh.js --offline        # skip network pricing fetch only
 *   node src/refresh.js --tokscale       # machine step: ONE tokscale scan (VALUE_RUN_SOURCE=tokscale)
 *   node src/refresh.js --tokscale --daily  # per-day tokscale graph (VALUE_RUN_SOURCE=tokscale-graph)
 *   node src/refresh.js --sync-git      # explicitly commit + push this host bundle
 */
const { spawn } = require('child_process');
const path = require('path');
const { tryReadJson } = require('../lib/load.js');
const { homeDataPath } = require('../lib/home.js');
const { parseSinceArg } = require('../lib/since.js');

const HELP = `Usage: npm run refresh -- [options]

Collect usage, rebuild scores, and render <home>/data/roi-dashboard.html.

Options:
  --since YYYY-MM-DD  Set the usage window start
  --fresh             Ignore the bundle cache and collect now
  --max-age-min N     Reuse a matching bundle for up to N minutes
  --tokscale          Use tokscale instead of ccusage for value attribution
  --daily             Use dated tokscale graph records (with --tokscale)
  --offline           Skip live pricing fetches
  --no-collect        Re-score and render existing data only
  --strict            Exit non-zero when an active wallet is underwater
  --sync-git          Commit and push this machine's usage bundle
  -h, --help          Show this help

Git synchronization is off by default.

Without --since, the window starts at ROI_SINCE when set, otherwise the
configured private-history start.`;

/** Async subprocess runner — returns a Promise that resolves on exit 0. */
function runAsync(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [path.join(__dirname, script), ...args], { stdio: 'inherit', timeout: 5 * 60_000 });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
    child.on('error', reject);
  });
}

// Re-read the canonical output and surface any underwater wallets prominently.
// With --strict, exit non-zero so a cron/CI run flags it. Returns the count.
function reportAlerts(strict) {
  const out = tryReadJson(homeDataPath('roi-output.json'));
  const alerts = out?.alerts ?? [];
  if (!alerts.length) return 0;
  console.error(`\n⚠ ${alerts.length} wallet(s) UNDERWATER — paying more than you're using:`);
  for (const a of alerts) {
    const be = a.breakEven;
    const hint = be ? (be.reachable
      ? `+$${be.needUsd}${be.needPct != null ? ` / +${be.needPct}% usage` : ''} to break even`
      : 'allowance caps below fee — cancel or downgrade') : '';
    console.error(`   • ${a.name}: ROI ${a.roi != null ? a.roi.toFixed(2) : '—'}${hint ? `  (${hint})` : ''}`);
  }
  if (strict) process.exitCode = 1;
  return alerts.length;
}

function positiveMinutes(raw, flag) {
  const minutes = Number(raw);
  if (!raw || !Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`Invalid value for ${flag}: "${raw || ''}". Expected positive minutes.`);
  }
  return raw;
}

function collectMachineArgs(argv, env = process.env) {
  const args = [];
  const sinceIdx = argv.indexOf('--since');
  if (sinceIdx !== -1 && argv[sinceIdx + 1]) {
    const cleaned = parseSinceArg(argv);
    const y = cleaned.slice(0, 4);
    const m = cleaned.slice(4, 6);
    const d = cleaned.slice(6, 8);
    args.push('--since', `${y}-${m}-${d}`);
  }

  if (!argv.includes('--fresh')) {
    const maxAgeIdx = argv.indexOf('--max-age-min');
    if (maxAgeIdx !== -1) {
      args.push('--max-age-min', positiveMinutes(argv[maxAgeIdx + 1], '--max-age-min'));
    } else {
      const envName = env.REFRESH_MAX_AGE_MINUTES != null ? 'REFRESH_MAX_AGE_MINUTES' : 'USAGE_BUNDLE_MAX_AGE_MINUTES';
      const raw = env.REFRESH_MAX_AGE_MINUTES ?? env.USAGE_BUNDLE_MAX_AGE_MINUTES ?? '15';
      args.push('--max-age-min', positiveMinutes(raw, envName));
    }
  }

  if (argv.includes('--sync-git')) args.push('--sync-git');
  if (argv.includes('--no-git')) args.push('--no-git');
  if (argv.includes('--tokscale')) args.push('--tokscale');
  if (argv.includes('--daily')) args.push('--daily');
  return args;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }

  let collectArgs = [];
  try {
    collectArgs = collectMachineArgs(argv);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
    return;
  }

  if (!argv.includes('--no-collect')) {
    // Start pricing + quota in parallel (both async).
    // Machine needs pricing.json on disk (pi scanner reads it), so we wait
    // for pricing to finish before starting machine. Quota is independent.
    const offline = argv.includes('--offline');

    const pricingPromise = offline
      ? Promise.resolve()
      : (() => {
          console.error('› fetching live pricing (OpenRouter + OpenCode)…');
          return runAsync('collect/pricing.js')
            .catch(() => console.error('  ⚠ pricing fetch failed — keeping last data/pricing.json'));
        })();

    const quotaPromise = (() => {
      console.error('› collecting app quota (codexbar)…');
      return runAsync('collect/quota.js')
        .catch(() => console.error('  ⚠ quota fetch failed — keeping last data/quota.json'));
    })();

    // Wait for pricing before starting machine (machine reads pricing.json
    // for pi session cost attribution). Quota runs independently in parallel.
    await pricingPromise;
    console.error('› collecting this machine\u2019s usage (value runs + per-model)…');
    try { await runAsync('collect/machine.js', collectArgs); }
    catch { console.error('  ⚠ usage collection failed — reusing last data/usage-imports bundle'); }
    await quotaPromise;
  }
  console.error('› scoring pipeline…');
  await runAsync('pipeline.js');
  console.error('› rendering dashboard…');
  await runAsync('render-html.js');
  console.error('✓ refreshed — open docs/roi-dashboard.html');
  reportAlerts(argv.includes('--strict'));
}

// Only run when invoked directly — importing this module must not kick off a
// full collect/commit/push cycle as a side effect.
if (require.main === module) main().catch(err => { console.error(err); process.exitCode = 1; });
module.exports = { main, collectMachineArgs };
