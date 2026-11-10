'use strict';

/**
 * Generic pinned task input.
 *
 * The queue pins a task's input at enqueue time: a digested snapshot goes to
 * the executor on stdin, and the executor checks it against
 * `AGENTQ_INPUT_SHA256`, so later edits cannot change what runs. GitHub is one
 * SOURCE of that input, not the shape itself:
 *
 *   { type: 'agentq.task-input/v1', source: 'github'|'file'|'inline',
 *     ref, title, body, url, capturedAt, sha256 }
 *
 * `ref` is the issue number as a string (github), the absolute file path
 * (file), or null (inline). `sha256` covers the canonical JSON of every other
 * field, using the same digest helper as the legacy issue input.
 *
 * Legacy `agentq.github-issue-input` snapshots are converted here, at read
 * time, in one place: `taskInputFromPrompt` and `taskInputFromTask` are the
 * only conversion points, so no call site needs its own compatibility branch.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  TYPE: ISSUE_TYPE,
  MAX_INPUT_BYTES,
  digestPayload,
  fetchIssueInput,
  fetchIssueInputAsync,
  validateIssueInput,
} = require('./issue-input.js');

const TYPE = 'agentq.task-input/v1';
const SOURCES = Object.freeze(['github', 'file', 'inline']);
const DIGEST_DOMAIN = 'agentq-task-input-v1';
const INVALID_INPUT_MESSAGE = 'Missing or invalid pinned task input; enqueue a new job to capture the intended task text.';

/**
 * @param {string} [message]
 * @returns {Error}
 */
function invalid(message = INVALID_INPUT_MESSAGE) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

/**
 * Validate one text field, naming the actual problem. A NUL byte and invalid
 * UTF-8 get their own one-line errors instead of the generic refusal, so a
 * caller can tell what to fix.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
function requireText(value, label) {
  if (typeof value !== 'string') throw invalid();
  if (value.includes('\0')) throw invalid(`${label} must not contain a NUL byte.`);
  if (Buffer.from(value).toString('utf8') !== value) throw invalid(`${label} is not valid UTF-8.`);
  return value;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isGithubRef(value) {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

/**
 * Canonicalize and validate the fields that are digested. Throws on anything
 * ambiguous (unknown source, a ref of the wrong shape for its source, a URL
 * that does not name the issue, invalid UTF-8, NUL bytes).
 *
 * @param {Record<string, any>} input
 * @param {string|number} [expectedRef] the ref the caller expects (github)
 * @returns {{ type: string, source: string, ref: string|null, title: string, body: string, url: string|null, capturedAt: string }}
 */
function payload(input, expectedRef) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  if (input.type !== TYPE) throw invalid();
  if (!SOURCES.includes(input.source)) throw invalid();
  const source = input.source;
  const ref = input.ref;
  if (source === 'github') {
    if (!isGithubRef(ref)) throw invalid();
    if (expectedRef !== undefined && expectedRef !== null && ref !== String(expectedRef)) throw invalid();
  } else if (source === 'file') {
    if (typeof ref !== 'string' || !path.isAbsolute(ref)) throw invalid();
    requireText(ref, 'Task ref');
  } else if (ref !== null) {
    throw invalid();
  }
  if (!requireText(input.title, 'Task title').trim()) throw invalid();
  requireText(input.body, 'Task body');
  const url = input.url;
  if (source === 'github') {
    // A queue capture always carries the issue URL; a standalone `gh issue
    // view` may omit it, and nothing in the prompt needs it.
    if (url !== null) {
      requireText(url, 'Task URL');
      let parsed;
      try { parsed = new URL(url); } catch { throw invalid(); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
        || !new RegExp(`^/[^/]+/[^/]+/issues/${ref}$`).test(parsed.pathname)) throw invalid();
    }
  } else if (url !== null) {
    throw invalid();
  }
  if (!Number.isFinite(Date.parse(requireText(input.capturedAt, 'Task capture time')))) throw invalid();
  return {
    type: TYPE,
    source,
    ref,
    title: input.title,
    body: input.body,
    url,
    capturedAt: input.capturedAt,
  };
}

/**
 * Validate a stored or transported input and return its canonical form.
 *
 * @param {unknown} input
 * @param {string|number} [expectedRef]
 * @returns {Record<string, any>} canonical input including `sha256`
 */
function validateTaskInput(input, expectedRef) {
  const canonical = payload(input, expectedRef);
  const result = { ...canonical, sha256: digestPayload(canonical, DIGEST_DOMAIN) };
  if (input.sha256 !== result.sha256
    || Object.keys(input).sort().join(',') !== 'body,capturedAt,ref,sha256,source,title,type,url') throw invalid();
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_INPUT_BYTES) {
    throw invalid(`Pinned task input is larger than ${MAX_INPUT_BYTES} bytes.`);
  }
  return result;
}

/**
 * Build a new pinned input.
 *
 * @param {{ source: string, ref?: string|null, title: string, body: string, url?: string|null }} fields
 * @param {string} [capturedAt]
 * @returns {Record<string, any>} canonical input including `sha256`
 */
function createTaskInput(fields, capturedAt = new Date().toISOString()) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw invalid();
  const canonical = payload({
    type: TYPE,
    source: fields.source,
    ref: fields.ref === undefined ? null : fields.ref,
    title: fields.title,
    body: fields.body,
    url: fields.url === undefined ? null : fields.url,
    capturedAt,
  });
  return validateTaskInput({ ...canonical, sha256: digestPayload(canonical, DIGEST_DOMAIN) });
}

/**
 * Map a captured GitHub issue snapshot to the generic shape.
 *
 * @param {unknown} issueInput legacy `agentq.github-issue-input` snapshot
 * @returns {Record<string, any>}
 */
function taskInputFromIssue(issueInput) {
  const issue = validateIssueInput(issueInput);
  return createTaskInput({
    source: 'github',
    ref: String(issue.issue.number),
    title: issue.issue.title,
    body: issue.issue.body,
    url: issue.issue.url,
  }, issue.captured_at);
}

/**
 * Map the raw `gh issue view` JSON to the generic shape.
 *
 * Standalone executors use this: they do not have a queue snapshot to validate,
 * and gh may omit fields the queue capture always requests.
 *
 * @param {unknown} raw
 * @param {string} [capturedAt]
 * @returns {Record<string, any>}
 */
function taskInputFromGithubJson(raw, capturedAt = new Date().toISOString()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
  const number = Number(raw.number);
  if (!Number.isSafeInteger(number) || number <= 0) throw invalid();
  return createTaskInput({
    source: 'github',
    ref: String(number),
    title: raw.title,
    body: typeof raw.body === 'string' ? raw.body : '',
    url: typeof raw.url === 'string' && raw.url ? raw.url : null,
  }, capturedAt);
}

/**
 * Capture a GitHub issue as a pinned task input (blocking).
 *
 * @param {string} repo
 * @param {number|string} number
 * @param {{ run?: Function }} [options]
 * @returns {Record<string, any>}
 */
function fetchTaskInput(repo, number, options = {}) {
  return taskInputFromIssue(fetchIssueInput(repo, number, options));
}

/**
 * Capture a GitHub issue as a pinned task input (non-blocking).
 *
 * @param {string} repo
 * @param {number|string} number
 * @returns {Promise<Record<string, any>>}
 */
function fetchTaskInputAsync(repo, number) {
  return fetchIssueInputAsync(repo, number).then(taskInputFromIssue);
}

/**
 * The first `# ` heading of a Markdown document, or null.
 *
 * @param {string} body
 * @returns {string|null}
 */
function firstHeading(body) {
  for (const line of body.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return null;
}

/**
 * Read a local Markdown spec as a pinned task input.
 *
 * The whole file is the body; the title is the first `# ` heading, else the
 * file name. A missing, empty or oversized file is refused with a one-line
 * error before anything is enqueued.
 *
 * @param {string} file
 * @param {string} [capturedAt]
 * @returns {Record<string, any>}
 */
function readSpecFile(file, capturedAt = new Date().toISOString()) {
  const resolved = path.resolve(String(file));
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw invalid(`Spec file not found: ${resolved}`);
  }
  if (!stat.isFile()) throw invalid(`Spec path is not a file: ${resolved}`);
  if (stat.size > MAX_INPUT_BYTES) {
    throw invalid(`Spec file is larger than ${MAX_INPUT_BYTES} bytes: ${resolved}`);
  }
  const body = fs.readFileSync(resolved, 'utf8');
  if (!body.trim()) throw invalid(`Spec file is empty: ${resolved}`);
  if (Buffer.byteLength(body) > MAX_INPUT_BYTES) {
    throw invalid(`Spec file is larger than ${MAX_INPUT_BYTES} bytes: ${resolved}`);
  }
  return createTaskInput({
    source: 'file',
    ref: resolved,
    title: firstHeading(body) || path.basename(resolved),
    body,
  }, capturedAt);
}

/**
 * Build an inline pinned input (used by MCP, which never reads a file path).
 *
 * @param {string} title
 * @param {string} body
 * @param {string} [capturedAt]
 * @returns {Record<string, any>}
 */
function createInlineTaskInput(title, body, capturedAt = new Date().toISOString()) {
  return createTaskInput({ source: 'inline', ref: null, title, body }, capturedAt);
}

/**
 * @param {unknown} prompt
 * @returns {Record<string, any>|null}
 */
function parseJsonObject(prompt) {
  if (typeof prompt !== 'string' || !prompt.trimStart().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(prompt);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read a pinned input out of a stored prompt, converting a legacy issue
 * snapshot on the way. Returns null for a plain prompt or anything invalid.
 *
 * @param {unknown} prompt
 * @param {string|number} [expectedRef]
 * @returns {Record<string, any>|null}
 */
function taskInputFromPrompt(prompt, expectedRef) {
  const parsed = parseJsonObject(prompt);
  if (!parsed) return null;
  try {
    if (parsed.type === TYPE) return validateTaskInput(parsed, expectedRef);
    if (parsed.type === ISSUE_TYPE) return taskInputFromIssue(validateIssueInput(parsed, expectedRef));
  } catch {
    return null;
  }
  return null;
}

/**
 * The pinned input of a stored task row, or null when it has none.
 *
 * @param {{ prompt?: unknown, issue_num?: number|null }} task
 * @returns {Record<string, any>|null}
 */
function taskInputFromTask(task) {
  if (!task || typeof task !== 'object') return null;
  return taskInputFromPrompt(task.prompt, task.issue_num ?? undefined);
}

/**
 * The canonical input to store for a task being created.
 *
 * A producer may hand over either shape (the CLI/MCP capture a legacy issue
 * snapshot; a spec enqueue hands over the generic one), so this is the single
 * conversion point on the write path. Returns null for a task with no pinned
 * input, and throws when a github/spec task has none.
 *
 * @param {Record<string, any>} task
 * @returns {Record<string, any>|null}
 */
function pinTaskInput(task) {
  if (!task || typeof task !== 'object' || task.kind === 'feedback') return null;
  const input = taskInputFromPrompt(task.prompt, task.issue_num ?? undefined);
  if (input) {
    // A GitHub task must be pinned to a GitHub input: an inline/file snapshot
    // under kind github_issue would never pass the job gate.
    if ((task.kind === 'github_issue' || task.issue_num != null) && input.source !== 'github') throw invalid();
    return input;
  }
  if (task.kind === 'github_issue' || task.kind === 'spec' || task.issue_num != null) throw invalid();
  return null;
}

/**
 * The input a job carries, from its stored prompt (preferred) or its derived
 * field. Returns null when the job has no pinned input at all.
 *
 * @param {Record<string, any>} job
 * @returns {Record<string, any>|null}
 */
function inputForJob(job) {
  // A stored prompt is authoritative: when it holds JSON it must validate, and
  // a tampered prompt is a refusal rather than a reason to trust the derived
  // field. The derived field is only used when there is no prompt at all.
  const hasPrompt = typeof job.prompt === 'string' && job.prompt.trimStart().startsWith('{');
  if (hasPrompt) return taskInputFromPrompt(job.prompt, job.issue_number ?? undefined);
  if (job.task_input) {
    try { return validateTaskInput(job.task_input, job.issue_number ?? undefined); } catch { return null; }
  }
  return null;
}

/**
 * Validate the pinned input of a job, whichever source it came from.
 *
 * Returns null for a job with no pinned input (feedback, a plain prompt task).
 * Throws for a github/spec job whose input is missing, tampered or for another
 * issue.
 *
 * @param {Record<string, any>} job
 * @returns {Record<string, any>|null}
 */
function validateTaskJob(job) {
  if (job.kind === 'feedback') return null;
  const input = inputForJob(job);
  if (job.kind === 'spec') {
    if (!input) throw invalid();
    return input;
  }
  if (job.kind === 'github_issue' || job.issue_number != null) {
    if (!input || input.source !== 'github') throw invalid();
    if (!Number.isSafeInteger(job.issue_number) || job.issue_number <= 0) throw invalid();
    if (input.ref !== String(job.issue_number)) throw invalid();
    return input;
  }
  // No kind at all is still an issue job by legacy default: only an explicit
  // non-issue kind with no issue number is exempt from the pinned-input gate.
  if (!job.kind) {
    if (!input) throw invalid();
    return input;
  }
  return input;
}

/**
 * Read the pinned input an executor receives on stdin and verify it against
 * `AGENTQ_INPUT_SHA256`.
 *
 * `expectedRef` is the identity the caller is running (an issue number for a
 * GitHub task): a github input for another issue is refused.
 *
 * @param {string|number} [expectedRef]
 * @returns {Record<string, any>}
 */
function readPinnedTaskInput(expectedRef) {
  try {
    const input = validateTaskInput(JSON.parse(fs.readFileSync(0, 'utf8')), expectedRef);
    if (input.sha256 !== process.env.AGENTQ_INPUT_SHA256) throw invalid();
    return input;
  } catch {
    throw invalid();
  }
}

/**
 * The worktree/branch label for an input: `issue-<n>` for GitHub (the
 * documented standalone contract) or `task-<slug>` for a spec.
 *
 * Shared with the shell executors (via src/runners/executor-input.js) and with
 * prune's standalone-ownership check, so all three derive the SAME name from
 * the pinned input.
 *
 * @param {Record<string, any>} input
 * @returns {string}
 */
function taskSlug(input) {
  if (input.source === 'github') return `issue-${input.ref}`;
  const base = input.source === 'file'
    ? path.basename(input.ref).replace(/\.[^.]+$/, '')
    : input.title;
  const slug = String(base)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `task-${slug || 'spec'}`;
}

module.exports = {
  TYPE,
  SOURCES,
  MAX_INPUT_BYTES,
  INVALID_INPUT_MESSAGE,
  createTaskInput,
  createInlineTaskInput,
  readSpecFile,
  firstHeading,
  taskInputFromIssue,
  taskInputFromGithubJson,
  fetchTaskInput,
  fetchTaskInputAsync,
  taskInputFromPrompt,
  taskInputFromTask,
  pinTaskInput,
  validateTaskInput,
  validateTaskJob,
  readPinnedTaskInput,
  taskSlug,
};
