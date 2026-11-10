'use strict';

/**
 * W29: `agentq status` — a readable, filterable table.
 *
 * A temp queue with two spec tasks (the second depends on the first, so it is
 * `blocked`), exercised through the CLI: `--status` filtering, `--limit` with its
 * footer, newest first, a bad `--status` erroring, and `--json` staying
 * byte-for-byte the old shape until a filter is given.
 *
 * W30 adds `--active` (unfinished tasks only, mutually exclusive with
 * `--status`) and the `queue:` summary line that closes the text output.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const dbModule = require('../src/queue/db.js');
const { SqliteSource } = require('../src/queue/sources.js');
const { ownStderr } = require('./helpers/stderr.js');

const AGENTQ = require.resolve('../src/interfaces/cli/agentq.js');
const MODEL = 'anthropic/claude-sonnet-4';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-status-'));
}

/** @param {string} dbPath @param {string[]} args @param {Record<string,string>} [env] */
function runCli(dbPath, args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [AGENTQ, '--db', dbPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, AGENTQ_HOME: path.dirname(dbPath), AGENTQ_QUOTA_REFRESH: '0', ...env },
      timeout: 30_000,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    return { exitCode: error.status ?? 1, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

/**
 * A two-task queue: A (oldest, pending) and B (newest, blocked — it depends on
 * A, which is still pending). Both tasks are enqueued through the CLI; the
 * dependency that blocks B is inserted from the test process and flushed with an
 * explicit WAL checkpoint so the spawned `status` CLI (a separate process) reads
 * it.
 */
function seededQueue(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const spec = path.join(root, 'spec.md');
  fs.writeFileSync(spec, '# Spec task\n\nBody.\n');
  const dbPath = path.join(root, 'orchestrator.sqlite');

  const a = runCli(dbPath, ['enqueue', '--repo', repo, '--spec', spec, '--model', MODEL, '--tier', 'medium', '--json']);
  assert.equal(a.exitCode, 0, a.stderr);
  const idA = JSON.parse(a.stdout).id;

  const b = runCli(dbPath, ['enqueue', '--repo', repo, '--spec', spec, '--model', MODEL, '--tier', 'medium', '--json']);
  assert.equal(b.exitCode, 0, b.stderr);
  const idB = JSON.parse(b.stdout).id;

  const db = dbModule.openDb(dbPath);
  dbModule.initSchema(db);
  try {
    db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)').run(idB, idA);
    // Flush the WAL so the spawned `status` CLI sees the dependency; without it a
    // separate process can read a main-db snapshot ahead of the un-checkpointed
    // -wal file.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }

  return { dbPath, idA, idB };
}

/**
 * A queue with one task per given status, in the order listed (oldest first),
 * for the `--active` filter and the summary line. The tasks have no dependency
 * between them, so what is stored is what `status()` reports — no implicit
 * `blocked`. Statuses are written from the test process and flushed with a WAL
 * checkpoint, the same way seededQueue flushes its dependency.
 *
 * @param {string} root
 * @param {string[]} statuses
 * @returns {{ dbPath: string, rows: Array<{ status: string, id: string }> }}
 */
function seededStatusQueue(root, statuses) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const spec = path.join(root, 'spec.md');
  fs.writeFileSync(spec, '# Spec task\n\nBody.\n');
  const dbPath = path.join(root, 'orchestrator.sqlite');

  const rows = [];
  for (const status of statuses) {
    const enq = runCli(dbPath, ['enqueue', '--repo', repo, '--spec', spec, '--model', MODEL, '--tier', 'medium', '--json']);
    assert.equal(enq.exitCode, 0, enq.stderr);
    // One entry per task, so a repeated status cannot silently hide a task that
    // stayed pending.
    rows.push({ status, id: JSON.parse(enq.stdout).id });
  }

  const db = dbModule.openDb(dbPath);
  dbModule.initSchema(db);
  try {
    const update = db.prepare('UPDATE tasks SET status = ? WHERE id = ?');
    for (const row of rows) update.run(row.status, row.id);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }

  return { dbPath, rows };
}

/**
 * The id of the task seededStatusQueue stored with that status.
 *
 * @param {Array<{ status: string, id: string }>} rows
 * @param {string} status
 */
function idOf(rows, status) {
  const match = rows.filter((row) => row.status === status);
  assert.equal(match.length, 1, `expected exactly one seeded ${status} task`);
  return match[0].id;
}

test('text status is newest first', () => {
  const root = tmpdir();
  const { dbPath, idB } = seededQueue(root);

  const result = runCli(dbPath, ['status']);
  assert.equal(result.exitCode, 0, result.stderr);

  const lines = result.stdout.trim().split('\n');
  assert.match(lines[0], /^id +status +kind +age +model +title$/);
  // First data row is the newest job (B), shown by its 8-char id.
  assert.match(lines[1], new RegExp(`^${idB.slice(0, 8)} `));
});

test('--status pending filters the list', () => {
  const root = tmpdir();
  const { dbPath, idA } = seededQueue(root);

  const result = runCli(dbPath, ['status', '--status', 'pending']);
  assert.equal(result.exitCode, 0, result.stderr);

  // header + the one pending row (A) + the `showing 1 of 2` footer + the summary.
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^id +status +kind +age +model +title$/);
  assert.match(lines[1], new RegExp(`^${idA.slice(0, 8)} +pending`));
  assert.match(lines[2], /^showing 1 of 2$/);
  assert.equal(lines[3], 'queue: 1 pending, 1 blocked');
});

test('--status with no matches prints `no tasks`, the footer and the summary', () => {
  const root = tmpdir();
  const { dbPath } = seededQueue(root);
  const result = runCli(dbPath, ['status', '--status', 'running']);
  assert.equal(result.exitCode, 0, result.stderr);
  // No running tasks: empty table, but the filter cut the list, so the footer
  // still reports it. The summary counts the queue regardless of the table.
  assert.equal(result.stdout, 'no tasks\nshowing 0 of 2\nqueue: 1 pending, 1 blocked\n');
});

test('--limit 1 shows one row and a `showing 1 of N` footer', () => {
  const root = tmpdir();
  const { dbPath } = seededQueue(root);

  const result = runCli(dbPath, ['status', '--limit', '1']);
  assert.equal(result.exitCode, 0, result.stderr);

  const lines = result.stdout.trim().split('\n');
  // header + one data row + footer + the summary line, which comes last.
  assert.equal(lines.length, 4);
  assert.match(lines.at(-2), /^showing 1 of 2$/);
  assert.equal(lines.at(-1), 'queue: 1 pending, 1 blocked');
});

test('a bad --status errors listing the valid values', () => {
  const root = tmpdir();
  const { dbPath } = seededQueue(root);

  const result = runCli(dbPath, ['status', '--status', 'bogus']);
  assert.notEqual(result.exitCode, 0);
  const stderr = ownStderr(result.stderr);
  assert.match(stderr, /invalid --status bogus/);
  assert.match(stderr, /pending/);
});

test('--json with no flags is byte-for-byte the old status() shape', () => {
  const root = tmpdir();
  const { dbPath } = seededQueue(root);

  const result = runCli(dbPath, ['status', '--json']);
  assert.equal(result.exitCode, 0, result.stderr);

  const expected = JSON.stringify(new SqliteSource(dbPath).status());
  assert.equal(result.stdout, `${expected}\n`);
});

test('--json --status X filters the array', () => {
  const root = tmpdir();
  const { dbPath, idA } = seededQueue(root);

  const result = runCli(dbPath, ['status', '--json', '--status', 'pending']);
  assert.equal(result.exitCode, 0, result.stderr);

  const rows = JSON.parse(result.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, idA);
  assert.equal(rows[0].status, 'pending');
});

test('--active keeps pending, blocked and running rows', () => {
  const root = tmpdir();
  const { dbPath, rows } = seededStatusQueue(root, ['running', 'pending', 'succeeded', 'blocked', 'failed']);

  const result = runCli(dbPath, ['status', '--active']);
  assert.equal(result.exitCode, 0, result.stderr);

  const lines = result.stdout.trim().split('\n');
  // header + the three unfinished rows + the `showing 3 of 5` footer + summary.
  assert.equal(lines.length, 6);
  assert.match(lines[0], /^id +status +kind +age +model +title$/);
  for (const status of ['running', 'pending', 'blocked']) {
    assert.match(lines.slice(1, 4).join('\n'), new RegExp(`^${idOf(rows, status).slice(0, 8)} +${status} `, 'm'));
  }
  // No finished row survives the filter, by status column and by id.
  assert.deepEqual(lines.slice(1, 4).map((line) => line.split(/ +/)[1]).sort(), ['blocked', 'pending', 'running']);
  assert.ok(!result.stdout.includes(idOf(rows, 'succeeded').slice(0, 8)), 'the succeeded task must not be shown');
  assert.ok(!result.stdout.includes(idOf(rows, 'failed').slice(0, 8)), 'the failed task must not be shown');
  assert.match(lines[4], /^showing 3 of 5$/);
});

test('--active --json filters the array', () => {
  const root = tmpdir();
  const { dbPath } = seededStatusQueue(root, ['running', 'pending', 'succeeded', 'blocked', 'failed']);

  const result = runCli(dbPath, ['status', '--active', '--json']);
  assert.equal(result.exitCode, 0, result.stderr);

  const rows = JSON.parse(result.stdout);
  // `--json` keeps the queue's own order (oldest first) and gains no line.
  assert.deepEqual(rows.map((row) => row.status), ['running', 'pending', 'blocked']);
});

test('--active and --status together are an error', () => {
  const root = tmpdir();
  const { dbPath } = seededStatusQueue(root, ['pending', 'succeeded']);

  const result = runCli(dbPath, ['status', '--active', '--status', 'pending']);
  assert.notEqual(result.exitCode, 0);
  assert.match(ownStderr(result.stderr), /--active and --status are mutually exclusive/);
});

test('--active still combines with --kind and --limit', () => {
  const root = tmpdir();
  const { dbPath } = seededStatusQueue(root, ['running', 'pending', 'blocked', 'failed']);

  const limited = runCli(dbPath, ['status', '--active', '--limit', '1']);
  assert.equal(limited.exitCode, 0, limited.stderr);
  const limitedLines = limited.stdout.trim().split('\n');
  // header + one unfinished row + footer + summary: the limit cuts the filtered
  // list, not the whole queue.
  assert.equal(limitedLines.length, 4);
  assert.match(limitedLines[1], /^.{8} +(running|pending|blocked) /);
  assert.match(limitedLines[2], /^showing 1 of 4$/);
  assert.match(limitedLines[3], /^queue: 1 running, 1 pending, 1 blocked, 1 failed$/);

  const otherKind = runCli(dbPath, ['status', '--active', '--kind', 'github_issue']);
  assert.equal(otherKind.exitCode, 0, otherKind.stderr);
  // Every task here is a spec task: the kind filter applies on top of --active.
  assert.equal(otherKind.stdout.trim(), 'no tasks\nshowing 0 of 4\nqueue: 1 running, 1 pending, 1 blocked, 1 failed');
});

test('the summary counts every task even when the table is cut', () => {
  const root = tmpdir();
  const { dbPath } = seededStatusQueue(root, ['running', 'pending', 'blocked', 'failed', 'succeeded']);
  const summary = 'queue: 1 running, 1 pending, 1 blocked, 1 failed, 1 succeeded';

  for (const args of [['status'], ['status', '--limit', '1'], ['status', '--active'], ['status', '--status', 'failed']]) {
    const result = runCli(dbPath, args);
    assert.equal(result.exitCode, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines.at(-1), summary, args.join(' '));
  }

  // JSON output never carries the summary line.
  const json = runCli(dbPath, ['status', '--json']);
  assert.equal(json.exitCode, 0, json.stderr);
  assert.ok(!json.stdout.includes('queue:'), json.stdout);
});

test('an empty queue prints `no tasks` and no summary line', () => {
  const root = tmpdir();
  const result = runCli(path.join(root, 'orchestrator.sqlite'), ['status']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, 'no tasks\n');
});
