'use strict';
/**
 * Score proposals must reproduce the mapping the two existing artifacts already
 * perform (gscripts/model-catalogs.gs → AA_fetch, scripts/export-from-xlsx.py →
 * registry), refuse everything that is not importer parity or documented as
 * unsafe, match identity strictly, and never overwrite a value a human entered.
 * Run with `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const aa = require('../src/roi-tracker/collect/aa.js');
const propose = require('../src/roi-tracker/collect/aa-propose.js');
const { readJson } = require('../src/lib/load.js');
const {
  freePages,
  proPage,
  page,
  freeModel,
  previewPage,
  pinnedPage,
  nameTiePage,
  ambiguousPage,
} = require('../testdata/aa-fixtures.js');

const ROOT = path.join(__dirname, '..');
// partitionMap is a method key: it lives in the tracked defaults.
const PARTITIONS = readJson(path.join(ROOT, 'config', 'defaults', 'roi.json')).partitionMap;
const FREE_URL = 'https://artificialanalysis.ai/api/v2/language/models/free';
const PRO_URL = 'https://artificialanalysis.ai/api/v2/language/models';

const BENCHMARK_FIELDS = ['terminalBench', 'sciCode', 'aaLcr', 'hle', 'gpqa', 'critPt'];

function snapshotOf(pages) {
  const models = pages.flatMap(p => p.data);
  const tier = pages[0].tier ?? 'free';
  return aa.buildSnapshot({
    access: tier,
    endpoint: tier === 'pro' ? PRO_URL : FREE_URL,
    intelligenceIndexVersion: pages[0].intelligence_index_version,
    pageCount: pages.length,
    models,
  }, { now: new Date('2026-11-08T10:00:00Z') });
}

function target(model, modelKey, row = null, runnable = null) {
  return { model, modelKey, row, runnable };
}

function proposeFor(model, modelKey, { snapshot = snapshotOf(freePages()), row = null, includeBenchmarks = false } = {}) {
  return propose.proposeOne({
    target: target(model, modelKey, row),
    snapshot,
    partitionMap: PARTITIONS,
    includeBenchmarks,
  });
}

function completeRow(model) {
  return {
    model,
    gdpval: 50,
    terminalBench: 50,
    tau3Banking: null,
    aaLcr: 50,
    aaOmni: null,
    hle: 50,
    gpqa: 50,
    sciCode: 50,
    critPt: null,
    apexAgents: null,
    intRef: 50,
    cachePrice: 1,
    inputPrice: 1,
    outputPrice: 2,
    speed: 50,
    aaSlug: null,
    aaCoding: null,
    aaAgentic: null,
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-aa-propose-'));
}

/**
 * Run the real Apps Script importer against one recorded-shape page and return
 * the AA_fetch header + first row, so mapping parity is checked against the
 * code that actually produced the sheet rather than against a copy of it.
 */
function gsAaFetchRow(payload) {
  const writes = [];
  const range = {
    setValues(values) { writes.push(values); return this; },
    clearContent() { return this; },
    setFontWeight() { return this; },
    setBackground() { return this; },
    setFontColor() { return this; },
    setNumberFormat() { return this; },
  };
  const sheet = {
    getLastRow: () => 1,
    getLastColumn: () => 19,
    getMaxRows: () => 1000,
    getMaxColumns: () => 26,
    getRange: () => range,
    setFrozenRows() {},
    autoResizeColumns() {},
    insertRowsAfter() {},
    insertColumnsAfter() {},
  };
  const context = vm.createContext({
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: () => sheet,
        toast() {},
        getActiveSheet() { throw new Error('must not write the active sheet'); },
      }),
      getUi: () => ({ createMenu() { return this; }, addItem() { return this; }, addToUi() {} }),
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: key => (key === 'AA_API_KEY' ? 'test-key' : undefined) }),
    },
    LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Logger: { log() {} },
    Utilities: { sleep() {}, formatDate: date => date.toISOString().slice(0, 10) },
    UrlFetchApp: {
      fetch: () => ({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify(payload),
        getAllHeaders: () => ({}),
      }),
    },
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gscripts', 'model-catalogs.gs'), 'utf8'), context);
  context.fetchArtificialAnalysisData();
  const [header, row] = writes[0];
  return { header, row };
}

// --- mapping -------------------------------------------------------------

test('registry mapping matches the gs importer column for column', () => {
  const singlePage = page([freeModel()]);
  const { header, row } = gsAaFetchRow(singlePage);

  const expectedHeaders = {
    aaSlug: 'Slug',
    intRef: 'Intelligence Index',
    aaCoding: 'Coding Index',
    aaAgentic: 'Agentic Index',
    inputPrice: 'Price / 1M Input ($)',
    outputPrice: 'Price / 1M Output ($)',
    cachePrice: 'Price / 1M Cache Hit ($)',
    speed: 'Median Output Tokens/s',
  };
  const columns = { aaSlug: 2, intRef: 4, aaCoding: 5, aaAgentic: 6, inputPrice: 8, outputPrice: 9, cachePrice: 10, speed: 12 };
  for (const [field, column] of Object.entries(columns)) {
    assert.equal(header[column], expectedHeaders[field], `AA_fetch column for ${field}`);
    assert.equal(propose.AA_FIELDS.find(f => f.field === field).column, expectedHeaders[field]);
  }

  const proposal = propose.proposeOne({
    target: target('x-ai/grok-4.6', 'grok-4-6'),
    snapshot: snapshotOf([singlePage]),
    partitionMap: PARTITIONS,
  });

  for (const [field, column] of Object.entries(columns)) {
    const sheetValue = row[column] === '' ? null : row[column];
    assert.deepEqual(proposal.proposed[field], sheetValue, `${field} must match AA_fetch col ${column}`);
  }
});

test('per-benchmark fields are refused by default: they are not importer parity', () => {
  const proposal = proposeFor('anthropic/claude-opus-5-5', 'claude-opus-5-5', { snapshot: snapshotOf([proPage()]) });

  const nulled = Object.fromEntries(proposal.nulled.map(n => [n.field, n]));
  for (const field of BENCHMARK_FIELDS) {
    assert.ok(nulled[field], `${field} must be reported as refused`);
    assert.equal(nulled[field].reason, propose.BENCHMARK_UNVERIFIED);
    assert.match(nulled[field].reason, /not in importer/);
    assert.equal(proposal.proposed[field], null, `${field} must stay null`);
    assert.ok(!proposal.fills.some(f => f.field === field), `${field} must not be filled`);
  }
  // The value is still reported, so a reviewer can see what was declined.
  assert.equal(nulled.terminalBench.aaValue, 83.9);
  assert.deepEqual(proposal.unverified, []);
  assert.match(propose.renderProposal(proposal), /refuse: terminalBench \(AA 83\.9\) — not in importer/);
});

test('--include-benchmarks proposes them and warns per field', () => {
  const proposal = proposeFor('anthropic/claude-opus-5-5', 'claude-opus-5-5', {
    snapshot: snapshotOf([proPage()]),
    includeBenchmarks: true,
  });

  assert.equal(proposal.proposed.terminalBench, 83.9);
  assert.equal(proposal.proposed.sciCode, 59);
  assert.equal(proposal.proposed.aaLcr, 79.7);
  assert.equal(proposal.proposed.hle, 42.3);
  assert.equal(proposal.proposed.gpqa, 91.7);
  assert.equal(proposal.proposed.critPt, 19.1);
  assert.deepEqual(proposal.unverified.map(u => u.field).sort(), [...BENCHMARK_FIELDS].sort());
  for (const entry of proposal.unverified) assert.equal(entry.reason, propose.BENCHMARK_UNVERIFIED);

  const report = propose.renderProposal(proposal);
  assert.match(report, /UNVERIFIED mapping: terminalBench ← evaluations\.terminalbench_v2_1 \(x100\)/);
  assert.match(report, /UNVERIFIED mapping: gpqa ← evaluations\.gpqa_diamond \(x100\)/);

  // Prices are already USD per 1M tokens in AA; the gs importer does not rescale.
  assert.equal(proposal.proposed.inputPrice, 4);
  assert.equal(proposal.proposed.outputPrice, 20);
  assert.equal(proposal.proposed.cachePrice, 0.5);
  assert.equal(proposal.proposed.speed, 108.75);
  assert.equal(proposal.proposed.intRef, 59.1);
  assert.ok(!proposal.fills.some(f => /cost/i.test(f.field)), 'no AA cost column becomes a price');
});

test('fields the backlog marks unsafe are refused even when AA has a number', () => {
  const proposal = proposeFor('anthropic/claude-opus-5-5', 'claude-opus-5-5', {
    snapshot: snapshotOf([proPage()]),
    includeBenchmarks: true,
  });

  const nulled = Object.fromEntries(proposal.nulled.map(n => [n.field, n]));
  assert.equal(nulled.gdpval.aaValue, 57.9);
  assert.match(nulled.gdpval.reason, /vintage/);
  assert.equal(nulled.tau3Banking.aaValue, 50.3);
  assert.match(nulled.tau3Banking.reason, /vintage/);

  const absent = Object.fromEntries(proposal.absent.map(a => [a.field, a.reason]));
  assert.match(absent.apexAgents, /scale-incompatible/);
  assert.match(absent.aaOmni, /omniscience/);

  for (const field of ['gdpval', 'tau3Banking', 'apexAgents', 'aaOmni']) {
    assert.equal(proposal.proposed[field], null, `${field} must stay null`);
    assert.ok(!proposal.fills.some(f => f.field === field), `${field} must not be filled`);
  }
});

test('a Free snapshot explains that the tier, not the model, is why benchmarks are absent', () => {
  // A Pro body carries the evaluations, so nothing is missing there.
  const pro = proposeFor('anthropic/claude-opus-5-5', 'claude-opus-5-5', {
    snapshot: snapshotOf([proPage()]),
    includeBenchmarks: true,
  });
  assert.deepEqual(pro.absent.filter(a => a.reason === propose.FREE_TIER), []);

  // A Free body has no per-benchmark evaluations at all: say so, and say how to
  // get them, instead of implying the model is unmeasured.
  const free = proposeFor('xai/grok-4.6', 'grok-4-6', { includeBenchmarks: true });
  const absent = Object.fromEntries(free.absent.map(a => [a.field, a.reason]));
  for (const field of BENCHMARK_FIELDS) assert.equal(absent[field], propose.FREE_TIER, field);
  assert.match(propose.renderProposal(free), /run npm run aa-sync -- --pro/);
});

// --- completeness --------------------------------------------------------

test('completeness uses the score.js partition rule, not a field count', () => {
  const proSnapshot = snapshotOf([proPage()]);

  // Without --include-benchmarks nothing reaches the partitions.
  const refused = proposeFor('anthropic/claude-opus-5-5', 'claude-opus-5-5', { snapshot: proSnapshot });
  assert.equal(refused.completeAfter, false);
  assert.deepEqual(refused.missingPartitions, ['agents', 'coding', 'general', 'scientific']);

  // With it, only the agents partition is still missing.
  const included = proposeFor('anthropic/claude-opus-5-5', 'claude-opus-5-5', { snapshot: proSnapshot, includeBenchmarks: true });
  assert.equal(included.completeAfter, false);
  assert.deepEqual(included.missingPartitions, ['agents']);

  // A row that already satisfies all four partitions stays complete, and every
  // AA value it already has is kept rather than replaced.
  const existing = { ...completeRow('anthropic/claude-opus-5-5'), tau3Banking: 34.64 };
  const complete = proposeFor('anthropic/claude-opus-5-5', 'claude-opus-5-5', { snapshot: proSnapshot, row: existing, includeBenchmarks: true });
  assert.equal(complete.completeBefore, true);
  assert.equal(complete.completeAfter, true);
  assert.deepEqual(complete.missingPartitions, []);
  assert.deepEqual(complete.fills.map(f => f.field).sort(), ['aaSlug', 'critPt']);
  assert.equal(complete.proposed.terminalBench, 50);
  assert.equal(complete.proposed.tau3Banking, 34.64);
});

test('a registry value always wins over a fresh AA value', () => {
  const existing = { ...completeRow('x-ai/grok-4.6'), speed: 96.4, gdpval: 61, intRef: null };
  const proposal = proposeFor('x-ai/grok-4.6', 'grok-4-6', { row: existing });

  assert.equal(proposal.proposed.speed, 96.4);
  assert.equal(proposal.proposed.gdpval, 61);
  assert.equal(proposal.proposed.intRef, 54, 'a null field is still filled');
  const kept = Object.fromEntries(proposal.kept.map(k => [k.field, k]));
  assert.equal(kept.speed.aaValue, 96.4);
  // gdpval is in the never-auto-filled set: the registry value wins and the
  // reason is still reported.
  assert.equal(kept.gdpval.registryValue, 61);
  assert.match(kept.gdpval.reason, /vintage/);
  assert.ok(!proposal.fills.some(f => f.field === 'speed'));
  assert.ok(!proposal.fills.some(f => f.field === 'gdpval'));
});

// --- identity ------------------------------------------------------------

test('an exact slug match is reported as exact', () => {
  const proposal = proposeFor('xai/grok-4.6', 'grok-4-6');
  assert.deepEqual({ via: proposal.match.via, exact: proposal.match.exact, slug: proposal.match.slug }, { via: 'slug', exact: true, slug: 'grok-4-6' });
  assert.doesNotMatch(propose.renderProposal(proposal), /FOLDED MATCH/);
});

test('a folded slug match is flagged and --write refuses it without --confirm-match', () => {
  // Only the `-preview` variant is in this snapshot; modelKey strips `-preview`.
  const snapshot = snapshotOf([page([freeModel({ id: 'id-preview', name: 'Mistral Large 4 Preview', slug: 'mistral-large-4-preview', creator: { id: 'c', name: 'Mistral' }, input: 1, output: 3 })])]);
  const proposal = propose.proposeOne({ target: target('mistral/mistral-large-4', 'mistral-large-4'), snapshot, partitionMap: PARTITIONS });

  assert.equal(proposal.match.via, 'slug');
  assert.equal(proposal.match.exact, false);
  assert.equal(proposal.match.slug, 'mistral-large-4-preview');
  assert.match(propose.renderProposal(proposal), /FOLDED MATCH, confirm with --confirm-match/);

  const registry = { models: [] };
  const blocked = propose.applyProposals(registry, [proposal]);
  assert.deepEqual(blocked.models, []);
  assert.equal(blocked.changes[0].action, 'unconfirmed');

  const confirmed = propose.applyProposals(registry, [proposal], { confirmMatch: ['mistral-large-4'] });
  assert.equal(confirmed.changes[0].action, 'created');
  assert.equal(confirmed.models[0].model, 'mistral/mistral-large-4-preview');
});

test('an exact slug beats a slug that only folds to the same key', () => {
  const proposal = proposeFor('mistral/mistral-large-4', 'mistral-large-4', { snapshot: snapshotOf([previewPage()]) });
  assert.equal(proposal.match.slug, 'mistral-large-4');
  assert.equal(proposal.match.exact, true);
  assert.equal(proposal.proposed.inputPrice, 2);
});

test('a registry aaSlug pins the match to that exact slug', () => {
  const snapshot = snapshotOf([pinnedPage()]);
  // Without a pin the plain slug wins.
  const unpinned = propose.proposeOne({ target: target('x-ai/grok-4.6', 'grok-4-6'), snapshot, partitionMap: PARTITIONS });
  assert.equal(unpinned.match.slug, 'grok-4-6');
  assert.equal(unpinned.proposed.inputPrice, 2);

  const pinned = propose.proposeOne({
    target: target('x-ai/grok-4.6', 'grok-4-6', { model: 'x-ai/grok-4.6', aaSlug: 'grok-4-6-high' }),
    snapshot,
    partitionMap: PARTITIONS,
  });
  assert.equal(pinned.match.via, 'aaSlug');
  assert.equal(pinned.match.exact, true);
  assert.equal(pinned.match.slug, 'grok-4-6-high');
  assert.equal(pinned.proposed.inputPrice, 3);

  // A pin that is not in the snapshot is a rejection, never a silent fallback.
  const stale = propose.proposeOne({
    target: target('x-ai/grok-4.6', 'grok-4-6', { model: 'x-ai/grok-4.6', aaSlug: 'grok-4-6-max' }),
    snapshot,
    partitionMap: PARTITIONS,
  });
  assert.equal(stale.match, null);
  assert.match(stale.rejected, /registry aaSlug "grok-4-6-max" is not in this snapshot/);
  assert.deepEqual(stale.fills, []);
});

test('a display-name fallback is folded and a tie is ambiguous', () => {
  const single = proposeFor('mistral/devstral-latest', 'devstral');
  assert.equal(single.match.via, 'name');
  assert.equal(single.match.exact, false);
  assert.equal(single.match.slug, 'devstral-1-0');
  assert.equal(single.proposed.inputPrice, 0.4);
  assert.match(propose.renderProposal(single), /FOLDED MATCH/);

  const tie = proposeFor('mistral/devstral-latest', 'devstral', { snapshot: snapshotOf([nameTiePage()]) });
  assert.equal(tie.match, null);
  assert.deepEqual(tie.ambiguous, ['id-devstral-1', 'id-devstral-2']);
  assert.deepEqual(tie.fills, []);
  assert.match(propose.renderProposal(tie), /ambiguous/);
});

test('an ambiguous AA match proposes nothing instead of guessing', () => {
  const proposal = proposeFor('xai/grok-4.7', 'grok-4-7', { snapshot: snapshotOf([ambiguousPage()]) });
  assert.equal(proposal.match, null);
  assert.deepEqual(proposal.ambiguous, ['id-grok-4-7-high', 'id-grok-4-7-max']);
  assert.deepEqual(proposal.fills, []);
});

test('a hosted runnable is not rejected because its host is not the AA creator', () => {
  // mistral/… is the subscription that serves DeepSeek's model, not its creator.
  const snapshot = snapshotOf([page([freeModel({ id: 'id-dsf', name: 'DeepSeek V4.1 Flash', slug: 'deepseek-v4-1-flash', creator: { id: 'd', name: 'DeepSeek' } })])]);
  const proposal = propose.proposeOne({ target: target('mistral/deepseek-v4-1-flash-1017', 'deepseek-v4-1-flash'), snapshot, partitionMap: PARTITIONS });
  assert.equal(proposal.rejected, null);
  assert.equal(proposal.model, 'deepseek/deepseek-v4-1-flash');
});

test('a provider disagreement between the registry name and AA creator is a rejection', () => {
  const snapshot = snapshotOf([page([freeModel({ id: 'id-luna', name: 'GPT-5.6 Luna', slug: 'gpt-5-6-luna', creator: { id: 'c', name: 'xAI' } })])]);
  const proposal = propose.proposeOne({ target: target('openai/gpt-5-6-luna', 'gpt-5-6-luna', { model: 'openai/gpt-5-6-luna' }), snapshot, partitionMap: PARTITIONS });

  assert.match(proposal.rejected, /provider mismatch: openai\/gpt-5-6-luna is openai but AA lists xAI \(x-ai\)/);
  assert.deepEqual(proposal.fills, []);
  assert.equal(proposal.proposed.intRef, null);
  assert.match(propose.renderProposal(proposal), /rejected: provider mismatch/);

  const applied = propose.applyProposals({ models: [] }, [proposal]);
  assert.deepEqual(applied.models, []);
  assert.equal(applied.changes[0].action, 'rejected');
});

test('provider families fold the spellings AA, the registry and runnables use', () => {
  assert.equal(propose.familyOf('xAI'), 'x-ai');
  assert.equal(propose.familyOf('x-ai'), 'x-ai');
  assert.equal(propose.familyOf('SpaceXAI'), 'x-ai');
  assert.equal(propose.familyOf('Z AI'), 'z-ai');
  assert.equal(propose.familyOf('Anthropic'), 'anthropic');
  assert.equal(propose.familyOf('claude'), 'anthropic');
  assert.equal(propose.familyOf('openai-codex'), 'openai');
  assert.equal(propose.familyOf('nex-agi'), 'nex-agi');
  assert.equal(propose.familyOf('Some New Lab'), null);
  assert.equal(propose.providerOfModel('xai/grok-4.6'), 'x-ai');
  assert.equal(propose.providerOfModel('no-slash'), null);
});

// --- row naming and writing ---------------------------------------------

test('a new row is named from the AA creator and slug, never the runnable id', () => {
  const proposal = proposeFor('xai/grok-4.6', 'grok-4-6');
  assert.equal(proposal.target, 'xai/grok-4.6');
  // `<creator family>/<AA slug>`: the runnable id is a local alias, not a name.
  assert.equal(proposal.model, 'x-ai/grok-4-6');
  assert.equal(proposal.rowNameSource, 'aa');
  assert.equal(proposal.canCreate, true);
  assert.match(propose.renderProposal(proposal), /row name: x-ai\/grok-4-6 \(AA creator \+ slug\)/);

  const registry = { models: [] };
  const applied = propose.applyProposals(registry, [proposal]);
  assert.equal(applied.models[0].model, 'x-ai/grok-4-6');
  assert.deepEqual(Object.keys(applied.models[0]), propose.REGISTRY_FIELDS);
});

test('an AA row without a creator or slug never creates a row', () => {
  const snapshot = snapshotOf([page([freeModel({ id: 'id-x', name: 'Grok 4.6', slug: 'grok-4-6', creator: null })])]);
  const proposal = propose.proposeOne({ target: target('xai/grok-4.6', 'grok-4-6'), snapshot, partitionMap: PARTITIONS });

  assert.equal(proposal.canCreate, false);
  assert.equal(proposal.rowNameSource, 'runnable');
  assert.match(propose.renderProposal(proposal), /row name: none/);

  const applied = propose.applyProposals({ models: [] }, [proposal]);
  assert.deepEqual(applied.models, []);
  assert.equal(applied.changes[0].action, 'unnamed');
});

test('applyProposals only fills nulls and keeps the exporter field order', () => {
  const registry = { models: [{ ...completeRow('x-ai/grok-4.6'), speed: 96.4, gdpval: 61, intRef: null }] };
  const proposals = [
    proposeFor('x-ai/grok-4.6', 'grok-4-6', { row: registry.models[0] }),
    proposeFor('mistral/mistral-large-4', 'mistral-large-4'),
  ];
  const applied = propose.applyProposals(registry, proposals);

  const grok = applied.models.find(m => m.model === 'x-ai/grok-4.6');
  assert.equal(grok.speed, 96.4);
  assert.equal(grok.gdpval, 61);
  assert.equal(grok.intRef, 54);

  const large = applied.models.find(m => m.model === 'mistral/mistral-large-4');
  assert.deepEqual(Object.keys(large), propose.REGISTRY_FIELDS);
  assert.equal(large.inputPrice, 2);
  assert.equal(large.cachePrice, null, 'AA null stays null');
  assert.ok(!('onClaudeMax' in large), 'coverage is not a registry column any more');

  assert.deepEqual(applied.changes.map(c => c.action), ['updated', 'created']);
  // The input registry is not mutated.
  assert.equal(registry.models.length, 1);
});

test('a model with no AA match never becomes an all-null registry row', () => {
  const proposal = proposeFor('mistral/devstral-latest', 'devstral', { snapshot: snapshotOf([previewPage()]) });
  assert.equal(proposal.match, null);
  assert.deepEqual(proposal.fills, []);
  const applied = propose.applyProposals({ models: [completeRow('x-ai/grok-4.5')] }, [proposal]);
  assert.equal(applied.models.length, 1);
  assert.deepEqual(applied.changes, [{ model: 'mistral/devstral-latest', action: 'skipped', fields: [] }]);
  assert.match(propose.renderProposal(proposal), /no AA row matched this model key/);
});

// --- targets and hints ---------------------------------------------------

test('default targets are the runnables that cannot score yet', () => {
  const runnables = {
    schemaVersion: 1,
    runnables: [
      { id: 'xai/grok-4.6', path: 'xai', modelKey: null, harness: 'pi' },
      { id: 'claude/claude-sonnet-5-5', path: 'claudemax', modelKey: null, harness: 'claude' },
      { id: 'mistral/mistral-large-4', path: 'mistral', modelKey: null, harness: 'pi' },
      { id: 'xai/grok-4.5', path: 'xai', modelKey: 'grok-4-5', harness: 'pi' },
      { id: 'openai-codex/gpt-5.6-luna', path: 'codex', modelKey: 'gpt-5-6-luna', harness: 'pi' },
      { id: 'openai-codex/gpt-5.2', path: 'codex', modelKey: 'gpt-5-2', harness: 'pi' },
    ],
  };
  const registry = {
    models: [
      completeRow('x-ai/grok-4.5'),
      completeRow('openai/gpt-5.6-luna'),
      { ...completeRow('openai/gpt-5.2'), gdpval: null, terminalBench: null, sciCode: null, aaLcr: null, hle: null, gpqa: null, critPt: null },
    ],
  };
  const targets = propose.defaultTargets({ runnables, registry, partitionMap: PARTITIONS });
  assert.deepEqual(targets.map(t => t.modelKey), ['grok-4-6', 'claude-sonnet-5-5', 'mistral-large-4', 'gpt-5-2']);
  assert.equal(targets.find(t => t.modelKey === 'mistral-large-4').model, 'mistral/mistral-large-4');
  assert.equal(targets.find(t => t.modelKey === 'gpt-5-2').model, 'openai/gpt-5.2');
});

test('explicit --models accepts registry names and keys, and rejects unknowns', () => {
  const runnables = { runnables: [{ id: 'xai/grok-4.6', path: 'xai', modelKey: null }] };
  const registry = { models: [completeRow('x-ai/grok-4.5')] };
  const targets = propose.explicitTargets(['x-ai/grok-4.5', 'grok-4-6'], { runnables, registry });
  assert.deepEqual(targets.map(t => t.modelKey), ['grok-4-5', 'grok-4-6']);
  assert.equal(targets[1].model, 'xai/grok-4.6');
  assert.throws(() => propose.explicitTargets(['nope-9'], { runnables, registry }), /unknown model "nope-9"/);
});

test('runnables.json hints appear even when the matched row needs no fills', () => {
  const row = {
    ...completeRow('x-ai/grok-4.6'),
    aaSlug: 'grok-4-6',
    intRef: 54,
    cachePrice: 0.2,
    inputPrice: 2,
    outputPrice: 5,
    speed: 96.4,
  };
  const proposal = propose.proposeOne({
    target: target('x-ai/grok-4.6', 'grok-4-6', row, { id: 'xai/grok-4.6', modelKey: null }),
    snapshot: snapshotOf(freePages()),
    partitionMap: PARTITIONS,
  });
  assert.deepEqual(proposal.fills, []);
  assert.deepEqual(propose.runnableUpdates([proposal]), [{ id: 'xai/grok-4.6', modelKey: 'grok-4-6' }]);

  // A rejected match is not a hint.
  const rejected = { ...proposal, rejected: 'provider mismatch' };
  assert.deepEqual(propose.runnableUpdates([rejected]), []);
  // A runnable that already has a modelKey needs no hint.
  const known = { ...proposal, runnableModelKey: 'grok-4-6' };
  assert.deepEqual(propose.runnableUpdates([known]), []);
});

// --- CLI ----------------------------------------------------------------

test('runPropose --write fills nulls in a registry file and points at the pipeline gate', () => {
  const dir = tempDir();
  const snapshotPath = path.join(dir, 'aa-snapshot.json');
  const registryPath = path.join(dir, 'benchmark-inputs.json');
  const runnablesPath = path.join(dir, 'runnables.json');

  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshotOf(freePages()), null, 2)}\n`);
  fs.writeFileSync(registryPath, `${JSON.stringify({ models: [{ ...completeRow('x-ai/grok-4.6'), speed: 96.4, gdpval: 61, intRef: null }] }, null, 2)}\n`);
  fs.writeFileSync(runnablesPath, `${JSON.stringify({
    schemaVersion: 1,
    runnables: [
      { id: 'xai/grok-4.6', path: 'xai', modelKey: null },
      { id: 'mistral/mistral-large-4', path: 'mistral', modelKey: null },
    ],
  }, null, 2)}\n`);

  const lines = [];
  const result = propose.runPropose({
    write: true,
    snapshotPath,
    registryPath,
    runnablesPath,
    log: line => lines.push(line),
  });

  const written = readJson(registryPath);
  const grok = written.models.find(m => m.model === 'x-ai/grok-4.6');
  assert.equal(grok.speed, 96.4, 'existing value untouched');
  assert.equal(grok.gdpval, 61, 'existing value untouched');
  assert.equal(grok.intRef, 54, 'null filled');
  assert.equal(grok.aaSlug, 'grok-4-6');
  assert.equal(written.models.length, 2, 'one new row appended');
  assert.equal(written.models[1].model, 'mistral/mistral-large-4', 'named from the AA creator and slug');
  assert.deepEqual(Object.keys(written.models[1]), propose.REGISTRY_FIELDS);

  const output = lines.join('\n');
  assert.match(output, /snapshot: .*aa-snapshot\.json \(tier free/);
  assert.match(output, /tier free: per-benchmark evaluations are unavailable/);
  assert.match(output, /npm run pipeline && npm run verify/);
  assert.match(output, /"id": "xai\/grok-4\.6", "modelKey": "grok-4-6"/);
  assert.deepEqual(result.updates, [
    { id: 'xai/grok-4.6', modelKey: 'grok-4-6' },
    { id: 'mistral/mistral-large-4', modelKey: 'mistral-large-4' },
  ]);
});

test('runPropose --write leaves the registry file alone when nothing is missing', () => {
  const dir = tempDir();
  const snapshotPath = path.join(dir, 'aa-snapshot.json');
  const registryPath = path.join(dir, 'benchmark-inputs.json');
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshotOf(freePages()), null, 2)}\n`);
  // Every AA-mapped field is already present, so the file must not be rewritten.
  const original = `${JSON.stringify({ models: [{ ...completeRow('x-ai/grok-4.6'), aaSlug: 'grok-4-6' }] }, null, 2)}\n`;
  fs.writeFileSync(registryPath, original);

  const lines = [];
  propose.runPropose({
    models: ['x-ai/grok-4.6'],
    write: true,
    snapshotPath,
    registryPath,
    runnablesPath: path.join(dir, 'missing-runnables.json'),
    log: line => lines.push(line),
  });
  assert.equal(fs.readFileSync(registryPath, 'utf8'), original);
  assert.match(lines.join('\n'), /registry unchanged: every proposed value was already present/);
  assert.doesNotMatch(lines.join('\n'), /npm run pipeline/);
});

test('runPropose without a snapshot explains aa-sync', () => {
  assert.throws(
    () => propose.runPropose({ snapshotPath: path.join(tempDir(), 'none.json'), log: () => {} }),
    /npm run aa-sync/,
  );
});

test('--json emits proposals with the snapshot provenance and tier', () => {
  const dir = tempDir();
  const snapshotPath = path.join(dir, 'aa-snapshot.json');
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshotOf(freePages()), null, 2)}\n`);
  // The registry is personal data (AGENTQ_HOME), so name a fixture explicitly.
  const registryPath = path.join(dir, 'benchmark-inputs.json');
  fs.writeFileSync(registryPath, `${JSON.stringify({ models: [{ model: 'grok-4-6' }] }, null, 2)}\n`);
  const printed = [];
  propose.runPropose({
    models: ['grok-4-6'],
    json: true,
    snapshotPath,
    registryPath,
    log: line => printed.push(line),
  });
  const parsed = JSON.parse(printed.join('\n'));
  assert.equal(parsed.snapshot.tier, 'free');
  assert.equal(parsed.snapshot.path, snapshotPath);
  assert.equal(parsed.snapshot.intelligenceIndexVersion, 4.1);
  assert.equal(parsed.includeBenchmarks, false);
  assert.equal(parsed.proposals.length, 1);
  assert.equal(parsed.proposals[0].modelKey, 'grok-4-6');
  assert.equal(parsed.written, null);
});

test('the Pro snapshot is preferred when both exist', () => {
  const dir = tempDir();
  const free = path.join(dir, 'aa-snapshot.json');
  const pro = path.join(dir, 'aa-snapshot-pro.json');
  fs.writeFileSync(free, '{}');
  assert.equal(propose.resolveSnapshotPath(null, { free, pro }), free);
  fs.writeFileSync(pro, '{}');
  assert.equal(propose.resolveSnapshotPath(null, { free, pro }), pro);
  assert.equal(propose.resolveSnapshotPath('/tmp/explicit.json', { free, pro }), '/tmp/explicit.json');
});

test('parseArgs rejects unknown flags and parses the new options', () => {
  assert.deepEqual(propose.parseArgs(['--json', '--write']), {
    models: null, json: true, write: true, includeBenchmarks: false, confirmMatch: [], snapshot: null, help: false,
    prices: false, driftK: 2, confirmPrice: [],
  });
  assert.deepEqual(propose.parseArgs(['--models', 'a, b']).models, ['a', 'b']);
  assert.equal(propose.parseArgs(['--include-benchmarks']).includeBenchmarks, true);
  assert.deepEqual(propose.parseArgs(['--confirm-match', 'a,b', '--confirm-match', 'c']).confirmMatch, ['a', 'b', 'c']);
  assert.equal(propose.parseArgs(['--snapshot', 'tmp/s.json']).snapshot, path.resolve('tmp/s.json'));
  assert.throws(() => propose.parseArgs(['--models']), /needs a comma-separated list/);
  assert.throws(() => propose.parseArgs(['--models', ' , ']), /at least one/);
  assert.throws(() => propose.parseArgs(['--confirm-match']), /needs a model key/);
  assert.throws(() => propose.parseArgs(['--snapshot']), /needs a path/);
  assert.throws(() => propose.parseArgs(['--nope']), /unknown argument/);

  const prices = propose.parseArgs(['--prices', '--drift-k', '3']);
  assert.equal(prices.prices, true);
  assert.equal(prices.driftK, 3);
  assert.deepEqual(propose.parseArgs(['--prices', '--confirm-price', 'a,b']).confirmPrice, ['a', 'b']);
  assert.throws(() => propose.parseArgs(['--prices', '--write']), /needs --confirm-price/);
  assert.throws(() => propose.parseArgs(['--prices', '--drift-k', '1']), /greater than 1/);
  assert.throws(() => propose.parseArgs(['--prices', '--drift-k', 'nope']), /greater than 1/);
  assert.throws(() => propose.parseArgs(['--prices', '--models', 'a']), /--models is not supported with --prices/);
  assert.throws(() => propose.parseArgs(['--prices', '--confirm-match', 'a']), /--confirm-match is not supported/);
  assert.throws(() => propose.parseArgs(['--confirm-price', 'a']), /only valid with --prices/);
  assert.throws(() => propose.parseArgs(['--drift-k', '3']), /only valid with --prices/);
});

test('the rendered report names fills, refusals, warnings and the missing partition', () => {
  const proposal = proposeFor('anthropic/claude-opus-5-5', 'claude-opus-5-5', {
    snapshot: snapshotOf([proPage()]),
    includeBenchmarks: true,
  });
  const report = propose.renderProposal(proposal);
  assert.match(report, /new row anthropic\/claude-opus-5-5/);
  assert.match(report, /fill:\s+aaSlug="claude-opus-5-5"/);
  assert.match(report, /UNVERIFIED mapping: hle ← evaluations\.hle \(x100\)/);
  assert.match(report, /refuse: gdpval \(AA 57\.9\)/);
  assert.match(report, /scoring: incomplete — missing agents/);
});
