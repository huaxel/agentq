#!/usr/bin/env node
/**
 * CSV export — canonical pipeline output to spreadsheet-friendly CSVs.
 *
 * WHY: ad-hoc analysis and spreadsheet pastes are easier with flat CSVs than
 * with the canonical `data/roi-output.json`. This exports the same honest,
 * aggregated numbers the dashboard already uses, without duplicating rates
 * or classification rules.
 *
 * OUTPUTS:
 *   - data/ccagg-by-model.csv      : canonical per-model usage + class + real $
 *   - data/ccagg-by-model-path.csv : observed per (model, provider, path/sub) usage
 *   - data/ccagg-daily.csv         : observed per (date, model) rows
 *
 * The by-model file uses the canonical pipeline total. The daily/path files are
 * source-evidence exports and can be lower when usage has no date/path record;
 * they never invent inferred rows to make totals appear reconciled.
 *
 * SOURCES:
 *   - data/roi-output.json            (by-model summary)
 *   - data/usage-imports/*.json       (daily rows from each machine)
 *   - optional raw ccusage JSON files on the command line
 *
 * USAGE:
 *   npm run export-csv
 *   npm run export-csv -- usage-host1.json usage-host2.json
 */

const fs = require('fs');
const path = require('path');
const { parseCcusageJson } = require('./ccusage-adapter.js');
const { modelKey } = require('../lib/model-key.js');
const { attributePath } = require('../lib/path-attribution.js');
const { agentqHome, homeDataPath, homeLoad, loadRoiConfig } = require('../lib/home.js');


// bestPath in roi-output.json is a display label (e.g. "ClaudeMax"), not the
// path id ("claudemax"). These are the labels emitted by score.js.
const SCORE_LABEL_TO_ID = {
  Local: 'local', Go: 'go', Codex: 'codex',
  ClaudeMax: 'claudemax', OpenRouter: 'openrouter',
};

function labelToId(config) {
  const map = { ...SCORE_LABEL_TO_ID };
  for (const p of config.paths) map[p.name] = p.id;
  for (const p of config.paths) {
    const short = p.id.charAt(0).toUpperCase() + p.id.slice(1);
    if (!map[short]) map[short] = p.id;
  }
  return map;
}

function pathType(config, pathId) {
  const p = config.paths.find(p => p.id === pathId);
  return p?.type ?? null;
}

function typeToClass(type) {
  if (type === 'Local') return 'local';
  if (type === 'Wallet') return 'sub';
  if (type === 'Metered') return 'metered';
  return 'unknown';
}

function tokensOf(r) {
  return (r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheWriteTokens || 0);
}

function pathName(config, pathId) {
  return config.paths.find(p => p.id === pathId)?.name || pathId || '';
}

function summarizeAttribution(config, records, fallbackModel, fallbackPath = '') {
  const totals = new Map();
  const sourceByPath = new Map();
  const rows = records && records.length ? records : [{ model: fallbackModel, agent: '', _tokens: 0 }];
  for (const r of rows) {
    let { pathId, source } = attributePath(config, r.model || fallbackModel, r.agent || '');
    if (!pathId && fallbackPath) { pathId = fallbackPath; source = 'best-path'; }
    const tok = r._tokens ?? tokensOf(r);
    totals.set(pathId, (totals.get(pathId) || 0) + tok);
    if (!sourceByPath.has(pathId)) sourceByPath.set(pathId, source);
  }
  const entries = [...totals.entries()].filter(([pathId]) => pathId).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { pathId: '', pathName: '', source: 'unknown', breakdown: '' };
  const breakdown = entries.map(([pathId, tok]) => `${pathId}:${tok}`).join(';');
  if (entries.length === 1) {
    const [pathId] = entries[0];
    return { pathId, pathName: pathName(config, pathId), source: sourceByPath.get(pathId) || '', breakdown };
  }
  return { pathId: 'mixed', pathName: 'Mixed', source: 'mixed', breakdown };
}

function classifyFromRecords(config, records, bestPath, labelMap) {
  if (records && records.length) {
    const types = new Set();
    for (const r of records) {
      const pid = config.agentPathMap[r.agent || ''];
      const t = pid && pathType(config, pid);
      if (t) types.add(t);
    }
    // Most expensive signal wins: metered > sub > local.
    if (types.has('Metered')) return 'metered';
    if (types.has('Wallet')) return 'sub';
    if (types.has('Local')) return 'local';
  }
  const pathId = labelMap[bestPath] || bestPath;
  return typeToClass(pathType(config, pathId));
}

function classFromAttribution(config, attr, fallbackClass = 'unknown') {
  const pathIds = attr.pathId === 'mixed'
    ? String(attr.breakdown || '').split(';').map(s => s.split(':')[0]).filter(Boolean)
    : [attr.pathId].filter(Boolean);
  const classes = new Set(pathIds.map(pid => typeToClass(pathType(config, pid))).filter(c => c !== 'unknown'));
  if (classes.size === 1) return [...classes][0];
  if (classes.size > 1) return 'mixed';
  return fallbackClass;
}

function csvLine(row) {
  return row.map(v => {
    if (v == null) return '';
    let s = String(v);
    // Neutralize formula-leading characters to prevent CSV injection.
    // Quoting alone does NOT stop this: Excel/Sheets evaluate a cell's
    // content as a formula once unquoted if it still starts with =/+/-/@,
    // regardless of the surrounding CSV quotes. The standard mitigation is
    // to prefix with a single quote so the leading character is no longer
    // one of the formula triggers.
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }).join(',');
}

function readDailySources(rawPaths, config, usageImportDir = null) {
  const records = []; // { key, model, agent, token fields } for classification/attribution
  const rows = [];    // raw records; rendered after path attribution is known
  const pathRows = []; // provider/path-aware rows for data/ccagg-by-model-path.csv
  const aliases = config.modelPriceAliases || {};
  function usageKey(model) {
    let key = modelKey(model);
    const seen = new Set();
    while (!seen.has(key)) {
      seen.add(key);
      const target = Object.entries(aliases).find(([alias]) => modelKey(alias) === key)?.[1];
      if (!target) break;
      key = modelKey(target);
    }
    return key;
  }

  function rowOf(r) {
    return { date: r.date, model: r.model, key: usageKey(r.model), agent: r.agent || '', inputTokens: r.inputTokens || 0, outputTokens: r.outputTokens || 0, cacheWriteTokens: r.cacheWriteTokens || 0, cacheReadTokens: r.cacheReadTokens || 0, cost: r.cost || 0 };
  }

  function addRecord(r) {
    const row = rowOf(r);
    records.push(row);
    return row;
  }

  function add(r) {
    const row = addRecord(r);
    rows.push(row);
    return row;
  }

  function addPathRow(r, host = '') {
    const key = usageKey(r.model);
    const attr = r.pathId ? { pathId: r.pathId, source: `provider:${r.provider || r.normalizedProvider || ''}` } : attributePath(config, r.model, r.agent || '');
    pathRows.push({
      host,
      date: r.date,
      model: r.model,
      key,
      agent: r.agent || '',
      provider: r.provider || '',
      pathId: attr.pathId,
      pathSource: attr.source,
      inputTokens: r.inputTokens || 0,
      outputTokens: r.outputTokens || 0,
      cacheWriteTokens: r.cacheWriteTokens || 0,
      cacheReadTokens: r.cacheReadTokens || 0,
      tokens: r.tokens || tokensOf(r),
      cost: r.cost || 0,
    });
  }

  if (rawPaths.length) {
    for (const p of rawPaths) {
      let json;
      try {
        json = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        throw new Error(`Could not read usage JSON at "${p}": ${e.message}`);
      }
      for (const r of parseCcusageJson(json)) addPathRow(add(r));
    }
  } else {
    const dir = usageImportDir || homeDataPath('usage-imports');
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { /* none */ }
    for (const f of files) {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const usageRecords = d.usageRecords || [];
      const providerRecords = d.providerUsageRecords || [];
      const usageCoverage = new Map();
      const providerCoverage = new Map();
      const addCoverage = (map, r) => {
        if (!r.date) return;
        const key = `${r.date}|${usageKey(r.model)}`;
        const current = map.get(key) || { tokens: 0, cost: 0 };
        current.tokens += (r.tokens || 0) || ((r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheWriteTokens || 0));
        current.cost += r.cost || 0;
        map.set(key, current);
      };
      for (const r of usageRecords) addCoverage(usageCoverage, r);
      for (const r of providerRecords) if ((r.cost || 0) > 0) addCoverage(providerCoverage, r);

      // Select one source per date/model. If provider records cover nearly all
      // tokens, they replace ccusage rows; if they cover only a subset, the
      // more complete ccusage rows win. This prevents both data loss and
      // additive double counting in pathRows.
      const authority = new Map();
      for (const [key, usage] of usageCoverage) {
        const provider = providerCoverage.get(key);
        authority.set(key, provider && provider.cost > 0 && !(usage.tokens > 0 && provider.tokens < usage.tokens * 0.95 && usage.cost > 0) ? 'provider' : 'usage');
      }
      for (const [key] of providerCoverage) if (!authority.has(key)) authority.set(key, 'provider');

      for (const r of usageRecords) {
        const row = rowOf(r);
        const key = `${row.date}|${row.key}`;
        if (authority.get(key) !== 'provider') {
          records.push(row);
          rows.push(row);
          addPathRow(row, d.hostname || f);
        }
      }

      // Date-less aggregate records cannot coexist with dated rows for the
      // same model in pathRows: that would export the aggregate plus its daily
      // components. Keep them only as a fallback when no dated source exists.
      const datedModels = new Set([...usageCoverage.keys(), ...providerCoverage.keys()].map(k => k.split('|').slice(1).join('|')));
      for (const r of providerRecords) {
        const key = `${r.date}|${usageKey(r.model)}`;
        const model = usageKey(r.model);
        if (!r.date) {
          if (datedModels.has(model)) continue;
          addRecord({ ...r, agent: 'pi' });
          addPathRow({ ...r, agent: 'pi' }, d.hostname || f);
          continue;
        }
        if (authority.get(key) !== 'provider') continue;
        const row = addRecord({ ...r, agent: 'pi' });
        rows.push(row);
        addPathRow({ ...r, agent: 'pi' }, d.hostname || f);
      }

    }
  }


  rows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.model).localeCompare(String(b.model)));
  pathRows.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.pathId).localeCompare(String(b.pathId)) || String(a.model).localeCompare(String(b.model)));
  return { records, rows, pathRows };
}

function main() {
  const config = loadRoiConfig();
  const out = homeLoad('data/roi-output.json');
  const rawPaths = process.argv.slice(2).filter(a => !a.startsWith('--'));

  const labelMap = labelToId(config);
  const { records, rows: dailyRows, pathRows } = readDailySources(rawPaths, config);
  const recordsByModel = new Map();
  for (const rec of records) {
    if (!recordsByModel.has(rec.key)) recordsByModel.set(rec.key, []);
    recordsByModel.get(rec.key).push(rec);
  }

  const byModelRows = [];
  for (const m of out.models) {
    const u = m.usage;
    if (!u) continue;
    const recs = recordsByModel.get(modelKey(m.model)) || [];
    const fallbackPath = labelMap[m.bestPath] || m.bestPath || '';
    const attr = summarizeAttribution(config, recs, m.model, fallbackPath);
    const cls = classFromAttribution(config, attr, classifyFromRecords(config, recs, m.bestPath, labelMap));
    byModelRows.push([
      m.model,
      attr.pathId,
      attr.pathName,
      attr.source,
      attr.breakdown,
      cls,
      u.inputTokens || 0,
      u.outputTokens || 0,
      u.cacheWriteTokens || 0,
      u.cacheReadTokens || 0,
      u.tokens || 0,
      (u.cost || 0).toFixed(2),
    ]);
  }
  byModelRows.sort((a, b) => b[10] - a[10]); // tokens desc

  const byModelCsvPath = homeDataPath('ccagg-by-model.csv');
  fs.writeFileSync(byModelCsvPath, [
    csvLine(['model', 'path_id', 'path_name', 'path_source', 'path_token_breakdown', 'class', 'input', 'output', 'cache_write', 'cache_read', 'tokens', 'cost_usd']),
    ...byModelRows.map(csvLine),
    '',
  ].join('\n'));

  const byModelPathRows = [];
  const byModelPathMap = new Map();
  for (const r of pathRows) {
    const k = `${r.key}\0${r.pathId || ''}\0${r.provider || ''}`;
    const m = (byModelPathMap.get(k) ?? { model_key: r.key, model: r.model, provider: r.provider || '', pathId: r.pathId || '', pathSource: r.pathSource || '', inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, tokens: 0, cost: 0 });
    m.inputTokens += r.inputTokens || 0;
    m.outputTokens += r.outputTokens || 0;
    m.cacheWriteTokens += r.cacheWriteTokens || 0;
    m.cacheReadTokens += r.cacheReadTokens || 0;
    m.tokens += r.tokens || tokensOf(r);
    m.cost += r.cost || 0;
    byModelPathMap.set(k, m);
  }
  for (const m of byModelPathMap.values()) {
    byModelPathRows.push([
      m.model_key,
      m.model,
      m.provider,
      m.pathId,
      pathName(config, m.pathId),
      m.pathSource,
      typeToClass(pathType(config, m.pathId)),
      m.inputTokens,
      m.outputTokens,
      m.cacheWriteTokens,
      m.cacheReadTokens,
      m.tokens,
      m.cost.toFixed(2),
    ]);
  }
  byModelPathRows.sort((a, b) => b[11] - a[11]);

  const byModelPathPath = homeDataPath('ccagg-by-model-path.csv');
  fs.writeFileSync(byModelPathPath, [
    csvLine(['model_key', 'model', 'provider', 'path_id', 'path_name', 'path_source', 'class', 'input', 'output', 'cache_write', 'cache_read', 'tokens', 'cost_usd']),
    ...byModelPathRows.map(csvLine),
    '',
  ].join('\n'));

  const dailyPath = homeDataPath('ccagg-daily.csv');
  fs.writeFileSync(dailyPath, [
    csvLine(['date', 'model', 'model_key', 'agent', 'path_id', 'path_name', 'path_source', 'input', 'output', 'cache_write', 'cache_read', 'cost_usd']),
    ...dailyRows.map(r => {
      const attr = attributePath(config, r.model, r.agent);
      return csvLine([r.date, r.model, r.key, r.agent, attr.pathId, pathName(config, attr.pathId), attr.source, r.inputTokens, r.outputTokens, r.cacheWriteTokens, r.cacheReadTokens, (r.cost || 0).toFixed(2)]);
    }),
    '',
  ].join('\n'));
  if (!dailyRows.length) {
    console.error('  (no daily rows: re-run `npm run collect` on each machine, or pass raw ccusage JSON files)');
  }

  console.error(`wrote ${path.relative(agentqHome(), byModelCsvPath)} (${byModelRows.length} models)`);
  console.error(`wrote ${path.relative(agentqHome(), byModelPathPath)} (${byModelPathRows.length} model/path rows)`);
  console.error(`wrote ${path.relative(agentqHome(), dailyPath)} (${dailyRows.length} daily rows)`);
}

if (require.main === module) main();
module.exports = { main, classifyFromRecords, typeToClass, attributePath, summarizeAttribution, csvLine, readDailySources };
