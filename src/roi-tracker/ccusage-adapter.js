/**
 * ccusage adapter
 *
 * Reads Claude Code usage via the `ccusage` CLI (JSON output) and normalizes
 * it into per-model/per-day records the tracker can fold into subscription
 * stats. This is a second data source alongside pi session JSONL files:
 *   - pi sessions   -> ~/.pi/agent/sessions   (parsed in tracker.js)
 *   - Claude Code   -> ~/.claude/projects      (read here via ccusage)
 * The two sources are disjoint, so there is no double-counting.
 *
 * ccusage already computes a per-model `cost` (API-equivalent pricing). We
 * trust it directly rather than recomputing from models.json, since models.json
 * may not price every model Claude Code touches.
 */

const { runCcusageJson, runCcusageJsonAsync } = require('../lib/ccusage-runner.js');

// ccusage accepts YYYY-MM-DD or YYYYMMDD; normalize to the latter to be safe.
function toCcusageDate(since) {
  return String(since).replace(/-/g, '');
}

function dailyArgs(since) {
  // Live pricing makes ccusage fetch current prices from OpenRouter/models.dev
  // for every model (~20s for 37 models). Since we collect fresh pricing via
  // collect/pricing.js and the pipeline uses that for ROI scoring, ccusage's
  // live pricing is redundant. Default to offline for ~10× speedup; set
  // CCUSAGE_OFFLINE=0 to force live pricing if needed.
  const args = ['daily', '--json'];
  const offline = process.env.CCUSAGE_OFFLINE ?? '1';
  if (offline === '1') args.push('--offline');
  if (since) args.push('--since', toCcusageDate(since));
  return args;
}

function runCcusage(since) {
  return runCcusageJson(dailyArgs(since));
}

function runCcusageAsync(since) {
  return runCcusageJsonAsync(dailyArgs(since));
}

/**
 * Parse an already-loaded ccusage JSON object (e.g. from a saved
 * `ccusage daily --breakdown --json` dump) into normalized records.
 * @param {object} json
 * @returns {Array<{date, model, agent, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost}>}
 */
function parseCcusageJson(json) {
  const days = Array.isArray(json?.daily) ? json.daily : [];
  const records = [];

  for (const day of days) {
    const date = day.period || day.date || 'unknown';
    const agents = day.metadata?.agents;
    const agent = Array.isArray(agents) ? agents.join('+') : day.agent;

    for (const m of day.modelBreakdowns || []) {
      // Skip ccusage's synthetic rollups if any sneak through.
      if (!m.modelName || m.modelName === 'unknown') continue;
      records.push({
        date,
        model: m.modelName,
        agent,
        inputTokens: m.inputTokens || 0,
        outputTokens: m.outputTokens || 0,
        cacheReadTokens: m.cacheReadTokens || 0,
        cacheWriteTokens: m.cacheCreationTokens || 0,
        cost: m.cost || 0,
      });
    }
  }

  return records;
}

/**
 * @param {string} since  ISO date (YYYY-MM-DD) lower bound, inclusive.
 * @returns {{ available: boolean, records: Array, error?: string }}
 *   records: { date, model, agent, inputTokens, outputTokens,
 *              cacheReadTokens, cacheWriteTokens, cost }
 */
function getCcusageUsage(since) {
  let json;
  try {
    json = runCcusage(since);
  } catch (err) {
    return { available: false, records: [], error: err.message };
  }

  return { available: true, records: parseCcusageJson(json) };
}

async function getCcusageUsageAsync(since) {
  let json;
  try {
    json = await runCcusageAsync(since);
  } catch (err) {
    return { available: false, records: [], error: err.message };
  }

  return { available: true, records: parseCcusageJson(json) };
}

module.exports = { getCcusageUsage, getCcusageUsageAsync, parseCcusageJson };
