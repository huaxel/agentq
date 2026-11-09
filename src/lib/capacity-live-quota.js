'use strict';
const { summarizeQuota } = require('./capacity-view.js');

function summary(key, windows, now) {
  const quota = summarizeQuota({ paths: { [key]: { windows, updatedAt: new Date(now).toISOString() } } }, key, { now });
  return { ...quota, source: 'live-provider-usage' };
}

function goWindows(result, now) {
  if (result?.error) return [];
  // Go exposes three simultaneous limits. A missing/malformed limit cannot
  // be silently dropped when deciding whether account headroom was observed.
  return ['rolling', 'weekly', 'monthly'].map(kind => {
    const window = result?.[kind];
    if (!window || !Number.isFinite(window.usagePercent)) return { usedPercent: null, resetsAt: null };
    return { usedPercent: window.status === 'exhausted' ? 100 : window.usagePercent,
      resetsAt: Number.isFinite(window.resetInSec) && window.resetInSec > 0 ? new Date(now + window.resetInSec * 1000).toISOString() : null };
  });
}

async function observeLiveQuota({ usage, auth, now }) {
  const observedTime = () => now ?? Date.now();
  const output = {};
  // Use known credential fields only; do not execute secret-command strings.
  const config = auth.loadAuthJson();
  const configuredKey = auth.authCredential('opencode-go') || auth.resolveAuthValue(process.env.OPENCODE_API_KEY);
  const rawAccounts = Array.isArray(config?.['opencode-go-failover']?.accounts) ? config['opencode-go-failover'].accounts : [];
  const keys = rawAccounts.slice(0, 8).map(a => auth.resolveAuthValue(a?.key)).filter(Boolean);
  const unique = [...new Set(configuredKey ? [configuredKey, ...keys] : keys)].slice(0, 8);
  const accounts = await Promise.all(unique.map(async (key, index) => {
    let result;
    try { result = await usage.fetchUsageApi(key, { timeoutMs: 10000 }); }
    catch { result = null; }
    const fetchedAt = observedTime();
    const quota = summary('go', goWindows(result, fetchedAt), fetchedAt);
    return { accountRef: `observed-go-account-${index + 1}`, matchesConfiguredProviderKey: configuredKey ? key === configuredKey : null,
      state: quota.state, freshness: quota.freshness, observedAt: quota.observedAt, nextResetAt: quota.nextResetAt, recheckAt: quota.recheckAt, reason: quota.reason };
  }));
  const current = accounts.find(a => a.matchesConfiguredProviderKey);
  output.go = { ...summary('go', [], observedTime()), scope: 'configured-provider-credential', accounts,
    ...(current ? { state: current.state, freshness: current.freshness, observedAt: current.observedAt, nextResetAt: current.nextResetAt, recheckAt: current.recheckAt, reason: current.reason, accountResolved: true } : {}),
    accountIdentity: 'observation-local-not-global-identity', modelResolved: false };
  let openference;
  try { openference = await usage.fetchOpenferenceUsage(undefined, { timeoutMs: 10000 }); }
  catch { openference = null; }
  // "now" means the collector observed an expired reset. Other relative
  // descriptions are approximate: do not invent exact reset timestamps.
  const windows = !openference?.error && Array.isArray(openference?.windows) ? openference.windows.map(w => ({ usedPercent: w.resetsIn === 'now' ? null : w.usedPercent, resetsAt: w.resetsAt ?? null })) : [];
  output.openference = { ...summary('openference', windows, observedTime()), scope: 'configured-provider-credential', accountResolved: windows.length > 0, accountIdentity: 'configured-provider-key-not-global-identity' };
  return output;
}

module.exports = { observeLiveQuota, goWindows };
