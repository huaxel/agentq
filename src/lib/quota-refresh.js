'use strict';

/**
 * On-demand quota refresh.
 *
 * Routing treats quota older than six hours as unknown (never available), and
 * nothing refreshes `data/quota.json` on its own: after a few idle hours every
 * `auto` decision and every MCP dispatch refuses for lack of fresh data. This
 * module closes that gap by running the same collector `npm run collect-quota`
 * runs, but only when the snapshot is actually stale.
 *
 * It lives in `src/lib` because it is IO, not policy, and because both the CLI
 * (interfaces/cli) and the MCP server (interfaces/mcp) may require lib. The
 * collector is invoked as a SUBPROCESS (`node …/src/roi-tracker/collect/quota.js`),
 * never imported, so this module has no compile-time dependency on the ROI
 * layer and the layering rules stay as they are.
 *
 * Rules that keep a broken collector from becoming a stampede:
 *   1. fresh data is never re-collected (the same six-hour window routing uses);
 *   2. an exclusive lock file next to the snapshot means one collection at a
 *      time, across processes; a second caller waits (interruptibly) and
 *      re-reads;
 *   3. the lock records `{ pid, startedAt, nonce }` and is created by writing
 *      the complete record to a private tmp file and hard-linking it into
 *      place, so it is never observable empty or half-written. Leftover tmp
 *      files from a process that died mid-acquire are swept once they are a
 *      minute old. A release only unlinks a lock that still carries our nonce.
 *      A lock is broken only when its holder is dead or it is older than 2x the
 *      timeout, and breakers are serialized by a breaker DIRECTORY
 *      (`<lock>.break.d`, owner record written the same link-based way) whose
 *      own staleness is 30 s or a dead holder. The break re-reads the lock
 *      under that mutex and unlinks it only when it is still the exact owner
 *      (nonce) that was judged stale; a lock that changed hands is left alone.
 *      The mutex itself is broken by renaming the directory aside and checking
 *      the renamed owner record — if it changed hands, the directory is put
 *      back with mkdir as the no-clobber primitive and the attempt is
 *      abandoned. Two remaining windows are accepted and not claimed to be
 *      race-free: a release whose lock was replaced between its read and its
 *      unlink (which needs a live, young lock to have been misjudged), and a
 *      mutex graveyard left behind when the slot was retaken (harmless;
 *      sweepable).
 *   4. a stamp file rate-limits attempts (default 10 minutes), including after
 *      a failure, so a broken collector is not retried on every call. The stamp
 *      is written BEFORE collecting, so a cancelled or crashed attempt also
 *      counts: an aborted collection does not retry immediately;
 *   5. nothing is ever thrown to the caller: failures come back as
 *      `{ refreshed: false, reason }`, and collector stderr is swallowed
 *      because it can contain account labels that must not reach MCP output.
 *
 * Cancellation (an AbortSignal, used by the MCP server when its client goes
 * away) is honoured while waiting for another process's lock and during the
 * collection. The built-in collector is a child process group, so it is killed
 * first; the collect promise is then awaited before the lock is released, so an
 * injected collector that registered no cleanup is never left writing
 * concurrently with the next collection.
 *
 * If the process exits or is signalled (SIGTERM, SIGINT, SIGHUP) while a
 * collection is running, the collector's process group is killed and our lock
 * is released before the signal is re-raised with its default behaviour.
 *
 * Pid liveness is SINGLE-HOST. Sharing one `data/` directory between hosts or
 * containers is not supported: a lock held by another machine looks like a
 * dead holder here, and the collector would be started twice.
 *
 * `AGENTQ_QUOTA_COLLECTOR` is a TEST HOOK (and an escape hatch for deployments
 * that collect elsewhere): it replaces the collector command and, because the
 * replacement may write any path, it also lifts the "custom quota path" guard
 * below. It is resolved to an absolute path.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { homeDataPath } = require('./home.js');

const ROOT = path.join(__dirname, '..', '..');
/** The shipped collector writes this path; a custom quota path is refused. */
const defaultQuotaPath = () => homeDataPath('quota.json');
const COLLECTOR_PATH = path.join(ROOT, 'src', 'roi-tracker', 'collect', 'quota.js');

/** Same freshness window as src/core/capacity.js. */
const DEFAULT_MAX_AGE_MS = 6 * 3600 * 1000;
/** Minimum gap between collection attempts, successful or not. */
const DEFAULT_MIN_INTERVAL_MS = 10 * 60 * 1000;
/** How long one collection may run before it is killed. */
const DEFAULT_TIMEOUT_MS = 90 * 1000;
const POLL_MS = 100;
const MAX_REASON_CHARS = 160;
/** A breaker mutex older than this may be removed (a breaker died). */
const BREAKER_STALE_MS = 30 * 1000;
/** A `<lock>.<nonce>.tmp` older than this is left over from a dead process. */
const TMP_SWEEP_MS = 60 * 1000;
const ABORTED = Symbol('quota-refresh-aborted');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newNonce() {
  return crypto.randomBytes(8).toString('hex');
}

function lockPathFor(quotaPath) {
  return `${quotaPath}.refresh.lock`;
}

function stampPathFor(quotaPath) {
  return `${quotaPath}.refresh.stamp`;
}

/**
 * Newest observation in the snapshot, in ms. Capacity judges each path by
 * `updatedAt ?? generatedAt`, so the file's own age is the newest of those:
 * a collector that just ran is fresh even if one provider kept an old window.
 *
 * @param {Record<string, any>|null} quota
 * @returns {number|null}
 */
function newestObservationMs(quota) {
  let newest = Date.parse(quota?.generatedAt);
  if (!Number.isFinite(newest)) newest = null;
  for (const entry of Object.values(quota?.paths ?? {})) {
    const ms = Date.parse(entry?.updatedAt);
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

/**
 * Read the quota snapshot. A missing or unparseable file is null, which is
 * stale: routing would call it unknown anyway.
 * @param {string} quotaPath
 * @returns {Record<string, any>|null}
 */
function readQuota(quotaPath) {
  try {
    return JSON.parse(fs.readFileSync(quotaPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Would routing consider this snapshot stale?
 * @param {string} quotaPath
 * @param {number} maxAgeMs
 * @param {number} nowMs
 * @returns {boolean}
 */
function isStale(quotaPath, maxAgeMs, nowMs) {
  const quota = readQuota(quotaPath);
  if (!quota) return true;
  const observedMs = newestObservationMs(quota);
  return observedMs === null || nowMs - observedMs > maxAgeMs;
}

/**
 * True if `pid` names a live process. EPERM means alive but owned by another
 * user; ESRCH (or anything else) means gone.
 *
 * Pid liveness is SINGLE-HOST: a `data/` directory shared between hosts or
 * containers (e.g. a network mount) is not supported, because a pid from
 * another machine cannot be checked here.
 *
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Lock content: who holds it and when it was taken.
 * @param {string} lockPath
 * @returns {{ pid: number|null, startedAt: number|null, nonce: string|null }|null}
 */
function readLock(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      pid: Number.isInteger(parsed.pid) ? parsed.pid : null,
      startedAt: Number.isFinite(parsed.startedAt) ? parsed.startedAt : null,
      nonce: typeof parsed.nonce === 'string' && parsed.nonce ? parsed.nonce : null,
    };
  } catch {
    return null;
  }
}

/**
 * Age of the lock: its recorded start time, or the file's mtime when the
 * content is unreadable (a lock written by an older version, or a corrupted
 * one — the link protocol never produces that).
 * @param {string} lockPath
 * @param {number} nowMs
 * @param {{ startedAt: number|null }|null} owner
 * @returns {number|null}
 */
function lockAgeMs(lockPath, nowMs, owner) {
  if (owner && owner.startedAt !== null) return nowMs - owner.startedAt;
  try {
    return nowMs - fs.statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Judge a lock: who holds it, how old it is, and whether it may be broken.
 * A lock may be broken only when its holder is provably gone or it is far past
 * the collection timeout. A live holder is never broken, even if it is slow.
 *
 * @param {string} lockPath
 * @param {{ nowMs: number, staleAfterMs: number }} options
 * @returns {{ owner: { pid: number|null, startedAt: number|null, nonce: string|null }|null, ageMs: number|null, stale: boolean }}
 */
function inspectLock(lockPath, { nowMs, staleAfterMs }) {
  const owner = readLock(lockPath);
  const ageMs = lockAgeMs(lockPath, nowMs, owner);
  const deadHolder = Boolean(owner && owner.pid !== null && !pidAlive(owner.pid));
  return { owner, ageMs, stale: deadHolder || (ageMs !== null && ageMs > staleAfterMs) };
}

/**
 * Same judgement as inspectLock; the name keeps the call sites readable.
 * Returns the owner it judged, so a breaker can prove the lock did not change
 * between the judgement and the break.
 * @param {string} lockPath
 * @param {{ nowMs: number, staleAfterMs: number }} options
 */
function shouldBreakLock(lockPath, options) {
  return inspectLock(lockPath, options);
}

/**
 * Two owner records name the same holder. Unreadable content (no owner) only
 * compares equal to unreadable content: it is then judged by mtime age alone.
 * @param {{ nonce: string|null, pid: number|null, startedAt: number|null }|null} a
 * @param {{ nonce: string|null, pid: number|null, startedAt: number|null }|null} b
 * @returns {boolean}
 */
function sameOwner(a, b) {
  if (!a || !b) return a === b;
  if (a.nonce && b.nonce) return a.nonce === b.nonce;
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

/**
 * Remove `<lock>.<nonce>.tmp` leftovers from processes that died between
 * creating the tmp file and linking it. Only files older than TMP_SWEEP_MS are
 * touched, so a live acquire (which holds its tmp for microseconds) is safe.
 *
 * @param {string} lockPath
 * @param {{ nowMs: number }} options
 * @returns {number} how many files were removed
 */
function sweepStaleLockTmp(lockPath, { nowMs }) {
  const dir = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.`;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.tmp')) continue;
    const full = path.join(dir, entry);
    try {
      if (nowMs - fs.statSync(full).mtimeMs <= TMP_SWEEP_MS) continue;
      fs.unlinkSync(full);
      removed += 1;
    } catch { /* gone, or not ours to remove */ }
  }
  return removed;
}

/**
 * Take a link-based lock.
 *
 * The complete owner record is written to a private tmp file next to the lock
 * and then hard-linked into place: link(2) is atomic and fails with EEXIST when
 * the target exists, so the lock is never visible empty or half-written (a
 * plain O_EXCL create followed by a write has that window). The tmp file is
 * always removed.
 *
 * @param {string} lockPath
 * @param {{ pid: number, startedAt: number, nonce: string }} owner
 * @returns {{ acquired: true } | { acquired: false, exists: true } | { acquired: false, reason: string }}
 */
function linkLock(lockPath, owner) {
  const tmpPath = `${lockPath}.${owner.nonce}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
  } catch (error) {
    return { acquired: false, reason: `lock tmp unavailable: ${error.code ?? 'error'}` };
  }
  try {
    fs.writeSync(fd, JSON.stringify(owner));
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(tmpPath, lockPath);
    return { acquired: true };
  } catch (error) {
    if (error.code === 'EEXIST') return { acquired: false, exists: true };
    return { acquired: false, reason: `lock unavailable: ${error.code ?? 'error'}` };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
  }
}

/**
 * Release our lock: read it, and only unlink when its nonce is still ours.
 *
 * The remaining microsecond window (read says ours, then a breaker replaces the
 * lock before the unlink) requires our lock to have been broken first, which
 * needs a breaker to misjudge a live, young lock: the break rules only allow a
 * dead holder or a lock older than 2x the collection timeout.
 *
 * @param {string} lockPath
 * @param {string} nonce
 * @param {{ afterReleaseRead?: (lockPath: string, owner: any) => void }} [hooks]
 * @returns {boolean} true when our lock was released
 */
function releaseLock(lockPath, nonce, hooks = {}) {
  const owner = readLock(lockPath);
  if (hooks.afterReleaseRead) hooks.afterReleaseRead(lockPath, owner);
  if (!owner || owner.nonce !== nonce) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The breaker mutex is a DIRECTORY (`<lock>.break.d`) holding an `owner` record.
 *
 * A file mutex could be broken by two breakers at once (both judge it stale,
 * both unlink, both enter) — the same race the mutex exists to prevent, one
 * level down. A directory cannot be replaced by rename while it is non-empty,
 * so breaking it is a rename-aside plus an owner check, and restoring a mutex
 * that changed hands uses mkdir as the no-clobber primitive.
 *
 * @param {string} lockPath
 * @returns {string}
 */
function breakerDirFor(lockPath) {
  return `${lockPath}.break.d`;
}

function breakerOwnerPath(dir) {
  return path.join(dir, 'owner');
}

/**
 * @param {string} dir
 * @returns {{ pid: number|null, startedAt: number|null, nonce: string|null }|null}
 */
function readBreakerOwner(dir) {
  return readLock(breakerOwnerPath(dir));
}

/**
 * Judge the breaker mutex. Its staleness is its own (30 s, or a dead holder):
 * a breaker is short-lived, unlike a collection.
 * @param {string} dir
 * @param {{ nowMs: number }} options
 * @returns {{ owner: any, ageMs: number|null, stale: boolean }}
 */
function inspectBreaker(dir, { nowMs }) {
  const owner = readBreakerOwner(dir);
  let ageMs = null;
  if (owner && owner.startedAt !== null) {
    ageMs = nowMs - owner.startedAt;
  } else {
    // No readable record: the directory's own mtime is the best evidence.
    try {
      ageMs = nowMs - fs.statSync(owner ? breakerOwnerPath(dir) : dir).mtimeMs;
    } catch {
      ageMs = null;
    }
  }
  const deadHolder = Boolean(owner && owner.pid !== null && !pidAlive(owner.pid));
  return { owner, ageMs, stale: deadHolder || (ageMs !== null && ageMs > BREAKER_STALE_MS) };
}

/**
 * Put a mutex we renamed aside back, without clobbering one that exists now.
 * mkdir is the no-clobber primitive: if the slot is taken, the graveyard is
 * left alone and this breaker gives up.
 * @param {string} graveyard
 * @param {string} dir
 * @returns {boolean} true when the mutex was restored
 */
function restoreBreakerDir(graveyard, dir) {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch {
    return false; // someone else holds the slot; leave the graveyard
  }
  try {
    // The record was written completely before it was linked, so moving the
    // file is atomic and the restored mutex is never partial.
    fs.renameSync(breakerOwnerPath(graveyard), breakerOwnerPath(dir));
  } catch {
    // Nothing to restore: drop the empty directory rather than locking
    // breakers out for the staleness window.
    try { fs.rmdirSync(dir); } catch { /* not empty or gone */ }
  }
  try { fs.rmdirSync(graveyard); } catch { try { fs.rmSync(graveyard, { recursive: true, force: true }); } catch { /* gone */ } }
  return true;
}

/**
 * Break a stale breaker mutex: rename the directory aside (atomic, one winner),
 * then verify the renamed directory still holds the owner that was judged
 * stale. If it changed hands, put it back and give up.
 * @param {string} dir
 * @param {{ owner: any }} judged
 * @returns {boolean}
 */
function breakBreakerDir(dir, judged) {
  const graveyard = `${dir}.stale-${process.pid}-${newNonce()}`;
  try {
    fs.renameSync(dir, graveyard);
  } catch {
    return false; // another breaker already moved it
  }
  const renamed = readBreakerOwner(graveyard);
  if (!sameOwner(renamed, judged.owner)) {
    restoreBreakerDir(graveyard, dir);
    return false;
  }
  try { fs.rmSync(graveyard, { recursive: true, force: true }); } catch { /* gone */ }
  return true;
}

/**
 * Take the breaker mutex directory and write its owner record (link-based, so
 * the record is never partial).
 * @param {string} dir
 * @param {{ pid: number, startedAt: number, nonce: string }} owner
 * @param {{ nowMs: number, hooks?: Record<string, Function> }} options
 * @returns {boolean}
 */
function acquireBreakerDir(dir, owner, { nowMs, hooks = {} }) {
  let created = true;
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    created = false;
    if (error.code !== 'EEXIST') return false;
    const judged = inspectBreaker(dir, { nowMs });
    if (!judged.stale) return false; // another breaker is working
    if (hooks.afterMutexJudge) hooks.afterMutexJudge(dir, judged);
    if (!breakBreakerDir(dir, judged)) return false;
    if (hooks.afterMutexBreak) hooks.afterMutexBreak(dir);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      created = true;
    } catch {
      return false; // another breaker won the re-created slot
    }
  }
  const ownerPath = breakerOwnerPath(dir);
  const tmpPath = `${ownerPath}.${owner.nonce}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify(owner));
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(tmpPath, ownerPath);
    created = false;
    return true;
  } catch {
    // Without an owner record nobody may enter, so release the directory we
    // made instead of locking breakers out for the whole staleness window.
    if (created) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
    }
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
  }
}

/**
 * Release the breaker mutex: only when the record still carries our nonce.
 * @param {string} dir
 * @param {string} nonce
 * @returns {boolean}
 */
function releaseBreakerDir(dir, nonce) {
  const owner = readBreakerOwner(dir);
  if (!owner || owner.nonce !== nonce) return false;
  try { fs.unlinkSync(breakerOwnerPath(dir)); } catch { /* gone */ }
  try { fs.rmdirSync(dir); } catch { /* a stale record or another entry */ }
  return true;
}

/**
 * Break a stale lock, serialized by the breaker mutex.
 *
 * Two processes can both judge the same lock stale. Without serialization the
 * second unlink could remove a lock the first breaker's successor had already
 * taken. Under the mutex the lock is re-read and broken only when it is still
 * the SAME owner that was judged stale and is still stale; a lock that changed
 * hands is left untouched.
 *
 * @param {string} lockPath
 * @param {{ nowMs: number, staleAfterMs: number, judged?: { owner: any }|null, hooks?: Record<string, Function> }} options
 * @returns {boolean} true when this caller broke the lock
 */
function breakLock(lockPath, { nowMs, staleAfterMs, judged = null, hooks = {} }) {
  const mutexDir = breakerDirFor(lockPath);
  const mutexOwner = { pid: process.pid, startedAt: nowMs, nonce: newNonce() };
  if (!acquireBreakerDir(mutexDir, mutexOwner, { nowMs, hooks })) return false;
  try {
    if (hooks.afterMutex) hooks.afterMutex(lockPath);
    const current = inspectLock(lockPath, { nowMs, staleAfterMs });
    if (!current.stale) return false;
    const expected = judged ? judged.owner : current.owner;
    if (!sameOwner(current.owner, expected)) return false;
    if (hooks.beforeBreakUnlink) hooks.beforeBreakUnlink(lockPath, current.owner);
    try {
      fs.unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  } finally {
    releaseBreakerDir(mutexDir, mutexOwner.nonce);
  }
}

/**
 * Try to take the collection lock.
 *
 * @param {string} lockPath
 * @param {{ nowMs: number, staleAfterMs: number, hooks?: Record<string, Function> }} options
 * @returns {{ acquired: true, nonce: string } | { acquired: false, held?: true, reason?: string }}
 */
function tryAcquireLock(lockPath, { nowMs, staleAfterMs, hooks = {} }) {
  sweepStaleLockTmp(lockPath, { nowMs });
  const owner = { pid: process.pid, startedAt: nowMs, nonce: newNonce() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (hooks.beforeLink) hooks.beforeLink(lockPath);
    const result = linkLock(lockPath, owner);
    if (result.acquired) return { acquired: true, nonce: owner.nonce };
    if (!result.exists) return { acquired: false, reason: result.reason ?? 'lock unavailable' };
    const judged = inspectLock(lockPath, { nowMs, staleAfterMs });
    if (!judged.stale) return { acquired: false, held: true };
    if (hooks.afterJudge) hooks.afterJudge(lockPath, judged);
    breakLock(lockPath, { nowMs, staleAfterMs, judged, hooks });
  }
  return { acquired: false, held: true };
}

/**
 * Wait for another process's collection to finish.
 *
 * Returns 'released' when the lock is gone, 'timeout' when the wait expired,
 * and 'aborted' as soon as the caller's signal fires: a closing server must
 * not linger for another process's 90 s collection.
 *
 * @param {string} lockPath
 * @param {{ timeoutMs: number, pollMs: number, now: () => number, staleAfterMs: number, hooks?: Record<string, Function>, signal?: AbortSignal|null }} options
 * @returns {Promise<'released'|'timeout'|'aborted'>}
 */
async function waitForLock(lockPath, { timeoutMs, pollMs, now, staleAfterMs, hooks = {}, signal = null }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (signal?.aborted) return 'aborted';
    await sleep(pollMs);
    if (signal?.aborted) return 'aborted';
    if (!fs.existsSync(lockPath)) return 'released';
    const judged = inspectLock(lockPath, { nowMs: now(), staleAfterMs });
    if (judged.stale) {
      breakLock(lockPath, { nowMs: now(), staleAfterMs, judged, hooks });
      if (!fs.existsSync(lockPath)) return 'released';
    }
  }
  if (signal?.aborted) return 'aborted';
  return fs.existsSync(lockPath) ? 'timeout' : 'released';
}

/**
 * @param {string} stampPath
 * @returns {number|null} last attempt, ms since epoch
 */
function readStamp(stampPath) {
  try {
    const value = Number(fs.readFileSync(stampPath, 'utf8').trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Record an attempt. Returns false when the stamp cannot be written: without
 * it the rate limit cannot work, so the caller must not start a collection
 * (otherwise an unwritable directory would collect on every call).
 * @param {string} stampPath
 * @param {number} nowMs
 * @returns {boolean}
 */
function writeStamp(stampPath, nowMs) {
  try {
    fs.writeFileSync(stampPath, String(nowMs), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the shipped collector exactly as `npm run collect-quota` does, with a
 * hard timeout. stdout/stderr are drained, never echoed: the collector prints
 * per-provider account labels.
 *
 * @param {{ timeoutMs: number, registerCleanup?: (fn: () => void) => () => void }} options
 * @returns {Promise<void>}
 */
function defaultCollector({ timeoutMs, registerCleanup = () => () => {} }) {
  const override = process.env.AGENTQ_QUOTA_COLLECTOR;
  const args = override
    ? [path.resolve(override)]
    : ['--experimental-strip-types', COLLECTOR_PATH];
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env },
      // Its own process group, so a timeout or a signal kills its children too.
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    };
    const unregister = registerCleanup(killGroup);
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      unregister();
      reject(new Error(`collector could not start: ${error.code ?? 'error'}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      unregister();
      if (timedOut) reject(new Error('collector timed out'));
      else if (code === 0) resolve();
      else reject(new Error(`collector exited ${code}`));
    });
  });
}

/**
 * @param {unknown} error
 * @returns {string} short, single-line, secret-free reason
 */
function shortReason(error) {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_CHARS) || 'unknown error';
}

/**
 * Refresh the quota snapshot if it is stale.
 *
 * @param {{
 *   quotaPath: string,
 *   maxAgeMs?: number,
 *   minIntervalMs?: number,
 *   timeoutMs?: number,
 *   collect?: (input: { quotaPath: string, timeoutMs: number, registerCleanup: (fn: () => void) => () => void }) => Promise<void>|void,
 *   now?: () => number,
 *   enabled?: boolean,
 *   pollMs?: number,
 *   signal?: AbortSignal, Aborts a running collection (kills its process group
 *     and releases the lock) and resolves with `reason: 'cancelled'`.
 *   _hooks?: Record<string, Function>, Internal test seam: called between the
 *     lock steps (beforeLink, afterJudge, afterMutex, beforeBreakUnlink,
 *     afterReleaseRead, afterMutexBreak) so interleavings can be reproduced.
 * }} options
 * @returns {Promise<{ refreshed: boolean, reason: string, durationMs?: number }>}
 */
async function refreshQuotaIfStale(options = {}) {
  const {
    quotaPath,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    collect: injectedCollect = null,
    now = Date.now,
    enabled = process.env.AGENTQ_QUOTA_REFRESH !== '0',
    pollMs = POLL_MS,
    signal = null,
    _hooks = {},
  } = options;

  if (!enabled) return { refreshed: false, reason: 'disabled' };
  if (signal?.aborted) return { refreshed: false, reason: 'cancelled' };
  if (typeof quotaPath !== 'string' || quotaPath === '') {
    return { refreshed: false, reason: 'no quota path' };
  }

  // The override may write any path, so it also lifts the guard below.
  const customCollector = typeof injectedCollect === 'function' || Boolean(process.env.AGENTQ_QUOTA_COLLECTOR);
  const collect = typeof injectedCollect === 'function' ? injectedCollect : defaultCollector;
  if (!customCollector && path.resolve(quotaPath) !== defaultQuotaPath()) {
    // The shipped collector always writes <home>/data/quota.json. Refreshing a
    // custom path with it would report a change that never happened.
    return { refreshed: false, reason: 'custom quota path' };
  }

  try {
    if (!isStale(quotaPath, maxAgeMs, now())) return { refreshed: false, reason: 'fresh' };

    const lockPath = lockPathFor(quotaPath);
    const staleAfterMs = 2 * timeoutMs;
    let lock = tryAcquireLock(lockPath, { nowMs: now(), staleAfterMs, hooks: _hooks });
    if (!lock.acquired && lock.held) {
      // Another process is collecting. Wait for it, then re-read: never start
      // a second collection.
      const waited = await waitForLock(lockPath, {
        timeoutMs, pollMs, now, staleAfterMs, hooks: _hooks, signal,
      });
      if (waited === 'aborted') return { refreshed: false, reason: 'cancelled' };
      if (waited === 'timeout') return { refreshed: false, reason: 'lock timeout' };
      if (!isStale(quotaPath, maxAgeMs, now())) {
        return { refreshed: false, reason: 'refreshed by another process' };
      }
      lock = tryAcquireLock(lockPath, { nowMs: now(), staleAfterMs, hooks: _hooks });
    }
    if (!lock.acquired) return { refreshed: false, reason: lock.reason ?? 'lock timeout' };

    const nonce = lock.nonce;
    /** @type {Set<() => void>} */
    const cleanups = new Set();
    const registerCleanup = (fn) => {
      cleanups.add(fn);
      return () => cleanups.delete(fn);
    };
    const runCleanups = () => {
      for (const fn of [...cleanups]) {
        try { fn(); } catch { /* best effort */ }
      }
      cleanups.clear();
    };
    // A signal or exit during a collection must not leave the collector's
    // process group running or the lock held. The signal is re-raised with its
    // default behaviour after cleanup, so the process still dies as signalled.
    const onExit = () => {
      runCleanups();
      releaseLock(lockPath, nonce);
    };
    const onSignal = (received) => {
      runCleanups();
      releaseLock(lockPath, nonce);
      process.removeListener(received, onSignal);
      process.kill(process.pid, received);
    };
    process.on('exit', onExit);
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    process.once('SIGHUP', onSignal);

    try {
      // Re-check under the lock: another run may have refreshed between the
      // first read and the lock.
      if (!isStale(quotaPath, maxAgeMs, now())) {
        return { refreshed: false, reason: 'refreshed by another process' };
      }

      const stampPath = stampPathFor(quotaPath);
      const lastAttempt = readStamp(stampPath);
      if (lastAttempt !== null && now() - lastAttempt < minIntervalMs) {
        return { refreshed: false, reason: 'rate limited' };
      }

      // Stamp before collecting: a crash mid-run still counts as an attempt,
      // so a broken collector is not retried on every call. Without a stamp
      // the rate limit cannot work, so refuse to collect at all.
      if (!writeStamp(stampPath, now())) {
        return { refreshed: false, reason: 'stamp unwritable' };
      }
      const startedAt = now();
      const collectPromise = Promise.resolve().then(() => collect({ quotaPath, timeoutMs, registerCleanup }));
      let abortListener = null;
      let aborted = null;
      if (signal) {
        // The signal cannot already be aborted here: it is checked at entry
        // and after the lock wait.
        aborted = new Promise((resolve) => {
          abortListener = () => resolve(ABORTED);
          signal.addEventListener('abort', abortListener, { once: true });
        });
      }
      try {
        const outcome = aborted ? await Promise.race([collectPromise, aborted]) : await collectPromise;
        if (outcome === ABORTED) {
          // The caller went away (stdin closed). Kill the built-in collector
          // (its registered cleanup), then WAIT for the collect promise to
          // settle before the lock is released: an injected collector that
          // registered no cleanup may still be writing, and letting a second
          // collection start alongside it would duplicate the work.
          runCleanups();
          try { await collectPromise; } catch { /* the killed collector rejects */ }
          return { refreshed: false, reason: 'cancelled' };
        }
      } finally {
        if (abortListener) signal.removeEventListener('abort', abortListener);
      }
      const durationMs = now() - startedAt;
      const fresh = !isStale(quotaPath, maxAgeMs, now());
      return {
        refreshed: fresh,
        reason: fresh ? 'refreshed' : 'collector produced no fresh data',
        durationMs,
      };
    } finally {
      process.removeListener('exit', onExit);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGHUP', onSignal);
      runCleanups();
      releaseLock(lockPath, nonce, _hooks);
    }
  } catch (error) {
    // Never throw to a caller: an MCP tool must still answer.
    return { refreshed: false, reason: shortReason(error) };
  }
}

module.exports = {
  refreshQuotaIfStale,
  isStale,
  newestObservationMs,
  lockPathFor,
  stampPathFor,
  readLock,
  releaseLock,
  breakLock,
  tryAcquireLock,
  shouldBreakLock,
  inspectLock,
  linkLock,
  sameOwner,
  pidAlive,
  breakerDirFor,
  readBreakerOwner,
  inspectBreaker,
  acquireBreakerDir,
  releaseBreakerDir,
  breakBreakerDir,
  sweepStaleLockTmp,
  BREAKER_STALE_MS,
  TMP_SWEEP_MS,
  defaultQuotaPath,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
};
