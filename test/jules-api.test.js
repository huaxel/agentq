#!/usr/bin/env node
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.JULES_API_KEY = 'test-key';

const {
  listSources, createSession, getSession, listActivities, approvePlan, sendMessage,
} = require('../src/lib/jules-api.js');

let originalFetch;
let fetchCalls = [];
let lastResponse = {};
let lastStatus = 200;

before(() => {
  originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return {
      ok: lastStatus >= 200 && lastStatus < 300,
      status: lastStatus,
      text: async () => (typeof lastResponse === 'string' ? lastResponse : JSON.stringify(lastResponse)),
    };
  };
});

after(() => {
  global.fetch = originalFetch;
});

function reset(response, status = 200) {
  fetchCalls = [];
  lastResponse = response;
  lastStatus = status;
}

test('listSources returns sources and sends the API key', async () => {
  reset({ sources: [{ name: 'sources/github/bobalover/boba', id: 'github/bobalover/boba' }] });
  const sources = await listSources();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].name, 'sources/github/bobalover/boba');
  assert.equal(fetchCalls[0].url, 'https://jules.googleapis.com/v1alpha/sources');
  assert.equal(fetchCalls[0].init.method, 'GET');
  assert.equal(fetchCalls[0].init.headers['x-goog-api-key'], 'test-key');
});

test('createSession posts the expected body with all options', async () => {
  reset({ name: 'sessions/31415926535897932384', id: '31415926535897932384' });
  const session = await createSession({
    source: 'sources/github/bobalover/boba',
    prompt: 'Create a boba app!',
    baseBranch: 'main',
    title: 'Boba App',
    automationMode: 'AUTO_CREATE_PR',
    requirePlanApproval: false,
  });
  assert.equal(session.id, '31415926535897932384');
  const init = fetchCalls[0].init;
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  const body = JSON.parse(init.body);
  assert.equal(body.prompt, 'Create a boba app!');
  assert.equal(body.sourceContext.source, 'sources/github/bobalover/boba');
  assert.equal(body.sourceContext.githubRepoContext.startingBranch, 'main');
  assert.equal(body.automationMode, 'AUTO_CREATE_PR');
  assert.equal(body.title, 'Boba App');
  assert.equal(body.requirePlanApproval, false);
});

test('createSession omits optional fields when not provided', async () => {
  reset({ name: 'sessions/1' });
  await createSession({ source: 'sources/github/bobalover/boba', prompt: 'minimal' });
  const body = JSON.parse(fetchCalls[0].init.body);
  assert.equal(body.prompt, 'minimal');
  assert.equal(body.sourceContext.source, 'sources/github/bobalover/boba');
  assert.equal(body.sourceContext.githubRepoContext.startingBranch, 'main');
  assert.equal(body.automationMode, undefined);
  assert.equal(body.title, undefined);
  assert.equal(body.requirePlanApproval, undefined);
});

test('getSession fetches a session by id', async () => {
  reset({ name: 'sessions/123', id: '123', prompt: 'Create a boba app!' });
  const session = await getSession('123');
  assert.equal(session.name, 'sessions/123');
  assert.equal(fetchCalls[0].url, 'https://jules.googleapis.com/v1alpha/sessions/123');
  assert.equal(fetchCalls[0].init.method, 'GET');
});

test('listActivities fetches with pageSize', async () => {
  reset({ activities: [{ name: 'sessions/123/activities/1' }] });
  const data = await listActivities('123', { pageSize: 10 });
  assert.equal(data.activities.length, 1);
  assert.equal(fetchCalls[0].url, 'https://jules.googleapis.com/v1alpha/sessions/123/activities?pageSize=10');
});

test('approvePlan posts an empty body', async () => {
  reset({});
  await approvePlan('123');
  assert.equal(fetchCalls[0].init.method, 'POST');
  assert.equal(fetchCalls[0].url, 'https://jules.googleapis.com/v1alpha/sessions/123:approvePlan');
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {});
});

test('sendMessage posts the prompt', async () => {
  reset({});
  await sendMessage('123', 'Can you make it corgi themed?');
  assert.equal(fetchCalls[0].init.method, 'POST');
  assert.equal(fetchCalls[0].url, 'https://jules.googleapis.com/v1alpha/sessions/123:sendMessage');
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), { prompt: 'Can you make it corgi themed?' });
});

test('throws on API error with response body', async () => {
  reset({ error: { code: 400, message: 'Invalid session ID format', status: 'INVALID_ARGUMENT' } }, 400);
  await assert.rejects(async () => listSources(), /Jules API GET.*failed: 400/);
});
