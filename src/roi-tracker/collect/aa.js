#!/usr/bin/env node
'use strict';
/**
 * Artificial Analysis snapshot collector — one recorded copy of the AA v2
 * language-model catalog, so score proposals (`aa-propose`) never need the
 * network and every proposal can be traced to a snapshot.
 *
 * The reference implementation is the Google Sheets importer
 * (`gscripts/model-catalogs.gs`, fetchArtificialAnalysisData). This file
 * reproduces its request shape and validation exactly:
 *
 *   - the Free endpoint (`/api/v2/language/models/free`)
 *   - `x-api-key` header, never logged
 *   - pagination validated per page (page number, total_pages, has_more)
 *   - Intelligence Index version must be stable across the whole crawl
 *   - bounded retries (3 attempts) with Retry-After, long cooldowns fail fast
 *   - response size cap, idle timeout and a total per-request deadline
 *   - duplicate or missing model ids abort the crawl
 *
 * The Free body carries the headline indices, prices and performance, and no
 * per-benchmark evaluations at all (0 of 726 models on 2026-11-08). The Pro
 * endpoint that adds them needs a Pro+ key this project does not have, so it is
 * not implemented: a flag that only ever returns 403 is a trap, not a feature.
 * The six benchmark columns in the registry come from the AA website or manual
 * research instead (see docs/benchmark-backlog.md).
 *
 * The raw model records are kept verbatim: the field mapping lives in
 * `aa-propose.js`, and a lossy snapshot would make that mapping unauditable.
 *
 * Credentials: `AA_API_KEY`, else `${XDG_CONFIG_HOME:-~/.config}/agentq/aa-api-key`.
 * The key file must be a regular file (not a symlink) owned by the current uid
 * with mode exactly 0600; it is opened with O_NOFOLLOW and read through the
 * descriptor, so a swapped path cannot redirect the read. No key means a clear
 * error and no network call at all.
 *
 * Usage:
 *   npm run aa-sync                # fetch + validate -> data/aa-snapshot.json
 *   npm run aa-sync -- --dry-run   # fetch + validate, write nothing
 */
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const { homeDataPath } = require('../../lib/home.js');

/** Snapshots are personal data: they live in AGENTQ_HOME, never the checkout. */
const freeSnapshotPath = () => homeDataPath('aa-snapshot.json');
const RELATIVE_FREE = 'data/aa-snapshot.json';

/** Supported V2 language catalog (see gscripts/README.md). */
const ENDPOINT = 'https://artificialanalysis.ai/api/v2/language/models';

const MAX_PAGES = 100;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 30000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const REQUEST_DEADLINE_MS = 60000;
const PAGE_DELAY_MS = 150;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
/** Transient transport failures worth another attempt (never auth/DNS-absent). */
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);
const STATUS_HINT = {
  401: 'check the API key',
  403: 'check that the key is valid for this endpoint',
  410: 'endpoint retired; update to a supported V2 endpoint',
  429: 'rate limited; retry later',
};

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** URL for one page of the Free catalog. */
function pageUrl(page) {
  return `${ENDPOINT}/free?page=${page}`;
}

function relativeOut(file) {
  return file === freeSnapshotPath() ? RELATIVE_FREE : file;
}

/** Case-insensitive header lookup (node lowercases, injected clients may not). */
function headerOf(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * Retry delay from `Retry-After` (seconds or HTTP date), else exponential
 * backoff. Same policy as the gs importer: never a negative sleep.
 */
function retryDelayMs(retryAfter, attempt, nowMs) {
  const backoff = 1000 * 2 ** attempt;
  const raw = retryAfter == null ? '' : String(retryAfter).trim();
  if (!raw) return backoff;
  if (/^\d+$/.test(raw)) return Math.max(0, Number(raw) * 1000);
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return backoff;
  return Math.max(0, at - nowMs);
}

/**
 * Parse and validate one page. Validation is identical to the gs importer so a
 * broken or shifting catalog aborts the crawl instead of writing a partial
 * snapshot. The response body is never echoed (it may hold provider secrets).
 */
function parsePage(body, page) {
  if (typeof body !== 'string') {
    throw new Error(`Artificial Analysis page ${page}: response body is not text`);
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error(`Artificial Analysis page ${page}: response exceeded ${MAX_RESPONSE_BYTES} bytes`);
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`Artificial Analysis page ${page}: invalid JSON response`);
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
    throw new Error(`Artificial Analysis page ${page}: expected a data array`);
  }
  const pagination = payload.pagination;
  const wellFormed = pagination
    && typeof pagination === 'object'
    && pagination.page === page
    && Number.isInteger(pagination.total_pages)
    && pagination.total_pages >= page
    && typeof pagination.has_more === 'boolean'
    && pagination.has_more === (page < pagination.total_pages);
  if (!wellFormed) {
    throw new Error(`Artificial Analysis page ${page}: invalid pagination; existing snapshot unchanged`);
  }
  return payload;
}

/**
 * Default transport: https with an idle timeout, a total per-request deadline
 * and a hard byte cap. Both timers exist because a slow-drip response never
 * trips an idle timeout on its own.
 */
function defaultHttp(url, headers, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? REQUEST_DEADLINE_MS;
  // `transport` exists so the socket-level limits can be exercised against a
  // local server without a certificate; production always uses https.
  const transport = options.transport ?? https;
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      settle(value);
    };
    const req = transport.get(url, { headers, timeout: idleTimeoutMs }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          // Settle here: a fully buffered body can still emit 'end' after the
          // destroy, which would otherwise resolve an oversized response.
          finish(reject, new Error(`response exceeded ${maxBytes} bytes`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        finish(resolve, {
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', error => finish(reject, error));
    });
    deadline = setTimeout(() => req.destroy(new Error(`request deadline of ${deadlineMs}ms exceeded`)), deadlineMs);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', error => finish(reject, error));
  });
}

/**
 * Fetch one page with bounded retries. Retries cover transient HTTP statuses
 * and transient transport failures; both share the same attempt budget.
 */
async function fetchPage({
  page,
  apiKey,
  http = defaultHttp,
  sleep = defaultSleep,
  nowMs = Date.now,
}) {
  const url = pageUrl(page);
  let lastStatus = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await http(url, { 'x-api-key': apiKey, Accept: 'application/json' });
    } catch (error) {
      const code = error && error.code;
      if (RETRYABLE_CODES.has(code) && attempt < MAX_ATTEMPTS - 1) {
        await sleep(retryDelayMs(null, attempt, nowMs()));
        continue;
      }
      const detail = code || (error && error.message) || 'transport error';
      throw new Error(`Artificial Analysis page ${page}: ${detail}`);
    }
    const status = res && res.status;
    if (status === 200) return parsePage(res.body, page);
    lastStatus = status;
    if (RETRYABLE_STATUS.has(status) && attempt < MAX_ATTEMPTS - 1) {
      const delay = retryDelayMs(headerOf(res.headers, 'retry-after'), attempt, nowMs());
      // Do not burn the request budget on a long cooldown; fail and retry later.
      if (delay > MAX_RETRY_DELAY_MS) {
        throw new Error(`Artificial Analysis page ${page}: HTTP ${status}; retry later after cooldown`);
      }
      await sleep(delay);
      continue;
    }
    const hint = STATUS_HINT[status];
    throw new Error(`Artificial Analysis page ${page}: HTTP ${status}${hint ? `; ${hint}` : ''}`);
  }
  throw new Error(`Artificial Analysis page ${page}: HTTP ${lastStatus}; retries exhausted`);
}

/**
 * Crawl every page and validate cross-page invariants (stable Intelligence
 * Index version, stable page count, no duplicate ids, no empty middle page).
 */
async function collectAll({
  apiKey,
  http = defaultHttp,
  sleep = defaultSleep,
  nowMs = Date.now,
  pageDelayMs = PAGE_DELAY_MS,
} = {}) {
  if (!apiKey) throw new Error('Artificial Analysis access needs an API key');
  const models = [];
  const seen = new Set();
  let intelligenceIndexVersion;
  let totalPages;
  let pageCount = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const payload = await fetchPage({ page, apiKey, http, sleep, nowMs });
    const pagination = payload.pagination;
    pageCount = page;

    if (page === 1) {
      intelligenceIndexVersion = payload.intelligence_index_version;
      totalPages = pagination.total_pages;
      if (typeof intelligenceIndexVersion !== 'number' || !Number.isFinite(intelligenceIndexVersion)) {
        throw new Error('Artificial Analysis: missing Intelligence Index version');
      }
      if (totalPages > MAX_PAGES) {
        throw new Error(`Artificial Analysis: catalog exceeds the ${MAX_PAGES}-page safety limit`);
      }
    } else if (payload.intelligence_index_version !== intelligenceIndexVersion
      || pagination.total_pages !== totalPages) {
      throw new Error('Artificial Analysis: catalog changed during pagination; retry sync');
    }

    if (pagination.has_more && payload.data.length === 0) {
      throw new Error(`Artificial Analysis page ${page}: empty intermediate page; existing snapshot unchanged`);
    }
    for (const model of payload.data) {
      if (!model || typeof model.id !== 'string' || !model.id) {
        throw new Error(`Artificial Analysis page ${page}: missing model id; retry sync`);
      }
      if (seen.has(model.id)) {
        throw new Error(`Artificial Analysis page ${page}: duplicate model id; retry sync`);
      }
      seen.add(model.id);
      models.push(model);
    }
    if (!pagination.has_more) break;
    await sleep(pageDelayMs);
  }

  if (!models.length) {
    throw new Error('Artificial Analysis returned no models; existing snapshot unchanged');
  }
  return {
    endpoint: pageUrl(1).replace('?page=1', ''),
    intelligenceIndexVersion,
    totalPages,
    pageCount,
    models,
  };
}

/** Snapshot document written to data/aa-snapshot.json. */
function buildSnapshot(result, { now = new Date() } = {}) {
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    source: { endpoint: result.endpoint },
    intelligenceIndexVersion: result.intelligenceIndexVersion,
    pageCount: result.pageCount,
    modelCount: result.models.length,
    models: result.models,
  };
}

/** Where a key file would live when AA_API_KEY is not set. */
function keyFilePath({ env = process.env, home = os.homedir() } = {}) {
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : '';
  const base = xdg || path.join(home, '.config');
  return path.join(base, 'agentq', 'aa-api-key');
}

/**
 * Resolve the API key: env first, then the 0600 key file. Returns
 * `{ key, source }`; the key itself is never included in any message.
 *
 * The file path is untrusted input: it is lstat'ed (symlinks refused), opened
 * with O_NOFOLLOW, then fstat'ed through the descriptor so the checks apply to
 * the object actually read. A group/world-readable key, or one owned by another
 * uid, is a leak and is refused rather than used.
 */
function readApiKey({
  env = process.env,
  home = os.homedir(),
  fs: fsImpl = fs,
  getuid = typeof process.getuid === 'function' ? process.getuid.bind(process) : null,
} = {}) {
  const fromEnv = typeof env.AA_API_KEY === 'string' ? env.AA_API_KEY.trim() : '';
  if (fromEnv) return { key: fromEnv, source: 'AA_API_KEY' };

  const file = keyFilePath({ env, home });
  const missing = () => new Error(`no Artificial Analysis API key: set AA_API_KEY or write the key to ${file} (mode 0600)`);

  let linkStat;
  try {
    linkStat = fsImpl.lstatSync(file);
  } catch {
    throw missing();
  }
  if (linkStat.isSymbolicLink()) {
    throw new Error(`${file} is a symlink; refusing to read the key through it`);
  }
  // Checked before opening: opening a FIFO read-only blocks until a writer
  // appears, so a non-regular key path could hang the sync forever.
  if (!linkStat.isFile()) {
    throw new Error(`${file} is not a regular file`);
  }

  const noFollow = fsImpl.constants && fsImpl.constants.O_NOFOLLOW ? fsImpl.constants.O_NOFOLLOW : 0;
  let fd;
  try {
    fd = fsImpl.openSync(file, fsImpl.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw missing();
    throw new Error(`cannot open ${file}: ${(error && error.code) || 'unknown error'}`);
  }
  try {
    const stat = fsImpl.fstatSync(fd);
    if (typeof stat.isFile === 'function' && !stat.isFile()) {
      throw new Error(`${file} is not a regular file`);
    }
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(`${file} must be mode 0600 (found 0${mode.toString(8)}); refusing to read the key`);
    }
    const uid = typeof getuid === 'function' ? getuid() : null;
    if (uid != null && stat.uid !== uid) {
      throw new Error(`${file} is owned by uid ${stat.uid}, not ${uid}; refusing to read the key`);
    }
    const key = String(fsImpl.readFileSync(fd, 'utf8')).trim();
    if (!key) throw new Error(`${file} is empty`);
    return { key, source: file };
  } finally {
    fsImpl.closeSync(fd);
  }
}

/** Atomic write (tmp + rename) so a crash never leaves a half snapshot. */
function writeSnapshot(file, snapshot) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Read a snapshot; throws with the command that creates one. */
function readSnapshot(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`no Artificial Analysis snapshot at ${file}; run npm run aa-sync first`);
  }
  let snapshot;
  try {
    snapshot = JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON in ${file}; run npm run aa-sync again`);
  }
  if (!snapshot || !Array.isArray(snapshot.models)) {
    throw new Error(`${file} has no models array; run npm run aa-sync again`);
  }
  return snapshot;
}

/** Key resolution + crawl + write, in that order (no key means no network). */
async function runSync({
  env = process.env,
  home = os.homedir(),
  http = defaultHttp,
  sleep,
  nowMs,
  out,
  dryRun = false,
  now = new Date(),
} = {}) {
  const { key } = readApiKey({ env, home });
  const result = await collectAll({ apiKey: key, http, sleep, nowMs });
  const snapshot = buildSnapshot(result, { now });
  const target = out || freeSnapshotPath();
  if (!dryRun) writeSnapshot(target, snapshot);
  return snapshot;
}

function parseArgs(argv) {
  const opts = { dryRun: false, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--out') {
      const value = argv[++i];
      if (!value) throw new Error('--out needs a path');
      opts.out = path.resolve(value);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const USAGE = `Usage: npm run aa-sync -- [--dry-run] [--out PATH]

  --dry-run   fetch and validate, print a summary, write nothing
  --out PATH  snapshot path (default ${RELATIVE_FREE})

Key: AA_API_KEY, or \${XDG_CONFIG_HOME:-~/.config}/agentq/aa-api-key (mode 0600).`;

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const target = opts.out || freeSnapshotPath();
  const snapshot = await runSync({ out: target, dryRun: opts.dryRun });
  const summary = `${snapshot.modelCount} models, Intelligence Index v${snapshot.intelligenceIndexVersion}, ${snapshot.pageCount} page(s)`;
  if (opts.dryRun) {
    console.log(`dry run: ${summary} (nothing written)`);
  } else {
    console.log(`wrote ${relativeOut(target)}: ${summary}`);
  }
  return 0;
}

if (require.main === module) {
  main().then(
    code => { process.exitCode = code; },
    error => {
      console.error(`aa-sync: ${error.message}`);
      process.exitCode = 1;
    },
  );
}

module.exports = {
  ENDPOINT,
  MAX_PAGES,
  MAX_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
  REQUEST_DEADLINE_MS,
  PAGE_DELAY_MS,
  RETRYABLE_CODES,
  freeSnapshotPath,
  pageUrl,
  relativeOut,
  headerOf,
  retryDelayMs,
  parsePage,
  defaultHttp,
  fetchPage,
  collectAll,
  buildSnapshot,
  keyFilePath,
  readApiKey,
  writeSnapshot,
  readSnapshot,
  runSync,
  parseArgs,
  main,
};
