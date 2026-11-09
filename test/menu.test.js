'use strict';
/**
 * Integration tests for the interactive menu (src/interfaces/cli/menu.js), driven as
 * a real spawned process with scripted stdin — this is how a person actually
 * uses it, and it needs no changes to menu.js itself to test.
 *
 * Scope: only paths that don't require menu.js's hardcoded pi-issue.sh
 * executor to actually run (it shells out to `gh`/`pi` for real — not
 * something a unit test should invoke). That rules out testing a real job
 * execution through the menu, but the two things worth covering here (an
 * idle queue, and write-lock contention) both short-circuit before the
 * executor would ever be spawned. Run with `npm test`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const { githubEnv } = require('./helpers/pinned-issue.js');
const AGENTQ = require.resolve('../src/interfaces/cli/agentq.js');
const MENU = require.resolve('../src/interfaces/cli/menu.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'menu-test-'));
}

function run(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [AGENTQ, ...args], { encoding: 'utf8', env: { ...process.env, AGENTQ_QUOTA_REFRESH: '0', ...githubEnv(), ...env }, timeout: 30_000 });
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status ?? 1, stdout: err.stdout || '' };
  }
}

function makeRepo(root) {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  return repo;
}

// Drives menu.js as a real process: writes each scripted line to its stdin
// (with a short delay between them so each prompt is actually up before the
// next answer arrives), collects stdout, and kills it after `waitMs` if it's
// still running (the menu loops forever until 'q', so tests must terminate it).
function driveMenu(env, inputs, { waitMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MENU], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AGENTQ_QUOTA_REFRESH: '0', ...githubEnv(), ...env },
    });
    let stdout = '';
    let promptOut = ''; // stdout only: stderr noise (e.g. Node 22's SQLite warning) can follow a prompt
    child.stdout.on('data', d => { stdout += d; promptOut += d; });
    child.stderr.on('data', d => { stdout += d; });

    // Answer each prompt only once it is on screen (output ends in a prompt
    // suffix and grew since the last answer), so a slow machine can't make an
    // answer land on the wrong prompt or the menu get killed mid-step.
    let i = 0;
    let seen = 0;
    const feed = () => {
      if (i >= inputs.length || promptOut.length === seen || !/(?:> |: )$/.test(promptOut)) return;
      seen = promptOut.length;
      child.stdin.write(inputs[i] + '\n');
      i++;
      if (i >= inputs.length) child.stdin.end();
    };
    child.stdout.on('data', () => setImmediate(feed));

    const timer = setTimeout(() => { child.kill(); }, waitMs);
    child.on('close', () => { clearTimeout(timer); resolve(stdout); });
  });
}

test('menu run-next reports "no pending jobs" for an idle queue, without ever needing a real executor', async () => {
  const root = tmpdir();
  const db = path.join(root, 'jobs.sqlite');
  makeRepo(root); // unused here, but keeps parity with other tests' setup

  const stdout = await driveMenu({ AGENTQ_DB: db }, ['2', '', 'q']);
  assert.match(stdout, /no pending jobs/);
});

test('menu drain reports write-lock contention distinctly, not as a job failure', async () => {
  const root = tmpdir();
  const db = path.join(root, 'jobs.sqlite');
  const repo = makeRepo(root);
  execFileSync('git', ['-C', repo, 'init', '-b', 'master'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'menu-test@example.test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Menu Test'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'README.md'), 'test\n');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init'], { stdio: 'ignore' });

  run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm', '--trusted']);

  // Simulate another agentq process holding the queue's write transaction:
  // the menu's claim waits out busy_timeout and then reports contention —
  // WITHOUT ever needing a job to actually execute, so pi-issue.sh is never
  // invoked. AGENTQ_BUSY_TIMEOUT_MS keeps that wait short in tests.
  const holder = new DatabaseSync(db);
  holder.exec('PRAGMA busy_timeout=0');
  holder.exec('BEGIN IMMEDIATE');
  try {
    const stdout = await driveMenu({ AGENTQ_DB: db, AGENTQ_BUSY_TIMEOUT_MS: '100' }, ['3', '', 'q']);
    assert.match(stdout, /another agentq process is currently working/,
      `expected the busy message, got: ${stdout}`);
    assert.doesNotMatch(stdout, /some jobs failed — check status/,
      'lock contention must not be miscounted as a job failure');
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
});

test('menu run-next prints the admission reasons instead of "no pending jobs"', async () => {
  const root = tmpdir();
  const db = path.join(root, 'jobs.sqlite');
  const repo = makeRepo(root);
  execFileSync('git', ['-C', repo, 'init', '-b', 'master'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'menu-test@example.test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'Menu Test'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, 'README.md'), 'test\n');
  execFileSync('git', ['-C', repo, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init'], { stdio: 'ignore' });

  // Untrusted job: the menu's run-next has no sandbox, so admission refuses it.
  const enqueued = run(['--db', db, 'enqueue', '--repo', repo, '--issue', '1', '--model', 'm', '--json']);
  const { id } = JSON.parse(enqueued.stdout);

  const stdout = await driveMenu({ AGENTQ_DB: db }, ['2', '', 'q']);
  assert.match(stdout, /nothing runnable here:/);
  assert.match(stdout, new RegExp(`job ${id.slice(0, 8)}: Refusing untrusted job`));
  assert.doesNotMatch(stdout, /no pending jobs/);
});
