'use strict';
const { summarizeQuota } = require('./capacity-view.js');
const { parseAgyCatalog } = require('./native-observations.js');

function unknownNativeQuota(reason = 'native-usage-unavailable') {
  return { ...summarizeQuota(null, 'antigravity'), scope: 'native-reported-pools', source: 'native-agy-usage', reason,
    pools: [], poolsOmitted: 0, accountIdentity: 'native-client-not-global-identity' };
}

function supportsAgyUsage(text) {
  const match = /^\s*v?(\d+)\.(\d+)\.(\d+)\s*$/m.exec(text);
  if (!match) return false;
  const version = match.slice(1).map(Number);
  if (!version.every(Number.isSafeInteger)) return false;
  const [major, minor, patch] = version;
  return major === 1 && (minor > 1 || (minor === 1 && patch >= 11));
}

// The existing parser accepts numeric strings. Blank fields must not coerce
// into fabricated zero remaining quota before passing through that parser.
function usagePayload(text) {
  const numeric = new Set(['remainingFraction', 'remaining_fraction', 'fractionRemaining', 'remainingPercent', 'remaining_percent', 'remainingRequests', 'remaining_requests', 'requestsRemaining', 'remainingTokens', 'remaining_tokens', 'tokensRemaining', 'resetsInSeconds', 'resetAfterSeconds', 'reset_after_seconds']);
  return JSON.stringify(JSON.parse(text, (key, value) => numeric.has(key) && typeof value === 'string' && !value.trim() ? undefined : value));
}

async function observeAgyQuota({ run, parseUsage, now = () => Date.now() }) {
  const unavailable = unknownNativeQuota();
  try {
    let version;
    try { version = await run(['--version'], 3000); }
    catch { return unknownNativeQuota('native-version-command-unavailable'); }
    if (!supportsAgyUsage(version)) return unknownNativeQuota('native-usage-version-unsupported');
    let catalog;
    try { catalog = parseAgyCatalog(await run(['models'], 5000)); }
    catch { return unknownNativeQuota('native-catalog-command-or-format-unavailable'); }
    const ids = new Set(catalog.map(model => model.id));
    if (!ids.size) return unknownNativeQuota('native-catalog-unavailable');
    let output;
    try { output = await run(['--output-format', 'json', '-p', '/usage'], 12000); }
    catch { return unknownNativeQuota('native-usage-command-unavailable'); }
    let snapshot;
    try { snapshot = parseUsage(usagePayload(output)); }
    catch { return unknownNativeQuota('native-usage-payload-unrecognized'); }
    if (!snapshot || snapshot.error || !Array.isArray(snapshot.models)) return unknownNativeQuota('native-usage-response-unrecognized');
    const fetchedAt = now();
    const entries = snapshot.models.filter(entry => typeof entry?.model === 'string' &&
      (ids.has(entry.model) || /^(?:Gemini(?: Models)?|Claude(?: and GPT)? Models|GPT-OSS Models)$/i.test(entry.model)));
    const pools = entries.slice(0, 16).map((entry, index) => {
      const amounts = [entry.remaining_fraction, entry.remaining_requests, entry.remaining_tokens];
      const known = amounts.filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
      const malformed = amounts.some((value, i) => value !== undefined && (!Number.isFinite(value) || value < 0 || (i === 0 && value > 1)));
      const expired = entry.reset_at === 'now' || entry.reset_at === 'in 0s';
      const usedPercent = expired ? null : known.includes(0) ? 100 : malformed || !known.length ? null : 0;
      const reset = typeof entry.reset_at === 'string' && /^\d{4}-\d\d-\d\dT/.test(entry.reset_at) && Number.isFinite(Date.parse(entry.reset_at)) ? new Date(entry.reset_at).toISOString() : null;
      const quota = summarizeQuota({ paths: { antigravity: { updatedAt: new Date(fetchedAt).toISOString(), windows: [{ usedPercent, resetsAt: reset }] } } }, 'antigravity', { now: fetchedAt });
      return { poolRef: `observed-agy-pool-${index + 1}`, label: entry.model,
        window: ['five-hour', 'weekly', 'daily', 'monthly'].includes(entry.window) ? entry.window : null,
        state: quota.state, freshness: quota.freshness, observedAt: quota.observedAt,
        nextResetAt: quota.nextResetAt, recheckAt: quota.recheckAt, reason: quota.reason };
    });
    return { ...unavailable, observedAt: new Date(fetchedAt).toISOString(), freshness: pools.length ? 'fresh' : 'missing',
      reason: 'separate-reported-pools-not-aggregate-capacity', pools, poolsOmitted: Math.max(0, snapshot.models.length - pools.length) };
  } catch { return unavailable; }
}

function applyNativeQuota(view, quota) {
  for (const execution of view.paths) {
    if (execution.machine === view.observedMachine && execution.harness === 'agy' && execution.provider === 'antigravity') {
      execution.quota = quota?.scope === 'native-reported-pools' && quota.source === 'native-agy-usage' ? quota : unknownNativeQuota();
    }
  }
  return view;
}
module.exports = { observeAgyQuota, supportsAgyUsage, unknownNativeQuota, applyNativeQuota, usagePayload };
