'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseAgyCatalog, codexAuthentication, observeNative } = require('../src/lib/native-observations.js');
const { buildCapacityView } = require('../src/lib/capacity-view.js');
const now = Date.parse('2026-10-06T12:00:00Z');
const descriptor = (id, overrides = {}) => ({ id, machine: 'local', subscription: 'codex', accountRef: null, harness: 'codex', provider: 'openai-codex', catalog: 'native', quotaPath: 'codex', constraints: [], ...overrides });
const inventory = (...paths) => ({ schemaVersion: 1, paths });

test('AGY catalog parses IDs without inventing capabilities or entitlement', () => {
  assert.deepEqual(parseAgyCatalog('warning: private-sentinel\ngemini-3.8-flash-high\tGemini Flash\nclaude-sonnet-4-6\tSonnet'), [
    { id: 'gemini-3.8-flash-high', reasoning: null, images: null, privacy: 'unverified' },
    { id: 'claude-sonnet-4-6', reasoning: null, images: null, privacy: 'unverified' },
  ]);
});

test('Codex status separates subscription and paid API modes without echoing output', () => {
  const subscription = codexAuthentication({ status: 0, stderr: 'Logged in using ChatGPT' });
  assert.equal(subscription.mode, 'subscription');
  const api = codexAuthentication({ status: 0, stderr: 'Logged in using an API key - private-sentinel' });
  assert.equal(api.mode, 'api-key');
  assert.ok(!JSON.stringify(api).includes('private-sentinel'));
  assert.equal(codexAuthentication({ status: 1, stderr: 'Not logged in' }).state, 'not-authenticated');
});

test('timeouts, errors and unrecognized statuses do not imply unauthenticated', () => {
  assert.equal(codexAuthentication({ status: null, stderr: 'Not logged in', error: new Error('timeout') }).state, 'unknown');
  assert.equal(codexAuthentication({ status: 1, stderr: 'private-sentinel' }).state, 'unknown');
});

test('probes use only fixed read-only commands and bounded captured output', () => {
  const calls = [];
  const observations = observeNative(new Set(['agy', 'codex', 'copilot']), { now, run: (command, args, options) => {
    calls.push([command, args]);
    assert.equal(options.timeout, 10000);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    return command === 'agy' ? { status: 0, stdout: 'gemini-3.8-flash-low\tGemini' } : { status: 0, stderr: 'Logged in using ChatGPT' };
  } });
  assert.deepEqual(calls, [['agy', ['models']], ['codex', ['login', 'status']]]);
  assert.equal(observations.copilot.catalog.state, 'native-auto');
  assert.equal(observations.agy.catalog.state, 'advertised');
});

test('native catalog does not grant configured access and subscription quota is not entitlement', () => {
  const observations = observeNative(new Set(['agy']), { now, run: () => ({ status: 0, stdout: 'claude-sonnet-4-6\tSonnet' }) });
  const view = buildCapacityView(inventory(descriptor('agy', { harness: 'agy', provider: 'antigravity', subscription: 'google-ai-pro' })), { now, installed: new Set(['agy']), nativeObservations: observations });
  assert.equal(view.paths[0].access, 'unknown');
  assert.equal(view.paths[0].catalog.state, 'advertised');
  assert.equal(view.paths[0].models[0].id, 'claude-sonnet-4-6');
});

test('API-key Codex login is unavailable for declared subscription path', () => {
  const observations = observeNative(new Set(['codex']), { now, run: () => ({ status: 0, stderr: 'Logged in using an API key' }) });
  const view = buildCapacityView(inventory(descriptor('codex')), { now, installed: new Set(['codex']), nativeObservations: observations });
  assert.equal(view.paths[0].access, 'unavailable');
  assert.equal(view.paths[0].accessReason, 'api-key-not-declared-subscription');
});

test('remote paths do not inherit native observations from local probes', () => {
  const view = buildCapacityView(inventory(descriptor('remote', { machine: 'remote' })), { now, installed: new Set(['codex']), nativeObservations: { codex: { authentication: { state: 'authenticated' } } } });
  assert.equal(view.paths[0].authentication.state, 'unknown');
  assert.equal(view.paths[0].nativeObservedAt, null);
});

test('missing harnesses invoke nothing and thrown probe errors stay private', () => {
  assert.deepEqual(observeNative(new Set(), { run: () => { throw new Error('must not run'); } }), {});
  const observations = observeNative(new Set(['agy', 'codex']), { now, run: () => { throw new Error('private-sentinel'); } });
  assert.ok(!JSON.stringify(observations).includes('private-sentinel'));
  assert.equal(observations.agy.catalog.state, 'unknown');
  assert.equal(observations.codex.authentication.state, 'unknown');
});
