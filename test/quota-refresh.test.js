'use strict';

/**
 * Stale-quota refresher: freshness gate, single-flight lock, rate limit,
 * opt-out, and the real spawn path (with a fake collector script, never the
 * shipped collector and never the network).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  refreshQuotaIfStale,
  isStale,
  lockPathFor,
  stampPathFor,
  readLock,
  releaseLock,
  breakLock,
  breakerDirFor,
  readBreakerOwner,
  acquireBreakerDir,
  releaseBreakerDir,
  tryAcquireLock,
  shouldBreakLock,
  pidAlive,
  defaultQuotaPath,
} = require('../src/lib/quota-refresh.js');
const { spawn, spawnSync } = require('node:child_process');

const HOUR = 3600 * 1000;
const MAX_AGE = 6 * HOUR;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-quota-refresh-'));
}

/** Write a quota snapshot whose newest observation is `ageMs` old. */
function writeQuota(quotaPath, { ageMs = 0, usedPercent = 10 } = {}) {
  const observed = new Date(Date.now() - ageMs).toISOString();
  fs.writeFileSync(quotaPath, JSON.stringify({
    generatedAt: observed,
    paths: {
      codex: { updatedAt: observed, windows: [{ label: 'week', usedPercent, resetsAt: null }] },
    },
  }));
}

/** Write a lock record the way the link protocol stores it. */
function writeLockFile(lockPath, owner) {
  fs.writeFileSync(lockPath, JSON.stringify(owner));
}

/** A pid that is provably gone: a child that has already exited. */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid;
}

/** Poll until `predicate()` is true (bounded). */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/** Run `fn` with AGENTQ_QUOTA_COLLECTOR set (or cleared), restoring it after. */
async function withCollectorEnv(value, fn) {
  const previous = process.env.AGENTQ_QUOTA_COLLECTOR;
  if (value === undefined) delete process.env.AGENTQ_QUOTA_COLLECTOR;
  else process.env.AGENTQ_QUOTA_COLLECTOR = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.AGENTQ_QUOTA_COLLECTOR;
    else process.env.AGENTQ_QUOTA_COLLECTOR = previous;
  }
}

test('a missing or unparseable snapshot is stale', () => {
  const dir = tmpdir();
  const missing = path.join(dir, 'quota.json');
  assert.equal(isStale(missing, MAX_AGE, Date.now()), true);

  fs.writeFileSync(missing, '{not json');
  assert.equal(isStale(missing, MAX_AGE, Date.now()), true);

  writeQuota(missing);
  assert.equal(isStale(missing, MAX_AGE, Date.now()), false);

  writeQuota(missing, { ageMs: 7 * HOUR });
  assert.equal(isStale(missing, MAX_AGE, Date.now()), true);
});

test('fresh quota is never collected', async () => {
  const dir = tmpdir();
  const quotaPath = path.join(dir, 'quota.json');
  writeQuota(quotaPath);
  let calls = 0;

  const outcome = await refreshQuotaIfStale({
    quotaPath,
    collect: async () => { calls += 1; },
  });

  assert.deepEqual(outcome, { refreshed: false, reason: 'fresh' });
  assert.equal(calls, 0);
});

test('stale quota is collected once, then re-read as fresh', async () => {
  const dir = tmpdir();
  const quotaPath = path.join(dir, 'quota.json');
  writeQuota(quotaPath, { ageMs: 7 * HOUR });
  let calls = 0;

  const outcome = await refreshQuotaIfStale({
    quotaPath,
    collect: async () => {
      calls += 1;
      writeQuota(quotaPath);
    },
  });

  assert.equal(calls, 1);
  assert.equal(outcome.refreshed, true);
  assert.equal(outcome.reason, 'refreshed');
  assert.ok(outcome.durationMs >= 0);
  assert.equal(isStale(quotaPath, MAX_AGE, Date.now()), false);
  // The lock is released and the rate-limit stamp records the attempt.
  assert.equal(fs.existsSync(lockPathFor(quotaPath)), false);
  assert.ok(Number(fs.readFileSync(stampPathFor(quotaPath), 'utf8')) > 0);
});

test('concurrent callers share one collection', async () => {
  const dir = tmpdir();
  const quotaPath = path.join(dir, 'quota.json');
  writeQuota(quotaPath, { ageMs: 7 * HOUR });
  let calls = 0;
  const slowCollect = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    writeQuota(quotaPath);
  };

  const [first, second] = await Promise.all([
    refreshQuotaIfStale({ quotaPath, collect: slowCollect }),
    refreshQuotaIfStale({ quotaPath, collect: slowCollect, pollMs: 10 }),
  ]);

  assert.equal(calls, 1, 'the second caller must wait, not collect');
  assert.equal([first, second].filter((outcome) => outcome.refreshed).length, 1);
  const skipped = [first, second].find((outcome) => !outcome.refreshed);
  assert.match(skipped.reason, /another process|rate limited/);
});

test('a lock left by a dead run is broken immediately', async () => {
  const dir = tmpdir();
  const quotaPath = path.join(dir, 'quota.json');
  writeQuota(quotaPath, { ageMs: 7 * HOUR });
  const lockPath = lockPathFor(quotaPath);
  // Young in wall-clock terms, but its holder is gone.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), startedAt: Date.now(), nonce: 'dead' }));
  let calls = 0;

  const outcome = await refreshQuotaIfStale({
    quotaPath,
    timeoutMs: 60_000,
    collect: async () => {
      calls += 1;
      writeQuota(quotaPath);
    },
  });

  assert.equal(calls, 1);
  assert.equal(outcome.refreshed, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('an ancient lock is broken even when its pid looks alive', async () => {
  const dir = tmpdir();
  const quotaPath = path.join(dir, 'quota.json');
  writeQuota(quotaPath, { ageMs: 7 * HOUR });
  const lockPath = lockPathFor(quotaPath);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 5000, nonce: 'old' }));
  let calls = 0;

  const outcome = await refreshQuotaIfStale({
    quotaPath,
    timeoutMs: 1000, // stale after 2000ms; the lock is 5000ms old
    collect: async () => {
      calls += 1;
      writeQuota(quotaPath);
    },
  });

  assert.equal(calls, 1);
  assert.equal(outcome.refreshed, true);
});

test('a live, young lock is never broken', () => {
  const dir = tmpdir();
  const lockPath = path.join(dir, 'quota.json.refresh.lock');
  writeLockFile(lockPath, { pid: process.pid, startedAt: Date.now(), nonce: 'live' });
  const judged = shouldBreakLock(lockPath, { nowMs: Date.now(), staleAfterMs: 5000 });
  assert.equal(judged.stale, false);
  assert.equal(judged.owner.nonce, 'live');
  assert.equal(breakLock(lockPath, { nowMs: Date.now(), staleAfterMs: 5000, judged }), false);
  assert.equal(readLock(lockPath).nonce, 'live');
});

test('two breakers racing on a stale lock: exactly one breaks it', async () => {
  const dir = tmpdir();
  const quotaPath = path.join(dir, 'quota.json');
  writeQuota(quotaPath, { ageMs: 7 * HOUR });
  const lockPath = lockPathFor(quotaPath);
  writeLockFile(lockPath, { pid: deadPid(), startedAt: Date.now(), nonce: 'dead' });

  // The breaker mutex serializes them: the first breaks the lock, the second
  // re-reads, finds nothing to break, and reports that it broke nothing.
  const now = Date.now();
  const judged = shouldBreakLock(lockPath, { nowMs: now, staleAfterMs: 60_000 });
  assert.equal(breakLock(lockPath, { nowMs: now, staleAfterMs: 60_000, judged }), true);
  assert.equal(breakLock(lockPath, { nowMs: now, staleAfterMs: 60_000, judged }), false);
  assert.equal(fs.existsSync(lockPath), false);

  // End to end: with a stale lock in place, two callers still collect once.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), startedAt: Date.now(), nonce: 'dead' }));
  let calls = 0;
  const slowCollect = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeQuota(quotaPath);
  };
  const [first, second] = await Promise.all([
    refreshQuotaIfStale({ quotaPath, collect: slowCollect, timeoutMs: 5000 }),
    refreshQuotaIfStale({ quotaPath, collect: slowCollect, pollMs: 10, timeoutMs: 5000 }),
  ]);
  assert.equal(calls, 1);
  assert.equal([first, second].filter((outcome) => outcome.refreshed).length, 1);
});

test('B1: a release after our lock was broken leaves the new holder\'s lock', () => {
  const dir = tmpdir();
  const lockPath = path.join(dir, 'quota.json.refresh.lock');
  writeLockFile(lockPath, { pid: process.pid, startedAt: Date.now(), nonce: 'A' });
  // While A was collecting, a breaker removed A's lock and B took the slot.
  fs.rmSync(lockPath);
  writeLockFile(lockPath, { pid: process.pid, startedAt: Date.now(), nonce: 'B' });

  let thirdAcquire = null;
  const released = releaseLock(lockPath, 'A', {
    afterReleaseRead: () => {
      // A third acquirer C tries during A's release: B holds the lock.
      thirdAcquire = tryAcquireLock(lockPath, { nowMs: Date.now(), staleAfterMs: 60_000 });
    },
  });

  assert.equal(released, false, 'A must not remove B\'s lock');
  assert.equal(readLock(lockPath).nonce, 'B', 'B keeps its lock');
  assert.equal(thirdAcquire.acquired, false);
  assert.equal(thirdAcquire.held, true, 'C gets EEXIST, not a broken lock');

  // Releasing our own lock still works.
  assert.equal(releaseLock(lockPath, 'B'), true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('B2: a breaker that judged a replaced lock leaves the new holder intact and does not acquire', () => {
  const dir = tmpdir();
  const lockPath = path.join(dir, 'quota.json.refresh.lock');
  const now = Date.now();
  // L1 is stale (dead holder).
  writeLockFile(lockPath, { pid: deadPid(), startedAt: now - 1000, nonce: 'L1' });

  let bResult = null;
  const aResult = tryAcquireLock(lockPath, {
    nowMs: now,
    staleAfterMs: 60_000,
    hooks: {
      afterJudge: () => {
        // B judges L1 stale too, breaks it and takes L2 before A's break runs.
        if (bResult) return;
        bResult = tryAcquireLock(lockPath, { nowMs: now, staleAfterMs: 60_000 });
      },
    },
  });

  assert.equal(bResult.acquired, true, 'B wins the race');
  assert.equal(readLock(lockPath).nonce, bResult.nonce, 'B\'s lock survives A\'s break');
  assert.equal(aResult.acquired, false, 'A must not acquire');
});

test('acquire never exposes an empty or partial lock file', () => {
  const dir = tmpdir();
  const lockPath = path.join(dir, 'quota.json.refresh.lock');
  const seen = [];
  const inspect = () => {
    if (!fs.existsSync(lockPath)) {
      seen.push('absent');
      return;
    }
    const owner = readLock(lockPath);
    seen.push(owner && owner.nonce ? 'full' : 'EMPTY');
  };

  const now = Date.now();
  const first = tryAcquireLock(lockPath, {
    nowMs: now,
    staleAfterMs: 60_000,
    hooks: { beforeLink: inspect },
  });
  assert.equal(first.acquired, true);
  assert.deepEqual(seen, ['absent']);

  // A contended acquire sees the existing record, never a half-written file.
  const contended = tryAcquireLock(lockPath, {
    nowMs: now,
    staleAfterMs: 60_000,
    hooks: { beforeLink: inspect },
  });
  assert.equal(contended.acquired, false);
  assert.ok(!seen.includes('EMPTY'), `saw ${seen.join(',')}`);
  assert.ok(seen.includes('full'));
});

test('an abort while waiting for another process returns promptly', async () => {
  const dir = tmpdir();
  const quotaPath = path.join(dir, 'quota.json');
  writeQuota(quotaPath, { ageMs: 7 * HOUR });
  const lockPath = lockPathFor(quotaPath);
  writeLockFile(lockPath, { pid: process.pid, startedAt: Date.now(), nonce: 'holder' });
  const controller = new AbortController();
  let calls = 0;

  const started = Date.now();
  const pending = refreshQuotaIfStale({
    quotaPath,
    timeoutMs: 30_000, // would be a 30 s wait without the abort
    pollMs: 10,
    signal: controller.signal,
    collect: async () => { calls += 1; },
  });
  setTimeout(() => controller.abort(), 50);
  const outcome = await pending;
  const elapsed = Date.now() - started;

  assert.equal(outcome.reason, 'cancelled');
  assert.ok(elapsed < 2000, `the abort must be prompt, took ${elapsed}ms`);
  assert.equal(calls, 0);
  assert.equal(readLock(lockPath).nonce, 'holder', 'the other holder keeps its lock');
  fs.rmSync(lockPath, { force: true });
});

test('a breaker that renamed a mutex which changed hands restores it and gives up', () => {
  const dir = tmpdir();
  const lockPath = path.join(dir, 'quota.json.refresh.lock');
  const mutexDir = breakerDirFor(lockPath);
  const now = Date.now();
  // A stale mutex: its breaker is dead.
  fs.mkdirSync(mutexDir, { mode: 0o700 });
  writeLockFile(path.join(mutexDir, 'owner'), { pid: deadPid(), startedAt: now - 60_000, nonce: 'N1' });

  let bAcquired = null;
  const aAcquired = acquireBreakerDir(mutexDir, { pid: process.pid, startedAt: now, nonce: 'A' }, {
    nowMs: now,
    hooks: {
      afterMutexJudge: () => {
        if (bAcquired) return;
        // B breaks the stale mutex and takes it before A's break runs.
        bAcquired = acquireBreakerDir(mutexDir, { pid: process.pid, startedAt: now, nonce: 'B' }, { nowMs: now });
      },
    },
  });

  assert.equal(bAcquired, true, 'B takes the mutex');
  assert.equal(aAcquired, false, 'A must not enter the critical section');
  assert.equal(readBreakerOwner(mutexDir).nonce, 'B', 'B\'s mutex survives A\'s break');

  releaseBreakerDir(mutexDir, 'B');
  assert.equal(fs.existsSync(mutexDir), false);
});

test('an abort waits for an injected collector to settle before releasing the lock', async () => {
  const dir = tmpdir();
  const quotaPath = path.join(dir, 'quota.json');
  writeQuota(quotaPath, { ageMs: 7 * HOUR });
  const lockPath = lockPathFor(quotaPath);
  let finishCollector;
  const collect = () => new Promise((resolve) => { finishCollector = resolve; });
  const controller = new AbortController();

  const pending = refreshQuotaIfStale({ quotaPath, collect, signal: controller.signal, timeoutMs: 5000 });
  assert.ok(await waitFor(() => fs.existsSync(lockPath)), 'the lock is held');
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(lockPath), true, 'the lock is held until the collector settles');

  finishCollector();
  const outcome = await pending;
  assert.equal(outcome.reason, 'cancelled');
  assert.equal(fs.existsSync(lockPath), false, 'the lock is released after the collector settled');
});

test('stale lock tmp files are swept at acquire time', () => {
  const dir = tmpdir();
  const lockPath = path.join(dir, 'quota.json.refresh.lock');
  const oldTmp = `${lockPath}.deadbeef.tmp`;
  const youngTmp = `${lockPath}.cafebabe.tmp`;
  fs.writeFileSync(oldTmp, '{}');
  fs.writeFileSync(youngTmp, '{}');
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(oldTmp, old, old);

  const result = tryAcquireLock(lockPath, { nowMs: Date.now(), staleAfterMs: 60_000 });

  assert.equal(result.acquired, true);
  assert.equal(fs.existsSync(oldTmp), false, 'the dead process\'s tmp file is removed');
  assert.equal(fs.existsSync(youngTmp), true, 'a live tmp file is left alone');
});

test('a lock that cannot be stamped is not collected', async () => {
  const dir = tmpdir();
  const quotaPath = path.join(dir, 'quota.json');
  writeQuota(quotaPath, { ageMs: 7 * HOUR });
  // A directory where the stamp file belongs: writeFileSync fails with EISDIR.
  fs.mkdirSync(stampPathFor(quotaPath));
  let calls = 0;

  const outcome = await refreshQuotaIfStale({
    quotaPath,
    collect: async () => { calls += 1; },
  });

  assert.equal(outcome.refreshed, false);
  assert.equal(outcome.reason, 'stamp unwritable');
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(lockPathFor(quotaPath)), false, 'the lock is still released');
});

test('SIGTERM during a collection kills the collector group and releases the lock', async () => {
  const dir = tmpdir();
  const quotaPath = path.join(dir, 'quota.json');
  writeQuota(quotaPath, { ageMs: 7 * HOUR });
  const collectorPidFile = path.join(dir, 'collector.pid');
  const collector = path.join(dir, 'slow-collector.js');
  fs.writeFileSync(collector, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(collectorPidFile)}, String(process.pid));`,
    'setTimeout(() => {}, 60000);',
  ].join('\n'));

  const refresher = path.join(dir, 'refresher.js');
  fs.writeFileSync(refresher, [
    `const { refreshQuotaIfStale } = require(${JSON.stringify(require.resolve('../src/lib/quota-refresh.js'))});`,
    `refreshQuotaIfStale({ quotaPath: ${JSON.stringify(quotaPath)} });`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));

  const child = spawn(process.execPath, [refresher], {
    env: { ...process.env, AGENTQ_QUOTA_COLLECTOR: collector },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    assert.ok(await waitFor(() => fs.existsSync(collectorPidFile)), 'the collector started');
    assert.ok(await waitFor(() => fs.existsSync(lockPathFor(quotaPath))), 'the lock is held');
    const collectorPid = Number(fs.readFileSync(collectorPidFile, 'utf8'));

    child.kill('SIGTERM');
    const exit = await new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));

    assert.equal(exit.signal, 'SIGTERM', 'the signal is re-raised, not swallowed');
    assert.equal(fs.existsSync(lockPathFor(quotaPath)), false, 'the lock is released');
    assert.ok(await waitFor(() => !pidAlive(collectorPid)), 'the collector process group is killed');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    // Tidy up the stub collector too, even if an assertion failed early.
    try {
      const collectorPid = Number(fs.readFileSync(collectorPidFile, 'utf8'));
      if (Number.isInteger(collectorPid) && collectorPid > 0) {
        try { process.kill(-collectorPid, 'SIGKILL'); } catch { /* gone */ }
      }
    } catch { /* the collector never started */ }
  }
});

test('a lock held by a live run is waited for, then reported as a timeout', async () => {
  const dir = tmpdir();
  const quotaPath = path.join(dir, 'quota.json');
  writeQuota(quotaPath, { ageMs: 7 * HOUR });
  const lockPath = lockPathFor(quotaPath);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  let calls = 0;
  try {
    const outcome = await refreshQuotaIfStale({
      quotaPath,
      timeoutMs: 120,
      pollMs: 10,
      collect: async () => { calls += 1; },
    });
    assert.equal(outcome.refreshed, false);
    assert.equal(outcome.reason, 'lock timeout');
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
});

test('a failed collection is rate-limited instead of retried', async () => {
  const dir = tmpdir();
  const quotaPath = path.join(dir, 'quota.json');
  writeQuota(quotaPath, { ageMs: 7 * HOUR });
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error('collector exited 1');
  };

  const first = await refreshQuotaIfStale({ quotaPath, collect: failing });
  assert.equal(first.refreshed, false);
  assert.match(first.reason, /collector exited 1/);

  const second = await refreshQuotaIfStale({ quotaPath, collect: failing });
  assert.equal(second.refreshed, false);
  assert.equal(second.reason, 'rate limited');
  assert.equal(calls, 1, 'the failed attempt must not be retried immediately');

  // Once the interval passes, a new attempt is allowed.
  const third = await refreshQuotaIfStale({ quotaPath, minIntervalMs: 0, collect: failing });
  assert.equal(third.refreshed, false);
  assert.equal(calls, 2);
});

test('AGENTQ_QUOTA_REFRESH=0 and enabled:false disable the refresh', async () => {
  const dir = tmpdir();
  const quotaPath = path.join(dir, 'quota.json');
  writeQuota(quotaPath, { ageMs: 7 * HOUR });
  let calls = 0;
  const collect = async () => { calls += 1; };

  const previous = process.env.AGENTQ_QUOTA_REFRESH;
  process.env.AGENTQ_QUOTA_REFRESH = '0';
  try {
    assert.deepEqual(await refreshQuotaIfStale({ quotaPath, collect }), { refreshed: false, reason: 'disabled' });
  } finally {
    if (previous === undefined) delete process.env.AGENTQ_QUOTA_REFRESH;
    else process.env.AGENTQ_QUOTA_REFRESH = previous;
  }

  assert.deepEqual(
    await refreshQuotaIfStale({ quotaPath, collect, enabled: false }),
    { refreshed: false, reason: 'disabled' },
  );
  assert.equal(calls, 0);
});

test('a custom quota path is not refreshed with the built-in collector', async () => {
  await withCollectorEnv(undefined, async () => {
    const dir = tmpdir();
    const custom = path.join(dir, 'custom-quota.json');
    writeQuota(custom, { ageMs: 7 * HOUR });
    assert.notEqual(path.resolve(custom), defaultQuotaPath());

    const outcome = await refreshQuotaIfStale({ quotaPath: custom });

    assert.equal(outcome.refreshed, false);
    assert.equal(outcome.reason, 'custom quota path');
  });
});

test('the spawned collector writes the snapshot and its stderr is not echoed', async () => {
  const dir = tmpdir();
  const quotaPath = path.join(dir, 'quota.json');
  writeQuota(quotaPath, { ageMs: 7 * HOUR });

  const good = path.join(dir, 'good-collector.js');
  fs.writeFileSync(good, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(quotaPath)}, JSON.stringify({`,
    '  generatedAt: new Date().toISOString(),',
    "  paths: { codex: { updatedAt: new Date().toISOString(), windows: [] } },",
    '}));',
    "process.stderr.write('account-label-secret\\n');",
  ].join('\n'));

  const refreshed = await withCollectorEnv(good, () => refreshQuotaIfStale({ quotaPath }));
  assert.equal(refreshed.refreshed, true, JSON.stringify(refreshed));
  assert.equal(refreshed.reason, 'refreshed');

  // A failing collector reports a short reason and never its stderr.
  writeQuota(quotaPath, { ageMs: 7 * HOUR });
  fs.rmSync(stampPathFor(quotaPath), { force: true });
  const bad = path.join(dir, 'bad-collector.js');
  fs.writeFileSync(bad, "process.stderr.write('account-label-secret\\n'); process.exit(3);");
  const failed = await withCollectorEnv(bad, () => refreshQuotaIfStale({ quotaPath }));
  assert.equal(failed.refreshed, false);
  assert.match(failed.reason, /collector exited 3/);
  assert.ok(!failed.reason.includes('account-label-secret'));
});

test('the refresher never throws, even for an unusable quota path', async () => {
  const dir = tmpdir();
  const outcome = await refreshQuotaIfStale({
    quotaPath: dir, // a directory: unreadable as a snapshot, unwritable lock
    collect: async () => {},
  });
  assert.equal(outcome.refreshed, false);
  assert.equal(typeof outcome.reason, 'string');
  assert.ok(outcome.reason.length > 0);
});
