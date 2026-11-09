'use strict';

const PURPOSE = 'facts-for-agent-reasoning-not-dispatch-policy';
function text(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.length || value.length > 512 || [...value].some(c => c.charCodeAt(0) < 32)) throw new Error('Invalid capacity observation field');
  return value;
}
function choice(value, choices) {
  if (!choices.includes(value)) throw new Error('Invalid capacity observation state');
  return value;
}
function timestamp(value, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid capacity observation timestamp');
  return new Date(value).toISOString();
}
function machineId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value) || value === 'local') throw new Error('Observation needs a concrete machine ID, not local');
  return value;
}
function models(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid capacity model observation');
  return value.map(model => ({
    id: text(model?.id),
    reasoning: choice(model?.reasoning, [true, false, null]),
    images: choice(model?.images, [true, false, null]),
    privacy: choice(model?.privacy, ['unverified', 'training-contributor-check-required']),
  }));
}

function sanitizePath(path) {
  if (!path || !Array.isArray(path.constraints) || path.constraints.length > 100) throw new Error('Invalid capacity path');
  const auth = path.authentication;
  const catalog = path.catalog;
  const quota = path.quota;
  // Copy only the summary schema; unsupported fields (including raw usage or
  // credential extras) are dropped. Supported metadata strings are copied as
  // data, not redacted: this is not an arbitrary-secret detector.
  return {
    id: text(path.id), machine: machineId(path.machine), subscription: text(path.subscription),
    accountRef: text(path.accountRef, true), harness: text(path.harness), provider: text(path.provider),
    selection: choice(path.selection, ['explicit-model', 'native-auto', 'native-catalog']),
    access: choice(path.access, ['configured', 'unavailable', 'unknown']), accessReason: text(path.accessReason),
    authentication: { state: choice(auth?.state, ['configured', 'authenticated', 'not-authenticated', 'unknown']), mode: choice(auth?.mode, [null, 'subscription', 'api-key']), source: text(auth?.source) },
    catalog: { state: choice(catalog?.state, ['authenticated', 'advertised', 'native-auto', 'unknown']), source: text(catalog?.source) },
    nativeObservedAt: timestamp(path.nativeObservedAt, true), models: models(path.models),
    quota: {
      bucket: text(quota?.bucket), scope: choice(quota?.scope, ['collector-aggregate', 'configured-provider-credential', 'native-reported-pools']),
      accountResolved: choice(quota?.accountResolved, [false, true]), modelResolved: choice(quota?.modelResolved, [false]),
      ...(['live-provider-usage', 'native-agy-usage'].includes(quota?.source) ? { source: quota.source } : {}),
      ...(Array.isArray(quota?.pools) ? { pools: quota.pools.slice(0, 16).map(pool => ({
        poolRef: text(pool.poolRef), label: text(pool.label), window: choice(pool.window, [null, 'five-hour', 'weekly', 'daily', 'monthly']),
        state: choice(pool.state, ['unknown', 'exhausted', 'headroom-observed']), freshness: choice(pool.freshness, ['fresh', 'stale', 'missing']),
        observedAt: timestamp(pool.observedAt, true), nextResetAt: timestamp(pool.nextResetAt, true), recheckAt: timestamp(pool.recheckAt ?? null, true), reason: text(pool.reason),
      })), poolsOmitted: Number.isSafeInteger(quota.poolsOmitted) && quota.poolsOmitted >= 0 ? quota.poolsOmitted : 0 } : {}),
      ...(quota?.accountIdentity ? { accountIdentity: text(quota.accountIdentity) } : {}),
      ...(Array.isArray(quota?.accounts) ? { accounts: quota.accounts.slice(0, 8).map(account => ({
        accountRef: text(account.accountRef), matchesConfiguredProviderKey: choice(account.matchesConfiguredProviderKey, [true, false, null]),
        state: choice(account.state, ['unknown', 'exhausted', 'headroom-observed']), freshness: choice(account.freshness, ['fresh', 'stale', 'missing']),
        observedAt: timestamp(account.observedAt, true), nextResetAt: timestamp(account.nextResetAt, true), recheckAt: timestamp(account.recheckAt ?? null, true), reason: text(account.reason),
      })) } : {}),
      state: choice(quota?.state, ['unknown', 'exhausted', 'headroom-observed']),
      freshness: choice(quota?.freshness, ['fresh', 'stale', 'missing']), reason: text(quota?.reason),
      nextResetAt: timestamp(quota?.nextResetAt, true),
      recheckAt: timestamp(quota?.recheckAt ?? null, true),
      observedAt: timestamp(quota?.observedAt ?? null, true),
    },
    constraints: path.constraints.map(c => text(c)),
  };
}

function mergeObservations(reports, { now = Date.now(), maxAgeHours = 6, maxClockSkewMs = 5000 } = {}) {
  if (!Array.isArray(reports) || !reports.length || reports.length > 100 || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0 ||
      !Number.isFinite(maxClockSkewMs) || maxClockSkewMs < 0 || maxClockSkewMs > 60000) throw new Error('Invalid capacity observation collection');
  const observations = new Map();
  for (const report of reports) {
    if (report?.schemaVersion !== 1 || report?.purpose !== PURPOSE || !Array.isArray(report.paths) || report.paths.length > 500) throw new Error('Invalid capacity observation report');
    const machine = machineId(report.observedMachine);
    const observedAt = timestamp(report.observedAt);
    const time = Date.parse(observedAt);
    if (time > now + maxClockSkewMs) throw new Error('Future-dated capacity observation');
    const paths = [];
    const ids = new Set();
    for (const path of report.paths) {
      const sanitized = sanitizePath(path);
      // A host cannot attest another host's access through copied inventory rows.
      if (sanitized.machine !== machine) continue;
      if (ids.has(sanitized.id)) throw new Error('Duplicate capacity path in observation');
      ids.add(sanitized.id);
      paths.push(sanitized);
    }
    paths.sort((a, b) => a.id.localeCompare(b.id));
    const previous = observations.get(machine);
    if (previous && previous.observedAt === observedAt && JSON.stringify(previous.paths) !== JSON.stringify(paths)) throw new Error('Conflicting capacity observations at the same timestamp');
    if (!previous || time > Date.parse(previous.observedAt)) observations.set(machine, { machine, observedAt, paths });
  }
  const paths = [];
  const sources = [];
  for (const observation of [...observations.values()].sort((a, b) => a.machine.localeCompare(b.machine))) {
    const stale = now - Date.parse(observation.observedAt) > maxAgeHours * 3600000;
    sources.push({ machine: observation.machine, observedAt: observation.observedAt, freshness: stale ? 'stale' : 'fresh', clockSkew: Date.parse(observation.observedAt) > now ? 'small-future-within-tolerance' : 'none-observed' });
    for (const path of observation.paths) {
      if (stale) {
        path.access = 'unknown';
        path.accessReason = 'stale-machine-observation';
        path.authentication = { state: 'unknown', mode: null, source: 'stale-machine-observation' };
        path.catalog = { state: 'unknown', source: 'stale-machine-observation' };
        path.models = null;
        path.quota = { ...path.quota, state: 'unknown', freshness: 'stale', reason: 'stale-machine-observation', nextResetAt: null };
      } else {
        const quotaTime = Date.parse(path.quota.observedAt);
        if (!Number.isFinite(quotaTime) || quotaTime > now + maxClockSkewMs || now - quotaTime > maxAgeHours * 3600000) {
          path.quota = { ...path.quota, state: 'unknown', freshness: Number.isFinite(quotaTime) ? 'stale' : 'missing', reason: 'quota-observation-age-unknown-or-stale', nextResetAt: null };
        } else if ([path.quota.recheckAt, path.quota.nextResetAt].some(time => time && Date.parse(time) <= now)) {
          path.quota = { ...path.quota, state: 'unknown', reason: 'reset-since-observation', nextResetAt: null };
        }
        const nativeTime = Date.parse(path.nativeObservedAt);
        if (path.selection !== 'explicit-model' && path.accessReason !== 'executable-not-found' &&
            (!Number.isFinite(nativeTime) || nativeTime > now + maxClockSkewMs || now - nativeTime > maxAgeHours * 3600000)) {
          path.access = 'unknown';
          path.accessReason = 'native-observation-age-unknown-or-stale';
          path.authentication = { state: 'unknown', mode: null, source: 'stale-native-observation' };
          path.catalog = { state: 'unknown', source: 'stale-native-observation' };
          path.models = null;
        }
      }
      if (path.quota.accounts) path.quota.accounts = path.quota.accounts.map(account => {
        const time = Date.parse(account.observedAt);
        if (stale || !Number.isFinite(time) || time > now + maxClockSkewMs || now - time > maxAgeHours * 3600000) {
          return { ...account, state: 'unknown', freshness: 'stale', reason: 'stale-account-observation', nextResetAt: null };
        }
        if ([account.recheckAt, account.nextResetAt].some(time => time && Date.parse(time) <= now)) return { ...account, state: 'unknown', reason: 'reset-since-observation', nextResetAt: null };
        return account;
      });
      if (path.quota.pools) path.quota.pools = path.quota.pools.map(pool => {
        const time = Date.parse(pool.observedAt);
        if (stale || !Number.isFinite(time) || time > now + maxClockSkewMs || now - time > maxAgeHours * 3600000) {
          return { ...pool, state: 'unknown', freshness: 'stale', reason: 'stale-pool-observation', nextResetAt: null };
        }
        if ([pool.recheckAt, pool.nextResetAt].some(time => time && Date.parse(time) <= now)) return { ...pool, state: 'unknown', reason: 'reset-since-observation', nextResetAt: null };
        return pool;
      });
      paths.push({ ...path, executionKey: `${encodeURIComponent(path.machine)}:${encodeURIComponent(path.id)}`, observation: { observedAt: observation.observedAt, freshness: stale ? 'stale' : 'fresh' } });
    }
  }
  return {
    schemaVersion: 1, generatedAt: new Date(now).toISOString(), purpose: PURPOSE, observations: sources, paths,
    warnings: ['Imported machine identity is self-reported, not verified transport identity', 'Supported metadata is not secret-scrubbed; import only trusted collector reports', 'Only each host own observed paths are included', 'Unknown is neither available nor exhausted', 'Subscriptions and unresolved accounts across hosts may share capacity; do not add quota', 'No ranking, dispatch, SSH connections or inference performed'],
  };
}

module.exports = { mergeObservations, sanitizePath };
