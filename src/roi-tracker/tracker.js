#!/usr/bin/env node
/**
 * Subscription ROI Tracker (Thin wrapper around pipeline)
 *
 * Delegates all data collection and economics calculations to `src/pipeline.js`.
 * Prints a concise subscription ROI dashboard using the roll‑up data.
 */

const { run: pipelineRun } = require('./pipeline.js');

const HELP = `Usage: npm run tracker

Render the current subscription roll-up in the terminal. This command reads the
existing local data; use \`npm run refresh\` first to collect and rebuild it.`;

/**
 * Render a compact subscription ROI dashboard based on the pipeline roll‑up.
 *
 * Indicators:
 *   🟢 keep   – ROI ≥ 1 (covers its subscription cost)
 *   🟡 review – ROI < 1 but usage > 50 % of quota/allowance
 *   🔴 cancel – low usage and ROI < 1
 *   ⚪ no‑data – insufficient information.
 */
function printRollupDashboard(rollup) {
  console.log('\n┌─ Subscription ROI Dashboard (via pipeline) ──\n');
  for (const s of rollup.subs) {
    const indicator = s.verdict === 'keep' ? '🟢' :
                      s.verdict === 'review' ? '🟡' :
                      s.verdict === 'cancel' ? '🔴' : '⚪';
    // Every fee in this system is a monthly figure (valuePerMonth/feePerMonth
    // are compared against it directly) — buildRollup never emits a `period`
    // field, so the old `s.period || 'period'` fallback always printed the
    // literal "/period" instead of a real cadence.
    const formattedFee = typeof s.fee === 'number' ? Number(s.fee.toFixed(2)) : s.fee;
    const costStr = s.fee === 0 ? '(FREE)' : `$${formattedFee}/mo`;
    const roiStr = s.roi != null ? `${s.roi.toFixed(2)}×` : 'n/a';
    console.log(`${indicator} ${s.name} ${costStr}`);
    console.log(`   Value Total: ${s.valueTotal != null ? s.valueTotal.toFixed(2) : 'n/a'}`);
    console.log(`   ROI: ${roiStr}`);
    if (s.usedPct != null) {
      const formattedPct = typeof s.usedPct === 'number' ? Number(s.usedPct.toFixed(1)) : s.usedPct;
      console.log(`   Used ${formattedPct}% (${s.usedSource})`);
    }
    console.log();
  }
}

function coverageNote(cov) {
  if (!cov) return null;
  const parts = [];
  if (cov.unscoredActionable) {
    parts.push(`${cov.unscoredActionable} usage model(s) unscored ($${cov.unscoredSpend.toFixed(0)})`);
  }
  if (cov.incomplete) {
    parts.push(`${cov.incomplete} registered model(s) incomplete (need benchmarks)`);
  }
  if (!parts.length) return null;
  return `⚠ ${parts.join(' · ')} — see data/benchmark-inputs.json`;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }

  if (argv.length) {
    throw new Error(`Unknown tracker option: ${argv[0]}. Use refresh --since to change the collection window.`);
  }

  const out = pipelineRun();

  if (out.alerts && out.alerts.length) {
    console.error(`⚠ Underwater wallets: ${out.alerts.map(a => a.name).join(', ')}`);
  }

  if (out.subscriptions) {
    printRollupDashboard(out.subscriptions);
  } else {
    console.error('No subscription roll‑up data available.');
  }

  const note = coverageNote(out.coverage);
  if (note) console.error(note);
}

if (require.main === module) main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});

module.exports = { main, printRollupDashboard, coverageNote };
