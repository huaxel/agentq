'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  collectTokscaleValueRun,
  collectTokscaleGraphValueRun,
  routeRecords,
  providerRecordsFrom,
  pathIdForRecord,
  repriceZeroCost,
} = require('../src/roi-tracker/collect/value-run-tokscale.js');

const config = {
  providerPathMap: {
    codex: 'codex',
    opencodego: 'go',
    opencode: 'go',
    fireworks: 'firepass',
    umans: 'umans',
    openrouter: 'openrouter',
    google: 'openrouter',
    nan: 'nan',
  },
  agentPathMap: {
    claude: 'claudemax',
    codex: 'codex',
    opencode: 'go',
    pi: 'openrouter',
    gemini: 'openrouter',
    'antigravity-cli': 'antigravity',
    cursor: 'cursor',
  },
};

// Adapter-normalized records (tokscale-adapter parseTokscaleJson shape).
const records = [
  { client: 'pi', provider: 'openai-codex', model: 'gpt-5.5', cost: 10, inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 0 },
  { client: 'pi', provider: 'umans', model: 'umans-kimi-k2.7', cost: 5, inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  { client: 'claude', provider: 'anthropic', model: 'claude-fable-5', cost: 20, inputTokens: 200, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
  { client: 'codex', provider: 'openai-codex', model: 'gpt-5.3-codex', cost: 7, inputTokens: 70, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
  { client: 'gemini', provider: 'google', model: 'gemini-3.5-flash', cost: 3, inputTokens: 30, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  { client: 'someclient', provider: 'nowhere', model: 'x', cost: 1, inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
];

// Same records but a Fireworks router key with ZERO cost — tokscale has no
// pricing for it (the kimi-k2p6 hole we patch with priceOverrides).
const configWithOverrides = {
  ...config,
  priceOverrides: {
    'accounts/fireworks/routers/kimi-k2p6-turbo': { input: 2.0, output: 8.0, cache: 0.3 },
  },
};
const zeroCostKimi = { client: 'pi', provider: 'fireworks', model: 'accounts/fireworks/routers/kimi-k2p6-turbo', cost: 0, inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 };


test('pathIdForRecord routes provider aliases, direct providers, joined lists, and client fallback', () => {
  // pi session via openai-codex aliases to the codex path (scanner semantics)
  assert.equal(pathIdForRecord({ client: 'pi', provider: 'openai-codex' }, config), 'codex');
  assert.equal(pathIdForRecord({ client: 'pi', provider: 'umans' }, config), 'umans');
  assert.equal(pathIdForRecord({ client: 'pi', provider: 'opencode-go' }, config), 'go');
  // joined provider list uses the first known provider
  assert.equal(pathIdForRecord({ client: 'pi', provider: 'github-copilot, openai-codex, vibeproxy' }, config), 'codex');
  // provider unknown → client fallback
  assert.equal(pathIdForRecord({ client: 'claude', provider: 'anthropic' }, config), 'claudemax');
  assert.equal(pathIdForRecord({ client: 'pi', provider: 'helmcode' }, config), 'openrouter');
  // nothing known → null
  assert.equal(pathIdForRecord({ client: 'someclient', provider: 'nowhere' }, config), null);
});

test('pathIdForRecord gives clientPrecedence clients their agent path over provider routing', () => {
  // antigravity-cli sessions use gemini via 'google' — providerPathMap.google
  // says openrouter, but the agy CLI belongs to the antigravity path (matches
  // antigravity-scanner's hardcoded pathId). Client precedence wins.
  const cfg = { ...config, clientPrecedence: ['antigravity-cli'] };
  assert.equal(pathIdForRecord({ client: 'antigravity-cli', provider: 'google' }, cfg), 'antigravity');
  assert.equal(pathIdForRecord({ client: 'antigravity-cli', provider: 'anthropic' }, cfg), 'antigravity');
  // other clients unaffected
  assert.equal(pathIdForRecord({ client: 'gemini', provider: 'google' }, cfg), 'openrouter');
});

test('pathIdForRecord routes cursor client to the cursor path', () => {
  assert.equal(pathIdForRecord({ client: 'cursor', provider: 'cursor' }, config), 'cursor');
  // unknown provider on cursor client → agentPathMap fallback
  assert.equal(pathIdForRecord({ client: 'cursor', provider: 'desktop-app' }, config), 'cursor');
});

test('routeRecords splits provider-attributed records into per-path and per-agent totals', () => {
  const { perAgent, perPath, unmapped, totalCost } = routeRecords(records, config);
  assert.deepEqual(perPath, { codex: 17, umans: 5, claudemax: 20, openrouter: 3 });
  assert.deepEqual(perAgent, { pi: 15, claude: 20, codex: 7, gemini: 3, someclient: 1 });
  assert.equal(totalCost, 46);
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].model, 'x');
});

test('providerRecordsFrom emits date-less records with pathId and token totals', () => {
  const prs = providerRecordsFrom(records, config);
  assert.equal(prs.length, records.length);
  assert.equal(prs[0].pathId, 'codex');
  assert.equal(prs[0].date, null); // tokscale JSON has no per-day dates
  assert.equal(prs[0].tokens, 170); // 100+20+50
  assert.equal(prs[2].pathId, 'claudemax');
  assert.equal(prs[5].pathId, null); // unmapped stays null
});

test('collectTokscaleValueRun returns routed totals from an injected adapter', async () => {
  const stub = async () => ({ available: true, records });
  const result = await collectTokscaleValueRun('20260501', config, { adapter: stub });
  assert.equal(result.source, 'tokscale');
  assert.equal(result.concurrency, 1);
  assert.deepEqual(result.perPath, { codex: 17, umans: 5, claudemax: 20, openrouter: 3 });
  assert.equal(result.totalCost, 46);
  assert.equal(result.providerRecords.length, records.length);
  assert.ok(result.timings.tokscale >= 0);
  // unmapped record surfaced as an error, not silently dropped
  assert.ok(result.errors.some(e => /unmapped/.test(e)));
  // per-model aggregate from the same scan — single source for usageByModel
  // in tokscale-mode machine bundles (keyed by modelKey, shaped like usage.js).
  assert.ok(result.models, 'collectTokscaleValueRun should return a models aggregate');
  assert.equal(result.models['gpt-5-5'].cost, 10);
  assert.equal(result.models['umans-kimi-k2-7'].cost, 5);
  assert.equal(result.models['claude-fable-5'].cost, 20);
  assert.equal(result.models['claude-fable-5'].tokens, 250); // 200+50
  // models aggregate cost equals totalCost
  const modelTotal = Object.values(result.models).reduce((s, m) => s + m.cost, 0);
  assert.equal(Math.round(modelTotal * 100) / 100, result.totalCost);
});

test('collectTokscaleValueRun reports unavailable tokscale without throwing', async () => {
  const fail = async () => ({ available: false, records: [], error: 'tokscale not available' });
  const result = await collectTokscaleValueRun('20260501', config, { adapter: fail });
  assert.equal(result.totalCost, 0);
  assert.deepEqual(result.perPath, {});
  assert.deepEqual(result.models, {});
  assert.ok(result.errors.includes('tokscale: tokscale not available'));
});

test('collectTokscaleGraphValueRun routes dated per-day records into dated providerRecords', async () => {
  const graphRecords = records.map((r, i) => ({ ...r, date: `2026-05-${String(i + 1).padStart(2, '0')}` }));
  const stub = async () => ({ available: true, records: graphRecords });
  const result = await collectTokscaleGraphValueRun('20260501', config, { adapter: stub });
  assert.equal(result.source, 'tokscale-graph');
  assert.equal(result.concurrency, 1);
  assert.deepEqual(result.perPath, { codex: 17, umans: 5, claudemax: 20, openrouter: 3 });
  assert.equal(result.totalCost, 46);
  // DATED providerRecords (feeds Strategy A + usageRecords), each with a pathId.
  assert.equal(result.providerRecords.length, records.length);
  assert.equal(result.providerRecords[0].date, '2026-05-01');
  assert.equal(result.providerRecords[0].origin, 'tokscale');
  assert.equal(result.providerRecords[0].pathId, 'codex');
  // models aggregate still present (shaped like usage.js, with days count).
  assert.equal(result.models['gpt-5-5'].cost, 10);
});

test('collectTokscaleGraphValueRun reports unavailable without throwing', async () => {
  const fail = async () => ({ available: false, records: [], error: 'graph not available' });
  const result = await collectTokscaleGraphValueRun('20260501', config, { adapter: fail });
  assert.equal(result.totalCost, 0);
  assert.deepEqual(result.models, {});
  assert.ok(result.errors.some(e => /tokscale-graph/.test(e)));
});

test('providerRecordsFrom emits origin=tokscale and preserves date when present', () => {
  const prs = providerRecordsFrom([{ ...records[0], date: '2026-05-09' }], config);
  assert.equal(prs[0].date, '2026-05-09');
  assert.equal(prs[0].origin, 'tokscale');
  const undated = providerRecordsFrom([records[0]], config);
  assert.equal(undated[0].date, null);
  assert.equal(undated[0].origin, 'tokscale');
});

test('repriceZeroCost fills cost for zero-cost records with a priceOverride', () => {
  // kimi router: 1M in * $2 + 0.5M out * $8 + 2M cache * $0.3 per Mtok = 2 + 4 + 0.6 = $6.6
  const [priced] = repriceZeroCost([zeroCostKimi], configWithOverrides);
  assert.equal(priced.cost, 6.6);
  // non-zero records are untouched
  const same = repriceZeroCost([records[0]], configWithOverrides);
  assert.equal(same[0].cost, 10);
  // zero-cost WITHOUT a matching override stays zero (can't price it)
  const unknown = { ...zeroCostKimi, model: 'no-override-model', cost: 0 };
  assert.equal(repriceZeroCost([unknown], configWithOverrides)[0].cost, 0);
});

test('collectTokscaleValueRun reprices zero-cost records so valueRun reflects config pricing', async () => {
  // aggregate adapter returns records incl the zero-cost kimi router
  const withKimi = [...records, zeroCostKimi];
  const stub = async () => ({ available: true, records: withKimi });
  const result = await collectTokscaleValueRun('20260501', configWithOverrides, { adapter: stub });
  // kimi (provider fireworks) routes to firepass path with the repriced $6.6
  assert.equal(result.perPath.firepass, 6.6);
  assert.equal(result.totalCost, 46 + 6.6);
  // model aggregate reflects it too
  assert.equal(result.models['kimi-k2-6'].cost, 6.6);
});

test('collectTokscaleGraphValueRun reprices zero-cost records in dated mode', async () => {
  const withKimi = [{ ...zeroCostKimi, date: '2026-05-09' }];
  const stub = async () => ({ available: true, records: withKimi });
  const result = await collectTokscaleGraphValueRun('20260501', configWithOverrides, { adapter: stub });
  assert.equal(result.providerRecords[0].cost, 6.6);
  assert.equal(result.providerRecords[0].date, '2026-05-09');
  assert.equal(result.perPath.firepass, 6.6);
});
