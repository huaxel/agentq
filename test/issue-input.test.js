'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { drainParallel } = require('../src/interfaces/cli/agentq.js');

// These tests drive the claim paths in-process: never run the real quota
// collector (the refresh tests inject a fake one).
process.env.AGENTQ_QUOTA_REFRESH = '0';
const { SqliteSource, OrchestratorSource } = require('../src/queue/sources.js');
const { executeJob } = require('../src/runners/execute.js');
const { createIssueInput, validateIssueInput, fetchIssueInputAsync } = require('../src/core/issue-input.js');
const dbModule = require('../src/queue/db.js');

function rawIssue(number = 42, body = 'original body\n\n') {
  return { number, title: 'Original title', body, url: `https://github.com/test/repo/issues/${number}`, updatedAt: '2026-11-02T00:00:00Z' };
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  return { root, repo };
}

test('enqueue fetches once and requeue retains exact text and digest after the live issue changes', async t => {
  const { root, repo } = workspace(t);
  let live = rawIssue();
  let calls = 0;
  const source = new SqliteSource(path.join(root, 'queue.sqlite'), {
    issueRunner: (_cmd, args, options) => {
      calls++;
      assert.deepEqual(args, ['issue', 'view', '42', '--json', 'number,title,body,url,updatedAt']);
      assert.equal(options.cwd, repo);
      return JSON.stringify(live);
    },
  });
  await source.enqueue({ repo, issue: '42', base: 'main', model: 'test/model', trusted: true });
  assert.equal(calls, 1);
  const firstJob = await source.claimNext();
  const original = firstJob.issue_input;
  assert.equal(original.issue.body, 'original body\n\n');
  // Requeue only starts from a terminal status: finish the attempt first.
  await source.sink.finish(firstJob, { status: 'failed', exit: 1 });
  live = rawIssue(42, 'edited after enqueue');
  source.requeue({ id: firstJob.id });
  assert.deepEqual((await source.claimNext()).issue_input, original);
  assert.equal(calls, 1);
  await source.enqueue({ repo, issue: '42', base: 'main', model: 'test/model', trusted: true });
  assert.equal(calls, 2);
  const jobs = source.status();
  assert.equal(jobs[1].issue_input.issue.body, 'edited after enqueue');
  assert.deepEqual(jobs[0].issue_input, original);
});

test('failed GitHub capture leaves no enqueued job or approval record', async t => {
  const { root, repo } = workspace(t);
  const source = new SqliteSource(path.join(root, 'queue.sqlite'), {
    issueRunner: () => { throw new Error('sensitive upstream body'); },
  });
  await assert.rejects(source.enqueue({ repo, issue: '42', base: 'main', trusted: true }), /nothing was enqueued/i);
  assert.deepEqual(source.status(), []);
});

test('tampered or legacy issue inputs are refused before claim or executor launch', async t => {
  const { root, repo } = workspace(t);
  const source = new SqliteSource(path.join(root, 'queue.sqlite'), {
    issueRunner: () => JSON.stringify(rawIssue()),
  });
  await source.enqueue({ repo, issue: '42', base: 'main', model: 'test/model', trusted: true });
  const job = await source.claimNext();
  job.issue_input.issue.body = 'changed without its digest';
  const marker = path.join(root, 'launched');
  const executor = path.join(root, 'executor');
  fs.writeFileSync(executor, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  await assert.rejects(executeJob(job, { executor }, source), /pinned issue input/i);
  assert.equal(fs.existsSync(marker), false);
  // The captured input can never validate, so the refusal is terminal: the
  // task ends failed with the reason instead of being re-pended and re-refused.
  const refused = dbModule.getTask(source.db, job.id);
  assert.equal(refused.status, 'failed');
  assert.match(JSON.parse(refused.result).error, /pinned issue input/i);
  delete job.issue_input;
  await assert.rejects(executeJob(job, { executor }, source), /enqueue a new job/i);
});

test('remote enqueue persists the same canonical snapshot in its immutable prompt', async t => {
  const { root, repo } = workspace(t);
  const source = new OrchestratorSource('http://127.0.0.1:1', 'fixture', {
    issueRunner: () => JSON.stringify(rawIssue()),
    logBase: path.join(root, 'logs'), worktreeBase: path.join(root, 'worktrees'),
  });
  let stored;
  source.worker.enqueue = async task => { stored = task; return { id: 'task-1' }; };
  await source.enqueue({ repo, issue: '42', base: 'main', trusted: true });
  const snapshot = validateIssueInput(JSON.parse(stored.prompt), 42);
  assert.equal(snapshot.issue.body, 'original body\n\n');
});

test('approved issue input cannot be edited in place and approval records its digest', t => {
  const { root, repo } = workspace(t);
  const db = dbModule.openDb(path.join(root, 'queue.sqlite'));
  dbModule.initSchema(db);
  t.after(() => db.close());
  const input = createIssueInput(rawIssue());
  const task = dbModule.createTask(db, {
    kind: 'github_issue', repo, issue_num: 42, prompt: JSON.stringify(input), approval_required: true,
  });
  assert.throws(() => dbModule.updateTaskPrompt(db, task.id, 'replacement'), /immutable/i);
  dbModule.approveTask(db, task.id, 'reviewer');
  assert.throws(() => dbModule.updateTaskPrompt(db, task.id, 'replacement'), /immutable/i);
  const event = db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event = 'approved'").get(task.id);
  assert.equal(JSON.parse(event.payload).input_sha256, input.sha256);
});

test('changing the task kind cannot make issue-number inputs editable', t => {
  const { root, repo } = workspace(t);
  const db = dbModule.openDb(path.join(root, 'queue.sqlite'));
  dbModule.initSchema(db);
  t.after(() => db.close());
  const input = createIssueInput(rawIssue());
  const task = dbModule.createTask(db, {
    kind: 'prompt', repo, issue_num: 42, prompt: JSON.stringify(input), approval_required: true,
  });
  assert.throws(() => dbModule.updateTaskPrompt(db, task.id, 'replacement'), /immutable/i);
  dbModule.approveTask(db, task.id, 'reviewer');
  const event = db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event = 'approved'").get(task.id);
  assert.equal(JSON.parse(event.payload).input_sha256, input.sha256);
  assert.throws(() => dbModule.createTask(db, { kind: 'prompt', issue_num: 42, prompt: 'not pinned' }), /pinned issue input/i);
});

test('new issue API tasks reject missing or corrupted snapshots without creating tasks', t => {
  const { root, repo } = workspace(t);
  const db = dbModule.openDb(path.join(root, 'queue.sqlite'));
  dbModule.initSchema(db);
  t.after(() => db.close());
  assert.throws(() => dbModule.createTask(db, { kind: 'github_issue', repo, issue_num: 42, prompt: 'mutable issue reference' }), /pinned issue input/i);
  const input = createIssueInput(rawIssue());
  input.issue.title = 'tampered';
  assert.throws(() => dbModule.createTask(db, { kind: 'github_issue', repo, issue_num: 42, prompt: JSON.stringify(input) }), /pinned issue input/i);
  assert.equal(db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0);
});

test('server completion records the pinned digest and rejects mismatched reports atomically', t => {
  const { root, repo } = workspace(t);
  const db = dbModule.openDb(path.join(root, 'queue.sqlite'));
  dbModule.initSchema(db);
  t.after(() => db.close());
  const input = createIssueInput(rawIssue());
  const task = dbModule.createTask(db, { kind: 'github_issue', repo, issue_num: 42, prompt: JSON.stringify(input), model: 'test/model' });
  dbModule.claimNextTask(db, 'worker');
  assert.throws(() => dbModule.completeTask(db, task.id, { status: 'succeeded', input_sha256: 'wrong' }), /digest does not match/i);
  assert.equal(dbModule.getTask(db, task.id).status, 'running');
  dbModule.completeTask(db, task.id, { status: 'succeeded' });
  assert.equal(JSON.parse(dbModule.getTask(db, task.id).result).input_sha256, input.sha256);
  const event = db.prepare("SELECT payload FROM task_events WHERE task_id = ? AND event = 'completed'").get(task.id);
  assert.equal(JSON.parse(event.payload).input_sha256, input.sha256);
});

test('server completion refuses corrupted pinned snapshots', t => {
  const { root, repo } = workspace(t);
  const db = dbModule.openDb(path.join(root, 'queue.sqlite'));
  dbModule.initSchema(db);
  t.after(() => db.close());
  const input = createIssueInput(rawIssue());
  const task = dbModule.createTask(db, { kind: 'github_issue', repo, issue_num: 42, prompt: JSON.stringify(input), model: 'test/model' });
  dbModule.claimNextTask(db, 'worker');
  db.prepare('UPDATE tasks SET prompt = ? WHERE id = ?').run('corrupted snapshot', task.id);
  assert.throws(() => dbModule.completeTask(db, task.id, { status: 'succeeded' }), /pinned issue input/i);
  assert.equal(dbModule.getTask(db, task.id).status, 'running');
});

test('server capture uses a nonblocking bounded GitHub subprocess', async t => {
  const { root, repo } = workspace(t);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nsetTimeout(() => console.log(${JSON.stringify(JSON.stringify(rawIssue()))}), 80);\n`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous}`;
  t.after(() => { process.env.PATH = previous; });
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  try {
    const input = await fetchIssueInputAsync(repo, 42);
    assert.equal(input.issue.body, 'original body\n\n');
    assert.ok(ticks > 0);
  } finally { clearInterval(timer); }
});

test('canonical input validation preserves text but rejects ambiguity and malformed fields', () => {
  const input = createIssueInput(rawIssue());
  const reordered = { sha256: input.sha256, issue: input.issue, captured_at: input.captured_at, version: 1, type: input.type };
  assert.deepEqual(validateIssueInput(reordered, 42), input);
  assert.throws(() => validateIssueInput({ ...input, extra: 'unhashed' }, 42), /invalid pinned/i);
  assert.throws(() => validateIssueInput(input, 43), /invalid pinned/i);
  for (const body of ['nul\0body', '\ud800', 'x'.repeat(600 * 1024)]) {
    assert.throws(() => createIssueInput(rawIssue(42, body)), /invalid pinned/i);
  }
});

test('corrupt persisted input is rejected before a parallel claim is appended', async t => {
  const { root, repo } = workspace(t);
  const source = new SqliteSource(path.join(root, 'queue.sqlite'), { issueRunner: () => JSON.stringify(rawIssue()) });
  const { id } = await source.enqueue({ repo, issue: '42', base: 'main', trusted: true });
  const stored = JSON.parse(dbModule.getTask(source.db, id).prompt);
  stored.issue.body = 'tampered';
  source.db.prepare('UPDATE tasks SET prompt = ? WHERE id = ?').run(JSON.stringify(stored), id);
  const result = await drainParallel(source, { executor: '/must-not-launch' }, 2);
  assert.equal(result.ran, 0);
  assert.equal(result.blocked, 1);
  assert.equal(source.status()[0].status, 'blocked');
  assert.match(source.status()[0].input_error, /pinned issue input/i);
  assert.equal(dbModule.listTaskEvents(source.db, id).filter(event => event.event === 'claimed').length, 0);
});

test('legacy invalid input stays visible without starving an independent valid job', async t => {
  const { root, repo } = workspace(t);
  const source = new SqliteSource(path.join(root, 'queue.sqlite'), {
    issueRunner: (_command, args) => JSON.stringify(rawIssue(Number(args[2]))),
  });
  // A legacy row without a pinned snapshot (createTask would refuse it, so
  // this is inserted directly to model an imported pre-snapshot job).
  source.db.prepare(`INSERT INTO tasks (id, kind, status, repo, issue_num, prompt, model, trust_level, created_at)
    VALUES ('legacy-task', 'github_issue', 'pending', ?, 42, 'mutable issue reference', 'test/model', 'trusted_agent', ?)`)
    .run(repo, new Date().toISOString());
  await source.enqueue({ repo, issue: '43', base: 'main', model: 'test/model', trusted: true });
  const ran = path.join(root, 'ran');
  const executor = path.join(root, 'executor');
  fs.writeFileSync(executor, `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(ran)}\n`, { mode: 0o755 });
  const result = await drainParallel(source, { executor }, 2);
  assert.equal(result.succeeded, 1);
  assert.equal(result.blocked, 1);
  assert.equal(fs.readFileSync(ran, 'utf8'), '43');
  const [legacy, valid] = source.status();
  assert.equal(legacy.status, 'blocked');
  assert.match(legacy.input_error, /enqueue a new job/);
  assert.equal(valid.status, 'succeeded');
  assert.equal(dbModule.getTask(source.db, 'legacy-task').prompt, 'mutable issue reference', 'the legacy row is never rewritten');
});

test('generic prompt executors without an issue number retain their existing contract', async t => {
  const { root, repo } = workspace(t);
  const source = new SqliteSource(path.join(root, 'queue.sqlite'));
  dbModule.createTask(source.db, { kind: 'prompt', repo, model: 'test/model', prompt: 'custom request', trust_level: 'trusted_agent' });
  const executor = path.join(root, 'executor');
  fs.writeFileSync(executor, '#!/bin/sh\necho custom-executor\n', { mode: 0o755 });
  const result = await executeJob(await source.claimNext({ kind: 'prompt' }), { executor }, source);
  assert.equal(result.status, 'succeeded');
});

for (const { workflow, stripAll } of [
  { workflow: false, stripAll: true }, { workflow: true, stripAll: true },
  { workflow: false, stripAll: false }, { workflow: true, stripAll: false },
]) {
  test(`queued execution cannot refetch when a sandbox strips context (workflow=${workflow}, all=${stripAll})`, async t => {
    const { root, repo } = workspace(t);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
    const source = new SqliteSource(path.join(root, 'queue.sqlite'), { issueRunner: () => JSON.stringify(rawIssue()) });
    await source.enqueue({ repo, issue: '42', base: 'main', model: 'test/model', trusted: true });
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    const fetched = path.join(root, 'unexpected-fetch');
    const launched = path.join(root, 'unexpected-model');
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ntouch ${JSON.stringify(fetched)}\nexit 99\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'pi'), `#!/bin/sh\ncat >/dev/null\ntouch ${JSON.stringify(launched)}\n`, { mode: 0o755 });
    const sandbox = path.join(root, 'sandbox');
    const launch = stripAll
      ? `exec env -i PATH=${JSON.stringify(bin + path.delimiter + process.env.PATH)} "$@"`
      : `export PATH=${JSON.stringify(bin + path.delimiter + process.env.PATH)}\nunset AGENTQ_WORKTREE\nexec "$@"`;
    fs.writeFileSync(sandbox, `#!/bin/sh\n${launch}\n`, { mode: 0o755 });
    const job = await source.claimNext();
    const result = await executeJob(job, { workflow, sandbox }, source);
    assert.equal(result.status, 'failed');
    assert.equal(fs.existsSync(fetched), false);
    assert.equal(fs.existsSync(launched), false);
    assert.match(fs.readFileSync(source.sink.jobLogPath(job.id), 'utf8'), /Queued input metadata is missing/);
  });
}

for (const mode of ['valid', 'stripped', 'wrong-digest']) {
  test(`Jules uses pinned stdin without live issue or repository lookup (${mode})`, t => {
    const { repo } = workspace(t);
    const input = createIssueInput(rawIssue(42, 'Pinned Jules body: `literal` and $shell\n\n'));
    const env = { PATH: process.env.PATH };
    if (mode !== 'stripped') Object.assign(env, {
      AGENTQ_PINNED_INPUT: '1', AGENTQ_INPUT_SHA256: mode === 'wrong-digest' ? 'a'.repeat(64) : input.sha256,
      AGENTQ_WORKTREE: repo, BASE_BRANCH: 'main',
    });
    const script = `
      require('node:child_process').execFileSync = () => { throw new Error('unexpected gh/git lookup'); };
      global.fetch = () => { throw new Error('unexpected network'); };
      const api = require(${JSON.stringify(require.resolve('../src/lib/jules-api.js'))});
      api.listSources = async () => [{ name: 'sources/test/repo' }];
      api.createSession = async options => {
        process.stdout.write(JSON.stringify(options));
        throw new Error('fixture-stop-before-cloud-session');
      };
      process.argv = [process.execPath, 'fixture', '42', 'test/model', '--agentq-pinned-input'];
      require(${JSON.stringify(require.resolve('../src/runners/jules-issue.js'))}).main().catch(error => {
        process.stderr.write(error.message);
        process.exitCode = error.message === 'fixture-stop-before-cloud-session' ? 17 : 19;
      });
    `;
    const result = spawnSync(process.execPath, ['-e', script], {
      env, input: JSON.stringify(input), encoding: 'utf8', timeout: 5000,
    });
    assert.ifError(result.error);
    if (mode === 'valid') {
      assert.equal(result.status, 17, result.stderr);
      const options = JSON.parse(result.stdout);
      assert.equal(options.source, 'sources/test/repo');
      assert.equal(options.baseBranch, 'main');
      assert.ok(options.prompt.includes(input.issue.title));
      assert.ok(options.prompt.includes(input.issue.body));
    } else {
      assert.equal(result.status, 19, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, mode === 'stripped' ? /requires pinned input metadata/ : /invalid pinned issue input/i);
    }
  });
}

test('invalid remotely claimed input releases the claim without retries', async () => {
  const input = createIssueInput(rawIssue());
  input.issue.body = 'tampered';
  let refusal;
  await assert.rejects(executeJob({ id: 'remote', kind: 'github_issue', issue_number: 42, issue_input: input, trusted: true }, {}, {
    claimIsRemote: true,
    sink: { recover: async (...args) => { refusal = args; } },
  }), /pinned issue input/i);
  assert.deepEqual(refusal[2], { retryable: false });
});

for (const workflow of [false, true]) {
  for (const sandboxed of [false, true]) {
    test(`built-in execution reuses exact pinned input across retry (workflow=${workflow}, sandbox=${sandboxed})`, { timeout: 20_000 }, async t => {
      const { root, repo } = workspace(t);
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
      const canary = path.join(root, 'must-not-execute');
      const body = 'deja\u0300\ud83d\ude42\n'.repeat(9000) + `\n$(touch ${canary})\n\n`;
      let live = rawIssue(42, body);
      let captures = 0;
      const source = new SqliteSource(path.join(root, 'queue.sqlite'), {
        issueRunner: () => { captures++; return JSON.stringify(live); },
      });
      await source.enqueue({ repo, issue: '42', base: 'main', model: 'test/model', trusted: true });
      // claimNext commits the claim, so the same job object is executed below.
      const job = await source.claimNext();
      const pinned = job.issue_input;
      live = rawIssue(42, 'replacement live requirements');
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      const ghCalled = path.join(root, 'unexpected-gh');
      fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ntouch ${JSON.stringify(ghCalled)}\nexit 99\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'jq'), `#!${process.execPath}\nconst a=process.argv.slice(2); console.log(JSON.stringify(a.includes('-Rs') ? require('node:fs').readFileSync(0,'utf8') : a[a.indexOf('--arg')+2]));\n`, { mode: 0o755 });
      const count = path.join(root, 'count');
      fs.writeFileSync(path.join(bin, 'pi'), `#!${process.execPath}\nconst fs=require('node:fs');const file=${JSON.stringify(count)};const n=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8'))+1:1;fs.writeFileSync(file,String(n));fs.writeFileSync(${JSON.stringify(path.join(root, 'prompt-'))}+n,fs.readFileSync(0));process.exitCode=n===1?7:0;\n`, { mode: 0o755 });
      const previous = process.env.PATH;
      process.env.PATH = `${bin}${path.delimiter}${previous}`;
      t.after(() => { process.env.PATH = previous; });
      const sandbox = path.join(root, 'sandbox');
      fs.writeFileSync(sandbox, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
      const result = await executeJob(job, {
        workflow, retries: 1, retryBaseMs: 0, ...(sandboxed ? { sandbox } : {}),
      }, source);
      assert.equal(result.status, 'succeeded');
      assert.equal(result.retries, 1);
      assert.equal(captures, 1);
      assert.equal(fs.existsSync(ghCalled), false);
      assert.equal(fs.existsSync(canary), false);
      for (const n of [1, 2]) {
        const prompt = fs.readFileSync(path.join(root, `prompt-${n}`), 'utf8');
        assert.ok(prompt.includes(body), 'preserve Unicode, shell-like text and trailing newlines');
        assert.ok(!prompt.includes('replacement live requirements'));
      }
      const completed = dbModule.listTaskEvents(source.db, job.id).filter(event => event.event === 'completed');
      assert.equal(completed.length, 2);
      assert.deepEqual(completed.map(event => JSON.parse(event.payload).input_sha256), [pinned.sha256, pinned.sha256]);
    });
  }
}
