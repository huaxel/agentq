'use strict';

/**
 * Machine data — reading and normalizing per-host usage bundles. Owns the
 * authority/precedence rules that prevent double counting across sources.
 */

const fs = require('node:fs');
const path = require('node:path');
const { modelKey } = require('../lib/model-key.js');
const { homeDataPath, homeLoad, homeLoadOptional, loadRoiConfig } = require('../lib/home.js');
const { parseDate8, date8, round2 } = require('./pipeline-util.js');

const load = homeLoad;
const loadOptional = homeLoadOptional;

function isLegacyCursorAggregate(record, isTokscale) {
  const pathId = String(record?.pathId || '').toLowerCase();
  const origin = String(record?.origin || '').toLowerCase();
  return isTokscale && pathId === 'cursor' && !record?.date && origin !== 'tokscale';
}

// Usage is machine-local (ccusage reads each machine's own logs). To get an
// account-wide picture, each machine exports a per-host bundle into
// data/usage-imports/ (via `collect-machine`); this sums them. Each box has
// distinct session logs, so summing doesn't double-count. Falls back to the
// single-machine value-run.json / usage-by-model.json when no imports exist.
function mergeUsageModel(into, key, u) {
  const k = modelKey(key);
  const m = (into[k] ??= { model: u.model || key, cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  // Accumulate raw; rounding per-merge compounds error across many bundles.
  // Cost is rounded once at the display boundary (usageShape / usage.total).
  m.cost += u.cost || 0;
  m.tokens += u.tokens || 0;
  m.inputTokens += u.inputTokens || 0;
  m.outputTokens += u.outputTokens || 0;
  m.cacheReadTokens += u.cacheReadTokens || 0;
  m.cacheWriteTokens += u.cacheWriteTokens || 0;
}

function normalizeUsageByModel(raw) {
  const usageByModel = {};
  for (const [k, u] of Object.entries(raw || {})) mergeUsageModel(usageByModel, k, u);
  return usageByModel;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasInvalidUsageNumbers(record) {
  return ['cost', 'tokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
    .some(field => record[field] != null && !Number.isFinite(record[field]));
}

function bundleShapeError(bundle) {
  for (const field of ['valueRun', 'usageByModel']) {
    if (bundle[field] != null && !isPlainObject(bundle[field])) return `${field} must be an object`;
  }
  for (const field of ['usageRecords', 'providerUsageRecords']) {
    if (bundle[field] != null && !Array.isArray(bundle[field])) return `${field} must be an array`;
    if (Array.isArray(bundle[field]) && bundle[field].some(record => !isPlainObject(record))) {
      return `${field} must contain only objects`;
    }
  }
  if (isPlainObject(bundle.usageByModel) && Object.values(bundle.usageByModel).some(row => !isPlainObject(row))) {
    return 'usageByModel must contain only objects';
  }
  if (isPlainObject(bundle.usageByModel) && Object.values(bundle.usageByModel).some(hasInvalidUsageNumbers)) {
    return 'usageByModel contains a non-finite numeric field';
  }
  for (const field of ['usageRecords', 'providerUsageRecords']) {
    if (Array.isArray(bundle[field]) && bundle[field].some(record => typeof record.model !== 'string' || !record.model)) {
      return `${field} contains a record without a model`;
    }
    if (Array.isArray(bundle[field]) && bundle[field].some(hasInvalidUsageNumbers)) {
      return `${field} contains a non-finite numeric field`;
    }
  }
  if (isPlainObject(bundle.valueRun) && Object.values(bundle.valueRun).some(value => !Number.isFinite(value))) {
    return 'valueRun must contain only finite numbers';
  }
  return null;
}

function countRecordIds(target, records, seen) {
  for (const record of records) {
    if (typeof record.recordId !== 'string' || !record.recordId) {
      target.missing += 1;
      continue;
    }
    target.present += 1;
    if (seen.has(record.recordId)) target.duplicates += 1;
    seen.add(record.recordId);
  }
}

function incrementCount(target, key) {
  const safeKey = String(key);
  const value = (Object.hasOwn(target, safeKey) ? target[safeKey] : 0) + 1;
  Object.defineProperty(target, safeKey, { value, writable: true, enumerable: true, configurable: true });
}

function readMachineData(dir) {
  // Overridable so tests can point at a temp usage-imports dir; the default is
  // the one in AGENTQ_HOME.
  dir = dir || homeDataPath('usage-imports');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { /* none */ }

  if (!files.length) {
    const valueRunData = loadOptional('data/value-run.json');
    const usageData = loadOptional('data/usage-by-model.json');
    // No usage-imports bundles (single-machine setup) — still surface a
    // generatedAt so snapshotAndTrend can tell fresh data from stale.
    const generatedAt = [valueRunData?._meta?.generatedAt, usageData?.generatedAt].filter(Boolean).sort().pop() || null;
    return {
      valueRun: valueRunData || {},
      usageByModel: normalizeUsageByModel(usageData?.models),
      usageRecords: [],
      machines: generatedAt ? [{ host: 'local', since: null, generatedAt }] : [],
      reconciliation: {
        bundleCount: generatedAt ? 1 : 0,
        validBundleCount: generatedAt ? 1 : 0,
        skippedBundleCount: 0,
        source: generatedAt ? 'legacy-local-files' : 'none',
        usageModelRows: Object.keys(usageData?.models || {}).length,
        usageRecords: 0,
        providerRecords: 0,
        usageRecordIds: { present: 0, missing: 0, duplicates: 0 },
        providerRecordIds: { present: 0, missing: 0, duplicates: 0 },
        errors: [],
      },
    };
  }

  const valueRun = {}, usageByModel = {}, usageRecords = [], pathUsageRecords = [], machines = [];
  const reconciliation = {
    bundleCount: files.length,
    validBundleCount: 0,
    skippedBundleCount: 0,
    source: 'usage-imports',
    usageModelRows: 0,
    usageRecords: 0,
    providerRecords: 0,
    usageRecordIds: { present: 0, missing: 0, duplicates: 0 },
    providerRecordIds: { present: 0, missing: 0, duplicates: 0 },
    providerSources: {},
    schemaVersions: {},
    errors: [],
  };
  const seenUsageRecordIds = new Set();
  const seenProviderRecordIds = new Set();
  // Pricing for zero-cost providerUsageRecords
  const __pricingModels = loadOptional('data/pricing.json')?.models || {};
  const __config = loadRoiConfig();
  const __aliases = __config.modelPriceAliases || {};
  const __priceOverrides = __config.priceOverrides || {};
  function recomputeCost(model, inp, out, cr, cw) {
    // Exact-key price overrides win — covers models not exposed by
    // models.dev/OpenRouter (e.g. Fireworks router keys).
    const ov = __priceOverrides[model] || __priceOverrides[model.toLowerCase()];
    if (ov) {
      return ((inp || 0) * (ov.input || 0) + (out || 0) * (ov.output || 0) + (cr || 0) * (ov.cache || ov.input || 0) + (cw || 0) * (ov.input || 0)) / 1e6;
    }
    for (const c of [model, model.replace(/^[^/]+\//, '')]) {
      const cl = c.toLowerCase().replace(/\./g, '-');
      const alias = Object.entries(__aliases).find(([k]) => k.toLowerCase() === cl || k.toLowerCase() === c.toLowerCase())?.[1];
      const key = alias || c;
      const pd = __pricingModels[key];
      if (!pd) continue;
      const p = pd.openrouter || pd.opencode;
      if (!p) continue;
      return ((inp || 0) * (p.input || 0) + (out || 0) * (p.output || 0) + (cr || 0) * (p.cache || p.input || 0) + (cw || 0) * (p.input || 0)) / 1e6;
    }
    return 0;
  }
  const pathModelUsage = {};
  for (const f of files) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (err) {
      reconciliation.errors.push({ file: f, error: `invalid JSON: ${err.message}` });
      reconciliation.skippedBundleCount += 1;
      continue;
    }
    if (!isPlainObject(d)) {
      reconciliation.errors.push({ file: f, error: 'bundle must contain a JSON object' });
      reconciliation.skippedBundleCount += 1;
      continue;
    }
    const shapeError = bundleShapeError(d);
    if (shapeError) {
      reconciliation.errors.push({ file: f, error: shapeError });
      reconciliation.skippedBundleCount += 1;
      continue;
    }
    reconciliation.validBundleCount += 1;
    machines.push({ host: d.hostname || f, since: d.since || null, generatedAt: d.generatedAt || null });
    reconciliation.usageModelRows += Object.keys(d.usageByModel || {}).length;
    reconciliation.usageRecords += (d.usageRecords || []).length;
    reconciliation.providerRecords += (d.providerUsageRecords || []).length;
    countRecordIds(reconciliation.usageRecordIds, d.usageRecords || [], seenUsageRecordIds);
    countRecordIds(reconciliation.providerRecordIds, d.providerUsageRecords || [], seenProviderRecordIds);
    const providerSource = d.providerUsageSource || 'legacy';
    const schemaVersion = Number.isInteger(d.usageSchemaVersion) && d.usageSchemaVersion >= 0
      ? d.usageSchemaVersion
      : 0;
    incrementCount(reconciliation.schemaVersions, schemaVersion);
    incrementCount(reconciliation.providerSources, providerSource);
    for (const [k, v] of Object.entries(d.valueRun || {})) valueRun[k] = (valueRun[k] || 0) + v;
    for (const r of d.usageRecords || []) usageRecords.push({ date: r.date, model: r.model, cost: r.cost || 0 });

    // tokscale-mode bundles already carry the tokscale scan's per-model totals
    // in usageByModel (tokscale replaced ccusage daily as the single scan for
    // that machine), and its own provider records (origin 'tokscale') are the
    // SAME scan — merging them additively would double count. Older collectors
    // also appended a second aggregate Cursor scan with origin 'cursor'; the
    // main tokscale scan already includes the Cursor client, so discard those
    // legacy duplicates at import time.
    const isTokscale = d.providerUsageSource === 'tokscale';
    const providerRecords = (d.providerUsageRecords || []).filter(r =>
      !isLegacyCursorAggregate(r, isTokscale)
    );

    // Priced provider-records (pi/Claude scanners) are the AUTHORITATIVE
    // per-model cost for non-tokscale bundles: each session's logged cost or
    // a successful token-price recomputation. ccusage daily's usageByModel
    // (offline, under-priced for newer models) overlaps it for most models, so
    // adding both double-counts (kimi appeared in both). Unpriced provider
    // rows do not claim authority; their model remains eligible for ccusage
    // gap-fill.
    const providerCoverage = new Map();
    if (!isTokscale) {
      for (const r of providerRecords) {
        // A provider record with zero cost is not authoritative when pricing
        // failed or the model is new: ccusage may still have valid usage for
        // the same model. Treat token-priced records as authoritative too.
        const priced = (r.cost || 0) || recomputeCost(
          r.model,
          r.inputTokens,
          r.outputTokens,
          r.cacheReadTokens,
          r.cacheWriteTokens,
        );
        if (priced <= 0) continue;
        const key = modelKey(r.model);
        let coverage = providerCoverage.get(key);
        if (!coverage) {
          coverage = { cost: 0, tokens: 0 };
          providerCoverage.set(key, coverage);
        }
        coverage.cost += priced;
        coverage.tokens += r.tokens || 0;
      }
    }

    // A provider scan can cover only one source while ccusage aggregates more
    // agents for the same model. In that case, model-level provider authority
    // would discard the extra usage. Prefer the source with materially greater
    // token coverage; when coverage is comparable, provider cost remains the
    // authority. This still prevents additive double counting.
    const usageAuthorityKeys = new Set();
    const providerAuthorityKeys = new Set();
    for (const [k, u] of Object.entries(d.usageByModel || {})) {
      const key = modelKey(k);
      const coverage = providerCoverage.get(key);
      const usageTokens = u.tokens || ((u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0));
      if (!isTokscale && coverage?.cost > 0 && usageTokens > 0 && coverage.tokens < usageTokens * 0.95 && (u.cost || 0) > 0) {
        usageAuthorityKeys.add(key);
      } else if (!isTokscale && coverage?.cost > 0) {
        providerAuthorityKeys.add(key);
      }
      // tokscale bundles merge usageByModel as-is.
      if (isTokscale || usageAuthorityKeys.has(key) || !providerAuthorityKeys.has(key)) {
        mergeUsageModel(usageByModel, k, u);
      }
    }

    for (const r of providerRecords) {
      // Skip date-less records for the per-date Strategy A path — a null date
      // would inflate totalAll while never matching totalDateRanged, silently
      // skewing the ratio. They still merge into per-model/per-path totals
      // below (tokscale provider records are date-less: no per-day JSON).
      if (r.pathId && r.date) pathUsageRecords.push({ date: r.date, pathId: r.pathId, model: r.model, cost: (r.cost || 0) || 0 });
      // Merge provider-level records into per-model totals (authoritative in
      // non-tokscale mode). For tokscale bundles, skip the scan's own records
      // (already in usageByModel); legacy Cursor duplicates were filtered above.
      const tsOwnRecord = isTokscale && r.origin === 'tokscale';
      const providerIsSuperseded = !isTokscale && usageAuthorityKeys.has(modelKey(r.model));
      if (!tsOwnRecord && !providerIsSuperseded) {
        mergeUsageModel(usageByModel, r.model, {
          model: r.model,
          cost: (r.cost || 0) || recomputeCost(r.model, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens),
          tokens: r.tokens || 0,
          inputTokens: r.inputTokens || 0,
          outputTokens: r.outputTokens || 0,
          cacheReadTokens: r.cacheReadTokens || 0,
          cacheWriteTokens: r.cacheWriteTokens || 0,
        });
      }
    }
    // Aggregate per-path model usage from pi session provider breakdown.
    // Stale machine imports may have zero-cost records (generated before the pi
    // scanner could price providers like Helmcode/nan). Recompute from tokens.
    for (const r of providerRecords) {
      const key = r.pathId + '||' + r.model;
      const e = (pathModelUsage[key] ??= { pathId: r.pathId, model: r.model, cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, tokscale: false });
      const cost = (r.cost || 0) || recomputeCost(r.model, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens);
      e.cost += cost;
      e.tokens += r.tokens || 0;
      e.inputTokens += r.inputTokens || 0;
      e.outputTokens += r.outputTokens || 0;
      e.cacheReadTokens += r.cacheReadTokens || 0;
      e.cacheWriteTokens += r.cacheWriteTokens || 0;
      if (r.origin === 'tokscale') e.tokscale = true;
    }
  }
  // Re-price usageByModel entries that ccusage left at $0 or severely
  // undercounted. ccusage runs in offline mode by default and may not have
  // pricing for newer models (claude-sonnet-5, claude-opus-5). The pi scanner
  // prices its own records, but ccusage's usageByModel feeds model totals
  // too. We recompute from tokens whenever the per-million-token cost looks
  // unreasonably low (arbitrary threshold: < $0.10/Mtok for a model that
  // should cost >= $0.50/Mtok).
  const MIN_PLAUSIBLE_BLEND = 0.10;
  for (const [k, u] of Object.entries(usageByModel)) {
    if (!u || !u.tokens || u.tokens < 10000) continue;
    const currentBlend = (u.cost || 0) / (u.tokens / 1_000_000);
    if (currentBlend >= MIN_PLAUSIBLE_BLEND) continue;
    // Recompute from the RAW model name (u.model, e.g. the slashed Fireworks
    // router path "accounts/fireworks/routers/kimi-k2p6-turbo"), not the
    // modelKey-normalized key k — recomputeCost's priceOverride table is keyed
    // by the raw path, which modelKey() mangles into something that misses.
    const priced = recomputeCost(u.model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens);
    if (priced > u.cost) u.cost = Math.round(priced * 100) / 100;
  }
  // Supplement with fresh value-run.json for any paths the stale machine
  // imports missed (e.g. recently-added subscriptions like Helmcode/nan).
  // Existing keys from usage-imports take priority.
  const supplement = loadOptional('data/value-run.json');
  if (supplement) {
    for (const [k, v] of Object.entries(supplement)) {
      if (k === '_meta') continue;
      if (valueRun[k] == null && typeof v === 'number') valueRun[k] = v;
    }
  }
  // Upgrade valueRun from recomputed provider usage for any path where the
  // pi-session data tells a more complete story than the (possibly stale)
  // per-machine valueRun. This matters for providers like Helmcode/nan that
  // have no ccusage agent — the pi session scanner is the sole data source.
  // We only upgrade (never downgrade), so ccusage-heavy paths keep their data.
  // In tokscale-mode bundles the main tokscale records (origin 'tokscale') are
  // the SAME scan that already produced valueRun, so they must NOT participate
  // in the upgrade (would double count); only supplemental (e.g. cursor) records
  // may bump a path, and only in pi/non-tokscale bundles do main-scan records
  // upgrade at all.
  const pmuByPath = {};
  for (const e of Object.values(pathModelUsage)) {
    if (e.tokscale) continue; // already counted in valueRun for tokscale bundles
    pmuByPath[e.pathId] = (pmuByPath[e.pathId] || 0) + e.cost;
  }
  for (const [pathId, total] of Object.entries(pmuByPath)) {
    const cur = valueRun[pathId];
    if ((cur == null || total > cur) && total > 0) valueRun[pathId] = round2(total);
  }
  reconciliation.mergedModelRows = Object.keys(usageByModel).length;
  reconciliation.mergedPathModelRows = Object.keys(pathModelUsage).length;
  return { valueRun, usageByModel, usageRecords, pathUsageRecords, machines, pathModelUsage, reconciliation };
}

/**
 * For paths with startDate (and optionally endDate), recompute valueRun by
 * filtering usageRecords by date range. Uses the path's `costModels` array
 * (model name prefixes like ["claude-"]) to determine which models belong to
 * this path. For each matching model, computes the proportion of its cost that
 * falls within [startDate, endDate) from usageRecords, then applies that
 * proportion to the model's mutually-exclusive total from usageByModel.
 *
 * Falls back to the pre-computed valueRun for paths without costModels or
 * when usage data is unavailable.
 *
 * @param {Array}  usageRecords  Per-date, per-model cost records
 * @param {Object} usageByModel  Mutually-exclusive per-model totals
 * @param {Object} path          Config path entry (may have startDate/endDate/costModels)
 * @param {number} valueRunTotal Pre-computed total valueRun for this path
 * @returns {number|null}        Date-filtered valueRun, or null if can't compute
 */
function dateFilteredValueRun(usageRecords, pathUsageRecords, usageByModel, path, valueRunTotal) {
  if (!path.startDate) return null;  // no date range — can't filter
  if (!usageRecords || !usageRecords.length) return null;

  // filterStartDate overrides startDate for the filtering window, while
  // startDate continues to drive the duration (subMonths) calculation.
  const filterRaw = path.filterStartDate ? String(path.filterStartDate).replace(/-/g, '') : String(path.startDate).replace(/-/g, '');
  const endRaw = path.endDate ? String(path.endDate).replace(/-/g, '') : null;
  if (!/^\d{8}$/.test(filterRaw)) return null;
  if (endRaw && !/^\d{8}$/.test(endRaw)) return null;

  const startDate = `${filterRaw.slice(0, 4)}-${filterRaw.slice(4, 6)}-${filterRaw.slice(6, 8)}`;
  const endDate = endRaw
    ? `${endRaw.slice(0, 4)}-${endRaw.slice(4, 6)}-${endRaw.slice(6, 8)}`
    : null;

  // Strategy A: use provider-attributed records (pathUsageRecords) when they
  // cover the path completely. This is the most accurate source when available,
  // since the scanner records the actual provider/path on each turn.
  // Records must carry ISO dates: a placeholder like 'unknown' would compare
  // true against any window start ('u' > '2') and corrupt the split.
  const isDated = r => typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(r.date);
  const pathId = path.sourcePath || path.id;
  const pathRecs = (pathUsageRecords || []).filter(r => r.pathId === pathId && isDated(r));

  let providerTotal = 0;
  let providerDateTotal = 0;
  for (const rec of pathRecs) {
    const cost = rec.cost || 0;
    providerTotal += cost;
    if (rec.date >= startDate && (!endDate || rec.date < endDate)) {
      providerDateTotal += cost;
    }
  }

  // Strategy B: use dated model records for paths with model patterns. This is
  // also the recovery path for partial provider attribution: a machine can
  // contribute Claude usageRecords without emitting providerUsageRecords (for
  // example, an older host collector), and using only the rows that happened
  // to have path metadata distorts subscription date splits.
  const patterns = (path.costModels || []).map(p => p.toLowerCase());
  const matchingModels = Object.keys(usageByModel).filter(k =>
    patterns.some(p => k.toLowerCase().startsWith(p))
  );
  const modelRecs = patterns.length
    // Skip date-less records: a null date would inflate modelTotal while
    // never matching the window, silently skewing the split — the same
    // reason Strategy A inputs are pre-filtered to dated records upstream.
    // Non-ISO placeholders ('unknown') are rejected too: they collate above
    // any window start and would corrupt the split in the other direction.
    ? usageRecords.filter(rec => isDated(rec) && patterns.some(p => String(rec.model || '').toLowerCase().startsWith(p)))
    : [];
  let modelTotal = 0;
  let modelDateTotal = 0;
  for (const rec of modelRecs) {
    const cost = rec.cost || 0;
    modelTotal += cost;
    if (rec.date >= startDate && (!endDate || rec.date < endDate)) {
      modelDateTotal += cost;
    }
  }

  // Prefer the dated model source when provider records are materially
  // incomplete. Do not merely check for zero rows: partial attribution is the
  // dangerous case because it silently produces plausible but wrong splits.
  const providerIncomplete = modelTotal > 0 && providerTotal < modelTotal * 0.95;
  if (pathRecs.length > 0 && !providerIncomplete) {
    if (providerTotal === 0) return null;
    const reference = (valueRunTotal != null) ? valueRunTotal : providerTotal;
    return round2(reference * (providerDateTotal / providerTotal));
  }

  if (modelTotal > 0) {
    const matchedUsageByModelTotal = matchingModels.reduce((s, k) => s + (usageByModel[k]?.cost || 0), 0);
    // valueRunTotal is already the authoritative aggregate when available.
    // If it is absent, model records still provide a usable reference even if
    // usageByModel is incomplete for a newly introduced Claude model.
    const reference = (valueRunTotal != null)
      ? valueRunTotal
      : (matchedUsageByModelTotal || modelTotal);
    return round2(reference * (modelDateTotal / modelTotal));
  }

  // Provider records remain the final fallback for paths without model-name
  // patterns (for example, a provider whose models are not uniquely named).
  if (providerTotal === 0) return null;
  const reference = (valueRunTotal != null) ? valueRunTotal : providerTotal;
  return round2(reference * (providerDateTotal / providerTotal));
}

module.exports = {
  isLegacyCursorAggregate,
  mergeUsageModel,
  normalizeUsageByModel,
  readMachineData,
  dateFilteredValueRun,
};
