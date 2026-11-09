/**
 * Claude Code transcript scanner.
 *
 * The pi session scanner only reads pi session logs (~/.pi, dotfiles SSoT,
 * ~/.omp), so it is blind to standalone Claude Code CLI usage that lives in
 * ~/.claude/projects. tokscale reads that store (its `clients` output shows
 * "Claude Code 18.5K messages") and attributes ~$1.2-1.4k of claude-opus-5/
 * sonnet-5/fable-5/opus-4-8 spend the ccusage pipeline never sees.
 *
 * This scanner reads Claude Code's own transcript format from ~/.claude,
 * including separate subagent transcripts, and emits entries shaped exactly
 * like pi-session-scanner entries:
 *   { provider:'claude', originalProvider:'claude', model, date,
 *     inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost }
 * Transcripts DON'T log a cost (only input_tokens / output_tokens /
 * cache_creation_input_tokens / cache_read_input_tokens), so cost is 0 here
 * and the shared aggregate() prices it from config pricing — same as tokscale
 * does from its own rates.
 *
 * Claude Code transcript schema (verified):
 *   top-level: { type:'assistant', timestamp, message:{ role:'assistant',
 *     model:'claude-sonnet-5', usage:{ input_tokens, output_tokens,
 *     cache_creation_input_tokens, cache_read_input_tokens } } }
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');

/**
 * Parse one Claude Code transcript JSONL file into usage entries.
 * @param {string} filePath
 * @param {string} [since]  YYYYMMDD lower bound (inclusive).
 * @returns {Array<{provider, originalProvider, model, date, inputTokens,
 *   outputTokens, cacheReadTokens, cacheWriteTokens, cost}>}
 */
function parseClaudeTranscript(filePath, since) {
  const entries = [];
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return entries; }
  // Claude Code writes the SAME API turn's usage more than once (the live
  // message AND its rendered representation), producing adjacent identical
  // usage rows. Counting both over-counts ~2x (43% of rows here were exact
  // adjacent duplicates). Use request/message IDs rather than token counts:
  // two legitimate turns can have identical token counts.
  const sinceKey = since ? String(since).replace(/-/g, '') : null;
  const seenTurnIds = new Set();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { continue; }
    // Only assistant turns carry usage; user/tool/system records have no
    // billable assistant usage in this transcript format.
    if (entry.type !== 'assistant') continue;
    const msg = entry.message;
    if (!msg || msg.role !== 'assistant') continue;
    const model = msg.model;
    const usage = msg.usage || {};
    if (!model) continue;
    const date = entry.timestamp ? entry.timestamp.slice(0, 10) : null;
    if (!date) continue;
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheReadTokens = usage.cache_read_input_tokens || 0;
    const cacheWriteTokens = usage.cache_creation_input_tokens || 0;
    if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) continue;
    // Filter before touching deduplication state so an out-of-range turn cannot
    // hide the first in-range turn when they happen to share token counts.
    if (sinceKey && date.replace(/-/g, '') < sinceKey) continue;
    // Duplicate transcript rows share the API request and assistant message ID.
    // The UUID is a fallback for older rows that lack one of those fields.
    const turnId = entry.requestId && msg.id
      ? `${entry.requestId}|${msg.id}`
      : (entry.requestId || msg.id || entry.uuid);
    if (turnId) {
      if (seenTurnIds.has(turnId)) continue;
      seenTurnIds.add(turnId);
    }
    entries.push({
      provider: 'claude',           // maps to providerPathMap['claude'] -> claudemax
      originalProvider: 'claude',
      model,
      date,
      cost: 0,                      // no logged cost in transcripts; aggregate prices it
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    });
  }
  return entries;
}

/**
 * Walk ~/.claude/projects (or a supplied dir), parse all transcripts including
 * subagents into usage entries.
 * @param {object} [opts]  { sessionDir?, since?, maxFiles? }
 */
function walkClaudeTranscripts(opts = {}) {
  const root = opts.sessionDir || process.env.CLAUDE_SESSIONS_DIR || DEFAULT_CLAUDE_DIR;
  const since = opts.since;
  const all = [];
  if (!fs.existsSync(root)) return all;
  const files = [];
  function collect(current) {
    let children;
    try { children = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      const childPath = path.join(current, child.name);
      if (child.isDirectory()) collect(childPath);
      else if (child.isFile() && child.name.endsWith('.jsonl')) files.push(childPath);
      if (opts.maxFiles && files.length >= opts.maxFiles) return;
    }
  }
  collect(root);
  for (const file of files) all.push(...parseClaudeTranscript(file, since));
  return all;
}

/**
 * Scan Claude Code transcripts since a date, priced + provider-attributed via
 * the shared pi-session-scanner aggregate().
 * @param {string} [since]  YYYYMMDD inclusive.
 * @param {object} [providerPathMap]  config.providerPathMap (claude -> claudemax).
 * @param {object} [opts]  { modelPriceAliases, pricingModels, sessionDir? }
 * @returns {{ perPath, perProvider, perModel, providerRecords, errors, totalEntries, totalCost, since }}
 */
function scanClaudeSessions(since, providerPathMap = {}, opts = {}) {
  const { aggregate } = require('./pi-session-scanner.js');
  const entries = walkClaudeTranscripts({ since, sessionDir: opts.sessionDir });
  const result = aggregate(entries, providerPathMap, {
    modelPriceAliases: opts.modelPriceAliases || {},
    pricingModels: opts.pricingModels || {},
  });
  return {
    ...result,
    totalEntries: entries.length,
    totalCost: result.perPathTotalRaw,
    since: since || 'all',
  };
}

module.exports = { scanClaudeSessions, parseClaudeTranscript, walkClaudeTranscripts, DEFAULT_CLAUDE_DIR };