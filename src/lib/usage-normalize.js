'use strict';

/**
 * Shared usage normalization for every path that persists job usage:
 *   - agentq queue (completeTask → usage_records)
 *   - legacy log import (storeUsageRecord → usage_records)
 *   - orchestrator live completion (completeTask → usage_records)
 *
 * Pi executors report token/cost fields in different shapes, so all three
 * paths must agree on how to interpret them or cache/write costs get
 * silently dropped or double-counted. Accepts both camelCase and snake_case:
 *   inputTokens/input_tokens, outputTokens/output_tokens,
 *   cacheTokens/cache_tokens (explicit total) OR cacheReadTokens + cacheWriteTokens,
 *   totalCost/cost — where cost may be a nested pi breakdown object whose
 *   total carries the money (a raw object would coerce to NaN, i.e. $0).
 * Also accepts pi session token names (input/output/cacheRead/cacheWrite) and
 * Claude Code's native field names (cache_read_input_tokens,
 * cache_creation_input_tokens, total_cost_usd), so a raw Claude Code result
 * keeps its cache spend and cost instead of reporting zero.
 *
 * @param {object|string} usage - usage object or JSON string
 * @returns {{ inputTokens: number, outputTokens: number, cacheTokens: number, totalCost: number }|null}
 *   null when the input is not a usable usage value.
 */
function normalizeUsage(usage) {
  if (typeof usage === 'string') {
    try { usage = JSON.parse(usage); } catch { return null; }
  }
  if (!usage || typeof usage !== 'object') return null;

  const num = v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  const cacheRead = num(usage.cacheReadTokens ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? usage.cacheRead);
  const cacheWrite = num(usage.cacheWriteTokens ?? usage.cache_write_tokens ?? usage.cache_creation_input_tokens ?? usage.cacheWrite);
  const costRaw = usage.totalCost ?? usage.total_cost ?? usage.total_cost_usd
    ?? (usage.cost && typeof usage.cost === 'object' ? usage.cost.total : usage.cost);

  return {
    inputTokens: num(usage.inputTokens ?? usage.input_tokens ?? usage.input),
    outputTokens: num(usage.outputTokens ?? usage.output_tokens ?? usage.output),
    cacheTokens: num(usage.cacheTokens ?? usage.cache_tokens ?? (cacheRead + cacheWrite)),
    totalCost: num(costRaw),
  };
}

module.exports = { normalizeUsage };