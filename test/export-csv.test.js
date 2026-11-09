'use strict';
/**
 * Unit tests for export-csv.js and the ccusage-adapter parse helper it uses.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');

const { parseCcusageJson } = require('../src/roi-tracker/ccusage-adapter.js');
const { aggregateRecords } = require('../src/roi-tracker/collect/usage.js');
const { classifyFromRecords, typeToClass, attributePath, summarizeAttribution, csvLine, readDailySources } = require('../src/roi-tracker/export-csv.js');

test('parseCcusageJson reads daily model breakdowns with cacheCreationTokens', () => {
  const json = {
    daily: [{
      date: '20260628',
      metadata: { agents: ['pi'] },
      modelBreakdowns: [
        { modelName: 'claude-opus-4-8', inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 1, cost: 2.5 },
      ],
    }],
  };
  const recs = parseCcusageJson(json);
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0], {
    date: '20260628', model: 'claude-opus-4-8', agent: 'pi',
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 1, cost: 2.5,
  });
});

test('parseCcusageJson ignores synthetic unknown rollups', () => {
  const recs = parseCcusageJson({
    daily: [{ date: '20260628', modelBreakdowns: [{ modelName: 'unknown' }] }],
  });
  assert.equal(recs.length, 0);
});

test('classifier uses actual agent records before falling back to bestPath', () => {
  const config = {
    paths: [{ id: 'openrouter', name: 'OpenRouter', type: 'Metered' }],
    agentPathMap: { pi: 'openrouter' },
  };
  assert.equal(typeToClass('Metered'), 'metered');
  // Records win over bestPath.
  assert.equal(classifyFromRecords(config, [{ agent: 'pi' }], '', { Local: 'local' }), 'metered');
  // Falls back to bestPath label when no records.
  assert.equal(classifyFromRecords(config, [], 'OpenRouter', { OpenRouter: 'openrouter' }), 'metered');
  // Unknown when nothing matches.
  assert.equal(classifyFromRecords(config, [], '', {}), 'unknown');
});

test('attributePath prefers model/provider clues before agent fallback', () => {
  const config = {
    paths: [
      { id: 'openrouter', name: 'OpenRouter', type: 'Metered' },
      { id: 'firepass', name: 'Firepass', type: 'Wallet' },
      { id: 'umans', name: 'Umans', type: 'Wallet' },
    ],
    providerPathMap: { fireworks: 'firepass', umans: 'umans', 'cline-pass': 'openrouter' },
    agentPathMap: { pi: 'openrouter' },
    modelPathPatterns: { kilo: [{ match: 'accounts/fireworks/', path: 'firepass' }] },
  };

  assert.deepEqual(attributePath(config, '[pi] accounts/fireworks/routers/kimi-k2p6-turbo', 'pi'), {
    pathId: 'firepass',
    source: 'model-pattern:any:accounts/fireworks/',
  });
  assert.deepEqual(attributePath(config, '[pi] umans-glm-5.2', 'pi'), {
    pathId: 'umans',
    source: 'provider:umans',
  });
  assert.deepEqual(attributePath(config, '[pi] cline-pass/deepseek-v4-flash', 'pi'), {
    pathId: 'openrouter',
    source: 'provider:cline-pass',
  });
});

test('summarizeAttribution reports mixed path token breakdowns', () => {
  const config = {
    paths: [
      { id: 'openrouter', name: 'OpenRouter', type: 'Metered' },
      { id: 'firepass', name: 'Firepass', type: 'Wallet' },
    ],
    providerPathMap: { fireworks: 'firepass' },
    agentPathMap: { pi: 'openrouter' },
    modelPathPatterns: {},
  };
  const summary = summarizeAttribution(config, [
    { model: '[pi] accounts/fireworks/routers/kimi-k2p6-turbo', agent: 'pi', inputTokens: 10 },
    { model: '[pi] deepseek-v4-flash', agent: 'pi', inputTokens: 5, cacheReadTokens: 5 },
  ], 'kimi-k2p6');
  assert.equal(summary.pathId, 'mixed');
  assert.equal(summary.pathName, 'Mixed');
  assert.equal(summary.breakdown, 'firepass:10;openrouter:10');
});

test('aggregateRecords keeps token-type breakdowns', () => {
  const { models, total } = aggregateRecords([
    { date: '20260628', model: 'anthropic/claude-opus-4-8', inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 1, cost: 2 },
    { date: '20260629', model: 'anthropic/claude-opus-4-8', inputTokens: 20, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 1 },
  ]);
  assert.equal(total, 3);
  const k = models['claude-opus-4-8'];
  assert.equal(k.tokens, 136);
  assert.equal(k.inputTokens, 30);
  assert.equal(k.outputTokens, 5);
  assert.equal(k.cacheReadTokens, 100);
  assert.equal(k.cacheWriteTokens, 1);
  assert.equal(k.days, 2);
});

test('csvLine neutralizes formula-leading values so unquoting cannot execute them', () => {
  for (const dangerous of ['=SUM(A1:A2)', '+1+1', '-1+1', '@SUM(A1)']) {
    const line = csvLine([dangerous, 'safe']);
    const [first] = line.split(',');
    const unquoted = first.startsWith('"') ? first.slice(1, -1).replace(/""/g, '"') : first;
    assert.ok(!/^[=+\-@]/.test(unquoted), `"${unquoted}" still starts with a formula trigger`);
    assert.ok(unquoted.startsWith(`'${dangerous}`), `expected a leading-quote prefix, got "${unquoted}"`);
  }
});

test('csvLine still quotes fields containing commas/quotes/newlines', () => {
  assert.equal(csvLine(['a,b']), '"a,b"');
  assert.equal(csvLine(['say "hi"']), '"say ""hi"""');
  assert.equal(csvLine(['plain']), 'plain');
  assert.equal(csvLine([null]), '');
});

test('readDailySources does not duplicate covered Claude provider rows in pathRows', () => {
  const dir = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'csv-imports-'));
  try {
    fs.writeFileSync(require('node:path').join(dir, 'host.json'), JSON.stringify({
      usageRecords: [
        { date: '2026-06-28', model: 'claude-opus-5', agent: 'claude', cost: 12, inputTokens: 10 },
        // Provider covers only part of this model/date, so usage wins.
        { date: '2026-06-28', model: 'gpt-5.5', agent: 'claude', cost: 10, inputTokens: 100 },
        // This low-cost stub must not be added alongside its provider row.
        { date: '2026-06-29', model: 'claude-sonnet-5', agent: 'claude', cost: 0, inputTokens: 1 },
      ],
      providerUsageRecords: [
        { date: '2026-06-28', model: 'claude-opus-5', provider: 'claude', pathId: 'claudemax', cost: 8, inputTokens: 10 },
        { date: '2026-06-28', model: 'gpt-5.5', provider: 'openai-codex', pathId: 'codex', cost: 5, inputTokens: 50 },
        { date: '2026-06-29', model: 'claude-sonnet-5', provider: 'claude', pathId: 'claudemax', cost: 4, inputTokens: 100 },
        // Aggregate-only row is suppressed because this model has dated data.
        { date: null, model: 'claude-opus-5', provider: 'claude', pathId: 'claudemax', cost: 8, inputTokens: 10 },
        // Aggregate-only model remains available as a fallback path row.
        { date: null, model: 'claude-opus-4-8', provider: 'claude', pathId: 'claudemax', cost: 7, inputTokens: 20 },
      ],
    }));
    const config = {
      paths: [{ id: 'claudemax', name: 'Claude Max', type: 'Wallet' }],
      providerPathMap: { claude: 'claudemax' },
      agentPathMap: { claude: 'claudemax' },
      modelPathPatterns: {},
    };
    const out = readDailySources([], config, dir);
    assert.equal(out.pathRows.length, 4);
    // Full provider coverage wins for opus-5; partial coverage leaves the
    // ccusage row; the stub is replaced by provider; aggregate-only opus-4-8
    // remains as a fallback row.
    assert.deepEqual(out.pathRows.map(r => [r.model, r.cost, r.provider]).sort(), [
      ['claude-opus-4-8', 7, 'claude'],
      ['claude-opus-5', 8, 'claude'],
      ['claude-sonnet-5', 4, 'claude'],
      ['gpt-5.5', 10, ''],
    ]);
    assert.deepEqual(out.rows.map(r => [r.model, r.cost]).sort(), [
      ['claude-opus-5', 8],
      ['claude-sonnet-5', 4],
      ['gpt-5.5', 10],
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
