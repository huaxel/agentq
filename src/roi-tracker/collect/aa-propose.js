#!/usr/bin/env node
'use strict';
/**
 * Artificial Analysis → benchmark registry proposals.
 *
 * Reads a recorded snapshot (`data/aa-snapshot.json`) and proposes
 * `data/benchmark-inputs.json` rows for the models the dispatcher can run but
 * cannot score yet.
 *
 * Field mapping is not invented here. Two existing artifacts define it:
 *
 *   gscripts/model-catalogs.gs  fetchArtificialAnalysisData  → AA_fetch columns
 *   scripts/export-from-xlsx.py Inputs sheet                 → registry fields
 *
 * The AA_fetch columns map one-to-one onto registry fields by name, and every
 * unit conversion below is the one those two already perform (prices are
 * already USD per 1M tokens; `cost_per_task.total_cost` is per task and
 * `total_cost` is the whole evaluation, so neither is a price column).
 *
 * Nothing here is importer parity except the eight AA_fetch fields. The six
 * per-benchmark columns (terminalBench, sciCode, aaLcr, hle, gpqa, critPt) are
 * deliberately not proposed: the Free body carries no per-benchmark evaluations
 * (0 of 726 models on 2026-11-08), the Pro endpoint that adds them needs a key
 * this project does not have, and the importer exports no such column, so
 * neither the AA keys nor their scale could be verified. Those columns come
 * from the AA website or manual research (docs/benchmark-backlog.md).
 *
 * Fields that docs/benchmark-backlog.md marks unsafe are never filled: a value
 * on the wrong scale or vintage silently corrupts the min–max normalization for
 * every model in the column, which is worse than a null.
 *
 * Identity is strict. A registry row's `aaSlug` pins the match to that exact
 * slug; a match that only folds (preview/thinking/date/parenthetical suffixes,
 * or a display-name fallback) is reported as FOLDED and is never written unless
 * `--confirm-match` names the model. A provider disagreement between the model
 * name and AA's `model_creator` is a rejection, not a proposal.
 *
 * Usage:
 *   npm run aa-propose                        # every runnable that cannot score
 *   npm run aa-propose -- --models grok-4-6
 *   npm run aa-propose -- --json
 *   npm run aa-propose -- --write --confirm-match grok-4-6
 *
 * `--prices` is a second, read-only by default mode: it compares the blended
 * $/MTok of every registry row that has an exact AA identity with the same
 * blend the ROI pipeline scores on, and flags a registry/AA ratio outside
 * [1/k, k] (default k = 2). Prices drive cost and therefore routing order, and
 * `--write` above only fills nulls, so a stale price is otherwise never
 * surfaced. There is no bulk overwrite: fixing a row needs
 * `--write --confirm-price <key>` naming that flagged row, because AA lists one
 * median price while a registry row may intentionally carry the price of the
 * provider this machine is billed by.
 */
const fs = require('node:fs');
const path = require('node:path');
const { readJson, tryReadJson } = require('../../lib/load.js');
const { homeConfigPath, homeDataPath, loadRoiConfig } = require('../../lib/home.js');
const { modelKey } = require('../../lib/model-key.js');
const { aaPrices, blendMtok } = require('../../lib/aa-pricing.js');
const { weightedPresent } = require('../score.js');
const { freeSnapshotPath, readSnapshot } = require('./aa.js');

const defaultRegistryPath = () => homeDataPath('benchmark-inputs.json');
const defaultRunnablesPath = () => homeConfigPath('runnables.json');
/**
 * The effective config: an explicit file, otherwise the method defaults merged
 * with the user's setup (costBlend and partitionMap are method keys).
 */
const readConfig = (configPath) => (configPath ? readJson(configPath) : loadRoiConfig());

/**
 * Registry field order, exactly as scripts/export-from-xlsx.py writes it.
 *
 * No `on*` availability columns: which subscription serves a model is the
 * user's setup, declared by `config.paths[].models` (src/lib/path-coverage.js),
 * so a proposal never writes coverage and a legacy column is left untouched
 * (and ignored) rather than proposed.
 */
const REGISTRY_FIELDS = [
  'model', 'gdpval', 'terminalBench', 'tau3Banking', 'aaLcr', 'aaOmni', 'hle',
  'gpqa', 'sciCode', 'critPt', 'apexAgents', 'intRef', 'cachePrice',
  'inputPrice', 'outputPrice', 'speed', 'aaSlug', 'aaCoding', 'aaAgentic',
];

const ABSENT = 'AA returned no value for this model';
const BENCHMARKS_UNSOURCED = 'AA publishes no per-benchmark evaluations; these columns need the AA website or manual research (docs/benchmark-backlog.md)';

/**
 * Provider families: the canonical registry prefix plus every spelling AA, the
 * registry and the runnable ids use for it. Used both to derive a new row name
 * and to reject a match whose creator disagrees with the model name.
 */
const PROVIDERS = [
  { id: 'x-ai', aliases: ['xai', 'x-ai', 'spacexai', 'xai'] },
  { id: 'mistral', aliases: ['mistral', 'mistralai'] },
  { id: 'anthropic', aliases: ['anthropic', 'claude', 'anthropicai'] },
  { id: 'openai', aliases: ['openai'] },
  { id: 'deepseek', aliases: ['deepseek'] },
  { id: 'z-ai', aliases: ['zai', 'z-ai', 'zhipu', 'zhipuai'] },
  { id: 'google', aliases: ['google', 'googledeepmind'] },
  { id: 'moonshotai', aliases: ['moonshot', 'moonshotai'] },
  { id: 'qwen', aliases: ['qwen', 'alibaba'] },
  { id: 'meta', aliases: ['meta', 'metaai'] },
  { id: 'nvidia', aliases: ['nvidia'] },
  { id: 'minimax', aliases: ['minimax'] },
  { id: 'xiaomi', aliases: ['xiaomi'] },
  { id: 'stepfun', aliases: ['stepfun'] },
  { id: 'inclusionai', aliases: ['inclusionai'] },
  { id: 'nex-agi', aliases: ['nexagi', 'nex'] },
  { id: 'thinkingmachines', aliases: ['thinkingmachines'] },
];

/**
 * AA payload → registry field, for the fields the gs importer already exports
 * to AA_fetch. `column` is the AA_fetch header the importer writes, so a
 * reviewer can check the mapping against the sheet.
 */
const AA_FIELDS = [
  { field: 'aaSlug', column: 'Slug', read: m => text(m.slug) },
  { field: 'intRef', column: 'Intelligence Index', read: m => num(m.evaluations?.artificial_analysis_intelligence_index) },
  { field: 'aaCoding', column: 'Coding Index', read: m => num(m.evaluations?.artificial_analysis_coding_index) },
  { field: 'aaAgentic', column: 'Agentic Index', read: m => num(m.evaluations?.artificial_analysis_agentic_index) },
  // The three price columns come from the shared mapping the catalog also uses
  // to price an estimated model (src/lib/aa-pricing.js), so the proposal and
  // the routing cost can never disagree about which AA field is which.
  { field: 'cachePrice', column: 'Price / 1M Cache Hit ($)', read: m => aaPrices(m).cachePrice },
  { field: 'inputPrice', column: 'Price / 1M Input ($)', read: m => aaPrices(m).inputPrice },
  { field: 'outputPrice', column: 'Price / 1M Output ($)', read: m => aaPrices(m).outputPrice },
  { field: 'speed', column: 'Median Output Tokens/s', read: m => num(m.performance?.median_output_tokens_per_second) },
];

/**
 * Registry columns AA cannot source. Listed so the report says why they stay
 * empty instead of leaving the reader to guess.
 */
const UNSOURCED = ['terminalBench', 'sciCode', 'aaLcr', 'hle', 'gpqa', 'critPt'];

/**
 * Never filled, with the reason from docs/benchmark-backlog.md. `key` names the
 * AA field that would have been used, so the report can show that AA does have
 * a number and that it was refused on purpose.
 */
const UNSAFE = [
  {
    field: 'gdpval',
    key: 'gdpval_aa_normalized',
    percent: true,
    reason: 'registry gdpval provenance/vintage unconfirmed; AA v2.1 is Elo (gdpval_aa_elo) plus a normalized fraction, and neither is known to share the column scale (docs/benchmark-backlog.md)',
  },
  {
    field: 'tau3Banking',
    key: 'tau_banking',
    percent: true,
    reason: 'AA tau_banking is a different vintage from the registry column (kimi-k2.7-code 18 vs 20.21, glm-5.2 27 vs 34.64), so filling it would mix vintages in one column (docs/benchmark-backlog.md)',
  },
  {
    field: 'apexAgents',
    key: null,
    reason: 'AA publishes no APEX-Agents field in the language list, and the third-party APEX-Agents-AA 33.0 is scale-incompatible with the registry column (39-85) (docs/benchmark-backlog.md)',
  },
  {
    field: 'aaOmni',
    key: null,
    reason: 'AA exposes both a signed aa_omniscience_index and an aa_omniscience_accuracy fraction; the registry column does not record which one it holds',
  },
];

const isPresent = value => value !== null && value !== undefined && value !== '';
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = value => (typeof value === 'string' && value.trim() ? value : null);
const round2 = value => Math.round(value * 100) / 100;
const percent = value => (num(value) == null ? null : round2(value * 100));

/** Lowercase alphanumerics only, so `x-ai`, `X AI` and `xai` compare equal. */
function normalizeToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Canonical provider family for a creator/prefix spelling, or null. */
function familyOf(value) {
  const token = normalizeToken(value);
  if (!token) return null;
  for (const provider of PROVIDERS) {
    if (provider.aliases.some(alias => normalizeToken(alias) === token)) return provider.id;
  }
  // `openai-codex` is the openai family; `nex-agi` folds to `nexagi` above.
  for (const provider of PROVIDERS) {
    const hit = provider.aliases.find(alias => {
      const norm = normalizeToken(alias);
      return norm.length >= 3 && token.startsWith(norm);
    });
    if (hit) return provider.id;
  }
  return null;
}

/** Provider family implied by a `provider/model` name, or null. */
function providerOfModel(name) {
  if (typeof name !== 'string' || !name.includes('/')) return null;
  return familyOf(name.split('/')[0]);
}

/** Deterministic slug for a creator name with no known family. */
function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Registry row name for a model AA knows but the registry does not:
 * `<creator-slug>/<aa slug>`. Never the runnable id, which is a local alias.
 */
function newRowNameFor(aa) {
  const creator = text(aa.model_creator?.name);
  const slug = text(aa.slug);
  if (!creator || !slug) return null;
  const prefix = familyOf(creator) || slugify(creator);
  if (!prefix) return null;
  return `${prefix}/${slug}`;
}

/**
 * AA publishes one row per model *variant*: "Claude Sonnet 4.6 (Non-reasoning,
 * High)", "GPT-5.6 Terra (Max)". The registry column is model-level, so a
 * variant qualifier is worth saying out loud when its index is proposed.
 */
function variantOf(name) {
  const match = /\(([^()]+)\)\s*$/.exec(typeof name === 'string' ? name.trim() : '');
  return match ? match[1].trim() : null;
}

/** A partition counts as filled when score.js's own weightedPresent sees input. */
function partitionState(row, partitionMap) {
  const missing = [];
  for (const name of Object.keys(partitionMap)) {
    if (weightedPresent(partitionMap[name], row) == null) missing.push(name);
  }
  return { complete: missing.length === 0, missing };
}

/**
 * Rank folded slug candidates, best first: a plain display name beats an effort
 * qualifier, then the shorter slug.
 */
function foldedRank(model) {
  return [/\s*\(/.test(model.name || '') ? 1 : 0, String(model.slug || '').length];
}

function compareRank(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Resolve the AA row for a target.
 *
 *   1. a registry `aaSlug` pins the match to that exact slug, nothing else
 *   2. otherwise an exact slug match for the model key
 *   3. otherwise a folded slug match (reported as folded)
 *   4. otherwise a display-name fallback (always folded, never a tie-break)
 *
 * Ties and missing pinned slugs are reported, never guessed.
 */
function matchAaRow(models, target, existing) {
  const pinned = existing && typeof existing.aaSlug === 'string' ? existing.aaSlug.trim() : '';
  if (pinned) {
    const hits = models.filter(m => typeof m.slug === 'string' && m.slug === pinned);
    if (!hits.length) {
      return { row: null, ambiguous: [], via: 'aaSlug', exact: true, rejected: `registry aaSlug "${pinned}" is not in this snapshot` };
    }
    if (hits.length > 1) return { row: null, ambiguous: hits.map(m => m.id), via: 'aaSlug', exact: true, rejected: null };
    return { row: hits[0], ambiguous: [], via: 'aaSlug', exact: true, rejected: null };
  }

  const key = target.modelKey;
  const slugHits = models.filter(m => typeof m.slug === 'string' && modelKey(m.slug) === key);
  const exactHits = slugHits.filter(m => m.slug.toLowerCase() === key);
  if (exactHits.length === 1) return { row: exactHits[0], ambiguous: [], via: 'slug', exact: true, rejected: null };
  if (exactHits.length > 1) return { row: null, ambiguous: exactHits.map(m => m.id), via: 'slug', exact: true, rejected: null };

  if (slugHits.length) {
    const ranked = slugHits.slice().sort((a, b) => compareRank(foldedRank(a), foldedRank(b)));
    if (ranked.length > 1 && compareRank(foldedRank(ranked[0]), foldedRank(ranked[1])) === 0) {
      return { row: null, ambiguous: ranked.map(m => m.id), via: 'slug', exact: false, rejected: null };
    }
    return { row: ranked[0], ambiguous: [], via: 'slug', exact: false, rejected: null };
  }

  // Display names are the weakest signal: any more than one hit is a tie.
  const nameHits = models.filter(m => typeof m.name === 'string' && modelKey(m.name) === key);
  if (!nameHits.length) return { row: null, ambiguous: [], via: null, exact: false, rejected: null };
  if (nameHits.length > 1) return { row: null, ambiguous: nameHits.map(m => m.id), via: 'name', exact: false, rejected: null };
  return { row: nameHits[0], ambiguous: [], via: 'name', exact: false, rejected: null };
}

/** Build one proposal: fills, refusals, identity verdict and the resulting row. */
function proposeOne({ target, snapshot, partitionMap }) {
  const existing = target.row || null;
  const proposed = {};
  for (const field of REGISTRY_FIELDS) proposed[field] = existing ? (existing[field] ?? null) : null;

  const fills = [];
  const kept = [];
  const nulled = [];
  const absent = [];

  const consider = (field, value, from) => {
    if (value == null) {
      absent.push({ field, reason: ABSENT });
      return;
    }
    if (isPresent(proposed[field])) {
      kept.push({ field, registryValue: proposed[field], aaValue: value });
      return;
    }
    proposed[field] = value;
    fills.push({ field, value, from });
  };

  const matched = matchAaRow(snapshot.models, target, existing);
  const aa = matched.row;
  let rejected = matched.rejected;

  // A creator that disagrees with the registry row's `creator/model` name means
  // the AA row is a different model, whatever the slug folded to. Only registry
  // names carry the creator: a runnable id's prefix is the HOST subscription
  // (mistral/deepseek-…, claude/…), not who made the model.
  if (aa && !rejected) {
    const declared = target.row ? providerOfModel(target.row.model) : null;
    const creator = familyOf(aa.model_creator?.name);
    if (declared && creator && declared !== creator) {
      const creatorName = aa.model_creator?.name ?? 'unknown';
      rejected = `provider mismatch: ${target.model} is ${declared} but AA lists ${creatorName} (${creator})`;
    }
  }

  if (aa && !rejected) {
    for (const entry of AA_FIELDS) consider(entry.field, entry.read(aa), entry.column);

    // Reported once, not per field: AA cannot source these at all.
    for (const field of UNSOURCED) {
      if (!isPresent(proposed[field])) absent.push({ field, reason: BENCHMARKS_UNSOURCED });
    }

    for (const entry of UNSAFE) {
      const raw = entry.key ? aa.evaluations?.[entry.key] : null;
      const value = entry.percent ? percent(raw) : num(raw);
      // A human-entered value is never second-guessed, even here.
      if (isPresent(proposed[entry.field])) {
        kept.push({ field: entry.field, registryValue: proposed[entry.field], aaValue: value, reason: entry.reason });
        continue;
      }
      if (value == null) absent.push({ field: entry.field, reason: entry.reason });
      else nulled.push({ field: entry.field, aaValue: value, reason: entry.reason });
    }
  }

  const derived = existing ? null : (aa ? newRowNameFor(aa) : null);
  const rowNameSource = existing ? 'existing' : (derived ? 'aa' : 'runnable');
  const rowName = existing ? existing.model : (derived || target.model);
  proposed.model = rowName;

  const before = existing ? partitionState(existing, partitionMap) : { complete: false, missing: Object.keys(partitionMap) };
  const after = partitionState(proposed, partitionMap);

  return {
    target: target.model,
    model: rowName,
    rowNameSource,
    // A new row may only be created from an AA-derived name, never a runnable id.
    canCreate: rowNameSource === 'aa',
    modelKey: target.modelKey,
    indexVersion: snapshot.intelligenceIndexVersion ?? null,
    runnable: target.runnable ? target.runnable.id : null,
    runnableModelKey: target.runnable ? (target.runnable.modelKey ?? null) : null,
    existingRow: Boolean(existing),
    match: aa ? {
      id: aa.id,
      slug: aa.slug ?? null,
      name: aa.name ?? null,
      creator: aa.model_creator?.name ?? null,
      variant: variantOf(aa.name),
      exact: matched.exact,
      via: matched.via,
    } : null,
    ambiguous: matched.ambiguous,
    rejected,
    fills,
    kept,
    nulled,
    absent,
    proposed,
    completeBefore: before.complete,
    completeAfter: after.complete,
    missingPartitions: after.missing,
  };
}

/**
 * Default targets: every runnable whose modelKey is null (so it has no registry
 * identity at all) or whose registry row cannot satisfy all four partitions.
 */
function defaultTargets({ runnables, registry, partitionMap }) {
  const byKey = new Map();
  for (const row of registry.models) byKey.set(modelKey(row.model), row);
  const targets = [];
  const seen = new Set();
  for (const runnable of runnables.runnables || []) {
    const key = runnable.modelKey || modelKey(runnable.id);
    if (seen.has(key)) continue;
    const row = byKey.get(key) || null;
    const complete = row ? partitionState(row, partitionMap).complete : false;
    if (runnable.modelKey == null || !complete) {
      seen.add(key);
      targets.push({ model: row ? row.model : runnable.id, modelKey: key, runnable, row });
    }
  }
  return targets;
}

/** Explicit `--models` targets: a registry row, a runnable, or an error. */
function explicitTargets(keys, { runnables, registry }) {
  const rowByKey = new Map();
  for (const row of registry.models) rowByKey.set(modelKey(row.model), row);
  const runnableByKey = new Map();
  for (const runnable of runnables.runnables || []) {
    runnableByKey.set(runnable.modelKey || modelKey(runnable.id), runnable);
  }
  return keys.map(raw => {
    const key = modelKey(raw);
    const row = rowByKey.get(key) || null;
    const runnable = runnableByKey.get(key) || null;
    if (!row && !runnable) {
      throw new Error(`unknown model "${raw}": not a registry row or a runnable`);
    }
    return { model: row ? row.model : runnable.id, modelKey: key, runnable, row };
  });
}

/**
 * Apply proposals to a registry document.
 *
 *   - a folded (non-exact) match is skipped unless `--confirm-match` names it
 *   - a new row is only created from an AA-derived name
 *   - only null fields are filled; an existing value always wins
 *   - new rows use the exporter's field order, so a later xlsx round-trip
 *     cannot reorder them
 */
function applyProposals(registry, proposals, { confirmMatch = [] } = {}) {
  const confirmed = new Set(confirmMatch.map(value => modelKey(value)));
  const models = registry.models.map(row => ({ ...row }));
  const changes = [];
  for (const proposal of proposals) {
    // `key` is the target model key, i.e. exactly what --confirm-match takes.
    const change = (action, fields = []) => ({ model: proposal.model, key: proposal.modelKey, action, fields });
    if (proposal.rejected) {
      changes.push(change('rejected'));
      continue;
    }
    if (!proposal.match) {
      changes.push(change('skipped'));
      continue;
    }
    if (!proposal.match.exact && !confirmed.has(proposal.modelKey)) {
      changes.push(change('unconfirmed'));
      continue;
    }
    let row = models.find(m => m.model === proposal.model) || null;
    if (!row && !proposal.canCreate) {
      changes.push(change('unnamed'));
      continue;
    }
    // A model AA knows nothing about must not become an all-null registry row.
    if (!row && !proposal.fills.length) {
      changes.push(change('skipped'));
      continue;
    }
    const created = !row;
    if (!row) {
      row = {};
      for (const field of REGISTRY_FIELDS) row[field] = null;
      row.model = proposal.model;
      models.push(row);
    }
    const applied = [];
    for (const fill of proposal.fills) {
      if (isPresent(row[fill.field])) continue;
      row[fill.field] = fill.value;
      applied.push(fill.field);
    }
    changes.push(change(created ? 'created' : 'updated', applied));
  }
  return { models, changes };
}

/** Write the registry in the exporter's exact JSON shape (atomic rename). */
function writeRegistry(file, doc) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * `config/runnables.json` modelKey updates the user should make by hand: every
 * runnable that has no modelKey yet and matched an AA row, whether or not the
 * row still needs values filled in.
 */
function runnableUpdates(proposals) {
  return proposals
    .filter(p => p.runnable && p.runnableModelKey == null && p.match && !p.rejected)
    .map(p => ({ id: p.runnable, modelKey: p.modelKey }));
}

function renderProposal(p) {
  const lines = [];
  const origin = p.existingRow ? `row ${p.model}` : `new row ${p.model}`;
  const runnable = p.runnable ? `, runnable ${p.runnable}` : '';
  lines.push(`${p.target}  [key ${p.modelKey}; ${origin}${runnable}]`);
  if (p.match) {
    const folded = p.match.exact ? '' : ' — FOLDED MATCH, confirm with --confirm-match';
    const creator = p.match.creator ? ` (${p.match.creator})` : '';
    lines.push(`  AA row: ${p.match.slug ?? p.match.id} "${p.match.name ?? ''}"${creator} via ${p.match.via}${folded}`);
  }
  if (p.ambiguous.length) lines.push(`  AA match ambiguous between ${p.ambiguous.join(', ')}; nothing proposed`);
  if (!p.match && !p.ambiguous.length && !p.rejected) lines.push('  no AA row matched this model key');
  if (p.rejected) lines.push(`  rejected: ${p.rejected}`);
  if (!p.existingRow) {
    lines.push(p.canCreate
      ? `  row name: ${p.model} (AA creator + slug)`
      : '  row name: none — the AA row has no creator or slug, so no row is created');
  }
  if (p.fills.length) lines.push(`  fill:   ${p.fills.map(f => `${f.field}=${JSON.stringify(f.value)}`).join('  ')}`);
  if (p.fills.some(f => f.field === 'intRef')) {
    lines.push(`  note:   intRef is Intelligence Index v${p.indexVersion ?? 'unknown'}; the registry has no version column, so existing INT values may come from another index version`);
    if (p.match?.variant) {
      lines.push(`  note:   the AA row is the "${p.match.variant}" variant, so intRef is that variant's index, not necessarily the model-level value`);
    }
  }
  if (p.kept.length) {
    lines.push(`  keep:   ${p.kept.map(f => `${f.field}=${JSON.stringify(f.registryValue)} (AA ${JSON.stringify(f.aaValue)})`).join('  ')}`);
    for (const k of p.kept) if (k.reason) lines.push(`  keep:   ${k.field} is never auto-filled — ${k.reason}`);
  }
  for (const n of p.nulled) lines.push(`  refuse: ${n.field} (AA ${JSON.stringify(n.aaValue)}) — ${n.reason}`);
  const absentByReason = new Map();
  for (const a of p.absent) {
    if (!absentByReason.has(a.reason)) absentByReason.set(a.reason, []);
    absentByReason.get(a.reason).push(a.field);
  }
  for (const [reason, fields] of absentByReason) lines.push(`  absent: ${fields.join(', ')} — ${reason}`);
  lines.push(p.completeAfter
    ? '  scoring: complete'
    : `  scoring: incomplete — missing ${p.missingPartitions.join(', ')}`);
  return lines.join('\n');
}

// --- price drift ---------------------------------------------------------

/** The registry's price columns, in the order the drift report prints them. */
const PRICE_FIELDS = ['cachePrice', 'inputPrice', 'outputPrice'];

/** Default tolerance k: a blended ratio outside [1/k, k] is flagged. */
const DRIFT_K = 2;

/** A usable price: a positive finite number. 0 means "not measured". */
function priceValue(value) {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * One side's prices with the shared unknown rules: 0 or a missing
 * input/output price means unknown.
 *
 * A missing (null) cache price falls back to that side's input price on the AA
 * side, because those tokens are billed at the input price (same substitution
 * as `aaListCost` in src/lib/aa-pricing.js). There is no fallback on the
 * registry side: score.js blends the raw row with `blendMtok`, which counts a
 * null cache as 0, i.e. cached tokens score as free. The report must show the
 * same number that drives routing, so the registry blend keeps the null and
 * the row carries a note instead of hiding the gap behind a substitution.
 */
function resolvePrices(prices, side, { fallbackCache = true } = {}) {
  const input = priceValue(prices?.inputPrice);
  const output = priceValue(prices?.outputPrice);
  const listedCache = num(prices?.cachePrice);
  const notes = [];
  let cache;
  let cacheSource;
  if (fallbackCache) {
    const cacheFromInput = listedCache === null;
    // A cache price of 0 is "not measured", never free.
    cache = cacheFromInput ? input : priceValue(listedCache);
    cacheSource = cacheFromInput ? 'input' : 'listed';
  } else {
    cache = priceValue(listedCache);
    cacheSource = listedCache === null ? 'missing' : 'listed';
    if (listedCache === null) notes.push('registry cache null: scored as free');
  }
  const reasons = [];
  if (input === null) reasons.push(`${side} inputPrice is 0 or missing`);
  if (output === null) reasons.push(`${side} outputPrice is 0 or missing`);
  if (listedCache !== null && cache === null) reasons.push(`${side} cachePrice is 0 (0 means not measured)`);
  return {
    cachePrice: cache,
    inputPrice: input,
    outputPrice: output,
    cacheSource,
    reasons,
    notes,
  };
}

function componentRatio(registryValue, aaValue) {
  if (registryValue == null || aaValue == null || !(aaValue > 0)) return null;
  return round6(registryValue / aaValue);
}

/**
 * Flag a blended registry/AA ratio outside [1/k, k]; the band edges are inside.
 * The comparison uses the ratio rounded to 6 places, the value the report
 * prints, so float noise at the edge cannot flip the flag.
 */
function isDrift(ratio, k = DRIFT_K) {
  const rounded = round6(ratio);
  return rounded < 1 / k || rounded > k;
}

/**
 * Compare every registry row that has an exact AA identity (an `aaSlug` pin,
 * otherwise an exact slug match: the strict rule `--write` uses, so a folded
 * match is out of scope and never compared).
 *
 * The registry side is blended from the raw row prices with `blendMtok`,
 * exactly as score.js prices a model (a null registry cache counts as 0 and
 * earns the row a note), while the AA side keeps the null-cache-to-input
 * fallback. The ratio is therefore the one that moves routing order.
 * Rows with an unknown price on either side are returned separately with the
 * reason instead of being flagged.
 */
function driftRows({ registry, snapshot, costBlend, driftK = DRIFT_K }) {
  const comparable = [];
  const notComparable = [];
  const unmatched = [];

  for (const row of registry.models || []) {
    const key = modelKey(row.model);
    const matched = matchAaRow(snapshot.models || [], { model: row.model, modelKey: key, row }, row);
    if (!matched.row || !matched.exact) {
      unmatched.push({
        model: row.model,
        modelKey: key,
        via: matched.via,
        rejected: matched.rejected,
        ambiguous: matched.ambiguous,
      });
      continue;
    }

    const aaSlug = matched.row.slug ?? null;
    const registrySide = resolvePrices(row, 'registry', { fallbackCache: false });
    const aaSide = resolvePrices(aaPrices(matched.row), 'AA');
    const reasons = [...registrySide.reasons, ...aaSide.reasons];
    const notes = [...registrySide.notes, ...aaSide.notes];
    if (reasons.length) {
      notComparable.push({ model: row.model, modelKey: key, aaSlug, reasons });
      continue;
    }

    const registryBlend = blendMtok(registrySide, costBlend);
    const aaBlend = blendMtok(aaSide, costBlend);
    // Reachable only with a broken config: a positive AA blend and the known
    // prices above make 0 impossible, and blendMtok nulls only without weights.
    if (registryBlend === null || aaBlend === null || !(registryBlend > 0) || !(aaBlend > 0)) {
      notComparable.push({
        model: row.model,
        modelKey: key,
        aaSlug,
        reasons: ['registry or AA blended price is not a positive number'],
      });
      continue;
    }

    const ratio = registryBlend / aaBlend;
    comparable.push({
      model: row.model,
      modelKey: key,
      aaSlug,
      notes,
      registry: {
        cachePrice: registrySide.cachePrice,
        inputPrice: registrySide.inputPrice,
        outputPrice: registrySide.outputPrice,
        cacheSource: registrySide.cacheSource,
      },
      aa: {
        cachePrice: aaSide.cachePrice,
        inputPrice: aaSide.inputPrice,
        outputPrice: aaSide.outputPrice,
        cacheSource: aaSide.cacheSource,
      },
      blends: { registry: registryBlend, aa: aaBlend },
      ratio,
      logRatio: Math.log(ratio),
      components: {
        cache: componentRatio(registrySide.cachePrice, aaSide.cachePrice),
        input: componentRatio(registrySide.inputPrice, aaSide.inputPrice),
        output: componentRatio(registrySide.outputPrice, aaSide.outputPrice),
      },
      flagged: isDrift(ratio, driftK),
    });
  }

  // |log ratio| descending: the same distance from 1 is the same severity.
  comparable.sort((a, b) => Math.abs(b.logRatio) - Math.abs(a.logRatio) || a.model.localeCompare(b.model));
  notComparable.sort((a, b) => a.model.localeCompare(b.model));
  unmatched.sort((a, b) => a.model.localeCompare(b.model));

  return {
    rows: comparable.map(({ logRatio, ...row }) => ({
      ...row,
      blends: { registry: round6(row.blends.registry), aa: round6(row.blends.aa) },
      ratio: round6(row.ratio),
      logRatio: round6(logRatio),
    })),
    notComparable,
    unmatched,
  };
}

function formatPrice(value) {
  if (value == null) return '-';
  return value >= 1 ? value.toFixed(2) : value.toFixed(3);
}

function formatRatio(value) {
  return value == null ? '-' : `${value.toFixed(2)}x`;
}

function renderPriceDrift(report) {
  const { snapshot, costBlend, driftK, rows, notComparable, unmatched } = report;
  const lines = [];
  lines.push(`snapshot: ${snapshot.path} (${snapshot.modelCount ?? 0} models, generated ${snapshot.generatedAt ?? 'unknown'})`);
  lines.push(`cost blend: cache ${costBlend.cache}, input ${costBlend.input}, output ${costBlend.output}; drift band [${formatRatio(1 / driftK)}, ${formatRatio(driftK)}] of registry/AA`);
  const inScope = rows.length + notComparable.length;
  lines.push(`exact AA identity: ${inScope} of ${inScope + unmatched.length} registry rows, ${rows.length} comparable, ${notComparable.length} not comparable`);
  lines.push('');

  if (rows.length) {
    const nameWidth = Math.max('model'.length, ...rows.map(row => row.model.length)) + 2;
    lines.push([
      ' '.repeat(nameWidth),
      'registry'.padStart(10),
      'AA'.padStart(10),
      'ratio'.padStart(9),
      'cache'.padStart(8),
      'input'.padStart(8),
      'output'.padStart(8),
    ].join('  '));
    for (const row of rows) {
      const cells = [
        `${row.flagged ? '!' : ' '} ${row.model}`.padEnd(nameWidth),
        formatPrice(row.blends.registry).padStart(10),
        formatPrice(row.blends.aa).padStart(10),
        formatRatio(row.ratio).padStart(9),
        formatRatio(row.components.cache).padStart(8),
        formatRatio(row.components.input).padStart(8),
        formatRatio(row.components.output).padStart(8),
      ];
      lines.push(cells.join('  ') + (row.notes.length ? `  (${row.notes.join('; ')})` : ''));
    }
  } else {
    lines.push('no comparable rows');
  }

  const flagged = rows.filter(row => row.flagged);
  lines.push('');
  lines.push(`${flagged.length} of ${rows.length} comparable row(s) flagged at k=${driftK} (blended registry/AA outside the band)`);
  if (flagged.length) {
    lines.push('fix one row with: npm run aa-propose -- --prices --write --confirm-price <model key>');
  }
  if (notComparable.length) {
    lines.push('');
    lines.push(`not comparable (${notComparable.length}):`);
    for (const row of notComparable) lines.push(`  ${row.model}: ${row.reasons.join('; ')}`);
  }
  if (unmatched.length) {
    lines.push('');
    lines.push(`no exact AA identity, not compared (${unmatched.length}):`);
    for (const row of unmatched) {
      const why = row.rejected
        ? ` (${row.rejected})`
        : row.ambiguous.length
          ? ` (ambiguous between ${row.ambiguous.join(', ')})`
          : row.via
            ? ` (only a folded ${row.via} match)`
            : '';
      lines.push(`  ${row.model}${why}`);
    }
  }
  return lines.join('\n');
}

/**
 * Resolve `--confirm-price` keys to flagged rows. Naming an unflagged,
 * not-comparable or unmatched row is an error: there is nothing to overwrite.
 * A key shared by two registry rows is an error too, naming the duplicates:
 * the key alone cannot say which row to fix, so nothing is written.
 */
function confirmedPriceRows(keys, { registry, rows, notComparable, driftK }) {
  const flagged = new Map();
  const comparable = new Map();
  for (const row of rows) {
    comparable.set(row.modelKey, row);
    if (row.flagged) flagged.set(row.modelKey, row);
  }
  const blocked = new Map(notComparable.map(row => [row.modelKey, row]));
  const registryNames = new Map((registry.models || []).map(row => [modelKey(row.model), row.model]));
  const duplicates = new Map();
  for (const row of registry.models || []) {
    const key = modelKey(row.model);
    if (!duplicates.has(key)) duplicates.set(key, []);
    // No dedup: two identical `model` strings are a duplicate too.
    duplicates.get(key).push(row.model);
  }
  const confirmed = [];
  const seen = new Set();
  for (const raw of keys) {
    const key = modelKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    const dups = duplicates.get(key) || [];
    if (dups.length > 1) {
      throw new Error(`--confirm-price "${raw}": matches ${dups.length} registry rows (${dups.join(', ')}); fix the duplicate registry rows by hand`);
    }
    const hit = flagged.get(key);
    if (hit) {
      confirmed.push(hit);
      continue;
    }
    const inBand = comparable.get(key);
    if (inBand) {
      throw new Error(`--confirm-price "${raw}": ${inBand.model} is within the drift band (ratio ${formatRatio(inBand.ratio)}, k=${driftK}); nothing to fix`);
    }
    const unknown = blocked.get(key);
    if (unknown) {
      throw new Error(`--confirm-price "${raw}": ${unknown.model} is not comparable (${unknown.reasons.join('; ')}); fix it by hand`);
    }
    if (registryNames.has(key)) {
      throw new Error(`--confirm-price "${raw}": ${registryNames.get(key)} has no exact AA identity, so there is no AA price to write`);
    }
    throw new Error(`--confirm-price "${raw}": unknown model, not a registry row`);
  }
  return confirmed;
}

/**
 * Overwrite the three price columns of the confirmed rows, and only those.
 * Every other row keeps its values and key order byte for byte.
 *
 * The AA cache price written is the one the report compared, so a null AA cache
 * price is written as the AA input price (the value those tokens are billed at)
 * and the row afterwards blends to the AA blend the report showed.
 */
function applyPriceFixes(models, confirmed) {
  const byModel = new Map(confirmed.map(row => [row.model, row]));
  return models.map(row => {
    const fix = byModel.get(row.model);
    if (!fix) return { ...row };
    return {
      ...row,
      cachePrice: fix.aa.cachePrice,
      inputPrice: fix.aa.inputPrice,
      outputPrice: fix.aa.outputPrice,
    };
  });
}

/**
 * The `--prices` report: registry price drift against the AA snapshot. This is
 * a report, so a flagged row never changes the exit code.
 *
 * `write` is opt-in per row: it requires `confirmPrice` naming flagged model
 * keys and overwrites only the three price columns of those rows.
 */
function runPrices({
  json = false,
  write = false,
  confirmPrice = [],
  driftK = DRIFT_K,
  snapshotPath = null,
  registryPath = defaultRegistryPath(),
  configPath = null,
  log = console.log,
} = {}) {
  if (write && !confirmPrice.length) {
    throw new Error('--write in --prices mode needs --confirm-price k1,k2: there is no bulk overwrite');
  }
  if (!(Number.isFinite(driftK) && driftK > 1)) {
    throw new Error(`--drift-k must be a number greater than 1 (got ${driftK})`);
  }

  const snapshotFile = resolveSnapshotPath(snapshotPath);
  const snapshot = readSnapshot(snapshotFile);
  const registry = readJson(registryPath);
  const costBlend = readConfig(configPath).costBlend ?? null;
  if (blendMtok({ cachePrice: 1, inputPrice: 1, outputPrice: 1 }, costBlend) === null) {
    throw new Error('config.costBlend must provide numeric cache/input/output weights; cannot blend registry and AA prices');
  }

  const { rows, notComparable, unmatched } = driftRows({ registry, snapshot, costBlend, driftK });

  const confirmed = write ? confirmedPriceRows(confirmPrice, { registry, rows, notComparable, driftK }) : [];
  let written = null;
  if (write) {
    const models = applyPriceFixes(registry.models || [], confirmed);
    writeRegistry(registryPath, { ...registry, models });
    written = {
      path: registryPath,
      models: confirmed.map(row => row.model),
      fields: PRICE_FIELDS.slice(),
      next: ['npm run pipeline', 'npm run verify'],
    };
  }

  const report = {
    snapshot: {
      path: snapshotFile,
      generatedAt: snapshot.generatedAt ?? null,
      intelligenceIndexVersion: snapshot.intelligenceIndexVersion ?? null,
      modelCount: snapshot.modelCount ?? (snapshot.models || []).length,
    },
    costBlend,
    driftK,
    rows,
    notComparable,
    unmatched,
    flagged: rows.filter(row => row.flagged).map(row => row.model),
    written,
  };

  if (json) {
    log(JSON.stringify(report, null, 2));
    return report;
  }
  log(renderPriceDrift(report));
  if (written) {
    log('');
    for (const model of written.models) log(`registry prices updated: ${model}`);
    log('next: npm run pipeline && npm run verify');
  }
  return report;
}

function parseModelList(value, flag) {
  const list = String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) throw new Error(`${flag} needs at least one model key`);
  return list;
}

function parseArgs(argv) {
  const opts = { models: null, json: false, write: false, confirmMatch: [], snapshot: null, help: false, prices: false, driftK: DRIFT_K, confirmPrice: [] };
  const explicit = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--write') opts.write = true;
    else if (arg === '--prices') opts.prices = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--models') {
      const value = argv[++i];
      if (!value) throw new Error('--models needs a comma-separated list of model keys');
      opts.models = parseModelList(value, '--models');
    } else if (arg === '--drift-k') {
      const value = argv[++i];
      const k = Number(value);
      if (!value || !Number.isFinite(k) || k <= 1) throw new Error('--drift-k needs a number greater than 1');
      opts.driftK = k;
      explicit.add('driftK');
    } else if (arg === '--confirm-price') {
      const value = argv[++i];
      if (!value) throw new Error('--confirm-price needs a model key');
      opts.confirmPrice.push(...parseModelList(value, '--confirm-price'));
    } else if (arg === '--confirm-match') {
      const value = argv[++i];
      if (!value) throw new Error('--confirm-match needs a model key');
      opts.confirmMatch.push(...parseModelList(value, '--confirm-match'));
    } else if (arg === '--snapshot') {
      const value = argv[++i];
      if (!value) throw new Error('--snapshot needs a path');
      opts.snapshot = path.resolve(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }

  if (opts.prices) {
    if (opts.models) throw new Error('--models is not supported with --prices: the report covers every registry row with an exact AA identity');
    if (opts.confirmMatch.length) throw new Error('--confirm-match is not supported with --prices: only an exact AA identity is compared');
    if (opts.write && !opts.confirmPrice.length) throw new Error('--write in --prices mode needs --confirm-price k1,k2: there is no bulk overwrite');
  } else {
    if (opts.confirmPrice.length) throw new Error('--confirm-price is only valid with --prices');
    if (explicit.has('driftK')) throw new Error('--drift-k is only valid with --prices');
  }
  return opts;
}

const USAGE = `Usage: npm run aa-propose -- [--models k1,k2] [--json] [--write]
                            [--confirm-match k1,k2] [--snapshot PATH]
       npm run aa-propose -- --prices [--drift-k K] [--json]
                            [--write --confirm-price k1,k2] [--snapshot PATH]

  --models K1,K2       restrict to these models (registry names or model keys)
  --json               print the proposals as JSON
  --write              apply null-fills/new rows to data/benchmark-inputs.json,
                       then run: npm run pipeline && npm run verify
  --confirm-match K1,K2  allow --write for models whose AA match only folds
                       (preview/thinking/date suffixes, display-name fallback)
  --snapshot PATH      snapshot to read (default ${freeSnapshotPath()})

Proposes only what the Free catalog carries: aaSlug, the three indices, prices
and speed. The six per-benchmark columns need the AA website or manual research.

Price drift (--prices), a report that never changes the exit code:

  --prices             compare the blended $/MTok of every registry row with
                       an exact AA identity, and flag a registry/AA ratio
                       outside [1/K, K]
  --drift-k K          tolerance K (default 2); the band edges are inside
  --confirm-price K1,K2  with --write, overwrite the three price columns of
                       these flagged rows only (a key of an unflagged or
                       unknown row is an error). A null AA cache price is
                       written as the AA input price

Never edits config/runnables.json; it prints the modelKey updates to make.`;

function resolveSnapshotPath(explicit) {
  return explicit || freeSnapshotPath();
}

/**
 * Full run: load inputs, propose, optionally write. All paths are injectable so
 * tests never touch the real data files.
 */
function runPropose({
  models = null,
  json = false,
  write = false,
  confirmMatch = [],
  snapshotPath = null,
  registryPath = defaultRegistryPath(),
  runnablesPath = defaultRunnablesPath(),
  configPath = null,
  log = console.log,
} = {}) {
  const snapshotFile = resolveSnapshotPath(snapshotPath);
  const snapshot = readSnapshot(snapshotFile);
  const registry = readJson(registryPath);
  // With --models the runnables file is only needed to resolve a runnable id.
  const runnables = models ? (tryReadJson(runnablesPath) || { runnables: [] }) : readJson(runnablesPath);
  const partitionMap = readConfig(configPath).partitionMap;

  const targets = models
    ? explicitTargets(models, { runnables, registry })
    : defaultTargets({ runnables, registry, partitionMap });
  const proposals = targets.map(target => proposeOne({ target, snapshot, partitionMap }));

  let written = null;
  if (write) {
    const applied = applyProposals(registry, proposals, { confirmMatch });
    const changed = applied.changes.filter(c => c.fields.length > 0);
    if (changed.length) writeRegistry(registryPath, { ...registry, models: applied.models });
    written = {
      changed,
      blocked: applied.changes.filter(c => c.action !== 'updated' && c.action !== 'created'),
      path: registryPath,
      next: changed.length ? ['npm run pipeline', 'npm run verify'] : [],
    };
  }

  const updates = runnableUpdates(proposals);
  if (json) {
    log(JSON.stringify({
      snapshot: {
        path: snapshotFile,
        generatedAt: snapshot.generatedAt ?? null,
        intelligenceIndexVersion: snapshot.intelligenceIndexVersion ?? null,
        modelCount: snapshot.modelCount ?? snapshot.models.length,
      },
      proposals,
      written,
      runnableUpdates: updates,
    }, null, 2));
    return { proposals, written, updates, snapshot: snapshotFile };
  }

  log(`snapshot: ${snapshotFile} (${snapshot.modelCount ?? snapshot.models.length} models, Intelligence Index v${snapshot.intelligenceIndexVersion ?? 'unknown'}, generated ${snapshot.generatedAt ?? 'unknown'})`);
  log(`Targets: ${proposals.length}`);
  log('');
  for (const proposal of proposals) {
    log(renderProposal(proposal));
    log('');
  }
  if (written) {
    if (!written.changed.length) {
      log(written.blocked.length
        ? `registry unchanged: ${written.blocked.map(c => `${c.model} (${c.action})`).join(', ')}`
        : 'registry unchanged: every proposed value was already present');
    }
    for (const change of written.changed) log(`registry ${change.action}: ${change.model} (${change.fields.join(', ')})`);
    for (const change of written.blocked.filter(c => c.action === 'unconfirmed')) {
      log(`registry skipped: ${change.model} — folded AA match, pass --confirm-match ${change.key} to write it`);
    }
    if (written.changed.length) log('next: npm run pipeline && npm run verify');
    log('');
  }
  if (updates.length) {
    log('config/runnables.json modelKey updates to make by hand:');
    for (const update of updates) log(`  { "id": ${JSON.stringify(update.id)}, "modelKey": ${JSON.stringify(update.modelKey)} }`);
    log('');
  }
  const scorable = proposals.filter(p => p.completeAfter).length;
  log(`${scorable} of ${proposals.length} proposal(s) would make the model scoreable.`);
  return { proposals, written, updates, snapshot: snapshotFile };
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.prices) {
    runPrices({
      json: opts.json,
      write: opts.write,
      confirmPrice: opts.confirmPrice,
      driftK: opts.driftK,
      snapshotPath: opts.snapshot,
    });
    // A drift report never fails the gate: flagged rows still exit 0.
    return 0;
  }
  runPropose(opts);
  return 0;
}

if (require.main === module) {
  main().then(
    code => { process.exitCode = code; },
    error => {
      console.error(`aa-propose: ${error.message}`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  REGISTRY_FIELDS,
  PROVIDERS,
  AA_FIELDS,
  UNSOURCED,
  UNSAFE,
  BENCHMARKS_UNSOURCED,
  familyOf,
  providerOfModel,
  variantOf,
  slugify,
  newRowNameFor,
  partitionState,
  matchAaRow,
  proposeOne,
  defaultTargets,
  explicitTargets,
  applyProposals,
  writeRegistry,
  runnableUpdates,
  renderProposal,
  parseArgs,
  resolveSnapshotPath,
  runPropose,
  PRICE_FIELDS,
  DRIFT_K,
  priceValue,
  resolvePrices,
  isDrift,
  driftRows,
  renderPriceDrift,
  confirmedPriceRows,
  applyPriceFixes,
  runPrices,
  main,
};
