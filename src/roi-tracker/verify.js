/**
 * Golden fidelity check: prove the JS ports still reproduce the xlsx's own
 * computed cells. One file covers both ports — Score v2 (score.js) and the
 * Values PERF/COST view (values.js) — reading the single golden.json.
 *
 * Run with `npm run verify`. Exits non-zero on any mismatch.
 * Run with `npm run verify -- --refresh` to re-freeze golden.json from the
 * current registry first (the documented flow after deliberate input
 * changes — the xlsx exporter that used to do this is gone).
 *
 * Inputs default to AGENTQ_HOME, so `npm run verify` checks the user's real
 * setup. Every one can be named explicitly with a flag or its environment
 * variable. `npm run verify:fixtures` points the whole run at the tracked
 * synthetic home in `testdata/home` (and `npm run fixtures:golden` re-freezes
 * that fixture's golden.json the same way).
 *
 *   --home PATH       base AGENTQ_HOME for the defaults below (config merged
 *                     over the method defaults, and the three data files)
 *   --config PATH     effective ROI config (default: defaults merged with the
 *                     home setup, or AGENTQ_ROI_CONFIG)
 *   --registry PATH   benchmark registry (default: <home>/data/benchmark-inputs.json,
 *                     or AGENTQ_BENCHMARK_INPUTS)
 *   --values PATH     values inputs (default: <home>/data/values-inputs.json,
 *                     or AGENTQ_VALUES_INPUTS)
 *   --golden PATH     golden snapshot (default: <home>/data/golden.json,
 *                     or AGENTQ_GOLDEN)
 *   --runnables PATH  runnables checked against path coverage (default:
 *                     <home>/config/runnables.json)
 */
const fs = require('fs');
const path = require('path');
const { buildScores } = require('./score.js');
const { buildValues } = require('./values.js');
const { agentqHome, homeDataPath, loadRequiredRoiConfig } = require('../lib/home.js');
const { readJson, tryReadJson } = require('../lib/load.js');
const { coverageProblems, coverageWarnings } = require('../lib/path-coverage.js');

/** `--flag value` from argv, or null. */
function flagValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`);
  return value;
}

// `--home` re-bases the defaults on another AGENTQ_HOME (the tracked fixture
// home for the gate). Without it every default is the user's own home.
const homeFlag = flagValue('--home');
const home = homeFlag ? path.resolve(homeFlag) : null;
const homeFile = (name) => (home ? path.join(home, 'data', name) : homeDataPath(name));

const configPath = flagValue('--config') || process.env.AGENTQ_ROI_CONFIG || null;
const registryPath = flagValue('--registry') || process.env.AGENTQ_BENCHMARK_INPUTS || homeFile('benchmark-inputs.json');
const valuesPath = flagValue('--values') || process.env.AGENTQ_VALUES_INPUTS || homeFile('values-inputs.json');
const goldenPath = flagValue('--golden') || process.env.AGENTQ_GOLDEN || homeFile('golden.json');

const config = configPath
  ? readJson(configPath)
  : loadRequiredRoiConfig(home ? { home } : undefined);

// Path coverage is a setup invariant, not a scoring one, so it is checked here
// where the gate runs: a runnable whose path does not declare its model would
// route work to a subscription that does not serve it. A declared model key
// the registry lacks is only a warning (the registry can lag a new sub).
const runnablesPath = flagValue('--runnables')
  || path.join(home ?? agentqHome(), 'config', 'runnables.json');
const runnables = tryReadJson(runnablesPath)?.runnables ?? [];
const registryModels = readJson(registryPath).models;
const coverageFailures = coverageProblems(config, { runnables });
for (const warning of coverageWarnings(config, registryModels)) {
  console.log(`coverage warning: ${warning}`);
}
if (coverageFailures.length) {
  console.error('verify: path coverage does not match config/runnables.json:');
  for (const failure of coverageFailures) console.error(`  ${failure}`);
  process.exit(1);
}

const TOL = 1e-4;

// Regenerate golden.json from the current registry/inputs, then verify. With
// the xlsx gone, this is the documented way to re-freeze the snapshot after
// deliberate input changes (new models, corrected benchmarks). Uses the same
// xlsx-era effMults as the check itself, so the two always agree.
function refreshGolden() {
  const effMults = { local: 0, go: 10 / 60, codex: 1, claudemax: 1, openrouter: 1 };
  const scored = buildScores(registryModels, config, effMults);
  const values = buildValues(readJson(valuesPath), config.costBlend);
  const golden = {
    score: scored.map(r => ({
      model: r.model, capTax: r.capTax ?? null, capHobby: r.capHobby ?? null,
      valTax: r.valTax ?? null, valHobby: r.valHobby ?? null,
      minCost: r.minCost ?? null, bestPath: r.bestPath ?? '', tierTax: r.tierTax ?? null,
    })),
    values: values.map(r => ({ model: r.model, mtok: r.mtok, cost: r.cost, perf: r.perf, aver: r.aver })),
  };
  fs.writeFileSync(goldenPath, JSON.stringify(golden, null, 2) + '\n');
  console.log(`golden refreshed: ${golden.score.length} score rows, ${golden.values.length} values rows`);
}

function checkSection(label, golden, computed, fields) {
  const byModel = new Map(computed.map(r => [r.model, r]));
  let checks = 0, fails = 0;
  const failRows = [];
  for (const g of golden) {
    const r = byModel.get(g.model);
    if (!r) { failRows.push(`MISSING: ${g.model}`); fails++; continue; }
    for (const f of fields) {
      const want = g[f];
      if (want == null) continue;
      checks++;
      if (typeof want === 'string') {
        if (r[f] !== want) { fails++; failRows.push(`${g.model}.${f}: got ${r[f]} want ${want}`); }
      } else if (Math.abs((r[f] ?? NaN) - want) > TOL) {
        fails++; failRows.push(`${g.model}.${f}: got ${r[f]} want ${want}`);
      }
    }
  }
  console.log(`${label}: verified ${checks} cells across ${golden.length} models — ${checks - fails} ok, ${fails} mismatch`);
  if (failRows.length) { console.log('  mismatches:'); failRows.slice(0, 25).forEach(l => console.log('    ' + l)); }
  return fails;
}

let fails = 0;

if (process.argv.includes('--refresh')) {
  refreshGolden();
}

// Re-read golden after a refresh so the check runs against the new snapshot.
const golden = readJson(goldenPath);

// The golden froze the spreadsheet's computed cells for the model set that
// existed at export time. min-max normalization in score.js is global across
// whatever rows are passed in, so scoring the LIVE registry (which grows as
// new models are researched) would shift every normalized subindex and flag
// every cell. Score the golden's own model subset instead: same rows, same
// normalization context, same cells — the check stays a pure formula-fidelity
// probe while the registry grows freely. A model that disappears from the
// registry is still reported as MISSING.
const goldenModelSet = new Set([
  ...golden.score.map(r => r.model),
  ...golden.values.map(r => r.model),
]);
const registry = registryModels
  .filter(m => goldenModelSet.has(m.model));

// Score v2 — uses the Eff. mults live in the xlsx when golden was exported
// (Go's $60 wallet -> 10/60; other wallets/metered default to 1).
const effMults = { local: 0, go: 10 / 60, codex: 1, claudemax: 1, openrouter: 1 };
const scored = buildScores(registry, config, effMults);
const values = buildValues(readJson(valuesPath), config.costBlend);

// Fail-fast: if golden data is empty/null the check vacuously passes.
// That gives false confidence — a regressed pipeline would still show
// "0 mismatch". Refuse to run when there's nothing to verify against.
if (!golden.score?.length && !golden.values?.length) {
  console.error('verify: golden.json has no score entries and no values entries — cannot verify');
  process.exit(1);
}

fails += checkSection('Score v2', golden.score, scored,
  ['capTax', 'capHobby', 'valTax', 'valHobby', 'minCost', 'bestPath', 'tierTax']);
fails += checkSection('Values  ', golden.values, values, ['mtok', 'cost', 'perf', 'aver']);

process.exit(fails ? 1 : 0);
