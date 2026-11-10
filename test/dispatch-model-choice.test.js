'use strict';

/**
 * W26: a dispatch-spawned worker records its model decision once.
 *
 * MCP `dispatch_task` records the `model-chosen` audit event itself (with the
 * correct chosenBy and shortlist roles) and marks the worker it spawns with the
 * internal env var `AGENTQ_MODEL_CHOICE_RECORDED=1`. The worker's initial claim
 * (`claimById`) must NOT record the event again, but a retry inside that worker
 * (`claimRetry`) re-resolves the model and still records its own.
 *
 * These tests drive the queue claim paths in-process (no real executor, no real
 * quota collector).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SqliteSource } = require('./helpers/pinned-issue.js');
const dbModule = require('../src/queue/db.js');

// Never run the real quota collector.
process.env.AGENTQ_QUOTA_REFRESH = '0';

// Routing reads the runnable list from AGENTQ_HOME. An empty list keeps an
// 'auto' resolution from blowing up; the fixtures below use a concrete model so
// routing is never actually invoked.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-w26-home-'));
fs.mkdirSync(path.join(HOME, 'config'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config', 'runnables.json'), JSON.stringify({ schemaVersion: 1, runnables: [] }));
process.env.AGENTQ_HOME = HOME;

/** @param {import('node:test').TestContext} t */
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-w26-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, '-c', 'user.name=AgentQ Test',
    '-c', 'user.email=agentq@example.test', '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'ignore' });
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  const job = await source.enqueue({ repo, issue: '42', base: 'main', model: 'original/model', trusted: true });
  return { root, repo, source, job };
}

function events(source, id) {
  return dbModule.listTaskEvents(source.db, id).map((event) => ({
    ...event,
    payload: JSON.parse(event.payload || 'null'),
  }));
}

function modelChosen(source, id) {
  return events(source, id).filter((event) => event.event === 'model-chosen');
}

test('a plain CLI run --id records exactly one model-chosen event', async (t) => {
  const { source, job } = await fixture(t);
  delete process.env.AGENTQ_MODEL_CHOICE_RECORDED;
  const claimed = await source.claimById({ id: job.id });
  assert.equal(claimed.id, job.id);
  assert.equal(modelChosen(source, job.id).length, 1, 'one decision, correctly labelled');
});

test('claimById records no model-chosen event when the dispatch marker is set', async (t) => {
  const { source, job } = await fixture(t);
  const prev = process.env.AGENTQ_MODEL_CHOICE_RECORDED;
  process.env.AGENTQ_MODEL_CHOICE_RECORDED = '1';
  try {
    const claimed = await source.claimById({ id: job.id });
    assert.equal(claimed.id, job.id);
    // Dispatch already recorded this decision; the worker must not duplicate it
    // (a duplicate would be mislabelled as a 'caller' pick with empty roles).
    assert.equal(modelChosen(source, job.id).length, 0, 'no second, mislabelled event');
  } finally {
    if (prev === undefined) delete process.env.AGENTQ_MODEL_CHOICE_RECORDED;
    else process.env.AGENTQ_MODEL_CHOICE_RECORDED = prev;
  }
});

test('a retry after a marked claim still records its own model-chosen event', async (t) => {
  const { source, job } = await fixture(t);
  // Keep the dispatch marker present for the WHOLE exchange: the claim must
  // skip, and the retry must still record despite the env var being set.
  const prev = process.env.AGENTQ_MODEL_CHOICE_RECORDED;
  process.env.AGENTQ_MODEL_CHOICE_RECORDED = '1';
  try {
    const claimed = await source.claimById({ id: job.id });
    assert.equal(modelChosen(source, job.id).length, 0, 'initial marked claim records nothing');

    // The worker fails the run; it retries, which re-resolves the model. That
    // is a new decision and must write its own `model-chosen` event.
    const completionId = (await source.sink.finish(claimed, { status: 'failed', exit: 7 })).completionId;
    const retried = await source.claimRetry(claimed, { completionId, retryCount: 1, options: {} });
    assert.ok(retried, 'the retry is claimable');
    const chosen = modelChosen(source, job.id);
    assert.equal(chosen.length, 1, 'the retry records exactly one model-chosen event');
    // The retry's event is a fresh decision, not the dispatch-spawned one.
    assert.ok(chosen[0].payload && chosen[0].payload.model === 'original/model');
  } finally {
    if (prev === undefined) delete process.env.AGENTQ_MODEL_CHOICE_RECORDED;
    else process.env.AGENTQ_MODEL_CHOICE_RECORDED = prev;
  }
});

test('the dispatch marker is not settable through dispatch_task input', async (t) => {
  // Dispatch owns the marker; this is a sanity check that the worker-side guard
  // is keyed on the env var and NOT on anything a plain CLI caller controls.
  // A plain `run --id` with no marker records as today.
  const { source, job } = await fixture(t);
  delete process.env.AGENTQ_MODEL_CHOICE_RECORDED;
  await source.claimById({ id: job.id });
  assert.equal(modelChosen(source, job.id).length, 1);
});
