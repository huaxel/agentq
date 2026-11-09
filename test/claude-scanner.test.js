'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseClaudeTranscript, walkClaudeTranscripts, scanClaudeSessions } = require('../src/lib/claude-scanner.js');

// Claude Code transcript line (assistant turn with usage, no cost logged).
function assistantTurn(model, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0, date = '2026-06-28', requestId = null, messageId = null } = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: `${date}T12:00:00Z`,
    ...(requestId ? { requestId } : {}),
    message: {
      role: 'assistant',
      model,
      ...(messageId ? { id: messageId } : {}),
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      },
    },
  });
}

function makeTranscriptDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-scan-'));
  const proj = path.join(dir, 'proj-a');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(path.join(proj, 'subagents'), { recursive: true });
  return { dir, proj };
}

test('parseClaudeTranscript extracts model/date/tokens with no cost', () => {
  const { proj } = makeTranscriptDir();
  const f = path.join(proj, 's.jsonl');
  fs.writeFileSync(f, assistantTurn('claude-opus-5', { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 100 }) + '\n');
  const entries = parseClaudeTranscript(f, '20260501');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].provider, 'claude');
  assert.equal(entries[0].model, 'claude-opus-5');
  assert.equal(entries[0].date, '2026-06-28');
  assert.equal(entries[0].cost, 0); // transcripts don't log cost
  assert.equal(entries[0].inputTokens, 1000);
  assert.equal(entries[0].outputTokens, 500);
  assert.equal(entries[0].cacheReadTokens, 2000);
  assert.equal(entries[0].cacheWriteTokens, 100);
});

test('parseClaudeTranscript dedupes adjacent identical usage rows', () => {
  const { proj } = makeTranscriptDir();
  const f = path.join(proj, 's.jsonl');
  // Claude Code writes the same API turn twice with the same request/message IDs.
  const duplicate = assistantTurn('claude-opus-5', { input: 10, output: 5, cacheRead: 100, requestId: 'req-1', messageId: 'msg-1' });
  const distinct = assistantTurn('claude-opus-5', { input: 10, output: 5, cacheRead: 100, requestId: 'req-2', messageId: 'msg-2' });
  fs.writeFileSync(f, duplicate + '\n' + duplicate + '\n' + distinct + '\n');
  const entries = parseClaudeTranscript(f, '20260501');
  assert.equal(entries.length, 2);
});

test('parseClaudeTranscript keeps distinct equal-token turns', () => {
  const { proj } = makeTranscriptDir();
  const f = path.join(proj, 's.jsonl');
  fs.writeFileSync(f,
    assistantTurn('claude-opus-5', { input: 10, output: 5, cacheRead: 100, requestId: 'req-a', messageId: 'msg-a' }) + '\n' +
    assistantTurn('claude-opus-5', { input: 10, output: 5, cacheRead: 100, requestId: 'req-b', messageId: 'msg-b' }) + '\n');
  assert.equal(parseClaudeTranscript(f, '20260501').length, 2);
});

test('parseClaudeTranscript keeps an in-range turn after an out-of-range equal-token turn', () => {
  const { proj } = makeTranscriptDir();
  const f = path.join(proj, 's.jsonl');
  fs.writeFileSync(f,
    assistantTurn('claude-opus-5', { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, date: '2026-04-30', requestId: 'req-old', messageId: 'msg-old' }) + '\n' +
    assistantTurn('claude-opus-5', { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, date: '2026-05-01', requestId: 'req-new', messageId: 'msg-new' }) + '\n');
  assert.equal(parseClaudeTranscript(f, '20260501').length, 1);
});

test('walkClaudeTranscripts includes subagent usage and returns no cost', () => {
  const { dir, proj } = makeTranscriptDir();
  fs.writeFileSync(path.join(proj, 'a.jsonl'), assistantTurn('claude-sonnet-5', { input: 50, cacheRead: 200, requestId: 'req-parent', messageId: 'msg-parent' }) + '\n');
  fs.writeFileSync(path.join(proj, 'subagents', 'sub.jsonl'), assistantTurn('claude-sonnet-5', { input: 9999, requestId: 'req-sub', messageId: 'msg-sub' }) + '\n');
  const entries = walkClaudeTranscripts({ since: '20260501', sessionDir: dir });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(e => e.inputTokens).sort((a, b) => a - b), [50, 9999]);
});

test('scanClaudeSessions prices zero-cost transcripts and routes provider to claudemax', () => {
  const { dir } = makeTranscriptDir();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'a.jsonl'), assistantTurn('claude-opus-5', { input: 1_000_000, output: 0, cacheRead: 0 }) + '\n');
  // claude-opus-5: $5 input / 1M tokens -> $5
  const r = scanClaudeSessions('20260501', { claude: 'claudemax' }, {
    sessionDir: dir,
    modelPriceAliases: {},
    pricingModels: { 'claude-opus-5': { openrouter: { input: 5, output: 25, cache: 0.5 } } },
  });
  assert.equal(r.perPath.claudemax, 5);
  assert.equal(r.providerRecords[0].provider, 'claude');
  assert.equal(r.providerRecords[0].pathId, 'claudemax');
  assert.equal(r.providerRecords[0].cost, 5);
});