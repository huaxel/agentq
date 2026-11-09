#!/usr/bin/env node
'use strict';

/**
 * agentq executor for Jules — Google's autonomous cloud agent.
 *
 * Usage: jules-issue.js <issue-number> [model]
 *
 * Expects to run inside a git checkout (or worktree) of the target repo.
 * It fetches the issue via `gh`, creates a Jules session, polls until the
 * session produces a pull request, then checks the PR branch into the
 * current worktree so agentq can verify/diff it.
 *
 * Session state is persisted to the orchestrator DB via jules-sync so it
 * survives crashes and can be reconnected via `agentq jules-reconnect`.
 *
 * Environment:
 *   JULES_API_KEY            required Jules API key
 *   BASE_BRANCH              base branch (default: main)
 *   AGENTQ_STOP_WHEN         optional stop condition forwarded to the prompt
 *   JULES_POLL_INTERVAL_MS   polling interval (default: 10000)
 *   JULES_TIMEOUT_MS         polling timeout (default: 30min)
 *   ORCHESTRATOR_DB          orchestrator DB path (default: data/orchestrator.sqlite)
 */

const { execFileSync } = require('node:child_process');
const { listSources, createSession, getSession } = require('../lib/jules-api.js');
const { pollJulesSession, extractSessionId } = require('../queue/jules-sync.js');
const { readPinnedIssue } = require('../core/issue-input.js');

const POLL_INTERVAL_MS = Number(process.env.JULES_POLL_INTERVAL_MS) || 10000;
const TIMEOUT_MS = Number(process.env.JULES_TIMEOUT_MS) || 30 * 60 * 1000;

function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
  } catch {
    execFileSync('sleep', [String(Math.ceil(ms / 1000))], { stdio: 'ignore' });
  }
}

function detectOwnerRepo() {
  try {
    const raw = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10000,
    }).trim();
    return JSON.parse(raw).nameWithOwner;
  } catch {
    throw new Error('Unable to detect owner/repo via `gh repo view`. Run from a repo with `gh` authenticated.');
  }
}

function fetchIssue(ownerRepo, issue) {
  const title = execFileSync(
    'gh',
    ['issue', 'view', String(issue), '--repo', ownerRepo, '--json', 'title', '-q', '.title'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 },
  ).trim();
  const body = execFileSync(
    'gh',
    ['issue', 'view', String(issue), '--repo', ownerRepo, '--json', 'body', '-q', '.body'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 },
  ).trim();
  return { title, body };
}

async function findSource(ownerRepo) {
  const sources = await listSources();
  const candidates = [
    `sources/${ownerRepo}`,
    `sources/github/${ownerRepo}`,
    ownerRepo,
    `github/${ownerRepo}`,
  ];
  const source = sources.find(s => candidates.includes(s.name) || candidates.includes(s.id));
  if (!source) {
    throw new Error(
      `No Jules source found for ${ownerRepo}. ` +
      'Install the Jules GitHub app in the web UI and connect this repo first.'
    );
  }
  return source.name;
}

function buildPrompt(issue, title, body, stopWhen) {
  let prompt = `Implement GitHub issue #${issue} in this repository.\n\nIssue #${issue}: ${title}\n\n${body}`;
  if (stopWhen) {
    prompt +=
      `\n\nStop condition (set by agentq):\n${stopWhen}\n\n` +
      'When you are confident this stop condition is fully satisfied, print this exact line as the VERY LAST line of your output and then stop:\n' +
      '  SHOULD_FULLY_STOP=true\n' +
      'Otherwise do not print it. Keep working normally toward the issue.';
  }
  return prompt;
}

function prBranchFromUrl(ownerRepo, prUrl) {
  const num = prUrl.split('/').pop();
  const raw = execFileSync('gh', ['pr', 'view', String(num), '--repo', ownerRepo, '--json', 'headRefName'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10000,
  }).trim();
  return JSON.parse(raw).headRefName;
}

function switchWorktreeToBranch(ownerRepo, prNumber, headRefName) {
  // `gh pr checkout` fetches the PR head via the GitHub API, which also
  // works for PRs from FORKS — their head ref does not exist on `origin`,
  // so a plain `git fetch origin <ref>` always failed on fork PRs even
  // though the PR itself was fine.
  execFileSync('gh', ['pr', 'checkout', String(prNumber), '--repo', ownerRepo], {
    stdio: ['inherit', 'pipe', 'pipe'],
    timeout: 60000,
  });
  return headRefName;
}

function currentWorktreeRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
  }).trim();
}

function getDb() {
  const path = require('node:path');
  const { openDb, initSchema } = require('../queue/db.js');
  const dbPath = process.env.ORCHESTRATOR_DB || homeDataPath('orchestrator.sqlite');
  const db = openDb(dbPath);
  initSchema(db);
  return db;
}

async function main() {
  const issue = process.argv[2];
  if (!issue || !/^\d+$/.test(issue)) {
    throw new Error('Usage: jules-issue.js <issue-number>');
  }

  if ((process.env.AGENTQ_JOB_ID || process.argv[4] === '--agentq-pinned-input')
    && (process.env.AGENTQ_PINNED_INPUT !== '1' || !process.env.AGENTQ_INPUT_SHA256
      || !process.env.AGENTQ_WORKTREE || !process.env.BASE_BRANCH)) {
    throw new Error('Queued issue execution requires pinned input metadata; forward it through the sandbox.');
  }
  const pinned = process.env.AGENTQ_PINNED_INPUT === '1' ? readPinnedIssue(issue) : null;
  const ownerRepo = pinned ? new URL(pinned.issue.url).pathname.split('/').slice(1, 3).join('/') : detectOwnerRepo();
  const base = process.env.BASE_BRANCH || 'main';
  const { title, body } = pinned ? pinned.issue : fetchIssue(ownerRepo, issue);
  const prompt = buildPrompt(issue, title, body, process.env.AGENTQ_STOP_WHEN);
  const source = await findSource(ownerRepo);

  // SSE broadcast helper — writes events to stdout for agentq to capture
  const events = [];
  const onEvent = (name, data) => {
    events.push({ name, data, ts: new Date().toISOString() });
    console.log(`event: ${name} ${JSON.stringify(data)}`);
  };

  // Create session via API
  const session = await createSession({
    source,
    prompt,
    baseBranch: base,
    title: `Issue #${issue}: ${title}`,
    automationMode: 'AUTO_CREATE_PR',
  });

  const sessionId = extractSessionId(session);
  console.log(`Jules session ${session.name} created`);

  // If we have an orchestrator DB, use jules-sync for full tracking
  let result;
  let db;
  try {
    db = getDb();
    // Store the session and poll with DB persistence
    const { trackJulesSession } = require('../queue/jules-sync.js');
    result = await trackJulesSession(db, issue, session, {
      onEvent,
      pollIntervalMs: POLL_INTERVAL_MS,
      timeoutMs: TIMEOUT_MS,
    });
  } catch (dbErr) {
    // DB not available — fall back to simple polling (no persistence)
    console.error(`DB unavailable, using simple poll: ${dbErr.message}`);
    result = await simplePoll(sessionId);
  } finally {
    if (db) try { db.close(); } catch {}
  }

  if (!result.prUrl) {
    throw new Error('Jules session completed without producing a pull request');
  }

  const headRefName = prBranchFromUrl(ownerRepo, result.prUrl);
  const localBranch = switchWorktreeToBranch(ownerRepo, result.prUrl.split('/').pop(), headRefName);
  const worktree = currentWorktreeRoot();

  console.log('worktree :', worktree);
  console.log('branch   :', localBranch);
  console.log('session  :', sessionId);
  console.log('pr       :', result.prUrl);
}

/**
 * Simple polling fallback when orchestrator DB is not available.
 */
async function simplePoll(sessionId) {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const session = await getSession(sessionId);
    const pr = session.outputs?.find(o => o.pullRequest)?.pullRequest;
    if (pr) return { state: session.state, prUrl: pr.url };

    const terminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'SUCCEEDED'];
    if (terminal.includes(session.state)) {
      throw new Error(`Jules session ${sessionId} ended in state ${session.state} without producing a pull request`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timeout waiting for Jules session ${sessionId} to produce a pull request`);
}

module.exports = {
  main,
  buildPrompt,
  sessionId: extractSessionId,
  detectOwnerRepo,
  fetchIssue,
  findSource,
  prBranchFromUrl,
  switchWorktreeToBranch,
  simplePoll,
};

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
