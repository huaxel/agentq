/**
 * Cursor session scanner — reads Cursor's AI tracking database to extract
 * model usage data for the ROI pipeline.
 *
 * Cursor stores AI code tracking data in an SQLite database at:
 *   ~/.cursor/ai-tracking/ai-code-tracking.db
 *
 * The `ai_code_hashes` table records file edits attributed to AI per model.
 * While it does NOT contain token counts or dollar costs, the model names
 * and timestamps provide useful insight into Cursor usage volume.
 *
 * Integration with collect-machine.js:
 *   This scanner is called from collect-machine.js and produces
 *   providerUsageRecords matching the pi-session-scanner format.
 *   Since Cursor runs on its own subscription model and doesn't expose
 *   local token/cost data, records carry cost: 0 by default. The pipeline
 *   can still attribute model usage and count edits as an activity proxy.
 *
 * Usage:
 *   const { scanCursorUsage } = require('./cursor-scanner.js');
 *   const result = scanCursorUsage(since);
 *   // { providerRecords: [...], totalEdits: 321, modelSummary: {...} }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CURSOR_DB_PATH = path.join(os.homedir(), '.cursor', 'ai-tracking', 'ai-code-tracking.db');

/**
 * Try to load the better-sqlite3 module, falling back to a child_process
 * sqlite33 approach if the native module isn't available in this context.
 */
let betterSqlite3 = null;
try {
  betterSqlite3 = require('better-sqlite3');
} catch {
  // Will use fallback via child_process
}

/**
 * Query the Cursor AI tracking DB using the better-sqlite3 module.
 * Returns rows from ai_code_hashes grouped by date and model.
 *
 * @param {string} dbPath - Path to the SQLite database
 * @param {string} [since] - ISO date (YYYY-MM-DD or YYYYMMDD), inclusive
 * @returns {Array<{date: string, source: string, model: string, edits: number, conversations: number, firstTs: number, lastTs: number}>}
 */
function queryDb(dbPath, since) {
  const sinceStr = since ? String(since).replace(/-/g, '') : null;

  if (betterSqlite3) {
    try {
      const db = betterSqlite3(dbPath, { readonly: true });
      try {
        // Convert epoch ms timestamps to date strings for grouping
        const rows = db.prepare(`
          SELECT
            date(timestamp / 1000, 'unixepoch') as date,
            source,
            model,
            COUNT(*) as edits,
            COUNT(DISTINCT conversationId) as conversations,
            MIN(timestamp) as firstTs,
            MAX(timestamp) as lastTs
          FROM ai_code_hashes
          WHERE model IS NOT NULL AND model != ''
          GROUP BY date, source, model
          ORDER BY date DESC, model
        `).all();

        if (sinceStr) {
          return rows.filter(r => r.date && r.date.replace(/-/g, '') >= sinceStr);
        }
        return rows;
      } finally {
        db.close();
      }
    } catch (e) {
      console.error(`  cursor-scanner: better-sqlite3 query failed: ${e.message}`);
      return [];
    }
  }

  // Fallback: use sqlite3 CLI if better-sqlite3 isn't available
  try {
    const { execFileSync } = require('child_process');
    const sql = `
      SELECT
        date(timestamp / 1000, 'unixepoch') as date,
        source,
        model,
        COUNT(*) as edits,
        COUNT(DISTINCT conversationId) as conversations,
        MIN(timestamp) as firstTs,
        MAX(timestamp) as lastTs
      FROM ai_code_hashes
      WHERE model IS NOT NULL AND model != ''
      GROUP BY date, source, model
      ORDER BY date DESC, model;
    `;
    const output = execFileSync('sqlite3', ['-json', dbPath, sql], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const rows = JSON.parse(output);
    if (sinceStr) {
      return rows.filter(r => r.date && r.date.replace(/-/g, '') >= sinceStr);
    }
    return rows;
  } catch (e) {
    console.error(`  cursor-scanner: sqlite3 CLI fallback failed: ${e.message}`);
    return [];
  }
}

/**
 * Map a Cursor model name to a pricing key using the config's modelPriceAliases.
 * Cursor's UI model names may differ from pricing keys.
 *
 * Known model names (from ai_code_hashes):
 *   - "default"     → user's default Cursor model setting
 *   - "grok-4.5"    → Grok 4.5 via Cursor
 *
 * @param {string} model - Model name from ai_code_hashes
 * @param {object} modelPriceAliases - Config modelPriceAliases for pricing lookup
 * @returns {string|null} Pricing key or null
 */
function mapModelToPricingKey(model, modelPriceAliases) {
  const lower = String(model).toLowerCase();

  // Direct match in aliases
  if (modelPriceAliases[lower]) return modelPriceAliases[lower];

  // Known Cursor model mappings
  const CURSOR_MODEL_MAP = {
    'default': null,  // Dynamic — depends on user's current Cursor model setting
    // grok-4.5 handled by modelPriceAliases fallback below (it IS in pricing)
  };

  // Check if the model key exists directly
  if (CURSOR_MODEL_MAP[lower] !== undefined) return CURSOR_MODEL_MAP[lower];

  // Try to find a partial match in aliases (e.g., "grok" → "grok-4-5")
  for (const [aliasKey, aliasValue] of Object.entries(modelPriceAliases)) {
    const aliasLower = aliasKey.toLowerCase();
    if (lower.includes(aliasLower) || aliasLower.includes(lower)) {
      return aliasValue;
    }
  }

  return null;
}

/**
 * Estimate per-edit token counts based on typical Cursor agent interactions.
 * Since Cursor doesn't expose per-edit token counts in its tracking DB, we
 * use conservative estimates for cost attribution:
 *   - 400 input tokens (prompt context for a code edit)
 *   - 150 output tokens (typical code suggestion)
 *
 * These are rough averages and should NOT be treated as exact billing data.
 *
 * @returns {{ inputTokens: number, outputTokens: number }}
 */
function estimateEditTokens() {
  return { inputTokens: 400, outputTokens: 150 };
}

/**
 * Compute an estimated cost for one edit using the configured pricing.
 *
 * @param {string} model - Model name
 * @param {object} modelPriceAliases - Config modelPriceAliases
 * @param {object} pricingModels - Config pricing data (from data/pricing.json)
 * @returns {number} Estimated cost in USD, or 0 if pricing unavailable
 */
function estimateEditCost(model, modelPriceAliases, pricingModels) {
  const pricingKey = mapModelToPricingKey(model, modelPriceAliases);
  if (!pricingKey) return 0;

  const priceData = pricingModels[pricingKey];
  if (!priceData) return 0;

  const p = priceData.openrouter || priceData.opencode;
  if (!p) return 0;

  const { inputTokens, outputTokens } = estimateEditTokens();
  const inp = (inputTokens || 0) * (p.input || 0) / 1_000_000;
  const out = (outputTokens || 0) * (p.output || 0) / 1_000_000;
  return inp + out;
}

/**
 * Scan Cursor's AI tracking database and return provider-level usage records.
 *
 * @param {string} [since] - ISO date (YYYY-MM-DD or YYYYMMDD), inclusive
 * @param {object} [opts]
 * @param {object} [opts.modelPriceAliases] - Config modelPriceAliases for cost estimation
 * @param {object} [opts.pricingModels] - Pricing data for cost estimation
 * @param {object} [opts.providerPathMap] - Config providerPathMap to resolve the cursor pathId
 * @param {string} [opts.dbPath] - Override SQLite DB path
 * @returns {{ providerRecords: Array, totalEdits: number, modelSummary: object, dbPath: string, since: string|null }}
 */
function scanCursorUsage(since, opts = {}) {
  const dbPath = opts.dbPath || CURSOR_DB_PATH;
  const modelPriceAliases = opts.modelPriceAliases || {};
  const pricingModels = opts.pricingModels || {};
  const providerPathMap = opts.providerPathMap || {};
  const cursorPathId = providerPathMap.cursor || 'openrouter';

  if (!fs.existsSync(dbPath)) {
    return {
      providerRecords: [],
      totalEdits: 0,
      modelSummary: {},
      dbPath,
      since: since || null,
      note: 'Cursor AI tracking database not found',
    };
  }

  const rows = queryDb(dbPath, since);
  if (!rows.length) {
    return {
      providerRecords: [],
      totalEdits: 0,
      modelSummary: {},
      dbPath,
      since: since || null,
    };
  }

  // Build provider records matching the pi-session-scanner format
  const providerRecords = [];
  const modelSummary = {};

  for (const row of rows) {
    const { date, source, model, edits, conversations, firstTs, lastTs } = row;

    // Track summary
    if (!modelSummary[model]) {
      modelSummary[model] = { edits: 0, conversations: 0, days: new Set() };
    }
    modelSummary[model].edits += edits;
    modelSummary[model].conversations += conversations;
    modelSummary[model].days.add(date);

    // Estimate cost using pricing if available
    // Since Cursor's ai_code_hashes doesn't have real token counts, we
    // estimate conservatively. Setting costEstimate in _meta so the
    // pipeline understands these are not real billing data.
    const editCost = estimateEditCost(model, modelPriceAliases, pricingModels);
    const estimatedCost = Math.round(edits * editCost * 100) / 100;

    const { inputTokens, outputTokens } = estimateEditTokens();
    const totalInput = inputTokens * edits;
    const totalOutput = outputTokens * edits;

    providerRecords.push({
      date,
      model,
      provider: 'cursor',
      normalizedProvider: 'cursor',
      pathId: cursorPathId,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      tokens: totalInput + totalOutput,
      cost: estimatedCost,
      // Metadata (not in standard providerRecord schema but preserved)
      _source: source,
      _edits: edits,
      _conversations: conversations,
      _estimatedCost: true,
    });
  }

  // Sort by date ascending
  providerRecords.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  // Convert days Set to count
  for (const ms of Object.values(modelSummary)) {
    ms.days = ms.days.size;
  }

  const totalEdits = providerRecords.reduce((s, r) => s + r._edits, 0);

  return {
    providerRecords,
    totalEdits,
    modelSummary,
    dbPath,
    since: since || null,
  };
}

module.exports = { scanCursorUsage, estimateEditTokens, mapModelToPricingKey, CURSOR_DB_PATH };
