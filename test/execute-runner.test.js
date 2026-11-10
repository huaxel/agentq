'use strict';
/**
 * Unit tests for the source-agnostic runner in execute.js: streamed output
 * capture, pid tracking, worktree preparation, and error recovery. Run with
 * `npm test`.
 *
 * (The JSONL append/replay tests that used to live here were removed with the
 * JSONL backend itself: the queue is a SQLite task store now.)
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { runOnce, runAsync, prepareJobWorktree } = require('../src/runners/execute.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'execute-runner-'));
}

for (const appendOutput of [false, true]) {
  test(`runAsync ${appendOutput ? 'appends to' : 'overwrites'} an existing output file without recapturing old text`, async t => {
    const root = tmpdir();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const outputPath = path.join(root, 'job.log');
    fs.writeFileSync(outputPath, 'prior evidence without trailing newline');
    const result = await runAsync(process.execPath, ['-e', "process.stdout.write('new evidence')"], {
      outputPath,
      ...(appendOutput ? { appendOutput: true, outputPrefix: '\n--- next attempt ---\n' } : {}),
      timeoutMs: 5000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'new evidence');
    assert.equal(result.stderr, '');
    assert.equal(fs.readFileSync(outputPath, 'utf8'), appendOutput
      ? 'prior evidence without trailing newline\n--- next attempt ---\nnew evidence'
      : 'new evidence');
  });
}

test('runAsync streams the full log while bounding captured output', async () => {
  const root = tmpdir();
  const outputPath = path.join(root, 'job.log');
  const result = await runAsync(process.execPath, ['-e', "process.stdout.write('x'.repeat(2 * 1024 * 1024))"], {
    timeoutMs: 10_000,
    outputPath,
  });

  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.length <= 1024 * 1024);
  assert.ok(fs.statSync(outputPath).size >= 2 * 1024 * 1024);
});

test('runAsync labels stdout and stderr transitions in the streamed log', async () => {
  const root = tmpdir();
  const outputPath = path.join(root, 'interleaved.log');
  const script = [
    "process.stdout.write('out-one')",
    "setTimeout(() => process.stderr.write('err-one'), 10)",
    "setTimeout(() => process.stdout.write('out-two'), 20)",
    'setTimeout(() => process.exit(0), 30)',
  ].join(';');
  const result = await runAsync(process.execPath, ['-e', script], { outputPath, timeoutMs: 5_000 });

  assert.equal(result.exitCode, 0);
  assert.equal(
    fs.readFileSync(outputPath, 'utf8'),
    'out-one\n--- stderr ---\nerr-one\n--- stdout ---\nout-two',
  );
});

test('runAsync kills the executor and removes its PID file when output writes fail', async (t) => {
  if (!fs.existsSync('/dev/full')) {
    t.skip('/dev/full is unavailable on this platform');
    return;
  }
  const root = tmpdir();
  const childPidPath = path.join(root, 'child.pid');
  const logPath = path.join(root, 'agentq.log');
  const script = [
    `require('node:fs').writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid))`,
    "process.stdout.write('trigger output failure')",
    'setInterval(() => {}, 1000)',
  ].join(';');

  await assert.rejects(
    runAsync(process.execPath, ['-e', script], {
      timeoutMs: 10_000,
      statePath: logPath,
      jobId: 7,
      outputPath: '/dev/full',
    }),
    /ENOSPC/,
  );

  const childPid = Number(fs.readFileSync(childPidPath, 'utf8'));
  assert.throws(() => process.kill(childPid, 0), /ESRCH/);
  assert.equal(fs.existsSync(path.join(root, 'logs', 'agentq-job-7.pid')), false);
});

test('prepareJobWorktree fails closed when git cannot create isolation', () => {
  const root = tmpdir();
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'test']);
  fs.writeFileSync(path.join(root, 'README.md'), 'seed\n');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'init']);

  assert.throws(
    () => prepareJobWorktree({ worktreePath: () => path.join(root, 'worktree') }, {
      id: 9,
      repo_path: root,
      base_branch: 'missing-branch',
    }),
    /Failed to create isolated worktree/,
  );
});

test('runOnce re-throws the original error even when sink.recover() itself throws', async () => {
  const root = tmpdir();
  // Force a post-claim throw: make the per-job log path a directory so the
  // streamed output log cannot be opened, producing an EISDIR-style error.
  const logPathJob = path.join(root, 'agentq-job-1.log');
  fs.mkdirSync(logPathJob, { recursive: true });

  const executor = path.join(root, 'fake-executor.sh');
  fs.writeFileSync(executor, '#!/usr/bin/env bash\necho ok\n', { mode: 0o755 });

  const fakeSink = {
    claim: async () => {},
    jobLogPath: () => logPathJob,
    worktreePath: () => path.join(root, 'unused-worktree'),
    finish: async () => { throw new Error('finish should not be reached'); },
    recover: async () => { throw new Error('recover exploded (e.g. a rejected stale claim)'); },
  };
  const job = { id: 1, kind: 'prompt', prompt: 'do work', repo_path: root, model: 'test-model', base_branch: 'main' };

  await assert.rejects(
    () => runOnce(job, { executor }, { sink: fakeSink }),
    (err) => {
      assert.match(err.message, /EISDIR|illegal operation/i, `expected the original EISDIR error, got: ${err.message}`);
      return true;
    },
  );
});
