/**
 * Scoring engine — faithful port of ModelBenchmark_v4.xlsx "Score v2".
 *
 * Pure function: (models, config, effMults) -> scored rows. No I/O.
 * Verified against the spreadsheet's own computed cells (see verify.js).
 *
 * The model is coupled: per-path effective model cost depends on each path's
 * Eff. mult, which the economics layer (Paths) derives from your actual usage.
 * So `effMults` is an input here, produced upstream by economics.js.
 */

const { blendMtok } = require('../lib/aa-pricing.js');
const { pathCovers, pathLabel } = require('../lib/path-coverage.js');

// Build the availability map from the coverage each config path declares
// (`paths[].models`), so a new subscription is one config entry and nothing in
// the model registry changes. Coverage is a fact about the user's setup; the
// registry only holds facts about the model.
function buildAvailabilityMap(config, raw) {
  const avail = {};
  for (const p of (config.paths || [])) {
    if (p?.id && pathCovers(p, raw?.model)) avail[p.id] = true;
  }
  return avail;
}

// Weighted average over the given {modelKey: weight} map, skipping missing
// inputs and renormalizing by the weights actually present (xlsx IF(...="",0)).
function weightedPresent(weights, model) {
  let num = 0, den = 0;
  for (const [key, w] of Object.entries(weights)) {
    const v = model[key];
    if (v !== null && v !== undefined && v !== '') { num += w * v; den += w; }
  }
  return den > 0 ? num / den : null;
}

// Min–max over present values; constant column -> 0 (xlsx IFERROR(...,0)).
function minMax(rows, field) {
  const vals = rows.map(r => r[field]).filter(v => v != null);
  if (!vals.length) return;
  const mn = Math.min(...vals), mx = Math.max(...vals);
  for (const r of rows) {
    r[field + 'N'] = r[field] == null ? null : (mx > mn ? (r[field] - mn) / (mx - mn) : 0);
  }
}

/** True when a registry row carries at least one usable list price. */
function hasPrice(raw) {
  return ['cachePrice', 'inputPrice', 'outputPrice'].some(
    (field) => typeof raw[field] === 'number' && Number.isFinite(raw[field]),
  );
}

function buildScores(models, config, effMults) {
  const { partitionMap: P, reconWeights, profiles, costBlend, lambdaCostAversion, tierThresholds } = config;

  // Subindices (raw) per model.
  const rows = models.map(m => ({
    model: m.model,
    raw: m,
    genIntel: weightedPresent(reconWeights, m),
    agentsRaw: weightedPresent(P.agents, m),
    codingRaw: weightedPresent(P.coding, m),
    generalRaw: weightedPresent(P.general, m),
    sciRaw: weightedPresent(P.scientific, m),
  }));

  // Normalize each subindex across all models that have it.
  ['agentsRaw', 'codingRaw', 'generalRaw', 'sciRaw'].forEach(f => minMax(rows, f));

  // Capability, cost blend, per-path effective cost.
  for (const r of rows) {
    r.complete = [r.agentsRaw, r.codingRaw, r.generalRaw, r.sciRaw].every(v => v != null);
    if (r.complete) {
      const t = profiles.tax, h = profiles.hobby;
      r.capTax = t.agents * r.agentsRawN + t.coding * r.codingRawN + t.general * r.generalRawN + t.scientific * r.sciRawN;
      r.capHobby = h.agents * r.agentsRawN + h.coding * r.codingRawN + h.general * r.generalRawN + h.scientific * r.sciRawN;
    }

    // A registry row with no cache price is blended as if cache tokens were
    // free (`|| 0`), and the cache weight dominates the blend. Say so once per
    // model: it is a registry gap, not a modelling choice. Diagnostics only.
    if (r.raw.cachePrice == null || r.raw.cachePrice === 0) {
      console.warn(
        `[score] ${r.raw.model}: registry cachePrice is ${r.raw.cachePrice == null ? 'missing' : '0'}; `
        + `the cost blend treats cached tokens as free (cache weight ${costBlend?.cache}).`,
      );
    }

    // Blended list $/Mtok (== Values!MTOK). Shared with the catalog's AA
    // pricing so an estimated model is priced by the same formula.
    r.costBlend = blendMtok(r.raw, costBlend);
    // blendMtok only returns null when the costBlend weights themselves are
    // missing or non-numeric. Propagating that null would make pathCost
    // `null * mult` = 0, i.e. a priced model would score as free, so a broken
    // config must stop the run instead.
    if (r.costBlend === null && hasPrice(r.raw)) {
      throw new Error(
        'score: config.costBlend must provide numeric cache/input/output weights '
        + `(got ${JSON.stringify(costBlend)}); refusing to score ${r.raw.model} as free.`,
      );
    }

    // Effective cost on each path that covers the model. Local is free at
    // margin (effMult 0); others scale the list cost by the path's Eff. mult.
    // Iterate every path the config declares coverage for, so a new
    // subscription competes for bestPath/minCost as soon as its `models` list
    // is written — no scoring change needed.
    const avail = buildAvailabilityMap(config, r.raw);
    const pathCost = {};
    for (const id of Object.keys(avail)) {
      pathCost[id] = id === 'local' ? 0 : r.costBlend * (effMults[id] ?? 1);
    }
    const entries = Object.entries(pathCost);
    if (entries.length) {
      const best = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
      r.minCost = best[1];
      // The label is the path's configured name, else its id: the spreadsheet's
      // fixed labels are gone, so a path is named by the setup, not by code.
      r.bestPath = pathLabel(config.paths?.find(p => p.id === best[0])) || best[0];
      r.pathCost = pathCost;
    } else {
      r.minCost = null; r.bestPath = '';
    }
  }

  // Cost penalty: log-scaled min cost, min–max normalized across models.
  for (const r of rows) r._ai = r.minCost != null ? Math.log(1 + r.minCost) : null;
  minMax(rows, '_ai');

  // Value = capability − λ·costPenalty; tier from capability.
  const tier = cap => cap == null ? '' :
    cap >= tierThresholds.frontier ? 'Frontier' :
    cap >= tierThresholds.high ? 'High' :
    cap >= tierThresholds.mid ? 'Mid' : 'Low';

  for (const r of rows) {
    if (r.complete) {
      r.valTax = r.capTax - lambdaCostAversion * (r._aiN ?? 0);
      r.valHobby = r.capHobby - lambdaCostAversion * (r._aiN ?? 0);
      r.tierTax = tier(r.capTax);
      r.tierHobby = tier(r.capHobby);
    }
    delete r._ai; delete r._aiN;
  }

  return rows;
}

module.exports = { buildScores, weightedPresent, minMax };
