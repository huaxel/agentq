'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { SqliteSource } = require('./helpers/pinned-issue.js');
const dbModule = require('../src/queue/db.js');

const AGENTQ = require.resolve('../src/interfaces/cli/agentq.js');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-requeue-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  const first = await source.enqueue({ repo, issue: '42', base: 'main', model: 'original/model', trusted: true });
  return { root, repo, source, first };
}

test('manual requeue refuses a running job without altering its claim or model', async t => {
  const { repo, source, first } = await fixture(t);
  const dependentJob = await source.enqueue({ repo, issue: '43', base: 'main', model: 'original/model', trusted: true, dependsOn: first.id });
  const job = await source.claimNext();
  assert.throws(() => source.requeue({ id: job.id, model: 'replacement/model' }),
    /running.*cancel|cancel.*running/i);
  const listed = source.status();
  const running = listed.find(candidate => candidate.id === job.id);
  const dependent = listed.find(candidate => candidate.id === dependentJob.id);
  assert.equal(running.status, 'running');
  assert.equal(running.model, 'original/model');
  assert.equal(running.claimed_by, job.claimed_by);
  assert.equal(running.claim_token, job.claim_token);
  assert.equal(dependent.status, 'blocked');
  assert.equal(await source.claimNext(), null);
});

test('a running state without a live PID still requires explicit recovery before requeue', async t => {
  const { source } = await fixture(t);
  const job = await source.claimNext();
  assert.throws(() => source.requeue({ id: job.id }), /running/i);
  assert.equal(source.status()[0].status, 'running');
});

test('CLI requeue fails on a held write lock without changing even a pending job', async t => {
  const { root, source, first } = await fixture(t);
  // A failed attempt makes the job requeueable.
  const job = await source.claimNext();
  await source.sink.finish(job, { status: 'failed', exit: 7 });
  const before = source.status().find(candidate => candidate.id === first.id);

  // Another process holds the queue's write transaction: the requeue must
  // fail (SQLITE_BUSY) rather than read stale state or block forever.
  const holder = new DatabaseSync(source.dbPath);
  holder.exec('PRAGMA busy_timeout=0');
  holder.exec('BEGIN IMMEDIATE');
  try {
    const result = spawnSync(process.execPath, [AGENTQ, '--db', source.dbPath,
      'requeue', '--id', first.id, '--model', 'replacement/model', '--json'], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, AGENTQ_QUOTA_REFRESH: '0', AGENTQ_BUSY_TIMEOUT_MS: '100' },
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /locked|busy/i);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  const after = source.status().find(candidate => candidate.id === first.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.model, before.model);

  // Once the lock is released the same requeue succeeds.
  assert.deepEqual(source.requeue({ id: first.id, model: 'replacement/model' }), { id: first.id, status: 'pending' });
  assert.equal(source.status().find(candidate => candidate.id === first.id).model, 'replacement/model');
});

test('requeue refuses a task a peer claimed after the failure', async t => {
  const { source, first } = await fixture(t);
  const job = await source.claimNext();
  await source.sink.finish(job, { status: 'failed', exit: 7 });

  // A peer claims the failed job (it was re-pended by an operator).
  source.requeue({ id: first.id });
  const peer = new SqliteSource(source.dbPath);
  t.after(async () => { await peer.stop(); });
  const peerJob = await peer.claimNext();
  assert.equal(peerJob.id, first.id);

  // The original worker can no longer requeue it: the claim is live.
  assert.throws(() => source.requeue({ id: first.id }), /running/i);
  const stored = source.status().find(candidate => candidate.id === first.id);
  assert.equal(stored.claimed_by, peerJob.claimed_by);
  assert.equal(stored.model, 'original/model');
  assert.equal(dbModule.listTaskEvents(source.db, first.id).filter(event => event.event === 'requeued').length, 1);
});

test('requeue rejects an unknown job id without leaving a write lock behind', async t => {
  const { source } = await fixture(t);
  assert.throws(() => source.requeue({ id: '999999' }), /No task found/);
  // The failed transaction was rolled back: the queue is still writable.
  assert.equal(source.status()[0].status, 'pending');
  assert.equal((await source.claimNext()).id, source.status()[0].id);
});

test('a feedback claim applies the command-line model before admission', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-feedback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  const handle = dbModule.openDb(source.dbPath);
  try {
    dbModule.initSchema(handle);
    dbModule.createTask(handle, {
      kind: 'feedback', repo, prompt: 'review this diff', model: null, trust_level: 'trusted_agent',
    });
  } finally {
    handle.close();
  }

  const caps = { kind: 'feedback', executor: '/tmp/executor', sandbox: '/tmp/sandbox' };
  // Without a model the feedback task is refused (admission) and stays pending.
  assert.equal(await source.claimNext(caps), null);
  assert.equal(source.refused.length, 1);
  assert.match(source.refused[0].reason, /no model configured/);
  assert.equal(source.status()[0].status, 'pending');

  // With --model the override is applied to the candidate before admission,
  // and the claim persists it.
  const claimed = await source.claimNext({ ...caps, model: 'chosen/model' });
  assert.equal(claimed.model, 'chosen/model');
  assert.equal(source.status()[0].model, 'chosen/model');

  // A feedback claim without a boundary never reaches the queue at all.
  await assert.rejects(
    source.claimNext({ kind: 'feedback', executor: '/tmp/executor' }),
    /executor and a sandbox boundary/,
  );
});
