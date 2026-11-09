/**
 * Antigravity brain session scanner — reads agy CLI / IDE / Core brain
 * transcript files to extract session-level usage data.
 *
 * Antigravity (agy) stores conversations as brain directories under:
 *   ~/.gemini/antigravity-cli/brain/   — CLI sessions
 *   ~/.gemini/antigravity-ide/brain/   — IDE sessions
 *   ~/.gemini/antigravity/brain/       — core sessions
 *
 * Each brain session contains a .system_generated/logs/transcript.jsonl
 * with step-by-step activity. While these transcripts don't record exact
 * token counts or model cost, we can extract:
 *   - Session date (from first step timestamp)
 *   - Number of MODEL-originated steps (proxy for cost)
 *   - Session duration
 *   - Model name from settings.json
 *
 * The output format matches the pi-session-scanner's providerUsageRecords
 * so it integrates into the ROI dashboard pipeline.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Proxy-captured usage log (from mitmproxy addon).
// Override with ANTIGRAVITY_USAGE_LOG env var; set to empty string to disable.
const DEFAULT_USAGE_LOG = path.join(os.homedir(), '.config', 'antigravity-usage', 'usage.jsonl');
const USAGE_LOG = process.env.ANTIGRAVITY_USAGE_LOG !== undefined
  ? process.env.ANTIGRAVITY_USAGE_LOG
  : DEFAULT_USAGE_LOG;

// Known antigravity data directories
const ANTIGRAVITY_BRAIN_DIRS = [
  path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
  path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain'),
  path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
];

// Settings file where the active model is stored
const ANTIGRAVITY_SETTINGS = [
  path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json'),
  path.join(os.homedir(), '.gemini', 'antigravity-ide', 'settings.json'),
];

/**
 * Model name mapping: antigravity settings display names → pricing keys.
 */
const MODEL_NAME_MAP = {
  'claude sonnet 4.6 (thinking)': 'claude-sonnet-4-6:thinking',
  'claude sonnet 4.6': 'claude-sonnet-4-6',
  'claude opus 4.6 (thinking)': 'claude-opus-4-6:thinking',
  'claude opus 4.6': 'claude-opus-4-6',
  'claude opus 4.5 (thinking)': 'claude-opus-4-5:thinking',
  'claude opus 4.5': 'claude-opus-4-5',
  'gemini 3 pro high': 'gemini-3-pro',
  'gemini 3 flash': 'gemini-3-flash',
  'gemini 2.5 pro': 'gemini-2-5-pro',
  'gemini 2.5 flash': 'gemini-2-5-flash',
  'gpt 5 6 sol': 'gpt-5-6-sol',
  'gpt 5 6 terra': 'gpt-5-6-terra',
  'gpt 5 5': 'gpt-5-5',
  'gpt-oss 120b medium': 'gpt-oss-120b',
};

/**
 * Read the active model from antigravity settings.
 * Falls back to a default if settings can't be read.
 */
function readSettingsModel() {
  for (const sp of ANTIGRAVITY_SETTINGS) {
    try {
      const raw = fs.readFileSync(sp, 'utf8');
      const settings = JSON.parse(raw);
      const displayName = (settings.model || '').toLowerCase();
      if (displayName) {
        return MODEL_NAME_MAP[displayName] || displayName;
      }
    } catch {
      // Try next settings file
    }
  }
  return null;
}

/**
 * Parse a brain transcript.jsonl file and extract session info.
 *
 * @param {string} filePath - Full path to transcript.jsonl
 * @returns {object|null} { date, modelSteps, totalSteps, firstTs, lastTs, modelCalls } or null
 */
function parseBrainTranscript(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());

    if (lines.length === 0) return null;

    let modelSteps = 0;
    let totalSteps = 0;
    let firstTs = null;
    let lastTs = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        totalSteps++;

        const ts = entry.created_at;
        if (ts) {
          if (!firstTs || ts < firstTs) firstTs = ts;
          if (!lastTs || ts > lastTs) lastTs = ts;
        }

        if (entry.source === 'MODEL') {
          modelSteps++;
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (!firstTs) return null;

    return {
      date: firstTs.slice(0, 10),
      modelSteps,
      totalSteps,
      firstTs,
      lastTs,
    };
  } catch {
    return null;
  }
}

/**
 * Read antigravity settings to determine which model(s) were in use.
 * Returns a map of { date: modelKey } for sessions where we know the
 * model based on when settings changed. Since antigravity settings
 * change only when the user switches models (infrequent), we default
 * to the current model and layer in any historical settings snapshots.
 */
function buildModelTimeline() {
  // For now, just return the current model from settings.
  // A future enhancement could track model changes over time
  // by inspecting session transcripts or settings backups.
  const model = readSettingsModel();
  return model || 'claude-sonnet-4-6';
}

/**
 * Walk a brain directory, parsing all transcript files.
 *
 * @param {string} brainDir - Path to a brain directory (e.g., ~/.gemini/.../brain/)
 * @param {string} source - Source label ('antigravity-cli', 'antigravity-ide', 'antigravity')
 * @param {string} since - ISO date (YYYY-MM-DD), inclusive
 * @returns {Array} Parsed provider usage records
 */
function walkBrainDir(brainDir, source, since) {
  const records = [];
  if (!fs.existsSync(brainDir)) return records;

  const sessions = fs.readdirSync(brainDir, { withFileTypes: true });
  for (const session of sessions) {
    if (!session.isDirectory()) continue;
    const transcriptPath = path.join(brainDir, session.name, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(transcriptPath)) {
      // Some sessions store transcripts without the .system_generated prefix
      const altPath = path.join(brainDir, session.name, 'transcript.jsonl');
      if (!fs.existsSync(altPath)) continue;
      // Fall through to use altPath — handled below
    }

    const resolvedPath = fs.existsSync(transcriptPath) ? transcriptPath
      : path.join(brainDir, session.name, 'transcript.jsonl');

    if (!fs.existsSync(resolvedPath)) continue;

    const info = parseBrainTranscript(resolvedPath);
    if (!info) continue;

    // Apply since filter
    if (since && info.date && info.date.replace(/-/g, '') < String(since).replace(/-/g, '')) continue;

    records.push({
      date: info.date,
      sessionId: session.name,
      modelSteps: info.modelSteps,
      totalSteps: info.totalSteps,
      firstTs: info.firstTs,
      lastTs: info.lastTs,
      source,
    });
  }

  return records;
}

/**
 * Scan antigravity brain sessions and return provider-level usage records.
 *
/**
 * Compute estimated cost from token counts using pricing models.
 * Mirrors pi-session-scanner's computeCostFromTokens logic.
 */
function computeCostFromTokens(model, inputTokens, outputTokens, cacheReadTokens, modelPriceAliases, pricingModels) {
  // Build a normalized alias lookup (lowercase, dots→dashes)
  const normAliases = {};
  for (const [k, v] of Object.entries(modelPriceAliases || {})) {
    normAliases[k.toLowerCase().replace(/\./g, '-')] = v;
  }
  // Try the model name directly, and stripped of any prefix
  const candidates = [
    model,
    model.replace(/^[^/]+\//, ''),
  ];
  for (const c of candidates) {
    const norm = c.toLowerCase().replace(/\./g, '-');
    const pricingKey = normAliases[norm] || norm;
    const priceData = pricingModels?.[pricingKey];
    if (!priceData) continue;
    const p = priceData.openrouter || priceData.opencode;
    if (!p) continue;
    const inp = (inputTokens || 0) * (p.input || 0) / 1_000_000;
    const out = (outputTokens || 0) * (p.output || 0) / 1_000_000;
    const cache = (cacheReadTokens || 0) * (p.cache || p.input || 0) / 1_000_000;
    return inp + out + cache;
  }
  return 0;
}

/**
 * Scan antigravity brain sessions and return provider-level usage records.
 *
 * @param {string} [since] - ISO date (YYYY-MM-DD), inclusive
 * @param {object} [opts]
 * @param {string[]} [opts.brainDirs] - Override brain directories to scan
 * @param {object} [opts.modelPriceAliases] - Model key → alias for pricing lookup
 * @param {object} [opts.pricingModels] - Pricing data { alias: { openrouter: { input, output, cache } } }
 * @returns {{ providerRecords: Array, sessions: Array, totalSessions: number, totalModelSteps: number, model: string|null }}
 */
function scanAntigravitySessions(since, opts = {}) {
  const brainDirs = opts.brainDirs || ANTIGRAVITY_BRAIN_DIRS;
  const { modelPriceAliases = {}, pricingModels = {} } = opts;
  const model = buildModelTimeline();
  const allSessions = [];

  for (const dir of brainDirs) {
    // Derive source label from directory path
    const parts = dir.split(path.sep);
    const geminiIdx = parts.indexOf('.gemini');
    let source = 'antigravity';
    if (geminiIdx !== -1 && geminiIdx + 1 < parts.length) {
      source = parts[geminiIdx + 1];
    }

    const sessions = walkBrainDir(dir, source, since);
    allSessions.push(...sessions);
  }

  // Sort by date
  allSessions.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  // Aggregate into per-date provider records matching the pi-session-scanner format
  const byDateModel = {};
  for (const s of allSessions) {
    const key = `${s.date}|${model}`;
    if (!byDateModel[key]) {
      byDateModel[key] = {
        date: s.date,
        model,
        provider: 'antigravity',
        normalizedProvider: 'antigravity',
        pathId: 'antigravity',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        tokens: 0,
        cost: 0,
        // Extra metadata not in pi format
        _sessionCount: 0,
        _modelSteps: 0,
        _totalSteps: 0,
      };
    }
    const r = byDateModel[key];
    r._sessionCount = (r._sessionCount || 0) + 1;
    r._modelSteps = (r._modelSteps || 0) + s.modelSteps;
    r._totalSteps = (r._totalSteps || 0) + s.totalSteps;
  }

  const providerRecords = Object.values(byDateModel).sort(
    (a, b) => String(a.date).localeCompare(String(b.date))
  ).map(r => {
    // Strip internal metadata before returning
    const { _sessionCount, _modelSteps, _totalSteps, ...clean } = r;
    return clean;
  });

  // Merge in proxy-captured usage log (real token counts if available)
  const usageLog = readUsageLog(since);
  const mergedRecords = providerRecords.map(r => {
    const logKey = `${r.date}|${r.model}`;
    const logEntry = usageLog[logKey];
    if (logEntry && logEntry.inputTokens + logEntry.outputTokens > 0) {
      return {
        ...r,
        inputTokens: logEntry.inputTokens,
        outputTokens: logEntry.outputTokens,
        tokens: logEntry.inputTokens + logEntry.outputTokens,
        _usageLogEntries: logEntry.count,
      };
    }
    return r;
  });

  // Also add any log dates that aren't covered by brain transcripts
  for (const [key, le] of Object.entries(usageLog)) {
    if (!mergedRecords.some(r => `${r.date}|${r.model}` === key)) {
      mergedRecords.push({
        date: le.date,
        model: le.model,
        provider: 'antigravity',
        normalizedProvider: 'antigravity',
        pathId: 'antigravity',
        inputTokens: le.inputTokens,
        outputTokens: le.outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        tokens: le.inputTokens + le.outputTokens,
        cost: 0,
        _usageLogEntries: le.count,
      });
    }
  }

  mergedRecords.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const finalRecords = mergedRecords.map(r => {
    const { _sessionCount, _modelSteps, _totalSteps, _usageLogEntries, ...clean } = r;
    // Estimate cost from token counts when cost is $0 and we have pricing data.
    // Brain sessions without proxy log have $0 cost and 0 tokens — they stay at $0.
    if ((clean.cost === 0 || clean.cost == null) && clean.tokens > 0) {
      clean.cost = Math.round(computeCostFromTokens(
        clean.model, clean.inputTokens, clean.outputTokens, clean.cacheReadTokens || 0,
        modelPriceAliases, pricingModels,
      ) * 100) / 100;
    }
    return clean;
  });

  return {
    providerRecords: finalRecords,
    sessions: allSessions,
    totalSessions: allSessions.length,
    totalModelSteps: allSessions.reduce((s, x) => s + x.modelSteps, 0),
    model,
    usageLogEntries: Object.values(usageLog).reduce((s, e) => s + e.count, 0),
  };
}

/**
 * Read the proxy-captured usage log and aggregate token counts per day+model.
 *
 * The usage log is produced by the mitmproxy addon when agy is run through
 * the `agy-with-usage` launcher. Each line is:
 *   {"timestamp": "...", "model": "claude-sonnet-4-6",
 *    "inputTokens": N, "outputTokens": N, "totalTokens": N, "responseId": "..."}
 *
 * @param {string} [since] - ISO date (YYYY-MM-DD), inclusive
 * @returns {object} Map of "date|model" -> { inputTokens, outputTokens, count }
 */
function readUsageLog(since) {
  const result = {};
  try {
    if (!USAGE_LOG || !fs.existsSync(USAGE_LOG)) return result;
    const content = fs.readFileSync(USAGE_LOG, 'utf8');
    for (const line of content.split('\n').filter(l => l.trim())) {
      try {
        const entry = JSON.parse(line);
        const date = (entry.timestamp || '').slice(0, 10);
        if (!date) continue;
        if (since && date.replace(/-/g, '') < String(since).replace(/-/g, '')) continue;
        const model = entry.model || 'unknown';
        const key = `${date}|${model}`;
        if (!result[key]) {
          result[key] = { date, model, inputTokens: 0, outputTokens: 0, count: 0 };
        }
        result[key].inputTokens += entry.inputTokens || 0;
        result[key].outputTokens += entry.outputTokens || 0;
        result[key].count++;
      } catch { /* skip malformed lines */ }
    }
  } catch { /* no log yet */ }
  return result;
}

module.exports = {
  scanAntigravitySessions,
  readUsageLog,
  parseBrainTranscript,
  walkBrainDir,
  readSettingsModel,
  MODEL_NAME_MAP,
  ANTIGRAVITY_BRAIN_DIRS,
  USAGE_LOG,
};
