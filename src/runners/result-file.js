#!/usr/bin/env node
'use strict';

/**
 * Executor result contract: `AGENTQ_RESULT`.
 *
 * agentq used to recover a run's metadata (worktree, branch, session, usage,
 * verification, stop) by scanning the executor's combined stdout. That channel
 * is untrusted: the executor echoes the issue body and the model's own output,
 * so an issue containing `worktree: /x` could steer verification's cwd and
 * prune's worktree/branch cleanup. The replacement is one file per attempt:
 *
 *   agentq creates a fresh 0700 directory under the job's log directory and
 *   passes <dir>/result.json as AGENTQ_RESULT. The variable is removed from the
 *   model process's environment (only the executor shell and the writer see
 *   it), and the directory is not derivable from sibling file names.
 *
 *   The executor writes ONE JSON object there
 *
 *     { "version": 1, "worktree": string|null, "branch": string|null,
 *       "session": string|null, "usage": object|null,
 *       "verification": "passed"|"failed"|null, "stop": boolean }
 *
 *   atomically (tmp + rename in the same directory) using a JSON encoder, never
 *   shell string interpolation. agentq reads it, validates it here, and applies
 *   the same safety checks to worktree/branch as before. Stdout stays the human
 *   log only: when the file is absent or invalid the run's metadata is null and
 *   the completion records `result_file: 'missing'|'invalid'`.
 *
 * `version` and `stop` are required; every other field may be omitted and is
 * read as null. Unknown top-level keys are rejected so a future field cannot be
 * silently dropped by an older agentq. `usage` is different: it is normalized
 * against an allowlist of the fields the sinks actually consume, so unknown,
 * non-numeric or implausible values are dropped rather than failing the run.
 */

const fs = require('node:fs');
const path = require('node:path');

const RESULT_FILE_ENV = 'AGENTQ_RESULT';
const RESULT_VERSION = 1;
const RESULT_FILE_NAME = 'result.json';
const MAX_RESULT_FILE_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 4096;
const RESULT_KEYS = Object.freeze([
  'version', 'worktree', 'branch', 'session', 'usage', 'verification', 'stop',
]);
const VERIFICATION_STATES = Object.freeze(['passed', 'failed']);

// Usage bounds. A token count or a cost above these is not a plausible run, so
// the field is dropped instead of being clamped: agentq never invents a number
// the executor did not report.
const MAX_TOKEN_VALUE = 1e10;
const MAX_COST_VALUE = 1e4;
const MAX_USAGE_TEXT = 200;
// Timestamp comparison tolerance for coarse filesystem mtime granularity.
const CLOCK_TOLERANCE_MS = 2000;

// Exactly the usage fields src/lib/usage-normalize.js and the completion sinks
// read (camelCase, snake_case and pi/Claude Code native names), plus the
// provider/model attribution usage_records stores.
const USAGE_TOKEN_FIELDS = Object.freeze([
  'inputTokens', 'input_tokens', 'input',
  'outputTokens', 'output_tokens', 'output',
  'cacheTokens', 'cache_tokens',
  'cacheReadTokens', 'cache_read_tokens', 'cache_read_input_tokens', 'cacheRead',
  'cacheWriteTokens', 'cache_write_tokens', 'cache_creation_input_tokens', 'cacheWrite',
  'totalTokens',
]);
const USAGE_COST_FIELDS = Object.freeze(['totalCost', 'total_cost', 'total_cost_usd']);
const USAGE_COST_BREAKDOWN_FIELDS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite', 'total']);
const USAGE_TEXT_FIELDS = Object.freeze(['provider', 'model']);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function invalid(detail) {
  return { ok: false, reason: 'invalid', detail };
}

function boundedNumber(value, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > max) return null;
  return value;
}

function hasControlCharacter(value) {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function boundedText(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_USAGE_TEXT) return null;
  if (hasControlCharacter(value)) return null;
  return value;
}

/**
 * Keep only the usage fields the sinks consume, with finite, non-negative and
 * bounded values. Unknown keys, wrong types, negatives, NaN/Infinity and
 * implausible magnitudes are dropped; the result is null when nothing usable
 * remains. Never throws: usage must not fail an otherwise valid result.
 */
function normalizeUsage(value) {
  if (!isPlainObject(value)) return null;
  const usage = {};
  for (const field of USAGE_TOKEN_FIELDS) {
    const n = boundedNumber(value[field], MAX_TOKEN_VALUE);
    if (n !== null) usage[field] = n;
  }
  for (const field of USAGE_COST_FIELDS) {
    const n = boundedNumber(value[field], MAX_COST_VALUE);
    if (n !== null) usage[field] = n;
  }
  for (const field of USAGE_TEXT_FIELDS) {
    const text = boundedText(value[field]);
    if (text !== null) usage[field] = text;
  }
  if (isPlainObject(value.cost)) {
    const cost = {};
    for (const field of USAGE_COST_BREAKDOWN_FIELDS) {
      const n = boundedNumber(value.cost[field], MAX_COST_VALUE);
      if (n !== null) cost[field] = n;
    }
    if (Object.keys(cost).length) usage.cost = cost;
  } else {
    const n = boundedNumber(value.cost, MAX_COST_VALUE);
    if (n !== null) usage.cost = n;
  }
  return Object.keys(usage).length ? usage : null;
}

function optionalText(value, field) {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== 'string') return invalid(`${field} must be a string or null`);
  if (value.includes('\0')) return invalid(`${field} must not contain NUL bytes`);
  if (value.length > MAX_TEXT_LENGTH) return invalid(`${field} exceeds ${MAX_TEXT_LENGTH} characters`);
  return { ok: true, value: value === '' ? null : value };
}

/**
 * Validate one result object. Returns the normalized value (missing optional
 * fields become null, usage is filtered) so callers never read a half-shaped
 * object.
 */
function validateResultFile(value) {
  if (!isPlainObject(value)) return invalid('result must be a JSON object');
  const unknown = Object.keys(value).filter(key => !RESULT_KEYS.includes(key));
  if (unknown.length) return invalid(`unknown result key(s): ${unknown.sort().join(', ')}`);
  if (value.version !== RESULT_VERSION) return invalid(`version must be ${RESULT_VERSION}`);
  if (typeof value.stop !== 'boolean') return invalid('stop must be a boolean');

  const worktree = optionalText(value.worktree, 'worktree');
  if (!worktree.ok) return worktree;
  const branch = optionalText(value.branch, 'branch');
  if (!branch.ok) return branch;
  const session = optionalText(value.session, 'session');
  if (!session.ok) return session;

  const verification = value.verification == null ? null : value.verification;
  if (verification !== null && !VERIFICATION_STATES.includes(verification)) {
    return invalid(`verification must be one of ${VERIFICATION_STATES.join(', ')} or null`);
  }

  return {
    ok: true,
    value: {
      version: RESULT_VERSION,
      worktree: worktree.value,
      branch: branch.value,
      session: session.value,
      usage: normalizeUsage(value.usage),
      verification,
      stop: value.stop,
    },
  };
}

function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Create this attempt's result path before the executor starts.
 *
 * The path lives in a fresh 0700 directory (mkdtemp: unique, unguessable from
 * sibling names, empty by construction) under the job's log directory, so a
 * leftover or guessed file from another attempt cannot be read as this one.
 * The file itself is NOT created: an executor that writes nothing leaves
 * nothing behind.
 */
function createResultPath(logDir, jobId, attemptId) {
  fs.mkdirSync(logDir, { recursive: true });
  const dir = fs.mkdtempSync(path.join(logDir, `agentq-result-${safeSegment(jobId)}-${safeSegment(attemptId)}-`));
  fs.chmodSync(dir, 0o700);
  return path.join(dir, RESULT_FILE_NAME);
}

/**
 * Write a result object atomically (tmp + rename in the same directory).
 * A null/empty target is a standalone run: nothing to write, no error.
 *
 * Usage is normalized rather than rejected, so an unusable usage value writes
 * `usage: null` instead of failing the whole result. Any other schema error
 * throws before anything is written, and a failed write removes its temporary
 * file so no partial result can be read.
 */
function writeResultFile(target, data) {
  if (!target) return null;
  const checked = validateResultFile(data);
  if (!checked.ok) throw new Error(`refusing to write an invalid result file: ${checked.detail}`);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(checked.value));
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, target);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  return target;
}

/**
 * Read and validate one result file.
 *
 * Returns `{ ok: true, value }` or `{ ok: false, reason: 'missing'|'invalid',
 * detail }`. An absent or empty file is `missing` (the executor wrote nothing);
 * anything present but unreadable, a symlink, oversized, not JSON, or off-schema
 * is `invalid`. There is no fallback to stdout.
 *
 * The file is opened O_NOFOLLOW and inspected through its descriptor (regular
 * file, size within the cap, bounded read), so a swapped path cannot redirect
 * the read. `notBefore` (ms since epoch) rejects a file older than the run, and
 * `uid` rejects one written by another user.
 */
function readResultFile(target, { notBefore = null, uid = null } = {}) {
  if (typeof target !== 'string' || !target) return { ok: false, reason: 'missing', detail: 'no result path' };
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    // O_NONBLOCK: a FIFO planted at the path must not block the event loop;
    // the fstat regular-file check below then rejects it. O_NOFOLLOW covers
    // only the last component, which is enough: the directory is our mkdtemp.
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow | (fs.constants.O_NONBLOCK || 0));
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, reason: 'missing', detail: 'ENOENT' };
    if (err.code === 'ELOOP') return invalid('result path is a symlink');
    return invalid(err.code || 'unreadable');
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return invalid('result path is not a regular file');
    if (stat.size === 0) return { ok: false, reason: 'missing', detail: 'empty result file' };
    if (stat.size > MAX_RESULT_FILE_BYTES) return invalid(`result file exceeds ${MAX_RESULT_FILE_BYTES} bytes`);
    if (uid !== null && stat.uid !== uid) return invalid('result file is owned by another user');
    if (notBefore !== null && stat.mtimeMs < notBefore - CLOCK_TOLERANCE_MS) {
      return invalid('result file predates the run');
    }
    // Bounded read through the descriptor: one byte past the cap proves an
    // oversized file even if it grew after the fstat.
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_RESULT_FILE_BYTES) + 1);
    let read = 0;
    while (read < buffer.length) {
      const chunk = fs.readSync(fd, buffer, read, buffer.length - read, read);
      if (!chunk) break;
      read += chunk;
    }
    if (read > MAX_RESULT_FILE_BYTES) return invalid(`result file exceeds ${MAX_RESULT_FILE_BYTES} bytes`);
    let parsed;
    try {
      parsed = JSON.parse(buffer.subarray(0, read).toString('utf8'));
    } catch {
      return invalid('result file is not valid JSON');
    }
    return validateResultFile(parsed);
  } finally {
    fs.closeSync(fd);
  }
}

function findLastUsage(value, found) {
  if (!value || typeof value !== 'object') return found;
  if (!Array.isArray(value) && isPlainObject(value.usage)) found.value = value.usage;
  for (const child of Object.values(value)) findLastUsage(child, found);
  return found;
}

/**
 * The last usage record in a pi session JSONL file. pi writes one JSON object
 * per line with usage nested inside the message, so this parses each line and
 * looks for a `usage` object rather than matching text (an agent echoing JSON
 * must not be able to fabricate a usage record).
 */
function lastUsageFromSession(text) {
  const found = { value: null };
  for (const line of String(text).split('\n')) {
    if (!line.includes('"usage"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    findLastUsage(parsed, found);
  }
  return found.value;
}

function readUsageFile(file) {
  try {
    return lastUsageFromSession(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const STOP_SENTINEL = /^SHOULD_FULLY_STOP\s*=\s*true$/;
const MAX_TAIL_BYTES = 64 * 1024;

/**
 * True when the LAST non-empty line of `text` is the documented stop sentinel.
 *
 * Only the last line counts: the executor's output echoes the untrusted issue
 * body, and an issue that merely mentions `SHOULD_FULLY_STOP=true` must not end
 * a drain. The prompt asks the agent to print the sentinel as its very last
 * line, so anything else is not a signal.
 */
function endsWithStopSentinel(text) {
  if (typeof text !== 'string' || !text) return false;
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  return lines.length > 0 && STOP_SENTINEL.test(lines[lines.length - 1]);
}

/** Read at most the last `maxBytes` of a file (bounded tail read). */
function readTail(file, maxBytes = MAX_TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function stopFromFile(file) {
  try {
    return endsWithStopSentinel(readTail(file));
  } catch {
    return false;
  }
}

const CLI_FLAGS = Object.freeze([
  'worktree', 'branch', 'session', 'usage-file', 'usage-json', 'verification',
  'stop', 'stop-from-file',
]);

function parseCli(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith('--')) throw new Error(`Unexpected argument: ${flag}`);
    const name = flag.slice(2);
    if (!CLI_FLAGS.includes(name)) throw new Error(`Unknown option: ${flag}`);
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    options[name] = value;
  }
  return options;
}

/**
 * CLI used by the shipped shell executors:
 *
 *   node src/runners/result-file.js --worktree W --branch B --session S \
 *     [--usage-file FILE | --usage-json JSON] [--verification passed|failed] \
 *     [--stop true|false | --stop-from-file CAPTURED-OUTPUT]
 *
 * Writes $AGENTQ_RESULT. Without that variable (a standalone, supervised run)
 * it does nothing and exits 0.
 */
function main(argv = process.argv.slice(2)) {
  const target = process.env[RESULT_FILE_ENV];
  if (!target) return 0;
  const options = parseCli(argv);
  let usage = null;
  if (options['usage-file']) usage = readUsageFile(options['usage-file']);
  else if (options['usage-json']) usage = JSON.parse(options['usage-json']);
  if (options.stop !== undefined && !['true', 'false'].includes(options.stop)) {
    throw new Error(`--stop must be true or false, got ${options.stop}`);
  }
  const stop = options['stop-from-file'] !== undefined
    ? stopFromFile(options['stop-from-file'])
    : options.stop === 'true';
  writeResultFile(target, {
    version: RESULT_VERSION,
    worktree: options.worktree ?? null,
    branch: options.branch ?? null,
    session: options.session ?? null,
    usage,
    verification: options.verification ?? null,
    stop,
  });
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(`result-file: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  RESULT_FILE_ENV,
  RESULT_VERSION,
  RESULT_FILE_NAME,
  MAX_RESULT_FILE_BYTES,
  MAX_TOKEN_VALUE,
  MAX_COST_VALUE,
  CLOCK_TOLERANCE_MS,
  RESULT_KEYS,
  VERIFICATION_STATES,
  normalizeUsage,
  validateResultFile,
  createResultPath,
  writeResultFile,
  readResultFile,
  lastUsageFromSession,
  readUsageFile,
  endsWithStopSentinel,
  readTail,
  stopFromFile,
  parseCli,
  main,
};
