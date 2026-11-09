'use strict';

/**
 * Quota-freshness wrapper for the MCP tools that read capacity.
 *
 * Routing treats quota older than six hours as unknown, so a long-idle server
 * would answer every `recommend_model` with "no eligible model" and refuse
 * every dispatch. The tools themselves stay dependency-injected and free of
 * IO; the server wraps the four tools that read capacity so a stale snapshot
 * is refreshed before the handler looks at it, and the outcome is passed
 * through as `quota_refresh: { refreshed, reason }`.
 *
 * The refresh runs in the BACKGROUND and each call waits for it for at most
 * `mcpWaitMs` (default 10 s). The protocol server serializes requests, so
 * awaiting a full collection (up to 90 s) would freeze ping/tools/list and
 * every other call until it finished. Instead:
 *
 *   - refresh finishes inside the bound -> answer from the fresh snapshot;
 *   - still running at the bound -> answer from the current snapshot with
 *     `{ refreshed: false, reason: 'refresh in progress' }`. Later calls during
 *     the same refresh return that immediately (they do not each pay the
 *     bound); when the collection settles, its outcome is reported once on the
 *     next call (`completed in background`, or the failure reason);
 *   - one background refresh per server: concurrent calls share the in-flight
 *     promise instead of starting another collection;
 *   - `cancel()` aborts a running collection (the refresher kills the
 *     collector's process group and releases its lock), so a closing server
 *     does not linger for the collection timeout.
 *
 * The wrapper is applied by the composition root (bin/agentq-mcp.js), which is
 * also where the refresher is configured (quota path, opt-out). The CLI keeps
 * the full wait: it is a one-shot command, not a shared server.
 */

/** Tools that read capacity and therefore refresh stale quota first. */
const REFRESH_TOOLS = Object.freeze([
  'capacity_overview',
  'recommend_model',
  'recommend_for_task',
  'dispatch_task',
]);

/** How long a tool call may wait for the background refresh. */
const DEFAULT_MCP_WAIT_MS = 10_000;

const TIMED_OUT = Symbol('quota-refresh-timeout');

/**
 * Outcomes that mean "no collection was started (or finished) here": they are
 * not worth reporting on the next call.
 */
const QUIET_REASONS = new Set([
  'fresh',
  'disabled',
  'rate limited',
  'refreshed by another process',
  'custom quota path',
  'no quota path',
]);

/**
 * Normalise a refresher outcome for the wire. A refresher that throws is a
 * skipped refresh, never a failed tool call.
 *
 * @param {unknown} outcome
 * @returns {{ refreshed: boolean, reason: string }}
 */
function normaliseOutcome(outcome) {
  const record = /** @type {{ refreshed?: unknown, reason?: unknown }} */ (outcome);
  return {
    refreshed: record?.refreshed === true,
    reason: typeof record?.reason === 'string' && record.reason ? record.reason : 'unknown',
  };
}

/**
 * Run one refresher call and normalise its outcome (or its failure).
 * @param {() => any} refreshQuota
 * @returns {Promise<{ refreshed: boolean, reason: string }>}
 */
async function quotaRefreshOutcome(refreshQuota) {
  try {
    return normaliseOutcome(await refreshQuota());
  } catch {
    return { refreshed: false, reason: 'refresh failed' };
  }
}

/**
 * Build a quota refresher for one server: wrap the capacity-reading tools and
 * expose `cancel()` for shutdown.
 *
 * @param {{
 *   refreshQuota: (input: { signal: AbortSignal }) => any,
 *   names?: readonly string[],
 *   mcpWaitMs?: number,
 * }} options
 * @returns {{ wrap: (tools: import('./protocol.js').McpTool[]) => import('./protocol.js').McpTool[], cancel: () => void, waitForRefresh: () => Promise<{ refreshed: boolean, reason: string }> }}
 */
function createQuotaRefresh({ refreshQuota, names = REFRESH_TOOLS, mcpWaitMs = DEFAULT_MCP_WAIT_MS } = {}) {
  if (typeof refreshQuota !== 'function') throw new TypeError('createQuotaRefresh requires refreshQuota');
  const waitMs = Number.isFinite(mcpWaitMs) && mcpWaitMs >= 0 ? mcpWaitMs : DEFAULT_MCP_WAIT_MS;
  const wrapped = new Set(names);

  /** @type {Promise<{ refreshed: boolean, reason: string }>|null} */
  let inFlight = null;
  /** @type {AbortController|null} */
  let controller = null;
  /** Did a call already give up on the current refresh? */
  let timedOut = false;
  /** Outcome of a refresh that finished after a call had given up. */
  let pendingResult = null;

  /** Start (or join) the single background refresh of this server. */
  const startRefresh = () => {
    if (!inFlight) {
      timedOut = false;
      controller = new AbortController();
      const { signal } = controller;
      inFlight = quotaRefreshOutcome(() => refreshQuota({ signal }))
        .then((outcome) => {
          // Report a collection that outlived the caller's wait exactly once.
          if (timedOut) {
            if (outcome.refreshed) {
              pendingResult = { refreshed: true, reason: 'completed in background' };
            } else if (!QUIET_REASONS.has(outcome.reason)) {
              pendingResult = { refreshed: false, reason: outcome.reason };
            }
          }
          return outcome;
        })
        .finally(() => {
          inFlight = null;
          controller = null;
          timedOut = false;
        });
    }
    return inFlight;
  };

  /**
   * Wait for the refresh, but never longer than the bound. A timeout leaves
   * the collection running; later calls during it answer immediately.
   * @returns {Promise<{ refreshed: boolean, reason: string }>}
   */
  const waitForRefresh = async () => {
    if (pendingResult) {
      const result = pendingResult;
      pendingResult = null;
      return result;
    }
    const pending = startRefresh();
    if (timedOut) return { refreshed: false, reason: 'refresh in progress' };
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), waitMs);
    });
    try {
      const outcome = await Promise.race([pending, timeout]);
      if (outcome === TIMED_OUT) {
        timedOut = true;
        return { refreshed: false, reason: 'refresh in progress' };
      }
      return /** @type {{ refreshed: boolean, reason: string }} */ (outcome);
    } finally {
      clearTimeout(timer);
    }
  };

  /** Abort a running collection (the refresher kills it and drops its lock). */
  const cancel = () => {
    if (controller) controller.abort();
  };

  /** @param {import('./protocol.js').McpTool[]} tools */
  const wrap = (tools) => {
    if (!Array.isArray(tools)) throw new TypeError('createQuotaRefresh.wrap requires a tool array');
    return tools.map((tool) => {
      if (!wrapped.has(tool.name)) return tool;
      return {
        ...tool,
        handler(args) {
          return (async () => {
            const quotaRefresh = await waitForRefresh();
            const result = await tool.handler(args);
            if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
            return { ...result, quota_refresh: quotaRefresh };
          })();
        },
      };
    });
  };

  return { wrap, cancel, waitForRefresh };
}

/**
 * Wrap the capacity-reading tools with a refresh-first handler.
 *
 * @param {import('./protocol.js').McpTool[]} tools
 * @param {{ refreshQuota?: (input: { signal: AbortSignal }) => any, names?: readonly string[], mcpWaitMs?: number }} [options]
 * @returns {import('./protocol.js').McpTool[]}
 */
function withQuotaRefresh(tools, options = {}) {
  if (!Array.isArray(tools)) throw new TypeError('withQuotaRefresh requires a tool array');
  if (typeof options.refreshQuota !== 'function') return tools;
  return createQuotaRefresh(options).wrap(tools);
}

module.exports = {
  createQuotaRefresh,
  withQuotaRefresh,
  quotaRefreshOutcome,
  normaliseOutcome,
  REFRESH_TOOLS,
  DEFAULT_MCP_WAIT_MS,
};
