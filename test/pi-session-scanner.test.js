'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanPiSessions, defaultSessionDirs, aggregate } = require('../src/lib/pi-session-scanner.js');

function assistantLine(date, provider = 'umans', cost = 1) {
  return JSON.stringify({
    type: 'message',
    timestamp: `${date}T12:00:00.000Z`,
    message: {
      role: 'assistant',
      provider,
      model: 'test-model',
      usage: { cost: { total: cost }, input: 1, output: 2, totalTokens: 3 },
    },
  }) + '\n';
}

test('scanPiSessions dedupes the same session dir listed twice', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sessions-dedup-'));
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, assistantLine('2026-06-28', 'umans', 3));
  fs.utimesSync(file, new Date('2026-06-28T12:00:00Z'), new Date('2026-06-28T12:00:00Z'));

  const result = scanPiSessions('20260628', { umans: 'umans' }, { sessionDirs: [dir, dir] });

  assert.equal(result.totalEntries, 1);
  assert.deepEqual(result.perPath, { umans: 3 });
});

test('scanPiSessions dedupes the SAME session id across different stores (SSoT + subset copy)', () => {
  // Two separate dirs (different inodes — not caught by directory-level dedup)
  // that both contain a copy of the SAME session file, mirroring the
  // dotfiles/pi SSoT + ~/.pi subset-copy situation. The identical session must
  // be counted once, not twice.
  const ssot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ssot-'));
  const subset = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subset-'));
  const shared = 'session-2026-06-28.jsonl';
  fs.writeFileSync(path.join(ssot, shared), assistantLine('2026-06-28', 'umans', 3));
  fs.writeFileSync(path.join(subset, shared), assistantLine('2026-06-28', 'umans', 3));
  // a distinct session only in the subset store
  fs.writeFileSync(path.join(subset, 'only-in-subset.jsonl'), assistantLine('2026-06-28', 'opencode-go', 4));
  for (const d of [ssot, subset]) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      fs.utimesSync(p, new Date('2026-06-28T12:00:00Z'), new Date('2026-06-28T12:00:00Z'));
    }
  }

  // SSoT store listed first, so its copy of the shared session wins.
  const result = scanPiSessions('20260628', { umans: 'umans', opencodego: 'go' }, { sessionDirs: [ssot, subset] });

  // shared session counted ONCE (3) + distinct subset session (4) = 2 sessions.
  assert.equal(result.totalEntries, 2);
  assert.deepEqual(result.perPath, { umans: 3, go: 4 });
  assert.equal(result.providerRecords.length, 2);
});

test('scanPiSessions keeps distinct intrinsic sessions sharing a filename', () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-first-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-second-'));
  const header = id => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-06-28T12:00:00.000Z' }) + '\n';
  const file = 'same-name.jsonl';
  fs.writeFileSync(path.join(first, file), header('session-one') + assistantLine('2026-06-28', 'umans', 3));
  fs.writeFileSync(path.join(second, file), header('session-two') + assistantLine('2026-06-28', 'umans', 4));
  for (const dir of [first, second]) fs.utimesSync(path.join(dir, file), new Date('2026-06-28T12:00:00Z'), new Date('2026-06-28T12:00:00Z'));
  const result = scanPiSessions('20260628', { umans: 'umans' }, { sessionDirs: [first, second] });
  assert.equal(result.totalEntries, 2);
  assert.deepEqual(result.perPath, { umans: 7 });
});

test('scanPiSessions dedupes duplicate intrinsic sessions within one store', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-session-internal-'));
  const header = JSON.stringify({ type: 'session', version: 3, id: 'same-session', timestamp: '2026-06-28T12:00:00.000Z' }) + '\n';
  fs.writeFileSync(path.join(dir, 'first.jsonl'), header + assistantLine('2026-06-28', 'umans', 3));
  fs.writeFileSync(path.join(dir, 'copy.jsonl'), header + assistantLine('2026-06-28', 'umans', 3));
  for (const file of ['first.jsonl', 'copy.jsonl']) fs.utimesSync(path.join(dir, file), new Date('2026-06-28T12:00:00Z'), new Date('2026-06-28T12:00:00Z'));
  const result = scanPiSessions('20260628', { umans: 'umans' }, { sessionDirs: [dir] });
  assert.equal(result.totalEntries, 1);
  assert.deepEqual(result.perPath, { umans: 3 });
});

test('scanPiSessions unions multiple session dirs into one attribution', () => {  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sessions-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sessions-b-'));
  fs.writeFileSync(path.join(dirA, 'a.jsonl'), assistantLine('2026-06-28', 'umans', 3));
  fs.writeFileSync(path.join(dirB, 'b.jsonl'), assistantLine('2026-06-28', 'opencode-go', 4));
  fs.utimesSync(path.join(dirA, 'a.jsonl'), new Date('2026-06-28T12:00:00Z'), new Date('2026-06-28T12:00:00Z'));
  fs.utimesSync(path.join(dirB, 'b.jsonl'), new Date('2026-06-28T12:00:00Z'), new Date('2026-06-28T12:00:00Z'));

  const result = scanPiSessions('20260628', { umans: 'umans', opencodego: 'go' }, { sessionDirs: [dirA, dirB] });

  assert.equal(result.totalEntries, 2);
  assert.deepEqual(result.perPath, { umans: 3, go: 4 });
  assert.equal(result.providerRecords.length, 2);
});

test('defaultSessionDirs honors PI_CODING_AGENT_DIR and always includes ~/.pi and ~/.omp', () => {
  const prev = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = '/tmp/custom-pi';
    const dirs = defaultSessionDirs();
    assert.ok(dirs.includes('/tmp/custom-pi/sessions'));
    assert.ok(dirs.includes(path.join(os.homedir(), '.pi', 'agent', 'sessions')));
    assert.ok(dirs.includes(path.join(os.homedir(), '.omp', 'agent', 'sessions')));
    // no duplicates
    assert.equal(new Set(dirs).size, dirs.length);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
  }
});

test('scanPiSessions prunes jsonl files older than since before parsing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sessions-'));
  const oldFile = path.join(dir, 'old.jsonl');
  const newFile = path.join(dir, 'new.jsonl');

  fs.writeFileSync(oldFile, assistantLine('2026-05-01', 'umans', 99));
  fs.writeFileSync(newFile, assistantLine('2026-06-28', 'umans', 2));

  fs.utimesSync(oldFile, new Date('2026-05-01T00:00:00Z'), new Date('2026-05-01T00:00:00Z'));
  fs.utimesSync(newFile, new Date('2026-06-28T12:00:00Z'), new Date('2026-06-28T12:00:00Z'));

  const result = scanPiSessions('20260628', { umans: 'umans' }, { sessionDir: dir });

  assert.equal(result.totalEntries, 1);
  assert.deepEqual(result.perPath, { umans: 2 });
});

test('scanPiSessions emits provider-aware usage records', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sessions-'));
  const file = path.join(dir, 'usage.jsonl');

  fs.writeFileSync(file, assistantLine('2026-06-28', 'opencode-go', 4));
  fs.utimesSync(file, new Date('2026-06-28T12:00:00Z'), new Date('2026-06-28T12:00:00Z'));

  const result = scanPiSessions('20260628', { opencodego: 'go' }, { sessionDir: dir });

  assert.equal(result.providerRecords.length, 1);
  assert.deepEqual(result.providerRecords[0], {
    date: '2026-06-28',
    model: 'test-model',
    provider: 'opencode-go',
    normalizedProvider: 'opencodego',
    pathId: 'go',
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    tokens: 3,
    cost: 4,
  });
});

test('scanPiSessions keeps files within the pruning safety window', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sessions-'));
  const boundaryFile = path.join(dir, 'boundary.jsonl');

  fs.writeFileSync(boundaryFile, assistantLine('2026-06-28', 'umans', 3));
  fs.utimesSync(boundaryFile, new Date('2026-06-27T23:30:00Z'), new Date('2026-06-27T23:30:00Z'));

  const result = scanPiSessions('20260628', { umans: 'umans' }, { sessionDir: dir });

  assert.equal(result.totalEntries, 1);
  assert.deepEqual(result.perPath, { umans: 3 });
});

test('aggregate never NaN-poisons sums on sparse entries', () => {
  // Hand-built or schema-drifted entries may lack cost/totalTokens. The
  // shared aggregator must treat them as 0, not propagate NaN (which
  // serializes to null and corrupts spend totals).
  const out = aggregate([
    { date: '2026-09-01', provider: 'codex', originalProvider: 'openai-codex', model: 'gpt-5.6', cost: 1.5, inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { date: '2026-09-01', provider: 'codex', originalProvider: 'openai-codex', model: 'gpt-5.6', cost: undefined, inputTokens: 10, outputTokens: 5 },
  ], { codex: 'codex' });
  assert.deepEqual(out.perPath, { codex: 1.5 });
  assert.equal(out.perProvider['openai-codex'].total, 1.5);
  assert.equal(out.perProvider['openai-codex'].totalTokens, 165); // parts-sum fallback, agreeing with providerRecords
  for (const v of [...Object.values(out.perPath), ...Object.values(out.perModel)]) {
    assert.ok(Number.isFinite(v), `non-finite aggregate value: ${v}`);
  }
});

test('scanPiSessions routes a self-hosted provider to the local path via providerPathMap', () => {
  // No hard-coded host names: any provider whose providerPathMap value is
  // 'local' must land on the local path, with the raw provider name kept for
  // attribution. 'homelab-llm' is invented — the mapping is config-driven.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-local-'));
  const file = path.join(dir, 'local.jsonl');
  fs.writeFileSync(file, assistantLine('2026-06-28', 'homelab-llm', 2.5));
  fs.utimesSync(file, new Date('2026-06-28T12:00:00Z'), new Date('2026-06-28T12:00:00Z'));

  const result = scanPiSessions('20260628', { 'homelab-llm': 'local' }, { sessionDirs: [dir] });

  assert.deepEqual(result.perPath, { local: 2.5 });
  assert.equal(result.providerRecords.length, 1);
  assert.equal(result.providerRecords[0].provider, 'homelab-llm');
  assert.equal(result.providerRecords[0].pathId, 'local');
});
