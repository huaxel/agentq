'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SqliteSource } = require('./helpers/pinned-issue.js');
const dbModule = require('../src/queue/db.js');
const { drainParallel, runNext } = require('../src/interfaces/cli/agentq.js');

// These tests drive the claim paths in-process: never run the real quota
// collector (the refresh tests inject a fake one).
process.env.AGENTQ_QUOTA_REFRESH = '0';

// Routing reads the runnable list from AGENTQ_HOME. An empty list makes an
// 'auto' retry fail as "no model available" instead of a missing-file error.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-retry-home-'));
fs.mkdirSync(path.join(HOME, 'config'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config', 'runnables.json'), JSON.stringify({ schemaVersion: 1, runnables: [] }));
process.env.AGENTQ_HOME = HOME;

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-auto-owner-'));
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

function script(root, name, body) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  return file;
}

function events(source, id) {
  return dbModule.listTaskEvents(source.db, id).map(event => ({
    ...event,
    payload: JSON.parse(event.payload || 'null'),
  }));
}

test('retry claim compares the exact failed completion, not just the failed state', async t => {
  const { source, job } = await fixture(t);
  const claimed = await source.claimNext();
  const older = (await source.sink.finish(claimed, { status: 'failed', exit: 7 })).completionId;
  source.requeue({ id: job.id });
  const reclaimed = await source.claimNext();
  const newer = (await source.sink.finish(reclaimed, { status: 'failed', exit: 7 })).completionId;

  await assert.rejects(source.claimRetry(claimed, { completionId: undefined, retryCount: 1, options: {} }), /receipt/i);
  assert.equal(await source.claimRetry(claimed, { completionId: older, retryCount: 1, options: {} }), null);
  assert.equal(source.status()[0].status, 'failed');
  assert.equal(source.status()[0].model, 'original/model');

  const retried = await source.claimRetry(claimed, { completionId: newer, retryCount: 1, options: {} });
  assert.equal(retried.model, 'original/model');
  assert.ok(retried.claim_token, 'the retry must carry its own claim token');
  assert.equal(source.status()[0].status, 'running');
  assert.equal(source.status()[0].claim_token, retried.claim_token);
  // The same receipt cannot claim a second retry.
  assert.equal(await source.claimRetry(claimed, { completionId: newer, retryCount: 1, options: {} }), null);
});

for (const mode of ['serial', 'parallel']) {
  test(`${mode} automatic retries still complete normally without a competing owner`, async t => {
    const { root, source, job } = await fixture(t);
    const marker = path.join(root, 'attempted');
    const executor = script(root, 'executor.sh', `
      if test -f ${JSON.stringify(marker)}; then echo second-attempt-success; exit 0; fi
      touch ${JSON.stringify(marker)}
      echo first-attempt-diagnostic
      echo first-attempt-error >&2
      exit 7
    `);
    const options = { executor, retries: 1, retryBaseMs: 0 };
    const result = mode === 'serial' ? await runNext(source, options) : await drainParallel(source, options, 2);
    if (mode === 'serial') {
      assert.equal(result.status, 'succeeded');
      assert.equal(result.retries, 1);
    } else {
      assert.equal(result.succeeded, 1);
      assert.equal(result.failed, 0);
    }
    assert.equal(source.status()[0].status, 'succeeded');
    const recorded = events(source, job.id);
    assert.equal(recorded.filter(event => event.event === 'claimed').length, 2);
    assert.equal(recorded.filter(event => event.event === 'requeued').length, 1);
    const completed = recorded.filter(event => event.event === 'completed');
    assert.deepEqual(completed.map(event => event.payload.status), ['failed', 'succeeded']);
    const transcript = fs.readFileSync(source.status()[0].log_path, 'utf8');
    assert.match(transcript, /first-attempt-diagnostic/);
    assert.match(transcript, /first-attempt-error/);
    assert.match(transcript, /second-attempt-success/);
    // Two distinct attempts, each announced in the transcript.
    const attemptIds = transcript.match(/--- attempt [0-9a-f-]{36} ---/g) || [];
    assert.equal(attemptIds.length, 2);
  });
}

test('automatic retry cannot execute over a peer that claimed the job during backoff', async t => {
  const { source, job } = await fixture(t);
  const claimed = await source.claimNext();
  const completionId = (await source.sink.finish(claimed, { status: 'failed', exit: 7 })).completionId;

  // An operator requeues the failed job and a PEER claims it while the
  // original worker is still backing off.
  source.requeue({ id: job.id });
  const peer = new SqliteSource(source.dbPath);
  t.after(async () => { await peer.stop(); });
  const peerJob = await peer.claimNext();
  assert.equal(peerJob.id, job.id);

  // The original worker's retry is superseded: no second claim, no second
  // executor in the peer's checkout.
  assert.equal(await source.claimRetry(claimed, { completionId, retryCount: 1, options: {} }), null);
  const [stored] = source.status();
  assert.equal(stored.status, 'running');
  assert.equal(stored.claimed_by, peerJob.claimed_by);
  assert.equal(stored.claim_token, peerJob.claim_token);
  assert.equal(events(source, job.id).filter(event => event.event === 'claimed').length, 2);

  // The peer's completion is accepted; the stale worker's is not.
  await assert.rejects(
    source.sink.finish(claimed, { status: 'succeeded', exit: 0 }),
    /not running or not claimed by this worker/,
  );
  await peer.sink.finish(peerJob, { status: 'succeeded', exit: 0 });
  assert.equal(source.status()[0].status, 'succeeded');
});

test('a retry whose routing fails leaves the task pending, never stranded', async t => {
  const { source, job } = await fixture(t);
  const claimed = await source.claimNext();
  const completionId = (await source.sink.finish(claimed, { status: 'failed', exit: 7 })).completionId;

  // 'auto' with no eligible model throws before the queue is touched.
  await assert.rejects(
    source.claimRetry({ ...claimed, model: 'auto' }, { completionId, retryCount: 1, options: { quotaPath: path.join(os.tmpdir(), 'missing-quota.json') } }),
    /No model available for auto routing/,
  );
  assert.equal(source.status()[0].status, 'failed');
  assert.equal(source.status()[0].model, 'original/model');

  // With a valid receipt the retry still works afterwards.
  const retried = await source.claimRetry(claimed, { completionId, retryCount: 1, options: {} });
  assert.equal(retried.model, 'original/model');
  assert.equal(source.status()[0].status, 'running');
  void job;
});

test('claimRetry respects a non-CLI task attempt budget', async t => {
  const { source, job } = await fixture(t);
  // Same task, but created by the orchestrator with a single attempt.
  source.db.prepare("UPDATE tasks SET source = 'orchestrator', max_attempts = 1 WHERE id = ?").run(job.id);
  const claimed = await source.claimNext();
  const completionId = (await source.sink.finish(claimed, { status: 'failed', exit: 7 })).completionId;
  assert.equal(source.status()[0].status, 'failed');

  // The budget is spent, so no automatic retry is claimed (the local CLI's
  // exemption only covers its own tasks).
  assert.equal(await source.claimRetry(claimed, { completionId, retryCount: 1, options: {} }), null);
  assert.equal(source.status()[0].status, 'failed');
});

test('claimRetry keeps retrying a CLI task the store would cap', async t => {
  const { source, job } = await fixture(t);
  const claimed = await source.claimNext();
  const completionId = (await source.sink.finish(claimed, { status: 'failed', exit: 7 })).completionId;
  // max_attempts is 1 for CLI tasks; the CLI owns the retry policy, so the
  // retry is still claimable and the attempt counter keeps counting.
  const retried = await source.claimRetry(claimed, { completionId, retryCount: 1, options: {} });
  assert.equal(retried.model, 'original/model');
  const [stored] = source.status();
  assert.equal(stored.status, 'running');
  assert.equal(stored.attempts, 2);
  void job;
});
