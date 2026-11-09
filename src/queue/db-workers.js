'use strict';

/**
 * Orchestrator worker and rate-limit queries — registration, heartbeats,
 * lease management, and utilization.
 */

const { nowIso, uuidv4, json } = require('./db-helpers.js');

function registerWorker(db, worker) {
  const ts = nowIso();
  db.prepare(`
    INSERT INTO workers (id, name, executor, provider, model, capabilities, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      executor = excluded.executor,
      provider = excluded.provider,
      model = excluded.model,
      capabilities = excluded.capabilities,
      last_seen = excluded.last_seen
  `).run(
    worker.id,
    worker.name || null,
    worker.executor || null,
    worker.provider || null,
    worker.model || null,
    json(worker.capabilities || []),
    ts,
  );
  return { id: worker.id, ...worker, last_seen: ts };
}

function listWorkers(db) {
  return db.prepare('SELECT * FROM workers ORDER BY id').all();
}

function heartbeatWorker(db, workerId) {
  db.prepare(
    'UPDATE workers SET last_seen = ? WHERE id = ?',
  ).run(nowIso(), workerId);
}

/**
 * Renew the lease on whatever task(s) this worker currently holds 'running'.
 * A worker processes one task at a time (claim -> run -> complete), so a live
 * heartbeat proves that task is still alive; without this, recoverExpiredTasks
 * would re-pend (and duplicate) any task that legitimately outlives the fixed
 * claim-time lease window, even while its worker keeps heartbeating.
 */
function renewTaskLease(db, workerId, leaseMinutes = 60) {
  const ts = nowIso();
  const leaseExpires = new Date(Date.now() + leaseMinutes * 60 * 1000).toISOString();
  // Renew the task-level lease
  db.prepare(`
    UPDATE tasks SET last_heartbeat_at = ?, lease_expires_at = ?
    WHERE claimed_by = ? AND status = 'running'
  `).run(ts, leaseExpires, workerId);
  // Also renew rate-limit leases for this worker's running tasks so a
  // long-running job does not lose its rate capacity mid-execution.
  db.prepare(`
    UPDATE rate_leases SET expires_at = ?
    WHERE task_id IN (SELECT id FROM tasks WHERE claimed_by = ? AND status = 'running')
  `).run(leaseExpires, workerId);
}

// --- Rate limit queries ---

function setRateLimit(db, rl) {
  // SQLite treats NULL as distinct from itself in a PRIMARY KEY/UNIQUE index,
  // so ON CONFLICT never fires for a NULL model column — each call would
  // insert a duplicate row instead of updating. Use '' (the column's own
  // schema default) so global (model-less) limits are a stable, updatable key.
  db.prepare(`
    INSERT INTO rate_limits (provider, metric, model, limit_val)
    VALUES (?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET limit_val = excluded.limit_val
  `).run(rl.provider, rl.metric, rl.model || '', rl.limit_val);
}

function getRateLimits(db, provider) {
  if (provider) {
    return db.prepare(
      'SELECT * FROM rate_limits WHERE provider = ?',
    ).all(provider);
  }
  return db.prepare('SELECT * FROM rate_limits').all();
}

function leaseResource(db, lease) {
  db.prepare(`
    INSERT INTO rate_leases (id, provider, model, metric, amount, task_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    lease.id || uuidv4(),
    lease.provider,
    lease.model || null,
    lease.metric,
    lease.amount,
    lease.task_id,
    lease.expires_at,
  );
}

function releaseLease(db, leaseId) {
  db.prepare('DELETE FROM rate_leases WHERE id = ?').run(leaseId);
}

function releaseLeasesForTask(db, taskId) {
  db.prepare('DELETE FROM rate_leases WHERE task_id = ?').run(taskId);
}

// model === undefined -> no model filter (every lease for provider+metric,
//   used for provider-wide/global rate limits); model === null -> only
//   leases explicitly recorded with no model; a string -> that exact model.
function getActiveLeases(db, provider, metric, model) {
  const modelClause = model === undefined ? '' : model === null ? 'AND model IS NULL' : 'AND model = ?';
  const rows = db.prepare(`
    SELECT SUM(amount) as total FROM rate_leases
    WHERE provider = ? AND metric = ? AND expires_at > ?
    ${modelClause}
  `).all(
    provider,
    metric,
    nowIso(),
    ...(model !== undefined && model !== null ? [model] : []),
  );
  if (!rows.length || rows[0].total == null) return [{ total: 0 }];
  return rows;
}

/**
 * Group a provider's rate limits by metric, pairing each metric's global
 * (model-less) limit with the limit for the task's model, if any.
 * Uses the task's model for scoping; if model is null, only global limits apply.
 */
function getApplicableMetrics(limits, model) {
  const metrics = [...new Set(limits.map(l => l.metric))];
  const applicable = [];
  for (const metric of metrics) {
    const globalLimit = limits.find(l => l.metric === metric && (!l.model || l.model === ''));
    const modelLimit = model ? limits.find(l => l.metric === metric && l.model === model) : null;
    if (globalLimit || modelLimit) {
      applicable.push({ metric, globalLimit, modelLimit });
    }
  }
  return applicable;
}

/**
 * Acquire rate-limit capacity for a task inside the caller's active
 * transaction, so INSERTs are rolled back on failure (the caller does
 * ROLLBACK + continue instead of releasing leases). Must only be called
 * after BEGIN IMMEDIATE.
 *
 * Returns an array of lease objects on success, or null if capacity is
 * exhausted. Returns an empty array when no limits are defined for this
 * provider or none apply to this model (capacity is unlimited).
 */
function acquireRateLimitLeaseWithinTx(db, provider, model, taskId, leaseTtlMinutes = 120) {
  const limits = getRateLimits(db, provider);
  if (!limits.length) return [];

  const applicable = getApplicableMetrics(limits, model);
  if (!applicable.length) return [];

  // Check capacity across all applicable limits jointly
  for (const { metric, globalLimit, modelLimit } of applicable) {
    if (globalLimit) {
      const active = getActiveLeases(db, provider, metric, undefined);
      const totalUsed = active.length ? active[0].total : 0;
      if (globalLimit.limit_val - totalUsed <= 0) return null;
    }
    if (modelLimit) {
      const active = getActiveLeases(db, provider, metric, model);
      const totalUsed = active.length ? active[0].total : 0;
      if (modelLimit.limit_val - totalUsed <= 0) return null;
    }
  }

  const leaseResults = [];
  for (const { metric } of applicable) {
    const leaseId = uuidv4();
    const expiresAt = new Date(Date.now() + leaseTtlMinutes * 60 * 1000).toISOString();
    const amount = 1;

    db.prepare(`
      INSERT INTO rate_leases (id, provider, model, metric, amount, task_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(leaseId, provider, model || null, metric, amount, taskId, expiresAt);

    leaseResults.push({ id: leaseId, metric, amount });
  }

  return leaseResults;
}

/**
 * Get effective rate-limit utilization (used / limit) for a provider.
 * When `model` is provided, returns utilization scoped to that model;
 * when null, returns utilization across all models.
 */
function getProviderUtilization(db, provider, model) {
  const limits = getRateLimits(db, provider);
  if (!limits.length) return [];

  // When model is specified, try to find a model-specific limit for that
  // model. If found, return utilization for that specific limit.
  if (model) {
    const modelSpecificLimits = limits.filter(
      l => l.provider === provider && l.model === model,
    );
    if (modelSpecificLimits.length) {
      return modelSpecificLimits.map(limit => {
        const activeLeases = getActiveLeases(db, provider, limit.metric, model);
        const totalUsed = activeLeases.length ? activeLeases[0].total : 0;
        return {
          provider: limit.provider,
          metric: limit.metric,
          model,
          limit: limit.limit_val,
          used: Math.round(totalUsed * 100) / 100,
          remaining: Math.max(0, limit.limit_val - totalUsed),
          utilization: Math.round((totalUsed / limit.limit_val) * 10000) / 100,
        };
      });
    }
    // No model-specific limit found — fall through to global limits below
  }

  // Global limits (or per-metric fallback if model is null/undefined)
  const globalLimits = limits.filter(l => !l.model || l.model === '');
  const limitsToReport = globalLimits.length ? globalLimits : (() => {
    const map = new Map();
    for (const l of limits) {
      if (!map.has(l.metric)) map.set(l.metric, l);
    }
    return [...map.values()];
  })();

  return limitsToReport.map(limit => {
    const queryModel = limit.model || undefined;
    const activeLeases = getActiveLeases(db, provider, limit.metric, queryModel);
    const totalUsed = activeLeases.length ? activeLeases[0].total : 0;
    return {
      provider: limit.provider,
      metric: limit.metric,
      model: limit.model || model || null,
      limit: limit.limit_val,
      used: Math.round(totalUsed * 100) / 100,
      remaining: Math.max(0, limit.limit_val - totalUsed),
      utilization: Math.round((totalUsed / limit.limit_val) * 10000) / 100,
    };
  });
}

module.exports = {
  registerWorker,
  listWorkers,
  heartbeatWorker,
  renewTaskLease,
  setRateLimit,
  getRateLimits,
  leaseResource,
  releaseLease,
  releaseLeasesForTask,
  getActiveLeases,
  acquireRateLimitLeaseWithinTx,
  getProviderUtilization,
};
