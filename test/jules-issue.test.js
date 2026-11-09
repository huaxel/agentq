#!/usr/bin/env node
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.JULES_API_KEY = 'test-key';

const { buildPrompt, sessionId, findSource } = require('../src/runners/jules-issue.js');

let originalFetch;
let lastResponse = {};
let lastStatus = 200;

before(() => {
  originalFetch = global.fetch;
  global.fetch = async (url) => ({
    ok: lastStatus >= 200 && lastStatus < 300,
    status: lastStatus,
    text: async () => (typeof lastResponse === 'string' ? lastResponse : JSON.stringify(lastResponse)),
  });
});

after(() => {
  global.fetch = originalFetch;
});

function reset(response, status = 200) {
  lastResponse = response;
  lastStatus = status;
}

test('buildPrompt includes issue title and body', () => {
  const prompt = buildPrompt('42', 'Fix the thing', 'It is broken.\n\nDetails here.');
  assert.match(prompt, /Issue #42: Fix the thing/);
  assert.match(prompt, /It is broken./);
});

test('buildPrompt appends stop-when sentinel when provided', () => {
  const prompt = buildPrompt('1', 'T', 'B', 'tests pass and the bug is gone');
  assert.match(prompt, /Stop condition \(set by agentq\):/);
  assert.match(prompt, /tests pass and the bug is gone/);
  assert.match(prompt, /SHOULD_FULLY_STOP=true/);
});

test('sessionId prefers id, then parses name', () => {
  assert.equal(sessionId({ id: '123', name: 'sessions/456' }), '123');
  assert.equal(sessionId({ name: 'sessions/789' }), '789');
});

test('findSource returns the matching source name', async () => {
  reset({
    sources: [
      { name: 'sources/github/other/repo', id: 'github/other/repo' },
      { name: 'sources/github/acme/widget', id: 'github/acme/widget' },
    ],
  });
  const source = await findSource('acme/widget');
  assert.equal(source, 'sources/github/acme/widget');
});

test('findSource throws when no source matches', async () => {
  reset({ sources: [{ name: 'sources/github/other/repo', id: 'github/other/repo' }] });
  await assert.rejects(async () => findSource('acme/widget'), /No Jules source found/);
});

// Note: pollForPullRequest is exercised via the real executor in integration tests;
// here we just verify helpers handle the API shapes used by the executor.
