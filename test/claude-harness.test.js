'use strict';
/**
 * Claude Code harness: claude-issue.sh keeps pi-issue.sh's argument/stdin/env
 * contract, and resolveExecutor picks it from the runnable's `harness`.
 *
 * A fake `claude` on PATH records argv/stdin/cwd and prints a canned JSON
 * result — the real CLI is never invoked with a prompt.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { githubEnv, taskInputForIssue, SqliteSource } = require('./helpers/pinned-issue.js');
const AGENTQ = require.resolve('../src/interfaces/cli/agentq.js');
const { drain } = require('../src/interfaces/cli/agentq.js');

// These tests drive the claim paths in-process: never run the real quota
// collector (the refresh tests inject a fake one).
process.env.AGENTQ_QUOTA_REFRESH = '0';
const { resolveExecutor, runOnce } = require('../src/runners/execute.js');
const { readResultFile } = require('../src/runners/result-file.js');
const dbModule = require('../src/queue/db.js');

const ROOT = path.join(__dirname, '..');
// resolveExecutor reads the runnable harnesses from AGENTQ_HOME, so point it at
// a temp home with just the runnables these tests exercise.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-harness-home-'));
fs.mkdirSync(path.join(HOME, 'config'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config', 'runnables.json'), JSON.stringify({
  schemaVersion: 1,
  runnables: [
    { id: 'claude/claude-sonnet-5-5', path: 'claudemax', modelKey: null, harness: 'claude' },
    { id: 'claude/claude-opus-5-5', path: 'claudemax', modelKey: null, harness: 'claude' },
    { id: 'claude/claude-haiku-5-5', path: 'claudemax', modelKey: null, harness: 'claude' },
    { id: 'openai-codex/gpt-5.6-sol', path: 'codex', modelKey: null, harness: 'pi' },
  ],
}));
process.env.AGENTQ_HOME = HOME;

const SCRIPT = path.join(ROOT, 'claude-task.sh');
const PI_EXECUTOR = path.join(ROOT, 'pi-task.sh');
const CLAUDE_EXECUTOR = path.join(ROOT, 'claude-task.sh');
const CLAUDE_MODEL = 'claude/claude-sonnet-5-5';
const SESSION_ID = 'sess-claude-0001';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-harness-'));
}

/** Environment with the executor's own variables cleared unless a test sets them. */
function baseEnv(extra = {}) {
  // Tests never run the real quota collector; the refresh tests inject a fake.
  const env = { ...process.env, AGENTQ_QUOTA_REFRESH: '0', ...extra };
  for (const key of [
    'AGENTQ_PINNED_INPUT', 'AGENTQ_INPUT_SHA256', 'AGENTQ_WORKTREE', 'AGENTQ_BRANCH',
    'AGENTQ_JOB_ID', 'AGENTQ_STOP_WHEN', 'AGENTQ_MAX_TURNS', 'BASE_BRANCH',
  ]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

function runCli(args, env = {}, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [AGENTQ, ...args], {
      encoding: 'utf8',
      env: baseEnv({ ...githubEnv(), ...env }),
      timeout: 60_000,
      ...opts,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    return { exitCode: err.status ?? 1, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

function runScript(args, env = {}, opts = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: baseEnv(env),
    ...opts,
  });
}

function makeGitRepo(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-b', 'master'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'agentq@example.test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'AgentQ Test'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'README.md'), 'test\n');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init'], { stdio: 'ignore' });
  return repo;
}

/**
 * Fake `claude` on PATH: records argv/stdin/cwd, prints one JSON result object
 * in the shape `claude -p --output-format json` produces.
 */
function writeFakeClaude(root, { exit = 0, result = 'Implemented the issue.', isError = false, stdout = null } = {}) {
  const dir = path.join(root, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const record = path.join(root, 'claude-call.json');
  fs.writeFileSync(path.join(dir, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  argv: process.argv.slice(2),
  stdin,
  cwd: process.cwd(),
  worktree: process.env.AGENTQ_WORKTREE ?? null,
  maxTurns: process.env.AGENTQ_MAX_TURNS ?? null,
}));
if (${JSON.stringify(stdout)} !== null) {
  process.stdout.write(${JSON.stringify(stdout)});
  process.exit(${exit});
}
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: ${JSON.stringify(isError ? 'error_during_execution' : 'success')},
  is_error: ${isError},
  duration_ms: 1234,
  num_turns: 3,
  result: ${JSON.stringify(result)},
  session_id: ${JSON.stringify(SESSION_ID)},
  total_cost_usd: 0.4321,
  usage: {
    input_tokens: 1200,
    output_tokens: 340,
    cache_read_input_tokens: 5600,
    cache_creation_input_tokens: 700,
  },
  modelUsage: { 'claude-sonnet-5-5': { inputTokens: 1200, outputTokens: 340 } },
}));
process.exit(${exit});
`, { mode: 0o755 });
  return { dir, record, read: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
}

function jobs(db) {
  const result = runCli(['--db', db, 'status', '--json']);
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function openDb(dbPath) {
  const db = dbModule.openDb(dbPath);
  dbModule.initSchema(db);
  return db;
}

test('a claude-harness job runs Claude Code headless in the job worktree', () => {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const fake = writeFakeClaude(root, { result: 'All checks pass.\nSHOULD_FULLY_STOP=true' });
  const env = { PATH: `${fake.dir}${path.delimiter}${githubEnv().PATH}`, AGENTQ_MAX_TURNS: '7' };

  const enqueued = runCli([
    '--db', db, 'enqueue', '--repo', repo, '--issue', '77',
    '--model', CLAUDE_MODEL, '--base', 'master', '--trusted', '--json',
  ], env);
  assert.equal(enqueued.exitCode, 0, enqueued.stderr);
  const { id } = JSON.parse(enqueued.stdout);

  const ran = runCli(['--db', db, 'run-next', '--stop-when', 'ship the fix', '--json'], env);
  assert.equal(ran.exitCode, 0, ran.stderr);
  assert.deepEqual(JSON.parse(ran.stdout), { id, status: 'succeeded', exitCode: 0, stop: true });

  const call = fake.read();
  // Model prefix stripped, edits accepted, no permission bypass, max-turns from env.
  assert.deepEqual(call.argv, [
    '-p', '--model', 'claude-sonnet-5-5',
    '--output-format', 'json',
    '--permission-mode', 'acceptEdits',
    '--settings', path.join(ROOT, 'config', 'defaults', 'claude-job-settings.json'),
    '--max-turns', '7',
  ]);
  assert.ok(
    !call.argv.some((arg) => /dangerously-skip-permissions|bypassPermissions|dontAsk/.test(arg)),
    'the harness must not bypass Claude Code permissions',
  );
  // Prompt arrives on stdin, never in argv.
  assert.match(call.stdin, /Issue #77: Fixture issue/);
  assert.match(call.stdin, /fixture body/);
  assert.match(call.stdin, /ship the fix/);
  assert.ok(!call.argv.some((arg) => arg.includes('Fixture issue')));

  // The executor runs inside the agentq-managed worktree, not the source repo.
  const worktree = path.join(root, 'worktrees', `job-${id}`);
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(worktree));
  assert.notEqual(fs.realpathSync(call.cwd), fs.realpathSync(repo));
  assert.equal(call.worktree, worktree);

  const [job] = jobs(db);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.branch, `agentq/job-${id}`);
  assert.equal(job.session_path, SESSION_ID);
  const usage = JSON.parse(job.usage_json);
  assert.equal(usage.totalCost, 0.4321);
  assert.equal(usage.cacheReadTokens, 5600);
  assert.equal(usage.cacheWriteTokens, 700);
  assert.equal(usage.provider, 'claude');
  assert.equal(usage.model, 'claude-sonnet-5-5');

  // Cache-aware usage lands in the shared store, priced from total_cost_usd.
  const handle = openDb(db);
  try {
    const [record] = dbModule.getUsageByTask(handle, id);
    assert.equal(record.input_tokens, 1200);
    assert.equal(record.output_tokens, 340);
    assert.equal(record.cache_tokens, 6300);
    assert.equal(record.cost, 0.4321);
    assert.equal(record.provider, 'claude');
    assert.equal(record.model, 'claude-sonnet-5-5');
  } finally {
    handle.close();
  }
});

test('claude-task.sh writes the session, usage and stop sentinel to AGENTQ_RESULT', () => {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const worktree = path.join(root, 'reused-worktree');
  fs.mkdirSync(worktree);
  const resultPath = path.join(root, 'result.json');
  const fake = writeFakeClaude(root, { result: 'Done.\nSHOULD_FULLY_STOP=true' });
  const snapshot = taskInputForIssue(42, 'fixture body');

  const result = runScript(['42', CLAUDE_MODEL, '--agentq-pinned-input'], {
    PATH: `${fake.dir}${path.delimiter}${process.env.PATH}`,
    AGENTQ_PINNED_INPUT: '1',
    AGENTQ_INPUT_SHA256: snapshot.sha256,
    AGENTQ_WORKTREE: worktree,
    BASE_BRANCH: 'master',
    AGENTQ_RESULT: resultPath,
  }, { cwd: repo, input: JSON.stringify(snapshot) });

  assert.equal(result.status, 0, result.stderr);
  // The machine-readable result is the only channel agentq reads.
  const written = readResultFile(resultPath);
  assert.equal(written.ok, true, written.detail);
  assert.equal(written.value.session, SESSION_ID);
  assert.equal(written.value.worktree, worktree);
  assert.equal(written.value.branch, 'claude/issue-42');
  assert.equal(written.value.stop, true);
  assert.equal(written.value.verification, null);
  assert.equal(written.value.usage.totalCost, 0.4321);
  assert.equal(written.value.usage.cacheReadTokens, 5600);
  assert.equal(written.value.usage.provider, 'claude');
  assert.equal(fs.statSync(resultPath).mode & 0o777, 0o600, 'the result file stays private');

  const call = fake.read();
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(worktree));
  assert.ok(!call.argv.includes('--max-turns'), 'no --max-turns without AGENTQ_MAX_TURNS');
});

test('claude-task.sh keeps pi-task.sh argument and pinned-input contract', () => {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const worktree = path.join(root, 'reused-worktree');
  fs.mkdirSync(worktree);
  const fake = writeFakeClaude(root);
  const env = { PATH: `${fake.dir}${path.delimiter}${process.env.PATH}` };
  const snapshot = taskInputForIssue(42, 'fixture body');
  const pinned = {
    AGENTQ_PINNED_INPUT: '1',
    AGENTQ_INPUT_SHA256: snapshot.sha256,
    AGENTQ_WORKTREE: worktree,
    BASE_BRANCH: 'master',
  };

  // Usage errors: no issue, no model, and a flag in the model position.
  for (const args of [[], ['42'], ['42', '--agentq-pinned-input']]) {
    const result = runScript(args, env, { cwd: repo });
    assert.equal(result.status, 2, `args ${JSON.stringify(args)}`);
    assert.match(result.stderr, /usage: claude-task\.sh <issue-number\|task-id> <provider\/model>/);
  }

  // Pinned-input metadata missing from the environment.
  const missing = runScript(['42', CLAUDE_MODEL, '--agentq-pinned-input'], env, {
    cwd: repo, input: JSON.stringify(snapshot),
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Queued input metadata is missing/);

  // A queued job (AGENTQ_JOB_ID) must never fall back to a live gh fetch.
  const queued = runScript(['42', CLAUDE_MODEL], { ...env, AGENTQ_JOB_ID: 'job-1' }, { cwd: repo });
  assert.equal(queued.status, 1);
  assert.match(queued.stderr, /Queued task execution requires pinned input/);

  // A tampered snapshot is refused rather than replaced with live text.
  const tampered = runScript(['42', CLAUDE_MODEL, '--agentq-pinned-input'], {
    ...env, ...pinned, AGENTQ_INPUT_SHA256: 'deadbeef',
  }, { cwd: repo, input: JSON.stringify(snapshot) });
  assert.equal(tampered.status, 1);
  assert.match(tampered.stderr, /Invalid task input/);

  // A snapshot for a different issue number is refused too.
  const wrongIssue = runScript(['43', CLAUDE_MODEL, '--agentq-pinned-input'], {
    ...env, ...pinned,
  }, { cwd: repo, input: JSON.stringify(snapshot) });
  assert.equal(wrongIssue.status, 1);
  assert.match(wrongIssue.stderr, /Invalid task input/);

  // None of the refusals may launch Claude Code.
  assert.equal(fs.existsSync(fake.record), false, 'no refusal may reach the model');
});

test('claude-task.sh rejects a malformed AGENTQ_MAX_TURNS', () => {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const worktree = path.join(root, 'reused-worktree');
  fs.mkdirSync(worktree);
  const fake = writeFakeClaude(root);
  const snapshot = taskInputForIssue(42);
  const result = runScript(['42', CLAUDE_MODEL, '--agentq-pinned-input'], {
    PATH: `${fake.dir}${path.delimiter}${process.env.PATH}`,
    AGENTQ_PINNED_INPUT: '1',
    AGENTQ_INPUT_SHA256: snapshot.sha256,
    AGENTQ_WORKTREE: worktree,
    BASE_BRANCH: 'master',
    AGENTQ_MAX_TURNS: 'lots',
  }, { cwd: repo, input: JSON.stringify(snapshot) });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /AGENTQ_MAX_TURNS must be a positive integer/);
  assert.equal(fs.existsSync(fake.record), false);
});

function runWithSettings(extraEnv) {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const worktree = path.join(root, 'reused-worktree');
  fs.mkdirSync(worktree);
  const fake = writeFakeClaude(root);
  const snapshot = taskInputForIssue(42);
  const result = runScript(['42', CLAUDE_MODEL, '--agentq-pinned-input'], {
    PATH: `${fake.dir}${path.delimiter}${process.env.PATH}`,
    AGENTQ_PINNED_INPUT: '1',
    AGENTQ_INPUT_SHA256: snapshot.sha256,
    AGENTQ_WORKTREE: worktree,
    BASE_BRANCH: 'master',
    ...extraEnv,
  }, { cwd: repo, input: JSON.stringify(snapshot) });
  return { root, fake, result };
}

test('AGENTQ_CLAUDE_SETTINGS overrides the settings file passed to Claude Code', () => {
  const custom = path.join(tmpdir(), 'settings.json');
  fs.writeFileSync(custom, JSON.stringify({ permissions: { deny: ['Bash(git push:*)'] } }));
  const { fake, result } = runWithSettings({ AGENTQ_CLAUDE_SETTINGS: custom });
  assert.equal(result.status, 0, result.stderr);
  const argv = fake.read().argv;
  assert.equal(argv[argv.indexOf('--settings') + 1], custom);
});

test('a missing or invalid settings file refuses the job before Claude runs', () => {
  for (const settings of ['/nonexistent/claude-settings.json', null]) {
    let target = settings;
    if (target === null) {
      target = path.join(tmpdir(), 'broken.json');
      fs.writeFileSync(target, '{ not json');
    }
    const { fake, result } = runWithSettings({ AGENTQ_CLAUDE_SETTINGS: target });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Claude job settings missing or not valid JSON/);
    assert.equal(fs.existsSync(fake.record), false, 'Claude must not run without its settings');
  }
});

test('the checked-in Claude job settings deny pushes, network and secret reads', () => {
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'defaults', 'claude-job-settings.json'), 'utf8'));
  const { allow, deny, defaultMode } = settings.permissions;
  assert.equal(defaultMode, 'acceptEdits');
  for (const rule of ['Bash(git push:*)', 'Bash(gh:*)', 'Bash(curl:*)', 'WebFetch', 'Read(~/.ssh/**)', 'Read(./.env)']) {
    assert.ok(deny.includes(rule), `deny must include ${rule}`);
  }
  // Nothing is both allowed and denied, and nothing allowed can leave the branch.
  assert.deepEqual(allow.filter((rule) => deny.includes(rule)), []);
  assert.deepEqual(allow.filter((rule) => /git (push|remote|checkout|switch|reset)|\bgh\b|curl|wget/.test(rule)), []);
});

test('a reported is_error result is not recorded as success', () => {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const worktree = path.join(root, 'reused-worktree');
  fs.mkdirSync(worktree);
  // Exit code 0 but is_error=true: the CLI must not report a successful run.
  const fake = writeFakeClaude(root, { exit: 0, isError: true, result: 'boom' });
  const snapshot = taskInputForIssue(42);
  const result = runScript(['42', CLAUDE_MODEL, '--agentq-pinned-input'], {
    PATH: `${fake.dir}${path.delimiter}${process.env.PATH}`,
    AGENTQ_PINNED_INPUT: '1',
    AGENTQ_INPUT_SHA256: snapshot.sha256,
    AGENTQ_WORKTREE: worktree,
    BASE_BRANCH: 'master',
  }, { cwd: repo, input: JSON.stringify(snapshot) });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is_error=true/);
});

test('an unreadable Claude result is a failure even when the process exits 0', () => {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const worktree = path.join(root, 'reused-worktree');
  fs.mkdirSync(worktree);
  const snapshot = taskInputForIssue(42);
  const env = {
    AGENTQ_PINNED_INPUT: '1',
    AGENTQ_INPUT_SHA256: snapshot.sha256,
    AGENTQ_WORKTREE: worktree,
    BASE_BRANCH: 'master',
  };

  // Exit 0 with output agentq cannot read (no cost, no session, no result).
  for (const stdout of ['', 'not json', '{}']) {
    const fake = writeFakeClaude(root, { exit: 0, stdout });
    const result = runScript(['42', CLAUDE_MODEL, '--agentq-pinned-input'], {
      ...env, PATH: `${fake.dir}${path.delimiter}${process.env.PATH}`,
    }, { cwd: repo, input: JSON.stringify(snapshot) });
    assert.equal(result.status, 1, `stdout ${JSON.stringify(stdout)} must fail`);
    assert.match(result.stderr, /recording the run as failed/);
  }
});

test('the raw result dump on a parse failure is bounded', () => {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const worktree = path.join(root, 'reused-worktree');
  fs.mkdirSync(worktree);
  const snapshot = taskInputForIssue(42);
  // Untrusted, unbounded output: 200 KiB of non-JSON text.
  const fake = writeFakeClaude(root, { exit: 0, stdout: 'Z'.repeat(200 * 1024) });
  const result = runScript(['42', CLAUDE_MODEL, '--agentq-pinned-input'], {
    PATH: `${fake.dir}${path.delimiter}${process.env.PATH}`,
    AGENTQ_PINNED_INPUT: '1',
    AGENTQ_INPUT_SHA256: snapshot.sha256,
    AGENTQ_WORKTREE: worktree,
    BASE_BRANCH: 'master',
  }, { cwd: repo, input: JSON.stringify(snapshot) });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /truncated: 204800 bytes of output, only the first 65536 shown/);
  // Exactly the 64 KiB prefix is echoed, not the whole 200 KiB blob.
  assert.equal(result.stderr.split('Z').length - 1, 65536);
});

test('resolveExecutor chooses the executor from the runnable harness', () => {
  assert.equal(resolveExecutor({}, { model: CLAUDE_MODEL }), CLAUDE_EXECUTOR);
  assert.equal(resolveExecutor({ model: 'claude/claude-opus-5-5' }, {}), CLAUDE_EXECUTOR);
  assert.equal(resolveExecutor({}, { model: 'openai-codex/gpt-5.6-sol' }), PI_EXECUTOR);
  // An explicit model outside the catalog (jules, a custom target) stays on pi.
  assert.equal(resolveExecutor({}, { model: 'jules' }), PI_EXECUTOR);
  // An explicit --executor still wins over the harness.
  assert.equal(
    resolveExecutor({}, { model: CLAUDE_MODEL, executor: '/tmp/custom.sh' }),
    '/tmp/custom.sh',
  );
  // A persisted per-job executor is an explicit choice too, so it still wins.
  assert.equal(
    resolveExecutor({ model: 'openai-codex/gpt-5.6-sol', executor: 'src/runners/jules-issue.js' }, {}),
    path.join(ROOT, 'src', 'runners', 'jules-issue.js'),
  );
  assert.equal(
    resolveExecutor({ model: CLAUDE_MODEL, executor: 'src/runners/jules-issue.js' }, {}),
    path.join(ROOT, 'src', 'runners', 'jules-issue.js'),
  );
});

test('resolveExecutor refuses an unknown harness before claiming', () => {
  const runnables = [{ id: 'native/thing', path: 'codex', harness: 'codex', modelKey: null }];
  assert.throws(
    () => resolveExecutor({}, { model: 'native/thing', runnables }),
    /declares harness 'codex', which agentq cannot execute/,
  );
});

test('an unlaunchable harness ends the job as failed instead of stranding it', async () => {
  // The queue's candidate filter cannot see an auto-resolved model's harness,
  // so the refusal happens in the runner: it must release the claim it was
  // handed (non-retryably) and report a finished job, or the task stays
  // 'running' until its lease expires and the drain re-refuses it forever.
  const recovered = [];
  const source = {
    sink: {
      claim: async () => { throw new Error('the refusal must happen before the claim is recorded'); },
      recover: async (job, err, opts) => { recovered.push({ id: job.id, reason: err.message, opts }); },
    },
  };
  const runnables = [{ id: 'native/thing', path: 'codex', harness: 'codex', modelKey: null }];

  const result = await runOnce(
    { id: 'job-1', kind: 'github_issue', model: 'native/thing', repo_path: os.tmpdir() },
    { runnables },
    source,
  );

  const reason = "Model native/thing declares harness 'codex', which agentq cannot execute (known harnesses: pi, claude).";
  assert.deepEqual(result, { id: 'job-1', status: 'failed', exitCode: 1, refusal: reason });
  assert.deepEqual(recovered, [{ id: 'job-1', reason, opts: { retryable: false } }]);
});

test('workflow, feedback and CUA execution stay pi-only', () => {
  assert.throws(
    () => resolveExecutor({}, { model: CLAUDE_MODEL, workflow: true }),
    /--workflow is pi-only/,
  );
  assert.throws(
    () => resolveExecutor({ kind: 'feedback' }, { model: CLAUDE_MODEL }),
    /Feedback jobs run on pi only/,
  );
  // Feedback stays pi-only even when a custom executor is supplied: the model
  // is the thing that cannot run there.
  assert.throws(
    () => resolveExecutor({ kind: 'feedback' }, { model: CLAUDE_MODEL, executor: '/tmp/custom.sh' }),
    /Feedback jobs run on pi only/,
  );
  assert.throws(
    () => resolveExecutor({ kind: 'feedback' }, { model: CLAUDE_MODEL, cua: true }),
    /--cua runs feedback jobs on pi only/,
  );
  // pi-harness feedback keeps its existing executors.
  assert.equal(resolveExecutor({ kind: 'feedback' }, { model: 'openai-codex/gpt-5.6-sol' }), PI_EXECUTOR);
  assert.equal(
    resolveExecutor({ kind: 'feedback' }, { model: 'openai-codex/gpt-5.6-sol', cua: true }),
    path.join(ROOT, 'src', 'runners', 'cua-feedback.js'),
  );
});

test('drain --workflow fails each claude-harness job once and terminates', async (t) => {
  // The local sink used to re-pend a non-retryable refusal, so drain re-claimed
  // and re-refused the same head-of-queue task forever. A refusal must end the
  // task (and stay requeueable), and the drain must finish.
  const root = tmpdir();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const db = path.join(root, 'jobs.sqlite');
  const source = new SqliteSource(db);
  await source.start();
  t.after(() => source.stop());

  const first = await source.enqueue({ repo, issue: 1, model: CLAUDE_MODEL, trusted: true, base: 'master' });
  const second = await source.enqueue({ repo, issue: 2, model: 'claude/claude-opus-5-5', trusted: true, base: 'master' });

  const summary = await drain(source, { workflow: true });

  assert.equal(summary.status, 'drained');
  assert.equal(summary.ran, 2);
  assert.equal(summary.failed, 2);
  assert.equal(summary.succeeded, 0);

  for (const { id } of [first, second]) {
    const task = dbModule.getTask(source.db, id);
    assert.equal(task.status, 'failed');
    assert.equal(task.claimed_by, null);
    assert.equal(task.claim_token, null);
    assert.match(JSON.parse(task.result).error, /--workflow is pi-only/);
  }

  // The operator can start it again after fixing the cause.
  assert.equal(source.requeue({ id: first.id }).status, 'pending');
});

test('drain continues past a refused job and still runs the next task', async (t) => {
  const root = tmpdir();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const db = path.join(root, 'jobs.sqlite');
  const ran = path.join(root, 'ran.txt');
  const executor = path.join(root, 'fake-executor.sh');
  fs.writeFileSync(executor, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' \"$1\" >> ${JSON.stringify(ran)}\n`, { mode: 0o755 });

  const source = new SqliteSource(db);
  await source.start();
  t.after(() => source.stop());

  // Job 1's runnable declares a harness agentq cannot launch, so it is refused
  // in the runner (after the claim). Job 2 is an ordinary pi-harness job with a
  // persisted executor.
  const refused = await source.enqueue({ repo, issue: 1, model: 'native/thing', trusted: true, base: 'master' });
  const runs = await source.enqueue({ repo, issue: 2, model: 'test-model', trusted: true, base: 'master', executor });

  const summary = await drain(source, {
    runnables: [{ id: 'native/thing', path: 'codex', harness: 'codex', modelKey: null }],
  });

  assert.equal(summary.status, 'drained');
  assert.equal(summary.failed, 1);
  assert.equal(summary.succeeded, 1);

  const refusedTask = dbModule.getTask(source.db, refused.id);
  assert.equal(refusedTask.status, 'failed');
  assert.match(JSON.parse(refusedTask.result).error, /cannot execute/);

  const ranTask = dbModule.getTask(source.db, runs.id);
  assert.equal(ranTask.status, 'succeeded');
  assert.deepEqual(fs.readFileSync(ran, 'utf8').trim().split('\n'), ['2']);
});

test('a sandbox wrapper receives the claude executor unchanged', () => {
  const root = tmpdir();
  const repo = makeGitRepo(root);
  const db = path.join(root, 'jobs.sqlite');
  const fake = writeFakeClaude(root);
  const argsFile = path.join(root, 'sandbox-args.json');
  const sandbox = path.join(root, 'sandbox.sh');
  fs.writeFileSync(sandbox, `#!/usr/bin/env bash
set -euo pipefail
node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' ${JSON.stringify(argsFile)} "$@"
exec "$@"
`, { mode: 0o755 });
  const env = { PATH: `${fake.dir}${path.delimiter}${githubEnv().PATH}` };

  // Jobs default to untrusted, so the sandbox is the only way this may run.
  const enqueued = runCli([
    '--db', db, 'enqueue', '--repo', repo, '--issue', '88',
    '--model', 'claude/claude-haiku-5-5', '--base', 'master', '--json',
  ], env);
  assert.equal(enqueued.exitCode, 0, enqueued.stderr);

  const ran = runCli(['--db', db, 'run-next', '--sandbox', sandbox, '--json'], env);
  assert.equal(ran.exitCode, 0, ran.stderr);
  assert.equal(JSON.parse(ran.stdout).status, 'succeeded');

  // The wrapper is handed the claude executor and the pi-issue.sh argument
  // contract unchanged, so a sandbox written for pi keeps working.
  assert.deepEqual(JSON.parse(fs.readFileSync(argsFile, 'utf8')), [
    CLAUDE_EXECUTOR, '88', 'claude/claude-haiku-5-5', '--agentq-pinned-input',
  ]);
  assert.equal(jobs(db)[0].status, 'succeeded');
  assert.equal(fake.read().argv[2], 'claude-haiku-5-5');
});
