#!/usr/bin/env node
/**
 * Quota collector — subscription usage limits from multiple sources.
 *
 * Primary source: codexbar CLI (works for claude, codex).
 * Fallback sources for providers codexbar can't reach:
 *   - cline-pass: ClinePass REST API (CLINE_API_KEY env)
 *   - opencode-go: scrapes opencode.ai dashboard (auth cookie from pi auth.json)
 *   - cursor / commandcode: billing APIs via @juanbenjumea/pi-provider-usage-fetcher
 *   - umans: Umans REST API (UMANS_API_KEY env)
 *
 * Writes data/quota.json keyed by path id.
 *
 * Usage:  node src/collect-quota.js [--dry-run]
 */
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { homedir } = require('os');
const { homeDataPath, loadRoiConfig } = require('../../lib/home.js');
const { subscriptionStatus } = require('../../lib/subscriptions.js');
const { fetchCursorQuotaEntry, fetchCommandCodeQuotaEntry, fetchXaiQuotaEntry, fetchMistralQuotaEntry } = require('../../lib/provider-usage.js');

/** @type {typeof import('@juanbenjumea/pi-provider-usage-fetcher/auth.ts')} */
let usageAuth;
/** @type {typeof import('@juanbenjumea/pi-provider-usage-fetcher/format.ts')} */
let usageFormat;

async function initUsageModules() {
  if (!usageAuth) {
    usageAuth = await import('@juanbenjumea/pi-provider-usage-fetcher/auth.ts');
    usageFormat = await import('@juanbenjumea/pi-provider-usage-fetcher/format.ts');
  }
}

function loadAuthJson() {
  return usageAuth.loadAuthJson();
}

function resolveAuthValue(v) {
  return usageAuth.resolveAuthValue(v);
}

function authCredential(...keys) {
  return usageAuth.authCredential(...keys);
}

function clampPercent(v) {
  return usageFormat.clampPercent(v);
}

function safeError(error) {
  return usageFormat.safeError(error);
}

function formatResetSeconds(seconds) {
  return usageFormat.formatResetSeconds(seconds);
}

const ROOT = path.join(__dirname, '..', '..', '..');

// Providers codexbar --source cli cannot query at all (proprietary APIs, or no
// CLI surface to probe). Querying them wastes 10+ seconds each on timeouts.
// Self-hosted providers are NOT listed here: they are recognized from
// config.providerPathMap (any provider routed to the 'local' path is skipped),
// so a new local endpoint needs no code change.
const NO_CODEXBAR = new Set([
  'nan', 'fireworks', 'firepass', 'google', 'commandcode', 'cursor',
]);

// Path id used for self-hosted endpoints. codexbar probes remote subscription
// APIs, so a provider routed here has nothing for it to query.
const LOCAL_PATH_ID = 'local';

/**
 * Whether codexbar should be asked for this provider's quota.
 * @param {string} provider  provider key from config.providerPathMap
 * @param {string} pathId    path id the provider routes to
 * @returns {boolean}
 */
function queriesCodexbar(provider, pathId) {
  if (pathId === LOCAL_PATH_ID) return false;
  return !NO_CODEXBAR.has(provider);
}

// Per-provider timeouts. claude hits claude.ai API (~15-20s); most other
// providers either respond fast (<1s) or timeout on --source cli.
const CODEXBAR_TIMEOUT = {
  claude: 25_000,
  default: 10_000,
};

/* ───── Helpers ───── */

const round2 = n => Math.round(n * 100) / 100;

function resolveShellAuthValue(v) {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('!')) {
    try {
      return execFileSync('/bin/sh', ['-c', trimmed.slice(1)], { encoding: 'utf8', timeout: 2000 }).trim() || undefined;
    } catch { return undefined; }
  }
  return resolveAuthValue(v);
}

function formatResetTime(date) {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return rem > 0 ? `${days}d${rem}h` : `${days}d`;
}

async function fetchJson(url, init, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { response, data: await response.json() };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, init, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { response, data: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

/* ───── codexbar (async concurrent) ───── */

const labelWindow = mins =>
  mins == null ? '?' : mins <= 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h`
  : mins === 10080 ? 'weekly' : mins === 1440 ? 'daily' : `${Math.round(mins / 1440)}d`;

function execFileJson(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(e); }
    });
  });
}

async function fetchCodexbarAsync(provider) {
  const timeout = CODEXBAR_TIMEOUT[provider] ?? CODEXBAR_TIMEOUT.default;
  let out;
  try {
    out = await execFileJson('codexbar', ['usage', '--json', '--provider', provider, '--source', 'cli'],
      { timeout });
  } catch (e) { return { error: e.message }; }
  let arr;
  try { arr = Array.isArray(out) ? out : [out]; } catch { return { error: 'unparseable' }; }
  const row = arr[0];
  if (!row || row.error) return { error: row?.error?.message || 'no data' };
  const returnedId = row.provider || row.usage?.identity?.providerID;
  if (returnedId && returnedId !== provider) {
    return { error: `codexbar returned '${returnedId}' data for requested provider '${provider}' — not a real codexbar-backed provider, skipping` };
  }
  const u = row.usage || {};
  const windows = [];
  for (const slot of ['primary', 'secondary', 'tertiary']) {
    const w = u[slot];
    if (!w || typeof w.usedPercent !== 'number') continue;
    windows.push({ slot, label: labelWindow(w.windowMinutes), usedPercent: w.usedPercent, resetsAt: w.resetsAt ?? null, resetDescription: w.resetDescription ?? null });
  }
  const credits = row.credits && typeof row.credits.remaining === 'number' ? row.credits.remaining : null;
  return { windows, credits, updatedAt: u.updatedAt ?? null };
}

/* ───── ClinePass API ───── */

async function fetchClinePassQuota() {
  const apiKey = resolveShellAuthValue(process.env.CLINE_API_KEY) || authCredential('cline-pass', 'clinepass');
  if (!apiKey) return { error: 'no-auth (set CLINE_API_KEY or configure in ~/.pi/agent/auth.json)' };

  try {
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'User-Agent': 'pi-roi-tracker' };
    const baseUrl = (process.env.CLINE_API_BASE || 'https://api.cline.bot').replace(/\/$/, '');

    // Get user info
    const me = await fetchJson(`${baseUrl}/api/v1/users/me`, { headers });
    const userId = me.data?.data?.id;
    if (!userId) return { error: 'invalid-user-response' };

    // Get plan to find inference cap threshold
    const plans = await fetchJson(`${baseUrl}/api/v1/plans`, { headers });
    const planList = Array.isArray(plans.data?.data) ? plans.data.data : [];
    const threshold = planList
      .find(p => p?.isActive && p?.entitlements?.cline_pass?.enabled && p?.entitlements?.cline_pass?.inferenceCapThreshold)
      ?.entitlements?.cline_pass?.inferenceCapThreshold;
    if (!threshold) return { error: 'no-active-plan' };

    // Fetch usage items (paginated, last 30 days)
    const items = [];
    let cursor = '';
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (let page = 0; page < 100; page++) {
      const url = new URL(`${baseUrl}/api/v1/users/${encodeURIComponent(userId)}/usages`);
      url.searchParams.set('limit', '100');
      if (cursor) url.searchParams.set('cursor', cursor);
      const resp = await fetchJson(url.toString(), { headers });
      const pageItems = Array.isArray(resp.data?.data?.items) ? resp.data.data.items : [];
      items.push(...pageItems);
      const oldest = pageItems
        .map(i => i.createdAt ? new Date(i.createdAt).getTime() : undefined)
        .filter(Boolean)
        .reduce((min, v) => min === undefined ? v : Math.min(min, v), undefined);
      cursor = typeof resp.data?.data?.nextToken === 'string' ? resp.data.data.nextToken.trim() : '';
      if (!cursor || pageItems.length === 0 || (oldest !== undefined && oldest < cutoff)) break;
    }

    // Compute windows
    const now = Date.now();
    const windows = [];

    for (const [label, durationMs, limitKey] of [
      ['5-hour', 5 * 60 * 60 * 1000, 'last5HoursUsageCostUSDPerUser'],
      ['weekly', 7 * 24 * 60 * 60 * 1000, 'last7daysUsageCostUSDPerUser'],
      ['monthly', 30 * 24 * 60 * 60 * 1000, 'last30daysUsageCostUSDPerUser'],
    ]) {
      const limitUnits = Number(threshold[limitKey]);
      if (!Number.isFinite(limitUnits) || limitUnits <= 0) continue;
      const start = now - durationMs;
      let usedUnits = 0;
      let oldestTs;
      for (const item of items) {
        const createdAt = item.createdAt ? new Date(item.createdAt).getTime() : undefined;
        if (createdAt === undefined || createdAt < start || createdAt > now) continue;
        const cost = Number(item.costUsd);
        if (Number.isFinite(cost)) usedUnits += cost;
        oldestTs = oldestTs === undefined ? createdAt : Math.min(oldestTs, createdAt);
      }
      windows.push({
        label,
        usedPercent: clampPercent(round2((usedUnits / limitUnits) * 100)),
        resetsIn: oldestTs !== undefined ? formatResetTime(new Date(oldestTs + durationMs)) : undefined,
      });
    }

    return { windows, updatedAt: new Date(now).toISOString() };
  } catch (error) {
    return { error: safeError(error) };
  }
}

/* ───── OpenCode Go (scrape dashboard, multi-account) ───── */

async function fetchOpenCodeGoQuota() {
  // Delegate to the dedicated multi-account collector script
  // (reads auth.json opencode-go-failover.accounts for both subs)
  const collector = path.join(ROOT, 'bin/collect-opencode-quota.js');
  if (!fs.existsSync(collector)) return { error: `collector not found at ${collector}` };

  try {
    const { execFile } = require('child_process');
    const stdout = await new Promise((resolve, reject) => {
      execFile(process.execPath, [collector], { encoding: 'utf8', timeout: 30000 }, (err, out) => {
        if (err) return reject(err);
        resolve(out);
      });
    });

    const parsed = JSON.parse(stdout);
    if (!parsed.windows || parsed.windows.length === 0) {
      return { error: 'no windows from collector' };
    }

    const windows = parsed.windows.map(w => ({
      label: w.label,
      usedPercent: clampPercent(w.usedPercent),
      resetsAt: w.resetsAt || null,
      resetDescription: w.resetDescription || formatResetSeconds(w.resetInSec),
    }));

    return {
      windows,
      accounts: parsed.accounts || [],
      updatedAt: parsed.updatedAt || new Date().toISOString(),
    };
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

/* ───── Codex / ChatGPT API ───── */

async function fetchCodexQuota() {
  // Try credential from pi auth.json first, then ~/.codex/auth.json
  let token = authCredential('openai-codex');
  let accountId = loadAuthJson()['openai-codex']?.accountId;

  if (!token) {
    const codexPath = path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'auth.json');
    try {
      const data = JSON.parse(fs.readFileSync(codexPath, 'utf8'));
      token = data.OPENAI_API_KEY || data.tokens?.access_token;
      accountId = accountId || data.tokens?.account_id;
    } catch { /* no codex auth */ }
  }

  if (!token) return { error: 'no-auth' };

  try {
    const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'pi-roi-tracker', Accept: 'application/json' };
    if (accountId) headers['ChatGPT-Account-Id'] = accountId;

    const { data } = await fetchJson('https://chatgpt.com/backend-api/wham/usage', { headers }, 5000);
    const rl = data.rate_limit || {};
    const windows = [];

    for (const [label, src] of [['5-hour', rl.primary_window], ['weekly', rl.secondary_window], ['monthly', rl.monthly_window ?? rl.tertiary_window]]) {
      if (!src) continue;
      const usedPct = clampPercent(Number(src.used_percent ?? 0));
      let resetsIn;
      if (typeof src.reset_at === 'number' && Number.isFinite(src.reset_at)) {
        const d = new Date(src.reset_at * 1000);
        if (Number.isFinite(d.getTime())) resetsIn = formatResetTime(d);
      } else if (typeof src.reset_after_seconds === 'number') {
        resetsIn = formatResetSeconds(src.reset_after_seconds);
      }
      windows.push({ label, usedPercent: usedPct, resetsIn });
    }
    return { windows, updatedAt: new Date().toISOString() };
  } catch (error) {
    return { error: safeError(error) };
  }
}

/* ───── Cursor / CommandCode (via @juanbenjumea/pi-provider-usage-fetcher) ───── */

async function fetchUmansQuota() {
  const key = resolveShellAuthValue(process.env.UMANS_API_KEY) || authCredential('umans');
  if (!key) return { error: 'no-auth (set UMANS_API_KEY or configure in ~/.pi/agent/auth.json)' };

  try {
    const baseUrl = (process.env.UMANS_BASE_URL || 'https://api.code.umans.ai').replace(/\/$/, '');
    const { data } = await fetchJson(`${baseUrl}/v1/usage`, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': 'pi-roi-tracker' },
    });
    const windows = [];
    const requestLimit = Number(data.limits?.requests?.limit);
    const requestsUsed = Number(data.usage?.requests_in_window);
    if (Number.isFinite(requestLimit) && requestLimit > 0 && Number.isFinite(requestsUsed)) {
      windows.push({ label: 'requests', usedPercent: clampPercent(round2((requestsUsed / requestLimit) * 100)) });
    }
    const concurrencyLimit = Number(data.limits?.concurrency?.limit);
    const concurrencyUsed = Number(data.usage?.concurrent_sessions);
    if (Number.isFinite(concurrencyLimit) && concurrencyLimit > 0 && Number.isFinite(concurrencyUsed)) {
      windows.push({ label: 'concurrency', usedPercent: clampPercent(round2((concurrencyUsed / concurrencyLimit) * 100)) });
    }
    return { windows, updatedAt: new Date().toISOString() };
  } catch (error) {
    return { error: safeError(error) };
  }
}

/* ───── Dispatch ───── */

const API_PROVIDERS = {
  'cline-pass': { path: 'clinepass', fetch: fetchClinePassQuota },
  'opencode-go': { path: 'go', fetch: fetchOpenCodeGoQuota },
  cursor: { path: 'cursor', fetch: fetchCursorQuotaEntry },
  commandcode: { path: 'commandcode', fetch: fetchCommandCodeQuotaEntry },
  umans: { path: 'umans', fetch: fetchUmansQuota },
  xai: { path: 'xai', fetch: fetchXaiQuotaEntry },
  mistral: { path: 'mistral', fetch: fetchMistralQuotaEntry },
};

async function run() {
  await initUsageModules();
  const config = loadRoiConfig();
  const map = config.providerPathMap || {};
  const paths = {};
  const errors = [];
  const promises = [];
  // Only query providers whose quota path is funded by an active
  // subscription: a cancelled plan's API key or cookie typically 401s or
  // times out, and its quota cannot route anything anyway (routing applies
  // the same subscription check).
  const subscriptions = Array.isArray(config.paths) ? config.paths : [];
  const inactive = [];
  const isActive = (provider, pathId) => {
    if (subscriptionStatus(subscriptions, pathId).state === 'active') return true;
    inactive.push(provider);
    return false;
  };

  // Step 1: async concurrent codexbar-based fetching for providers that
  // actually support --source cli. Providers we know codexbar can't handle
  // (local/proprietary/etc.) are skipped entirely — no point waiting on
  // timeouts.
  const codexbarEntries = Object.entries(map)
    .filter(([provider, pathId]) => !API_PROVIDERS[provider] && queriesCodexbar(provider, pathId))
    .filter(([provider, pathId]) => isActive(provider, pathId));

  for (const [provider, pathId] of codexbarEntries) {
    promises.push(
      fetchCodexbarAsync(provider).then(r => {
        if (r.error) {
          errors.push(`${provider}: ${r.error}`);
          return;
        }
        paths[pathId] = { provider, windows: r.windows, credits: r.credits, updatedAt: r.updatedAt };
      })
    );
  }

  // Step 2: async API-based fetching for providers codexbar can't reach.
  // Each fetch is wrapped with a per-provider timeout so a single hanging API
  // call doesn't block the entire collection. Rejections are converted to
  // per-provider errors: without this, one throwing fetcher would reject the
  // whole Promise.all and nuke every provider's quota (fail-closed for the
  // file, but a total outage from a single flaky source).
  for (const [provider, { path: pathId, fetch }] of Object.entries(API_PROVIDERS)) {
    if (!isActive(provider, pathId)) continue;
    // Shared flag prevents BOTH sides of the race from pushing errors.
    // Promise.race doesn't cancel the loser — the setTimeout callback fires
    // regardless and would push misleading timeout errors.
    let settled = false;
    const guardedFetch = () => fetch().then(
      r => ({ ok: true, r }),
      e => ({ ok: false, error: e?.message || String(e) }),
    );
    promises.push(
      Promise.race([
        guardedFetch().then(({ ok, r, error }) => {
          if (settled) return;
          settled = true;
          if (!ok) {
            errors.push(`${provider}: ${error}`);
            return;
          }
          if (r.error) {
            errors.push(`${provider}: ${r.error}`);
            return;
          }
          paths[pathId] = { provider, windows: r.windows, updatedAt: r.updatedAt ?? new Date().toISOString() };
        }),
        new Promise(resolve => setTimeout(() => {
          if (settled) return resolve();
          settled = true;
          errors.push(`${provider}: timeout (15s)`);
          resolve();
        }, 15000)),
      ])
    );
  }

  await Promise.all(promises);
  return { generatedAt: new Date().toISOString(), paths, errors, inactive: [...new Set(inactive)].sort() };
}

function readPreviousPaths() {
  try {
    const prev = JSON.parse(fs.readFileSync(homeDataPath('quota.json'), 'utf8'));
    return prev && prev.paths ? prev.paths : null;
  } catch { return null; }
}

// Decide what a collection result may do to data/quota.json. Same rule as
// pricing: an all-failure run must never wipe last-known quota — and here
// the stakes are higher, because an all-failure stub would erase the only
// evidence routing has, so an empty file would strand every 'auto' task.
// Returns 'write' (new data), 'keep' (empty result,
// previous exists), or 'empty' (empty result, nothing previous).
function resolveQuotaWrite(prevPaths, nextPaths) {
  const nextKeys = nextPaths ? Object.keys(nextPaths).length : 0;
  if (nextKeys > 0) return 'write';
  const prevKeys = prevPaths ? Object.keys(prevPaths).length : 0;
  return prevKeys > 0 ? 'keep' : 'empty';
}

// Merge a partial collection over last-known quota: providers that failed
// this run keep their previous windows with their original timestamps (so
// downstream freshness checks still age them out). Without this, one flaky
// fetcher deletes its provider's limits from the snapshot — and missing
// quota reads as AVAILABLE downstream, routing work onto saturated paths.
// Only applied when the run reports errors; a clean run writes exactly what
// it collected so retired paths can disappear.
function mergeQuotaPaths(prevPaths, nextPaths) {
  if (!prevPaths) return { paths: nextPaths, preserved: 0 };
  const paths = { ...prevPaths };
  for (const [id, entry] of Object.entries(nextPaths || {})) paths[id] = entry;
  const preserved = Object.keys(prevPaths).filter(id => !nextPaths || !Object.hasOwn(nextPaths, id)).length;
  return { paths, preserved };
}

async function main() {
  const result = await run();
  for (const [id, q] of Object.entries(result.paths)) {
    const w = q.windows.map(x => `${x.label} ${x.usedPercent}%`).join(' · ');
    console.error(`  ${id.padEnd(10)} ${w}${q.credits != null ? ` · credits ${q.credits}` : ''}`);
  }
  if (result.errors.length) console.error('  skipped:', result.errors.join('; '));
  if (result.inactive?.length) console.error('  not queried (no active subscription):', result.inactive.join(', '));
  if (process.argv.includes('--dry-run')) return result;
  const prevPaths = readPreviousPaths();
  const decision = resolveQuotaWrite(prevPaths, result.paths);
  if (decision === 'keep') {
    console.error('refusing to overwrite data/quota.json with an empty result — keeping last good data');
    process.exitCode = 1;
    return result;
  }
  let out = result;
  if (result.errors.length && prevPaths) {
    const merged = mergeQuotaPaths(prevPaths, result.paths);
    if (merged.preserved) console.error(`  preserved ${merged.preserved} provider(s) with no fresh data (keeping last windows)`);
    out = { ...result, paths: merged.paths };
  }
  fs.writeFileSync(homeDataPath('quota.json'), JSON.stringify(out, null, 2) + '\n');
  console.error('wrote data/quota.json');
  if (decision === 'empty') process.exitCode = 1;
  return out;
}

if (require.main === module) main().catch(err => { console.error(err.message); process.exit(1); });
module.exports = { run, resolveQuotaWrite, mergeQuotaPaths, queriesCodexbar, NO_CODEXBAR, LOCAL_PATH_ID };
