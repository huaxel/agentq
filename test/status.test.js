'use strict';

/**
 * W29: `agentq status` — a readable, filterable table.
 *
 * A temp queue with two spec tasks (the second depends on the first, so it is
 * `blocked`), exercised through the CLI: `--status` filtering, `--limit` with its
 * footer, newest first, a bad `--status` erroring, and `--json` staying
 * byte-for-byte the old shape until a filter is given.
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

  // header + the one pending row (A) + the `showing 1 of 2` footer.
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^id +status +kind +age +model +title$/);
  assert.match(lines[1], new RegExp(`^${idA.slice(0, 8)} +pending`));
  assert.match(lines[2], /^showing 1 of 2$/);
});

test('--status with no matches prints `no tasks` and the footer', () => {
  const root = tmpdir();
  const { dbPath } = seededQueue(root);
  const result = runCli(dbPath, ['status', '--status', 'running']);
  assert.equal(result.exitCode, 0, result.stderr);
  // No running tasks: empty table, but the filter cut the list, so the footer
  // still reports it.
  assert.equal(result.stdout.trim(), 'no tasks\nshowing 0 of 2');
});

test('--limit 1 shows one row and a `showing 1 of N` footer', () => {
  const root = tmpdir();
  const { dbPath } = seededQueue(root);

  const result = runCli(dbPath, ['status', '--limit', '1']);
  assert.equal(result.exitCode, 0, result.stderr);

  const lines = result.stdout.trim().split('\n');
  // header + one data row + footer
  assert.equal(lines.length, 3);
  assert.match(lines.at(-1), /^showing 1 of 2$/);
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
