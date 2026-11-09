'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { executeJob } = require('../src/runners/execute.js');
const { SqliteSource } = require('./helpers/pinned-issue.js');
const { emitResult, resultPayload } = require('./helpers/result-file.js');
const dbModule = require('../src/queue/db.js');

const ROOT = path.resolve(__dirname, '..');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-integrity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, '-c', 'user.name=AgentQ Test',
    '-c', 'user.email=agentq@example.test', '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-m', 'fixture'], { stdio: 'ignore' });
  return { root, repo };
}

function script(root, name, body) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  return file;
}

function stubTools(root) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  script(bin, 'gh', `printf '%s\\n' '{"number":42,"title":"fixture-issue","body":"fixture body"}'`);
  script(bin, 'pi', 'cat >/dev/null\nexit "$FAKE_PI_EXIT"');
  // Only JSON string encoding is used by these wrappers. Keep the tests
  // independent of an installed jq and do not invoke a real model or GitHub.
  fs.writeFileSync(path.join(bin, 'jq'), `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst value = args.includes('-Rs') ? require('node:fs').readFileSync(0, 'utf8') : args[args.indexOf('--arg') + 2];\nconsole.log(JSON.stringify(value));\n`, { mode: 0o755 });
  return bin;
}

function standaloneFixture(t) {
  const { root, repo } = fixture(t);
  const bin = stubTools(root);
  const invoked = path.join(root, 'pi-invoked');
  script(bin, 'pi', `cat >/dev/null\ntouch ${JSON.stringify(invoked)}\nexit 0`);
  const tmp = path.join(root, 'standalone-tmp');
  fs.mkdirSync(tmp);
  const git = (args, cwd = repo) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const run = (wrapper, reuse = '') => spawnSync('bash', [path.join(ROOT, wrapper), '42', 'test/model'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      TMPDIR: tmp,
      BASE_BRANCH: 'main',
      AGENTQ_WORKTREE: reuse,
      AGENTQ_BRANCH: '',
      AGENTQ_STOP_WHEN: '',
      AGENTQ_WORKFLOW_SCRIPT: '',
      AGENTQ_WORKFLOW_ARGS: '',
    },
  });
  return { root, repo, invoked, git, run };
}

for (const wrapper of ['pi-issue.sh', 'pi-workflow.sh']) {
  for (const state of ['clean', 'dirty', 'removed']) {
    test(`${wrapper} refuses to replace an existing standalone branch (${state})`, t => {
      const { root, invoked, git, run } = standaloneFixture(t);
      const retained = path.join(root, 'retained');
      git(['worktree', 'add', '-b', 'pi/issue-42', retained, 'main']);
      fs.writeFileSync(path.join(retained, 'result.txt'), 'previous implementation\n');
      git(['add', 'result.txt'], retained);
      git(['-c', 'user.name=AgentQ Test', '-c', 'user.email=agentq@example.test',
        '-c', 'commit.gpgsign=false', 'commit', '-m', 'retained result'], retained);
      const tip = git(['rev-parse', 'refs/heads/pi/issue-42']).trim();
      if (state === 'dirty') {
        fs.writeFileSync(path.join(retained, 'result.txt'), 'uncommitted edit\n');
        fs.writeFileSync(path.join(retained, 'notes.txt'), 'untracked work\n');
      } else if (state === 'removed') {
        git(['worktree', 'remove', retained]);
      }
      const result = run(wrapper);
      assert.ifError(result.error);
      assert.notEqual(result.status, 0, 'a collision requires an explicit human decision');
      assert.match(result.stderr, /existing branch|already exists/i);
      assert.equal(git(['rev-parse', 'refs/heads/pi/issue-42']).trim(), tip);
      assert.equal(fs.existsSync(invoked), false, 'do not launch pi on a replacement checkout');
      if (state !== 'removed') {
        assert.equal(fs.readFileSync(path.join(retained, 'result.txt'), 'utf8'),
          state === 'dirty' ? 'uncommitted edit\n' : 'previous implementation\n');
        assert.match(git(['worktree', 'list', '--porcelain']), /branch refs\/heads\/pi\/issue-42/);
      }
      if (state === 'dirty') assert.equal(fs.readFileSync(path.join(retained, 'notes.txt'), 'utf8'), 'untracked work\n');
    });
  }

  test(`${wrapper} still creates a fresh standalone worktree`, t => {
    const { invoked, git, run } = standaloneFixture(t);
    const result = run(wrapper);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(invoked), true);
    assert.equal(git(['rev-parse', 'refs/heads/pi/issue-42']), git(['rev-parse', 'main']));
  });

  test(`${wrapper} permits explicit reuse without discarding dirty work`, t => {
    const { root, invoked, git, run } = standaloneFixture(t);
    const retained = path.join(root, 'retained');
    git(['worktree', 'add', '-b', 'pi/issue-42', retained, 'main']);
    fs.writeFileSync(path.join(retained, 'notes.txt'), 'keep me\n');
    const result = run(wrapper, retained);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(invoked), true);
    assert.equal(fs.readFileSync(path.join(retained, 'notes.txt'), 'utf8'), 'keep me\n');
  });

  for (const exitCode of [0, 7]) {
    test(`${wrapper} preserves pi exit ${exitCode} after printing diagnostics`, t => {
      const { root, repo } = fixture(t);
      const bin = stubTools(root);
      const result = spawnSync('bash', [path.join(ROOT, wrapper), '42', 'test/model'], {
        cwd: repo,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          BASE_BRANCH: 'main',
          AGENTQ_WORKTREE: repo,
          AGENTQ_BRANCH: 'main',
          AGENTQ_STOP_WHEN: '',
          AGENTQ_WORKFLOW_SCRIPT: '',
          AGENTQ_WORKFLOW_ARGS: '',
          FAKE_PI_EXIT: String(exitCode),
        },
      });
      assert.ifError(result.error);
      assert.equal(result.status, exitCode, result.stderr);
      assert.match(result.stdout, new RegExp(`pi exit code: ${exitCode}`));
      assert.match(result.stdout, /worktree\s*:/, 'diagnostics must still be emitted');
    });
  }

  test(`${wrapper} failure keeps queue dependencies blocked even with passing verification`, async t => {
    const { root, repo } = fixture(t);
    const bin = stubTools(root);
    // Scope the stub PATH and exit code to this executor, not the test process.
    const executor = script(root, 'executor.sh', `
      export PATH=${JSON.stringify(bin)}:"$PATH"
      export FAKE_PI_EXIT=7
      exec bash ${JSON.stringify(path.join(ROOT, wrapper))} "$@"
    `);
    const source = new SqliteSource(path.join(root, 'queue.sqlite'));
    const first = await source.enqueue({ repo, issue: '42', model: 'test/model', base: 'main', trusted: true });
    await source.enqueue({ repo, issue: '43', model: 'test/model', base: 'main', trusted: true, dependsOn: first.id });
    const job = await source.claimNext();
    const verificationMarker = path.join(root, 'verification-ran');
    const result = await executeJob(job, {
      executor,
      verify: `touch ${JSON.stringify(verificationMarker)}`,
    }, source);
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 7);
    assert.equal(fs.existsSync(verificationMarker), false, 'failed execution must not proceed to verification');
    assert.deepEqual(source.status().map(j => j.status), ['failed', 'blocked']);
  });
}

test('a timed-out executor cannot succeed by exiting zero during SIGTERM cleanup', async t => {
  const { root, repo } = fixture(t);
  const executor = path.join(root, 'executor');
  fs.writeFileSync(executor, `#!${process.execPath}\nprocess.on('SIGTERM', () => process.exit(0));\nconsole.log('termination-handler-ready');\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  const first = await source.enqueue({ repo, issue: '42', model: 'test/model', base: 'main', trusted: true });
  await source.enqueue({ repo, issue: '43', model: 'test/model', base: 'main', trusted: true, dependsOn: first.id });
  const job = await source.claimNext();
  const verificationMarker = path.join(root, 'verification-ran');
  const result = await executeJob(job, {
    executor,
    timeout: 5000,
    verify: `touch ${JSON.stringify(verificationMarker)}`,
  }, source);
  const log = fs.readFileSync(source.sink.jobLogPath(job.id), 'utf8');
  assert.match(log, /termination-handler-ready/);
  assert.match(log, /timed out after/);
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 124);
  assert.equal(source.status()[0].exit_code, 124);
  assert.equal(fs.existsSync(verificationMarker), false);
  assert.deepEqual(source.status().map(j => j.status), ['failed', 'blocked']);
});

test('manual requeue preserves earlier transcript bytes and verification evidence', async t => {
  const { root, repo } = fixture(t);
  const executor = script(root, 'executor.sh', 'echo executor-evidence');
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  const { id } = await source.enqueue({ repo, issue: '42', model: 'test/model', base: 'main', trusted: true });
  const log = source.sink.jobLogPath(id);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, 'legacy evidence without trailing newline\n"usage":{"totalCost":999}\nSHOULD_FULLY_STOP=true');
  const first = await executeJob(await source.claimNext(), {
    executor, verify: 'echo first-verification-evidence; exit 9',
  }, source);
  assert.equal(first.status, 'unverified');
  const previous = fs.readFileSync(log);
  assert.ok(previous.toString().startsWith('legacy evidence without trailing newline'));
  source.requeue({ id });
  const second = await executeJob(await source.claimNext(), {
    executor, verify: 'echo second-verification-evidence', stopWhen: 'retention test',
  }, source);
  assert.equal(second.status, 'succeeded');
  assert.equal(second.stop, false);
  assert.equal(source.status()[0].usage_json, null);
  const current = fs.readFileSync(log);
  assert.deepEqual(current.subarray(0, previous.length), previous, 'previous evidence must remain byte-identical');
  assert.match(current.toString(), /first-verification-evidence/);
  assert.match(current.toString(), /second-verification-evidence/);
  assert.equal(source.status()[0].verified, 1);
});

test('transcript sync failure is surfaced before completion is recorded', async t => {
  const { root, repo } = fixture(t);
  const executor = script(root, 'executor.sh', 'echo evidence-before-sync');
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  const { id } = await source.enqueue({ repo, issue: '42', model: 'test/model', base: 'main', trusted: true });
  const log = source.sink.jobLogPath(id);
  const failure = new Error('transcript fsync failed');
  const sync = fs.fsyncSync;
  let evidenceSyncAttempted = false;
  t.mock.method(fs, 'fsyncSync', fd => {
    if (fs.existsSync(log)) {
      const transcript = fs.statSync(log);
      const opened = fs.fstatSync(fd);
      if (transcript.dev === opened.dev && transcript.ino === opened.ino) {
        evidenceSyncAttempted = true;
        throw failure;
      }
    }
    return sync(fd);
  });
  await assert.rejects(executeJob(await source.claimNext(), { executor }, source), error => error === failure);
  assert.equal(evidenceSyncAttempted, true);
  assert.equal(source.status()[0].status, 'pending');
  const events = dbModule.listTaskEvents(source.db, source.status()[0].id).map(event => event.event);
  assert.ok(!events.includes('completed'), 'no completion may be recorded');
  assert.match(fs.readFileSync(log, 'utf8'), /evidence-before-sync/);
});

test('an asynchronous accounting failure is reported without reopening completed work', async t => {
  const { root, repo } = fixture(t);
  const executor = script(root, 'executor.sh', emitResult(root, resultPayload({
    usage: { inputTokens: 1, outputTokens: 1, totalCost: 0.001 },
  })));
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  await source.enqueue({ repo, issue: '42', model: 'test/model', base: 'main', trusted: true });
  const failure = new Error('asynchronous accounting failure');
  source.sink.recordUsage = async () => { throw failure; };
  const job = await source.claimNext();
  await assert.rejects(executeJob(job, { executor }, source), error => error === failure);
  assert.equal(source.status()[0].status, 'succeeded');
  assert.equal(await source.claimNext(), null);
});

for (const status of ['succeeded', 'failed', 'unverified']) {
  test(`post-completion callback failure preserves the ${status} result`, async t => {
    const { root, repo } = fixture(t);
    const executor = script(root, 'executor.sh', status === 'failed' ? 'exit 7' : 'echo done');
    const source = new SqliteSource(path.join(root, 'queue.sqlite'));
    source.enqueue({ repo, issue: '42', model: 'test/model', base: 'main', trusted: true });
    const failure = new Error('callback failure');
    source.sink.fireCallback = async () => { throw failure; };
    const job = await source.claimNext();
    const options = { executor, verify: status === 'unverified' ? 'false' : 'true' };
    await assert.rejects(executeJob(job, options, source), error => error === failure);
    const [stored] = source.status();
    assert.equal(stored.status, status);
    assert.equal(stored.exit_code, status === 'failed' ? 7 : 0);
    assert.equal(await source.claimNext(), null);
    const events = dbModule.listTaskEvents(source.db, source.status()[0].id).map(event => event.event);
    assert.ok(!events.includes('recovered'), 'a persisted completion must not be reopened');
  });
}

test('completion persistence failure still recovers the claim and preserves its error', async t => {
  const { root, repo } = fixture(t);
  const executor = script(root, 'executor.sh', 'echo done');
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  await source.enqueue({ repo, issue: '42', model: 'test/model', base: 'main', trusted: true });
  const failure = new Error('completion not persisted');
  source.sink.finish = async () => { throw failure; };
  let bookkeepingRan = false;
  source.sink.fireCallback = async () => { bookkeepingRan = true; };
  const job = await source.claimNext();
  await assert.rejects(executeJob(job, { executor }, source), error => error === failure);
  assert.equal(source.status()[0].status, 'pending');
  assert.equal(bookkeepingRan, false);
  const events = dbModule.listTaskEvents(source.db, source.status()[0].id).map(event => event.event);
  assert.ok(events.includes('recovered'), 'the claim must be released back to pending');
});

for (const sandboxed of [false, true]) {
  for (const markerInCheckout of [false, true]) {
    test(`managed checkout owns verification despite a scratch label (sandbox=${sandboxed}, actual proof=${markerInCheckout})`, async t => {
      const { root, repo } = fixture(t);
      const scratch = path.join(root, 'scratch');
      fs.mkdirSync(scratch);
      if (!markerInCheckout) fs.writeFileSync(path.join(scratch, 'proof'), 'decoy');
      const executor = script(root, 'executor.sh', `
        ${markerInCheckout ? 'touch proof' : ':'}
        printf 'worktree: %s\\n' ${JSON.stringify(scratch)}
        echo 'branch: main'
      `);
      const sandbox = sandboxed ? script(root, 'sandbox.sh', 'exec "$@"') : undefined;
      const source = new SqliteSource(path.join(root, 'queue.sqlite'));
      source.enqueue({ repo, issue: '42', model: 'test/model', base: 'main', trusted: true });
      const job = await source.claimNext();
      const result = await executeJob(job, { executor, sandbox, verify: 'test -f proof' }, source);
      const stored = source.status()[0];
      assert.equal(result.status, markerInCheckout ? 'succeeded' : 'unverified');
      assert.equal(stored.verified, markerInCheckout ? 1 : 0);
      assert.equal(stored.branch, `agentq/job-${job.id}`);
      assert.equal(fs.realpathSync(stored.worktree_path), fs.realpathSync(source.sink.worktreePath(job.id)));
    });
  }
}
