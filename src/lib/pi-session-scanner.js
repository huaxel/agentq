/**
 * Pi session scanner — reads pi's JSONL session files directly to extract
 * per-provider cost attribution.
 *
 * Problem: ccusage daily's modelBreakdowns drop the provider field. A
 * `[pi] deepseek-v4-flash` row could be from openrouter, opencode-go, or
 * cline-pass — but we can't tell which. Pi's own session files DO record the
 * provider on every assistant message, so we parse them directly.
 *
 * This module replaces the modelPathPatterns approach for pi agent attribution.
 * It scans ALL pi session stores (default ~/.pi/agent/sessions, any custom
 * PI_CODING_AGENT_DIR/sessions like a dotfiles checkout, and Oh My Pi's
 * ~/.omp/agent/sessions), extracts provider + model + cost from every
 * assistant message, and aggregates by (provider, model, date).
 *
 * Multi-store note: pi installs write to several stores; reading only the
 * PI_CODING_AGENT_DIR one silently undercounts attribution by an order of
 * magnitude (e.g. ~/.pi/agent held 888M qwen3.6/nan input tokens vs 5M in the
 * dotfiles store). defaultSessionDirs() returns the deduped union.
 *
 * Provider → path mapping uses config.providerPathMap, with an additional
 * alias map for pi-specific provider names (normalized: strip hyphens, lowercase).
 *
 * Usage:
 *   const { scanPiSessions, scanPiSessionsAsync } = require('./pi-session-scanner.js');
 *   const result = scanPiSessions(since, providerPathMap);
 *   // { perPath: { go: 4.89, umans: 33.12, ... },
 *   //   perProvider: { 'opencode-go': { total: 4.89, models: {...} } },
 *   //   perModel: { ... },
 *   //   errors: [] }
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PI_SESSION_DIR = (() => {
  // Respect PI_CODING_AGENT_DIR if set (dotfiles or custom install).
  const codingAgentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  return path.join(codingAgentDir, 'sessions');
})();

/**
 * All known pi session stores, deduped. The user's pi installs write to
 * MULTIPLE stores (default ~/.pi/agent, a custom PI_CODING_AGENT_DIR like the
 * dotfiles checkout, and Oh My Pi's ~/.omp/agent), and each holds real
 * sessions. Reading only one (previously just PI_CODING_AGENT_DIR/sessions)
 * silently undercounts pi provider attribution by orders of magnitude
 * (e.g. ~/.pi/agent held 888M qwen3.6/nan input tokens vs 5M in the dotfiles
 * store). Computed lazily so env changes are honored per call.
 */
function defaultSessionDirs() {
  const dirs = [];
  const add = d => { if (d && !dirs.includes(d)) dirs.push(d); };
  if (process.env.PI_CODING_AGENT_DIR) add(path.join(process.env.PI_CODING_AGENT_DIR, 'sessions'));
  add(path.join(os.homedir(), '.pi', 'agent', 'sessions'));
  add(path.join(os.homedir(), '.omp', 'agent', 'sessions'));
  return dirs;
}

// Providers from pi that need aliasing to match config.providerPathMap keys.
// Self-hosted providers are deliberately absent: they resolve through
// providerPathMap like any other provider, so `{ "<host>": "local" }` in the
// config is enough to route their sessions to the local path.
const PROVIDER_ALIASES = {
  'opencode-go': 'opencodego',
  'opencode': 'opencodego',
  'openai-codex': 'codex',
  'nan': 'nan',
};

/**
 * Normalize a pi provider name to match config.providerPathMap keys.
 */
function normalizeProvider(provider) {
  const lower = String(provider).toLowerCase();
  return PROVIDER_ALIASES[lower] || lower;
}

/**
 * Parse a pi session JSONL file and extract assistant message usage data.
 * Returns an array of { provider, model, date, cost, inputTokens, outputTokens,
 * cacheReadTokens, cacheWriteTokens, totalTokens } objects.
 */
function parseSessionFile(filePath) {
  const entries = [];
  const content = fs.readFileSync(filePath, 'utf8');
  // Current pi files begin with a session header carrying a stable UUID. Keep
  // the basename only as a fallback for older/minimal fixtures without one.
  let sessionId = filePath ? path.basename(filePath) : null;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry.type === 'session' && entry.id) {
        sessionId = entry.id;
        continue;
      }
      if (entry.type !== 'message') continue;
      const msg = entry.message;
      if (!msg || msg.role !== 'assistant') continue;

      const provider = msg.provider;
      const model = msg.model;
      const usage = msg.usage || {};
      const cost = (usage.cost || {}).total || 0;
      const inputTokens = usage.input || 0;
      const outputTokens = usage.output || 0;
      const cacheReadTokens = usage.cacheRead || 0;
      const cacheWriteTokens = usage.cacheWrite || 0;
      const totalTokens = usage.totalTokens || 0;

      // Date from the entry timestamp
      const date = entry.timestamp ? entry.timestamp.slice(0, 10) : null;
      if (!date || !provider || !model) continue;

      entries.push({
        // Intrinsic session UUID when present, basename for legacy files. Used
        // to dedup the same session across multiple stores, then stripped before
        // aggregation so it never leaks into providerRecords.
        sessionId,
        provider: normalizeProvider(provider),
        originalProvider: provider,
        model,
        date,
        cost: cost || 0,
        inputTokens: inputTokens || 0,
        outputTokens: outputTokens || 0,
        cacheReadTokens: cacheReadTokens || 0,
        cacheWriteTokens: cacheWriteTokens || 0,
        totalTokens: totalTokens || 0,
      });
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Walk a session directory recursively, parsing all .jsonl files.
 * Returns an array of all parsed usage entries across all sessions.
 */
function walkSessionDir(sessionDir, opts = {}) {
  const allEntries = [];
  if (!fs.existsSync(sessionDir)) return allEntries;

  const sinceTime = opts.sinceTime;
  // Bind-mounted copies of the OTHER known session stores (e.g. tokscale's
  // view gets the dotfiles store bind-mounted into ~/.pi/agent/sessions/from-*)
  // would double-count if recursed. realpath can't see bind mounts (they are
  // not symlinks), but a bind mount preserves the inode: skip any subdir whose
  // (st_dev, st_ino) matches a known top-level store.
  const skipIdentity = opts.skipIdentity;
  const items = fs.readdirSync(sessionDir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(sessionDir, item.name);
    if (item.isDirectory()) {
      if (skipIdentity && skipIdentity.size) {
        try {
          const st = fs.statSync(fullPath);
          if (skipIdentity.has(`${st.dev}:${st.ino}`)) continue;
        } catch { /* unreadable — skip */ }
      }
      // Directory mtimes are cheap but not reliable for pruning nested files, so
      // recurse and let file-level mtimes decide what needs parsing.
      const subEntries = walkSessionDir(fullPath, opts);
      allEntries.push(...subEntries);
    } else if (item.isFile() && item.name.endsWith('.jsonl')) {
      try {
        // Use a conservative mtime cutoff to avoid parsing gigabytes of stale
        // history; filterSince() still applies the exact inclusive date bound.
        if (sinceTime != null && fs.statSync(fullPath).mtimeMs < sinceTime) continue;
        const entries = parseSessionFile(fullPath);
        allEntries.push(...entries);
      } catch (e) {
        // Skip corrupt files
      }
    }
  }
  return allEntries;
}

/**
 * Filter entries to those on or after `since` date.
 */
function filterSince(entries, since) {
  if (!since) return entries;
  const s = String(since).replace(/-/g, '');
  return entries.filter(e => e.date && e.date.replace(/-/g, '') >= s);
}

/**
 * Aggregate parsed entries into per-path costs and per-model usage.
 * For zero-cost entries (e.g., Umans with agreement pricing), falls back
 * to computing cost from token counts × alias pricing if available.
 *
 * @param {Array} entries  Parsed assistant message entries
 * @param {object} providerPathMap  Config's providerPathMap { providerKey: pathId }
 * @param {object} [opts]
 * @param {object} [opts.modelPriceAliases]  { umans-glm-5-2: 'glm-5-2', ... } — model key → alias
 * @param {object} [opts.pricingModels]  { alias: { openrouter: { input, output, cache } } }
 * @returns {{ perPath: object, perProvider: object, perModel: object, errors: string[] }}
 */
function aggregate(entries, providerPathMap, opts = {}) {
  const perPath = {};
  const perProvider = {};
  const perModel = {};
  const perModelTokens = {};
  const providerRecordsByKey = {};
  const unmappedProviders = new Set();
  const { modelPriceAliases = {}, pricingModels = {} } = opts;

  // Build a model-to-alias lookup that also strips common prefixes (umans-, etc.)
  // so 'umans-glm-5.2' matches 'umans-glm-5-2' in the aliases.
  function lookupAlias(model) {
    // Build lowercase alias map once
    if (!lookupAlias.lowerCache) {
      lookupAlias.lowerCache = {};
      for (const [k, v] of Object.entries(modelPriceAliases)) {
        lookupAlias.lowerCache[k.toLowerCase()] = v;
      }
    }
    // Direct hit (case-insensitive)
    const lower = model.toLowerCase();
    if (lookupAlias.lowerCache[lower]) return lookupAlias.lowerCache[lower];
    // Try dot → dash normalization (umans-glm-5.2 → umans-glm-5-2)
    const dashed = lower.replace(/\./g, '-');
    if (lookupAlias.lowerCache[dashed]) return lookupAlias.lowerCache[dashed];
    return null;
  }

  /**
   * Compute cost from token counts using alias pricing, matching
   * the logic in collect-value-run.js computeModelCost().
   *
   * Tries three lookup strategies in order:
   *   1. modelPriceAliases (from config)
   *   2. direct key in pricingModels (e.g. "deepseek-v4-flash")
   *   3. stripped of any provider prefix (e.g. "nan/qwen3.6" → "qwen3.6")
   *      tried both with the alias map and as a direct key
   */
  // Lazy-built index of normalized (dots↔dashes, lowercase) pricing keys so
  // fuzzy lookup after a direct miss is O(1) instead of O(n) per model.
  let _pricingNormIndex = null;
  function buildPricingNormIndex() {
    _pricingNormIndex = {};
    for (const key of Object.keys(pricingModels)) {
      const norm = key.toLowerCase().replace(/\./g, '-');
      if (!(norm in _pricingNormIndex)) _pricingNormIndex[norm] = key;
    }
  }

  function computeCostFromTokens(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens) {
    // Attempt lookup with progressively cleaner model names
    const candidates = [
      model,
      model.replace(/^[^/]+\//, ''),   // "nan/qwen3.6" → "qwen3.6"
    ];

    for (const candidate of candidates) {
      // Try alias first, then direct pricing key
      const pricingKey = lookupAlias(candidate) || candidate;
      let priceData = pricingModels[pricingKey];

      // Fuzzy fallback: if the exact key missed, normalise dots↔dashes and
      // try again against a pre-built normalised index. This absorbs cases
      // where pricing.json keys use dashes ("kimi-k2-7-code") but pi session
      // model names use dots ("kimi-k2.7-code"), or vice versa.
      if (!priceData) {
        if (!_pricingNormIndex) buildPricingNormIndex();
        const normKey = pricingKey.toLowerCase().replace(/\./g, '-');
        const matchedKey = _pricingNormIndex[normKey];
        if (matchedKey) priceData = pricingModels[matchedKey];
      }

      if (!priceData) continue;

      const p = priceData.openrouter || priceData.opencode;
      if (!p) continue;

      const inp = (inputTokens || 0) * (p.input || 0) / 1_000_000;
      const out = (outputTokens || 0) * (p.output || 0) / 1_000_000;
      const cache = (cacheReadTokens || 0) * (p.cache || p.input || 0) / 1_000_000;
      const creation = (cacheWriteTokens || 0) * (p.input || 0) / 1_000_000;
      return inp + out + cache + creation;
    }
    return 0;
  }

  // Token total for one entry: pi does not always report totalTokens, so
  // fall back to the parts sum (the per-record and per-provider buckets must
  // agree — using raw totalTokens in one and the fallback in the other
  // silently undercounts whichever bucket skips the fallback).
  const entryTokens = e => e.totalTokens || (e.inputTokens || 0) + (e.outputTokens || 0) + (e.cacheReadTokens || 0) + (e.cacheWriteTokens || 0);

  for (const e of entries) {
    // Map provider to path ID
    const pathId = providerPathMap[e.provider];

    // Determine effective cost (default 0 — a missing cost must never
    // NaN-poison the per-path/per-provider sums below).
    let effectiveCost = e.cost || 0;

    // For zero-cost entries (e.g., Umans with agreement pricing), compute
    // cost from token counts using the alias-based pricing model.
    if (effectiveCost === 0 && pathId) {
      effectiveCost = computeCostFromTokens(
        e.model,
        e.inputTokens,
        e.outputTokens,
        e.cacheReadTokens,
        e.cacheWriteTokens,
      );
    }

    if (pathId) {
      perPath[pathId] = (perPath[pathId] || 0) + effectiveCost;
    } else if (effectiveCost > 0) {
      unmappedProviders.add(e.originalProvider);
    }

    const recordKey = `${e.date}|${e.model}|${e.originalProvider}|${e.provider}|${pathId || ''}`;
    const pr = (providerRecordsByKey[recordKey] ??= {
      date: e.date,
      model: e.model,
      provider: e.originalProvider,
      normalizedProvider: e.provider,
      pathId: pathId || '',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      tokens: 0,
      cost: 0,
    });
    pr.inputTokens += e.inputTokens || 0;
    pr.outputTokens += e.outputTokens || 0;
    pr.cacheReadTokens += e.cacheReadTokens || 0;
    pr.cacheWriteTokens += e.cacheWriteTokens || 0;
    pr.tokens += entryTokens(e);
    pr.cost += effectiveCost || 0;

    // Track per-model token counts for zero-cost models with aliases. Start
    // from a zeroed accumulator — spreading `e` here would copy this entry's
    // tokens and then the `+=` below would count them a second time.
    if (effectiveCost === 0 && lookupAlias(e.model)) {
      const key = `${e.date}|${e.model}|${e.originalProvider}`;
      if (!perModelTokens[key]) {
        perModelTokens[key] = {
          date: e.date, model: e.model, provider: e.originalProvider,
          cost: 0, inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0,
        };
      }
      const tm = perModelTokens[key];
      tm.inputTokens += e.inputTokens || 0;
      tm.outputTokens += e.outputTokens || 0;
      tm.cacheReadTokens += e.cacheReadTokens || 0;
      tm.cacheWriteTokens += e.cacheWriteTokens || 0;
      tm.totalTokens += entryTokens(e);
    }

    // Per-provider breakdown
    if (!perProvider[e.originalProvider]) {
      perProvider[e.originalProvider] = {
        total: 0,
        totalTokens: 0,
        models: {},
        paths: new Set(),
      };
    }
    const pp = perProvider[e.originalProvider];
    pp.total += effectiveCost;
    pp.totalTokens += entryTokens(e);
    if (pathId) pp.paths.add(pathId);
    pp.models[e.model] = (pp.models[e.model] || 0) + effectiveCost;

    // Per-model (by model key, not provider-qualified)
    perModel[e.model] = (perModel[e.model] || 0) + effectiveCost;
  }

  // Sum the raw per-path costs before rounding each bucket, so the grand total
  // doesn't accumulate per-bucket rounding error (perPath is rounded in place).
  const perPathTotalRaw = Object.values(perPath).reduce((s, v) => s + v, 0);
  // Round per-path costs
  for (const [k, v] of Object.entries(perPath)) {
    perPath[k] = Math.round(v * 100) / 100;
  }
  const providerRecords = Object.values(providerRecordsByKey).map(r => ({
    ...r,
    cost: Math.round(r.cost * 100) / 100,
  })).sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.provider).localeCompare(String(b.provider)) || String(a.model).localeCompare(String(b.model)));

  // Round per-provider costs
  for (const pp of Object.values(perProvider)) {
    pp.total = Math.round(pp.total * 100) / 100;
    for (const [mk, mv] of Object.entries(pp.models)) {
      pp.models[mk] = Math.round(mv * 100) / 100;
    }
    pp.paths = [...pp.paths];
  }

  const errors = [];
  if (unmappedProviders.size) {
    errors.push(`Unmapped providers (cost not attributed): ${[...unmappedProviders].join(', ')}`);
  }

  return { perPath, perProvider, perModel, errors, perModelTokens, providerRecords, perPathTotalRaw };
}

/**
 * Scan pi sessions since a given date and return per-path cost attribution.
 *
 * @param {string} [since]  ISO date (YYYY-MM-DD or YYYYMMDD), inclusive
 * @param {object} [providerPathMap]  { providerKey: pathId }
 * @param {object} [opts]
 * @param {string} [opts.sessionDir]  Override default session dir
 * @param {object} [opts.modelPriceAliases]  { modelName: alias } for zero-cost pricing
 * @param {object} [opts.pricingModels]  { alias: { openrouter: { input, output, cache } } }
 * @returns {{ perPath: object, perProvider: object, perModel: object, errors: string[],
 *             totalEntries: number, totalCost: number, since: string }}
 */
const PRUNE_SAFETY_WINDOW_MS = 24 * 60 * 60 * 1000;

function sincePruneStartMs(since) {
  if (!since) return null;
  const s = String(since).replace(/-/g, '');
  if (!/^\d{8}$/.test(s)) return null;
  return Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8))) - PRUNE_SAFETY_WINDOW_MS;
}

function scanPiSessions(since, providerPathMap = {}, opts = {}) {
  // opts.sessionDirs wins; else single-dir override; else all known stores.
  const dirs = opts.sessionDirs || (opts.sessionDir ? [opts.sessionDir] : defaultSessionDirs());
  // Inode identity (dev:ino) of every store being scanned — subdirs that are
  // bind mounts of one of these (e.g. tokscale's from-dotfiles) resolve to the
  // same inode and are skipped to avoid double counts. Also dedupes the same
  // dir listed twice.
  const skipIdentity = new Set();
  const uniqueDirs = [];
  const seenDirIdentity = new Set();
  for (const d of dirs) {
    if (!d) continue;
    try {
      const st = fs.statSync(d);
      const id = `${st.dev}:${st.ino}`;
      if (seenDirIdentity.has(id)) continue;  // same dir listed twice — scan once
      seenDirIdentity.add(id);
      skipIdentity.add(id);
      uniqueDirs.push(d);
    } catch {
      uniqueDirs.push(d);  // missing/unreadable — let walkSessionDir decide
    }
  }
  let allEntries = [];
  const scanned = [];
  // Dedup the same session id across stores (the SSoT store is listed first, so
  // its copy wins; a redundant/bind-mounted subset store's copy of an identical
  // session is dropped, avoiding ~2x double-count). Strips the sessionId tag so
  // it never reaches aggregation.
  const seenSession = new Set();
  for (const d of uniqueDirs) {
    const entries = walkSessionDir(d, { sinceTime: sincePruneStartMs(since), skipIdentity });
    if (entries.length) {
      // Always filter through the global set, including the first directory:
      // a store can itself contain copied files with the same intrinsic session
      // UUID. Entries without an intrinsic ID retain their legacy file-name ID.
      const kept = [];
      for (const e of entries) {
        const id = e.sessionId;
        if (id == null || !seenSession.has(id)) {
          if (id != null) seenSession.add(id);
          kept.push(e);
        }
      }
      if (kept.length) {
        // concat, NOT push(...entries) — spreading 200K+ entries blows the V8
        // apply-argument limit (RangeError: Maximum call stack size exceeded).
        allEntries = allEntries.concat(kept);
        scanned.push(d);
      }
    }
  }
  // Drop the transient sessionId tag before downstream aggregation.
  allEntries = allEntries.map(({ sessionId, ...rest }) => rest);
  const filtered = filterSince(allEntries, since);
  const { modelPriceAliases = {}, pricingModels = {} } = opts;
  const result = aggregate(filtered, providerPathMap, { modelPriceAliases, pricingModels });

  const totalCost = result.perPathTotalRaw;

  return {
    ...result,
    totalEntries: filtered.length,
    totalCost: Math.round(totalCost * 100) / 100,
    since: since || 'all',
    sessionDir: scanned.join(', ') || opts.sessionDir || '',
  };
}

/**
 * Async version with progress reporting.
 */
async function scanPiSessionsAsync(since, providerPathMap = {}, opts = {}) {
  // Same implementation as sync for now — JSONL parsing is I/O bound but
  // small enough that sync is fine. Can upgrade to streaming/async later.
  return scanPiSessions(since, providerPathMap, opts);
}

module.exports = {
  scanPiSessions,
  scanPiSessionsAsync,
  parseSessionFile,
  walkSessionDir,
  filterSince,
  aggregate,
  normalizeProvider,
  PROVIDER_ALIASES,
  PI_SESSION_DIR,
  defaultSessionDirs,
};
