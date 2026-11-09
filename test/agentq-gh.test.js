'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { listRepos, listIssues, listPrs, listMilestones, groupIssuesByMilestone, resolveLocalPath, matchReposToLocal } = require('../src/runners/gh.js');

// A fake runner: returns canned stdout for given args. Throws if unexpected call.
function fakeRunner(table) {
  return (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    const entry = table[key];
    if (!entry) throw new Error(`unexpected gh call: ${key}`);
    if (entry.error) throw new Error(entry.error);
    return entry.stdout;
  };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-gh-test-'));
}

function makeCloneRoot(root, names) {
  for (const n of names) fs.mkdirSync(path.join(root, n), { recursive: true });
}

test('resolveLocalPath joins clone root + repo name', () => {
  assert.equal(resolveLocalPath('/home/dev/projects', 'acme/widgets'), '/home/dev/projects/widgets');
  assert.equal(resolveLocalPath('/home/dev/projects', 'widgets'), '/home/dev/projects/widgets');
});

test('matchReposToLocal keeps only repos with a local clone, annotating the path', () => {
  const root = tmpdir();
  makeCloneRoot(root, ['widgets', 'gadgets']);
  const ghRepos = [
    { nameWithOwner: 'acme/widgets' },
    { nameWithOwner: 'acme/gadgets' },
    { nameWithOwner: 'acme/no-clone-here' },
  ];
  const matched = matchReposToLocal(ghRepos, root);
  assert.equal(matched.length, 2);
  assert.deepEqual(matched[0], {
    nameWithOwner: 'acme/widgets',
    name: 'widgets',
    localPath: path.join(root, 'widgets'),
  });
  assert.equal(matched[1].name, 'gadgets');
});

test('matchReposToLocal returns empty for a clone root with no matching dirs', () => {
  const root = tmpdir();
  const ghRepos = [{ nameWithOwner: 'acme/nonexistent' }];
  assert.deepEqual(matchReposToLocal(ghRepos, root), []);
});

test('listRepos calls gh repo list and matches against the local clone root', () => {
  const root = tmpdir();
  makeCloneRoot(root, ['widgets']);
  const run = fakeRunner({
    'gh repo list --json nameWithOwner --limit 30': { stdout: JSON.stringify([
      { nameWithOwner: 'acme/widgets' },
      { nameWithOwner: 'acme/no-clone' },
    ]) },
  });
  const repos = listRepos({ cloneRoot: root, run });
  assert.equal(repos.length, 1);
  assert.equal(repos[0].nameWithOwner, 'acme/widgets');
  assert.equal(repos[0].localPath, path.join(root, 'widgets'));
});

test('listRepos returns empty array when gh is not authenticated or unavailable', () => {
  const root = tmpdir();
  const run = () => { throw new Error('gh: not found'); };
  const repos = listRepos({ cloneRoot: root, run });
  assert.deepEqual(repos, []);
});

test('listIssues calls gh issue list and returns number+title', () => {
  const run = fakeRunner({
    'gh issue list --repo acme/widgets --state open --json number,title,milestone --limit 30': {
      stdout: JSON.stringify([
        { number: 42, title: 'Fix DossierLoader error handling', milestone: null },
        { number: 7, title: 'Add quota-aware model picker', milestone: null },
      ]),
    },
  });
  const issues = listIssues('acme/widgets', { run });
  assert.deepEqual(issues, [
    { number: 42, title: 'Fix DossierLoader error handling', milestone: null },
    { number: 7, title: 'Add quota-aware model picker', milestone: null },
  ]);
});

test('listIssues returns empty array on gh failure', () => {
  const run = () => { throw new Error('network error'); };
  assert.deepEqual(listIssues('acme/widgets', { run }), []);
});

test('listPrs calls gh pr list and returns number+title', () => {
  const run = fakeRunner({
    'gh pr list --repo acme/widgets --state open --json number,title --limit 30': {
      stdout: JSON.stringify([
        { number: 5, title: 'WIP: refactor economics' },
      ]),
    },
  });
  const prs = listPrs('acme/widgets', { run });
  assert.deepEqual(prs, [{ number: 5, title: 'WIP: refactor economics' }]);
});

test('listPrs returns empty array on gh failure', () => {
  const run = () => { throw new Error('network error'); };
  assert.deepEqual(listPrs('acme/widgets', { run }), []);
});

test('listMilestones calls gh api and returns number+title+counts', () => {
  const run = fakeRunner({
    'gh api repos/acme/gadgets/milestones': { stdout: JSON.stringify([
      { number: 8, title: 'Failure is visible', open_issues: 9, closed_issues: 0, state: 'open' },
      { number: 10, title: 'Hardening round 3', open_issues: 7, closed_issues: 0, state: 'open' },
    ]) },
  });
  const ms = listMilestones('acme/gadgets', { run });
  assert.equal(ms.length, 2);
  assert.deepEqual(ms[0], { number: 8, title: 'Failure is visible', openIssues: 9, closedIssues: 0 });
  assert.equal(ms[1].title, 'Hardening round 3');
});

test('listMilestones returns empty array on gh failure', () => {
  const run = () => { throw new Error('not found'); };
  assert.deepEqual(listMilestones('acme/gadgets', { run }), []);
});

test('groupIssuesByMilestone groups issues by their milestone, unassigned last', () => {
  const issues = [
    { number: 311, title: 'guard globals', milestone: { number: 8, title: 'Failure is visible' } },
    { number: 325, title: 'docs freshness', milestone: { number: 10, title: 'Hardening round 3' } },
    { number: 310, title: 'shallow-copy sweep', milestone: { number: 8, title: 'Failure is visible' } },
    { number: 328, title: 'no milestone here', milestone: null },
  ];
  const groups = groupIssuesByMilestone(issues);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].milestone.number, 8);
  assert.equal(groups[0].issues.length, 2);
  assert.equal(groups[0].issues[0].number, 311);
  assert.equal(groups[1].milestone.number, 10);
  assert.equal(groups[1].issues.length, 1);
  assert.equal(groups[2].milestone, null);
  assert.equal(groups[2].issues.length, 1);
  assert.equal(groups[2].issues[0].number, 328);
});

test('groupIssuesByMilestone returns a single unassigned bucket when no issues have milestones', () => {
  const issues = [
    { number: 1, title: 'a', milestone: null },
    { number: 2, title: 'b', milestone: null },
  ];
  const groups = groupIssuesByMilestone(issues);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].milestone, null);
  assert.equal(groups[0].issues.length, 2);
});

test('groupIssuesByMilestone returns empty array for no issues', () => {
  assert.deepEqual(groupIssuesByMilestone([]), []);
});
