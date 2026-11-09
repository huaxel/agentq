#!/usr/bin/env node
'use strict';

/**
 * Orchestrator worker client — lightweight library for agents to
 * interact with the orchestrator REST API.
 *
 * Usage:
 *   const worker = new OrchestratorWorker('http://localhost:8090', 'my-agent');
 *   await worker.register();
 *   const task = await worker.claimNext();
 *   // ... do work ...
 *   await worker.complete(task.id, { status: 'succeeded', branch: 'main' });
 */

const { URL } = require('node:url');

class OrchestratorWorker {
  constructor(baseUrl, workerId, options = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.workerId = workerId;
    this.heartbeatInterval = options.heartbeatInterval || 30000;
    this.authToken = options.authToken || process.env.AUTH_TOKEN || null;
    this.heartbeatTimer = null;
    this.lastLeaseMinutes = null;
  }

  _headers() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.authToken) headers.Authorization = `Bearer ${this.authToken}`;
    return headers;
  }

  async _fetch(path, { method = 'GET', body } = {}) {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: this._headers(),
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`Orchestrator API error: ${res.status} ${text}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  /** Register or update this worker with the orchestrator. */
  async register({ name, executor, provider, model, capabilities } = {}) {
    return this._fetch('/api/workers', {
      method: 'POST',
      body: {
        id: this.workerId,
        name,
        executor,
        provider,
        model,
        capabilities,
      },
    });
  }

  /** Start periodic heartbeats. */
  startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatInterval);
  }

  /** Stop periodic heartbeats. */
  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Send a heartbeat. */
  async heartbeat() {
    try {
      // Renew the held task's lease by the same length it was claimed with.
      // Without this the server's fixed 60-minute renewal default silently
      // shrinks a long claim lease (e.g. agentq's 12.5 h) on the first beat,
      // letting recoverExpiredTasks re-pend (and duplicate) a live long job
      // after a >60 min stall.
      const qs = this.lastLeaseMinutes ? `?leaseMinutes=${this.lastLeaseMinutes}` : '';
      await this._fetch(`/api/workers/${this.workerId}/heartbeat${qs}`, { method: 'POST' });
    } catch { /* silent — worker may be offline */ }
  }

  /** Claim the next available task. Returns null if none available.
   *  leaseMinutes bounds how long the claim is held before recoverExpiredTasks
   *  re-pends it; pass a value long enough to cover this worker's own
   *  execution model if it can't renew the lease via heartbeat mid-task
   *  (e.g. a blocking/synchronous executor that can't run the heartbeat
   *  timer while a job is in flight). */
  async claimNext({ kind, model, modelOverride, maxAttempts = 3, leaseMinutes } = {}) {
    const params = new URLSearchParams();
    if (kind) params.set('kind', kind);
    if (model) params.set('model', model);
    if (modelOverride) params.set('modelOverride', modelOverride);
    params.set('maxAttempts', String(maxAttempts));
    params.set('worker', this.workerId);
    if (leaseMinutes) params.set('leaseMinutes', String(leaseMinutes));
    // 204 (no task) is res.ok — _fetch returns null for its empty body
    // before any throw, so no special-case catch is needed here.
    const task = await this._fetch(`/api/tasks/next?${params}`);
    // Only a successful claim changes which lease our heartbeats renew:
    // the server's default is 60 min when we didn't request a lease. A
    // failed or empty claim keeps the previous task's lease value.
    if (task) this.lastLeaseMinutes = leaseMinutes || 60;
    return task;
  }

  /** Report task completion. */
  async complete(taskId, result) {
    return this._fetch(`/api/tasks/${taskId}/result`, {
      method: 'POST',
      body: { status: result.status || 'succeeded', ...result, worker: this.workerId },
    });
  }

  /** Report task failure. Pass { retryable: false } for a deterministic/
   *  policy failure (e.g. a trust-gate refusal) that would fail identically
   *  on every retry, so the server skips straight to a terminal state. */
  async fail(taskId, error, { retryable = true } = {}) {
    return this._fetch(`/api/tasks/${taskId}/result`, {
      method: 'POST',
      body: { status: 'failed', error: String(error), worker: this.workerId, retryable },
    });
  }

  /** Approve a pending task. */
  async approveTask(taskId, approvedBy) {
    return this._fetch(`/api/tasks/${taskId}/approve`, {
      method: 'POST',
      body: { approved_by: approvedBy || this.workerId },
    });
  }

  /** Reject a pending task. */
  async rejectTask(taskId, reason) {
    return this._fetch(`/api/tasks/${taskId}/reject`, {
      method: 'POST',
      body: { rejected_by: this.workerId, reason: reason || null },
    });
  }

  /** List tasks awaiting approval. */
  async listPendingApprovals({ limit = 50 } = {}) {
    return this._fetch(`/api/tasks/pending-approvals?limit=${limit}`);
  }

  /** Get rate-limit utilization for a provider. */
  async getUtilization(provider, model) {
    const params = new URLSearchParams();
    if (provider) params.set('provider', provider);
    if (model) params.set('model', model);
    return this._fetch(`/api/utilization?${params}`);
  }

  /** Enqueue a new task (for agents that spawn subtasks). */
  async enqueue(task) {
    return this._fetch('/api/tasks', {
      method: 'POST',
      body: { ...task, source: this.workerId },
    });
  }

  /** Get task status. */
  async getTask(taskId) {
    return this._fetch(`/api/tasks/${taskId}`);
  }

  /** Drain loop — claim and process tasks until queue is empty. */
  async drain(processFn, { maxTasks = 0 } = {}) {
    let count = 0;
    while (true) {
      const task = await this.claimNext();
      if (!task) break;
      await processFn(task);
      count++;
      if (maxTasks && count >= maxTasks) break;
    }
    return count;
  }
}

module.exports = { OrchestratorWorker };
