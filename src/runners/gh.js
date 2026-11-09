'use strict';

// GitHub-aware repo/issue/PR discovery for the agentq menu.
// All functions shell out to `gh` via an injectable runner (defaults to
// execFileSync) so they're unit-testable without mocking the network.
// Pure data in, structured data out — no readline, no menu logic here.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const DEFAULT_CLONE_ROOT = path.join(os.homedir(), 'projects');
const DEFAULT_LIMIT = 30;

function defaultRunner(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] });
}

// Extract the repo name (last segment) from a nameWithOwner string.
function repoName(nameWithOwner) {
  return nameWithOwner.split('/').pop();
}

function resolveLocalPath(cloneRoot, nameWithOwner) {
  return path.join(cloneRoot, repoName(nameWithOwner));
}

function matchReposToLocal(ghRepos, cloneRoot) {
  return ghRepos
    .map(r => ({
      ...r,
      name: repoName(r.nameWithOwner),
      localPath: resolveLocalPath(cloneRoot, r.nameWithOwner),
    }))
    .filter(r => fs.existsSync(r.localPath));
}

function listRepos({ cloneRoot = DEFAULT_CLONE_ROOT, limit = DEFAULT_LIMIT, run = defaultRunner } = {}) {
  let raw;
  try {
    raw = run('gh', ['repo', 'list', '--json', 'nameWithOwner', '--limit', String(limit)]);
  } catch {
    return [];
  }
  let ghRepos;
  try { ghRepos = JSON.parse(raw); } catch { return []; }
  return matchReposToLocal(ghRepos, cloneRoot);
}

function listIssues(nameWithOwner, { limit = DEFAULT_LIMIT, run = defaultRunner } = {}) {
  let raw;
  try {
    raw = run('gh', ['issue', 'list', '--repo', nameWithOwner, '--state', 'open',
      '--json', 'number,title,milestone', '--limit', String(limit)]);
  } catch {
    return [];
  }
  try { return JSON.parse(raw); } catch { return []; }
}

function listPrs(nameWithOwner, { limit = DEFAULT_LIMIT, run = defaultRunner } = {}) {
  let raw;
  try {
    raw = run('gh', ['pr', 'list', '--repo', nameWithOwner, '--state', 'open',
      '--json', 'number,title', '--limit', String(limit)]);
  } catch {
    return [];
  }
  try { return JSON.parse(raw); } catch { return []; }
}

function listMilestones(nameWithOwner, { run = defaultRunner } = {}) {
  let raw;
  try {
    raw = run('gh', ['api', `repos/${nameWithOwner}/milestones`]);
  } catch {
    return [];
  }
  let arr;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(m => m.state === 'open')
    .map(m => ({
      number: m.number,
      title: m.title,
      openIssues: m.open_issues ?? 0,
      closedIssues: m.closed_issues ?? 0,
    }));
}

function groupIssuesByMilestone(issues) {
  if (!issues || !issues.length) return [];
  const byNumber = new Map();
  const order = [];
  const unassigned = [];
  for (const iss of issues) {
    if (iss.milestone) {
      const ms = iss.milestone;
      if (!byNumber.has(ms.number)) {
        byNumber.set(ms.number, { milestone: { number: ms.number, title: ms.title }, issues: [] });
        order.push(ms.number);
      }
      byNumber.get(ms.number).issues.push(iss);
    } else {
      unassigned.push(iss);
    }
  }
  const groups = order.map(n => byNumber.get(n));
  if (unassigned.length) groups.push({ milestone: null, issues: unassigned });
  return groups;
}

module.exports = {
  listRepos,
  listIssues,
  listPrs,
  listMilestones,
  groupIssuesByMilestone,
  matchReposToLocal,
  resolveLocalPath,
  repoName,
  DEFAULT_CLONE_ROOT,
};
