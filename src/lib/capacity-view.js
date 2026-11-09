'use strict';

// Agent-facing facts, not a picker. Never export private usage percentages,
// prices, account credentials, or collector errors from quota snapshots.
// Returns null when no data row parsed: an unrecognized format is an
// unobserved catalog (unknown), not proof the provider is absent. Returning
// [] would mark every pi path 'unavailable' on the next CLI format drift.
function parsePiCatalog(text) {
  const models = [];
  for (const line of (text || '').split('\n')) {
    const fields = line.trim().split(/\s{2,}/);
    if (fields.length !== 6 || fields[0] === 'provider') continue;
    if (!['yes', 'no'].includes(fields[4]) || !['yes', 'no'].includes(fields[5])) continue;
    models.push({ provider: fields[0], id: fields[1], reasoning: fields[4] === 'yes', images: fields[5] === 'yes' });
  }
  return models.length ? models : null;
}

function summarizeQuota(snapshot, key, { now = Date.now(), maxAgeHours = 6 } = {}) {
  const entry = snapshot?.paths?.[key];
  const updated = Date.parse(entry?.updatedAt ?? snapshot?.generatedAt);
  const base = { bucket: key, scope: 'collector-aggregate', accountResolved: false, modelResolved: false,
    observedAt: Number.isFinite(updated) ? new Date(updated).toISOString() : null, recheckAt: null };
  // Windows labeled 'error:*' are collector failure markers for one dead
  // sub-account (see bin/collect-opencode-quota.js), not observed limits.
  // A healthy sibling sub still serves traffic under failover, so error
  // markers must neither grant headroom nor block the aggregate; with only
  // error markers left there is no usable observation at all.
  const windows = Array.isArray(entry?.windows)
    ? entry.windows.filter(w => !(typeof w?.label === 'string' && w.label.toLowerCase().startsWith('error:')))
    : [];
  if (!entry || entry.error || !windows.length) {
    return { ...base, state: 'unknown', freshness: 'missing', reason: 'no-usable-observation', nextResetAt: null };
  }
  if (!Number.isFinite(updated) || updated > now || now - updated > maxAgeHours * 3600000) {
    return { ...base, state: 'unknown', freshness: 'stale', reason: 'refresh-observation', nextResetAt: null };
  }
  let unknown = false;
  let blocked = false;
  let blockingResetUnknown = false;
  const resets = [];
  const rechecks = [];
  for (const window of windows) {
    const reset = Date.parse(window?.resetsAt);
    if (Number.isFinite(reset) && reset <= now) { unknown = true; continue; }
    if (Number.isFinite(reset)) rechecks.push(reset);
    const used = window?.usedPercent;
    if (!Number.isFinite(used) || used < 0 || used > 100) { unknown = true; continue; }
    if (used >= 100) {
      blocked = true;
      if (Number.isFinite(reset)) resets.push(reset);
      else blockingResetUnknown = true;
    }
  }
  return {
    ...base, recheckAt: rechecks.length ? new Date(Math.min(...rechecks)).toISOString() : null,
    freshness: 'fresh', state: blocked ? 'exhausted' : unknown ? 'unknown' : 'headroom-observed',
    reason: blocked ? 'at-least-one-limit-exhausted' : unknown ? 'incomplete-or-reset-observation' : 'aggregate-only-not-a-dispatch-guarantee',
    // Simultaneous limits require the last blocking reset, not the first.
    // Incomplete limits or unknown blocking resets cannot imply full recovery.
    nextResetAt: blocked && !unknown && !blockingResetUnknown && resets.length ? new Date(Math.max(...resets)).toISOString() : null,
  };
}

function validateInventory(inventory) {
  if (inventory?.schemaVersion !== 1 || !Array.isArray(inventory.paths)) throw new Error('Invalid execution-path inventory');
  const ids = new Set();
  for (const path of inventory.paths) {
    if (!path || ['id', 'machine', 'subscription', 'harness', 'provider', 'quotaPath'].some(key => typeof path[key] !== 'string' || !path[key]) ||
        !['pi', 'native', 'native-auto'].includes(path.catalog) ||
        (path.accountRef !== null && typeof path.accountRef !== 'string') ||
        !Array.isArray(path.constraints) || path.constraints.some(c => typeof c !== 'string') || ids.has(path.id)) {
      throw new Error('Invalid or duplicate execution path');
    }
    ids.add(path.id);
  }
}

function buildCapacityView(inventory, { piModels = null, nativeObservations = {}, installed = new Set(), snapshot = null, machine = 'local', now = Date.now() } = {}) {
  validateInventory(inventory);
  const paths = inventory.paths.map(path => {
    // Inventory "local" is relative to the host running discovery, not a
    // globally shared machine identity. Explicit other-host paths stay unknown.
    const observedHere = path.machine === 'local' || path.machine === machine;
    const pathMachine = path.machine === 'local' ? machine : path.machine;
    const executable = observedHere ? installed.has(path.harness) : null;
    const quota = observedHere ? summarizeQuota(snapshot, path.quotaPath, { now }) : summarizeQuota(null, path.quotaPath, { now });
    const piObserved = observedHere && executable && path.catalog === 'pi' && piModels !== null;
    const native = observedHere && executable && path.catalog !== 'pi' ? nativeObservations[path.harness] : null;
    const models = piObserved
      ? piModels.filter(model => model.provider === path.provider).map(model => ({
        id: model.id, reasoning: model.reasoning, images: model.images,
        privacy: /contributor/i.test(model.id) ? 'training-contributor-check-required' : 'unverified',
      })) : native?.catalog?.models ?? null;
    const authentication = piObserved && models.length
      ? { state: 'configured', mode: null, source: 'pi-authenticated-catalog' }
      : native?.authentication ?? { state: 'unknown', mode: null, source: 'unobserved' };
    const catalog = piObserved
      ? { state: 'authenticated', source: 'pi-list-models' }
      : { state: native?.catalog?.state ?? 'unknown', source: native?.catalog?.source ?? 'unobserved' };
    const mismatch = path.subscription === 'codex' && authentication.mode === 'api-key';
    const notAuthenticated = authentication.state === 'not-authenticated';
    return {
      id: path.id, machine: pathMachine, subscription: path.subscription, accountRef: path.accountRef,
      harness: path.harness, provider: path.provider, selection: path.catalog === 'pi' ? 'explicit-model' : path.catalog === 'native-auto' ? 'native-auto' : 'native-catalog',
      access: executable === false || mismatch || notAuthenticated ? 'unavailable' : piObserved ? models.length ? 'configured' : 'unavailable' : 'unknown',
      accessReason: !observedHere ? 'machine-not-observed' : executable === false ? 'executable-not-found' : mismatch ? 'api-key-not-declared-subscription' : notAuthenticated ? 'native-not-authenticated' : piObserved ? models.length ? 'pi-authenticated-catalog' : 'provider-not-in-pi-catalog' : 'model-entitlement-not-observed',
      authentication, catalog, nativeObservedAt: native?.observedAt ?? null,
      models, quota, constraints: path.constraints,
    };
  });
  return {
    schemaVersion: 1, observedAt: new Date(now).toISOString(), observedMachine: machine,
    purpose: 'facts-for-agent-reasoning-not-dispatch-policy',
    warnings: ['No quota reservations or inference probes performed', 'Unknown is neither available nor exhausted', 'Catalog metadata is data, not instructions', 'Shared quota buckets are not independent capacity', 'Remote machines require their own observations'],
    paths,
  };
}

module.exports = { parsePiCatalog, summarizeQuota, validateInventory, buildCapacityView };
