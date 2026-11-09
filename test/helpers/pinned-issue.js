'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after } = require('node:test');
const source = require('../../src/queue/sources.js');
const { createIssueInput, issueInputFromPrompt } = require('../../src/core/issue-input.js');

function rawIssue(number, body = 'fixture body') {
  return { number: Number(number), title: 'Fixture issue', body,
    url: `https://github.com/test/repo/issues/${number}`, updatedAt: '2026-11-02T00:00:00Z' };
}

function issueRunner(_command, args) {
  return JSON.stringify(rawIssue(Number(args[2])));
}

class SqliteSource extends source.SqliteSource {
  constructor(dbPath, options = {}) { super(dbPath, { issueRunner, ...options }); }
}

class OrchestratorSource extends source.OrchestratorSource {
  constructor(url, workerId, options = {}) { super(url, workerId, { issueRunner, ...options }); }
}

function snapshotForIssue(number, body) {
  return createIssueInput(rawIssue(number, body));
}

// Positive scheduling fixtures need a complete request now. Snapshot-policy
// rejection tests deliberately use the real API without this adapter.
function pinnedTask(task) {
  if (task.kind !== 'github_issue') return task;
  const number = task.issue_num ?? 1;
  if (issueInputFromPrompt(task.prompt, number)) return task;
  return { ...task, issue_num: number, prompt: JSON.stringify(snapshotForIssue(number, task.prompt || 'fixture body')) };
}

const tools = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-fixture-gh-'));
after(() => fs.rmSync(tools, { recursive: true, force: true }));
fs.writeFileSync(path.join(tools, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'issue' || args[1] !== 'view' || !Number.isSafeInteger(Number(args[2]))) process.exit(2);
if (process.env.FIXTURE_GH_CALLS) fs.appendFileSync(process.env.FIXTURE_GH_CALLS, 'fetch\\n');
if (process.env.FIXTURE_GH_FAIL === '1') process.exit(7);
const number = Number(args[2]);
console.log(JSON.stringify({number, title: 'Fixture issue', body: process.env.FIXTURE_ISSUE_BODY ?? 'fixture body', url: 'https://github.com/test/repo/issues/' + number, updatedAt: '2026-11-02T00:00:00Z'}));
`, { mode: 0o755 });

function githubEnv() {
  return { PATH: `${tools}${path.delimiter}${process.env.PATH}` };
}

module.exports = { SqliteSource, OrchestratorSource, snapshotForIssue, pinnedTask, githubEnv, rawIssue };
