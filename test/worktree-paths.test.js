'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { trustedWorktreeLabel } = require('../src/runners/execute.js');
const { canonicalizePath } = require('../src/lib/paths.js');
const dbModule = require('../src/queue/db.js');
const { createIssueInput } = require('../src/core/issue-input.js');

const AGENTQ = require.resolve('../src/interfaces/cli/agentq.js');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-paths-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const area = path.join(root, 'area');
  const alias = path.join(root, 'alias');
  fs.mkdirSync(area);
  fs.symlinkSync(area, alias, 'dir');
  return { root, area, alias };
}

test('missing worktree descendants honor a symlinked work-area spelling', t => {
  const { root, area, alias } = fixture(t);
  const label = path.join(alias, 'scratch', 'missing');
  assert.equal(trustedWorktreeLabel(label, path.join(root, 'repo'), area, 1), label);
  const canonicalLabel = path.join(area, 'scratch', 'missing');
  assert.equal(trustedWorktreeLabel(canonicalLabel, path.join(root, 'repo'), alias, 1), canonicalLabel);
});

test('symlink aliases cannot hide another job behind a missing descendant', t => {
  const { root, area, alias } = fixture(t);
  const sibling = path.join(area, 'worktrees', 'job-2');
  fs.mkdirSync(sibling, { recursive: true });
  fs.symlinkSync(sibling, path.join(area, 'shortcut'), 'dir');
  assert.equal(trustedWorktreeLabel(path.join(alias, 'worktrees', 'job-2', 'missing'),
    path.join(root, 'repo'), area, 1), null);
  assert.equal(trustedWorktreeLabel(path.join(area, 'shortcut', 'missing'),
    path.join(root, 'repo'), area, 1), null);
});

test('a symlinked ancestor cannot make missing outside paths look contained', t => {
  const { root, area } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(area, 'escape'), 'dir');
  assert.equal(trustedWorktreeLabel(path.join(area, 'escape', 'missing', 'scratch'),
    path.join(root, 'repo'), area, 1), null);
});

test('dangling links, symlink loops and non-directory ancestors fail closed', t => {
  const { root, area } = fixture(t);
  fs.symlinkSync(path.join(root, 'absent'), path.join(area, 'dangling'), 'dir');
  fs.symlinkSync('loop', path.join(area, 'loop'), 'dir');
  fs.writeFileSync(path.join(area, 'file'), 'not a directory');
  for (const ancestor of ['dangling', 'loop', 'file']) {
    assert.equal(trustedWorktreeLabel(path.join(area, ancestor, 'scratch'),
      path.join(root, 'repo'), area, 1), null, ancestor);
  }
});

test('dot-dot is resolved after symlinks rather than lexically before them', t => {
  const { root, area } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(outside, 'deep'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'scratch'));
  fs.mkdirSync(path.join(area, 'scratch'));
  fs.symlinkSync(path.join(outside, 'deep'), path.join(area, 'link'), 'dir');
  // Do not use path.join here: it would erase the filesystem's link/.. semantics.
  const label = `${area}/link/../scratch`;
  assert.equal(trustedWorktreeLabel(label, path.join(root, 'repo'), area, 1), null);
});

test('relative labels and missing-then-dot-dot paths fail closed', t => {
  const { root, area } = fixture(t);
  const relative = path.relative(process.cwd(), path.join(area, 'scratch'));
  assert.equal(trustedWorktreeLabel(relative, path.join(root, 'repo'), area, 1), null);
  assert.equal(canonicalizePath(`${area}/missing/..`), null);
  assert.equal(canonicalizePath(`${area}/missing/../scratch`), null);
});

/** Insert a finished github_issue task with a stored completion result. */
function seedFinishedTask(dbPath, { repo, issue, worktree, branch }) {
  const db = dbModule.openDb(dbPath);
  try {
    dbModule.initSchema(db);
    const input = createIssueInput({
      number: issue, title: 'Fixture issue', body: 'fixture body',
      url: `https://github.com/test/repo/issues/${issue}`, updatedAt: '2026-11-02T00:00:00Z',
    });
    const task = dbModule.createTask(db, {
      kind: 'github_issue', repo, issue_num: issue, prompt: JSON.stringify(input),
      model: 'test/model', base_branch: 'main', trust_level: 'trusted_agent',
    });
    db.prepare("UPDATE tasks SET status = 'succeeded', finished_at = ?, result = ? WHERE id = ?")
      .run(new Date().toISOString(), JSON.stringify({ status: 'succeeded', exit: 0, worktree, branch }), task.id);
  } finally {
    db.close();
  }
}

function legacyWorktree(t, { escaping = false, dirty = false, relative = false } = {}) {
  const { root, area, alias } = fixture(t);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main');
  git('-c', 'user.name=AgentQ Test', '-c', 'user.email=agentq@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'fixture');
  let label = path.join(alias, 'pi-issue-42');
  if (escaping) {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(area, 'escape'), 'dir');
    label = path.join(alias, 'escape', 'pi-issue-42');
  }
  git('worktree', 'add', '-b', 'pi/issue-42', label, 'main');
  if (dirty) fs.writeFileSync(path.join(label, 'keep.txt'), 'uncommitted work');
  // Seed a finished task whose completion record carries the executor's
  // worktree/branch labels, exactly as a completed run would have stored them.
  const recordedLabel = relative ? path.relative(root, label) : label;
  const dbPath = path.join(root, 'queue.sqlite');
  seedFinishedTask(dbPath, { repo, issue: 42, worktree: recordedLabel, branch: 'pi/issue-42' });
  const result = spawnSync(process.execPath, [AGENTQ, '--db', dbPath, 'prune', '--json'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, AGENTQ_QUOTA_REFRESH: '0', TMPDIR: alias, TMP: alias, TEMP: alias },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return { label, recordedLabel, git, result: JSON.parse(result.stdout) };
}

test('legacy prune recognizes temporary-directory and registered-worktree aliases', t => {
  const { label, git, result } = legacyWorktree(t);
  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(label), false);
  assert.equal(git('branch', '--list', 'pi/issue-42').trim(), '');
});

test('legacy prune preserves dirty worktrees reached through an alias', t => {
  const { label, git, result } = legacyWorktree(t, { dirty: true });
  assert.equal(result.removed, 0);
  assert.equal(fs.readFileSync(path.join(label, 'keep.txt'), 'utf8'), 'uncommitted work');
  assert.match(git('branch', '--list', 'pi/issue-42'), /pi\/issue-42/);
});

test('legacy prune refuses ambiguous relative worktree labels', t => {
  const { label, recordedLabel, git, result } = legacyWorktree(t, { relative: true });
  assert.equal(result.removed, 0);
  assert.equal(fs.existsSync(label), true);
  assert.match(git('branch', '--list', 'pi/issue-42'), /pi\/issue-42/);
  assert.ok(result.skipped.some(entry => entry.path === recordedLabel));
});

test('legacy prune rejects a temporary-directory symlink escape', t => {
  const { label, git, result } = legacyWorktree(t, { escaping: true });
  assert.equal(result.removed, 0);
  assert.equal(fs.existsSync(label), true);
  assert.match(git('branch', '--list', 'pi/issue-42'), /pi\/issue-42/);
  assert.ok(result.skipped.some(entry => entry.path === label));
});
