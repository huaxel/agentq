'use strict';

const { createHash } = require('node:crypto');
const { execFileSync, execFile } = require('node:child_process');

const TYPE = 'agentq.github-issue-input';
const MAX_INPUT_BYTES = 512 * 1024;

function invalid() {
  const error = new Error('Missing or invalid pinned issue input; enqueue a new job to capture the intended issue text.');
  error.statusCode = 400;
  return error;
}

function payload(input, number) {
  if (!input || input.type !== TYPE || input.version !== 1 || !input.issue
    || !Number.isSafeInteger(input.issue.number) || input.issue.number <= 0
    || (number !== undefined && input.issue.number !== Number(number))) throw invalid();
  const issue = input.issue;
  for (const value of [issue.title, issue.body, issue.url, issue.updated_at, input.captured_at]) {
    if (typeof value !== 'string' || value.includes('\0') || Buffer.from(value).toString('utf8') !== value) throw invalid();
  }
  if (!issue.title || !Number.isFinite(Date.parse(issue.updated_at)) || !Number.isFinite(Date.parse(input.captured_at))) throw invalid();
  let url;
  try { url = new URL(issue.url); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !new RegExp(`^/[^/]+/[^/]+/issues/${issue.number}$`).test(url.pathname)) throw invalid();
  return {
    type: TYPE, version: 1, captured_at: input.captured_at,
    issue: { number: issue.number, title: issue.title, body: issue.body, url: issue.url, updated_at: issue.updated_at },
  };
}

/**
 * The pinned-input digest: SHA-256 over a domain separator and the canonical
 * JSON payload. The generic task input (src/core/task-input.js) reuses this
 * helper with its own domain, so there is exactly one digest implementation.
 *
 * @param {unknown} value canonical payload, without the digest itself
 * @param {string} [domain] separator that keeps input types from colliding
 * @returns {string} lowercase hex digest
 */
function digestPayload(value, domain = 'agentq-issue-input-v1') {
  return createHash('sha256').update(domain).update('\0').update(JSON.stringify(value)).digest('hex');
}

function digest(value) {
  return digestPayload(value);
}

function validateIssueInput(input, number) {
  const canonical = payload(input, number);
  const result = { ...canonical, sha256: digest(canonical) };
  if (input.sha256 !== result.sha256
    || Object.keys(input).sort().join(',') !== 'captured_at,issue,sha256,type,version'
    || Object.keys(input.issue).sort().join(',') !== 'body,number,title,updated_at,url'
    || Buffer.byteLength(JSON.stringify(result)) > MAX_INPUT_BYTES) throw invalid();
  return result;
}

function createIssueInput(raw, capturedAt = new Date().toISOString()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
  const canonical = payload({
    type: TYPE, version: 1, captured_at: capturedAt,
    issue: { number: raw.number, title: raw.title, body: raw.body, url: raw.url, updated_at: raw.updatedAt },
  });
  return validateIssueInput({ ...canonical, sha256: digest(canonical) }, raw.number);
}

function fetchIssueInput(repo, number, { run = execFileSync } = {}) {
  let raw;
  try {
    raw = JSON.parse(run('gh', ['issue', 'view', String(number), '--json', 'number,title,body,url,updatedAt'], {
      cwd: repo, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    }));
  } catch {
    throw new Error('Unable to capture issue input from GitHub; nothing was enqueued. Check gh access and retry.');
  }
  return validateIssueInput(createIssueInput(raw), number);
}

function fetchIssueInputAsync(repo, number) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['issue', 'view', String(number), '--json', 'number,title,body,url,updatedAt'], {
      cwd: repo, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    }, (error, stdout) => {
      if (error) {
        reject(new Error('Unable to capture issue input from GitHub; nothing was enqueued. Check server gh access and retry.'));
        return;
      }
      try { resolve(validateIssueInput(createIssueInput(JSON.parse(stdout)), number)); }
      catch { reject(invalid()); }
    });
  });
}

function issueInputFromPrompt(prompt, number) {
  try { return validateIssueInput(JSON.parse(prompt), number); } catch { return null; }
}

module.exports = {
  TYPE, MAX_INPUT_BYTES, createIssueInput, fetchIssueInput, fetchIssueInputAsync, validateIssueInput,
  issueInputFromPrompt, digestPayload,
};
