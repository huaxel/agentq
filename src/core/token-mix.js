'use strict';

/**
 * Observed token mix: the share of cache reads, cache writes, input and output
 * tokens a model actually spends, and the fallback chain a cost uses when the
 * data is thin.
 *
 * A blended list price is only as good as its weights. The ROI pipeline uses
 * ONE global `costBlend` for every model and harness, but real usage is mostly
 * cache reads, and the cache-read price is a fraction of the input price on
 * most subscriptions — so the weights decide the price far more than the list
 * does. `<home>/data/ccagg-by-model-path.csv` already records the per-model,
 * per-path totals, so the catalog reads the observed mix instead of guessing.
 *
 * Pure: no fs, no clock. `snapshot.js` reads the file and hands the rows here.
 *
 * Fallback chain for a (modelKey, path):
 *
 *   1. the rows for that modelKey on that path   → 'observed-path'
 *   2. the rows for that modelKey on any path    → 'observed-model'
 *   3. the global `costBlend` from config        → 'default'
 *
 * A level only counts when its total tokens reach MIN_MIX_TOKENS; below that
 * the shares are noise (one afternoon of work, or a single retry loop). There
 * is deliberately NO harness-level fallback: the CSV has no harness column, so
 * a per-harness mix cannot be observed and must not be invented.
 *
 * The default level reuses the configured weights UNCHANGED (they are not
 * normalized to 1), so an AA list price computed from the default mix is
 * exactly the number the ROI pipeline's `mtok` formula produces today.
 */

const { modelKey } = require('../lib/model-key.js');

/** Below this many tokens a level is too thin to describe a mix. */
const MIN_MIX_TOKENS = 1_000_000;

/** The mix fields, in reason order (cache-read/write/in/out). */
const MIX_FIELDS = ['cacheRead', 'cacheWrite', 'input', 'output'];

/**
 * @param {unknown} value
 * @returns {number}
 */
function tokens(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Parse CSV text into row objects keyed by the header names.
 *
 * Deliberately small: comma separated, optional double quotes around a field
 * (with `""` for an embedded quote), CRLF or LF line endings, and a BOM. That
 * is everything `export-csv.js` writes and everything a spreadsheet exports.
 * Unparseable text yields whatever rows could be read — never an error, because
 * the mix only refines a price.
 *
 * @param {string} text
 * @returns {Array<Record<string, string>>}
 */
function parseCsv(text) {
  if (typeof text !== 'string' || text === '') return [];
  /** @type {string[][]} */
  const records = [];
  /** @type {string[]} */
  let record = [];
  let field = '';
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || record.length) {
    record.push(field);
    records.push(record);
  }
  if (!records.length) return [];
  const header = records[0].map((name) => name.trim());
  const rows = [];
  for (const values of records.slice(1)) {
    if (values.length === 1 && values[0].trim() === '') continue;
    /** @type {Record<string, string>} */
    const row = {};
    header.forEach((name, index) => {
      if (name) row[name] = values[index] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

/**
 * @param {Record<string, any>} row a CSV-shaped row (snake_case) or camelCase
 * @param {string[]} names candidate column names, in precedence order
 * @returns {string}
 */
function column(row, names) {
  for (const name of names) {
    if (row && row[name] !== undefined && row[name] !== null) return String(row[name]);
  }
  return '';
}

/**
 * Token totals per (modelKey, path) and per modelKey.
 *
 * @param {Array<Record<string, any>>} [rows] rows shaped like ccagg-by-model-path.csv
 * @returns {{ byPath: Map<string, Record<string, number>>, byModel: Map<string, Record<string, number>> }}
 */
function mixIndex(rows = []) {
  /** @type {Map<string, Record<string, number>>} */
  const byPath = new Map();
  /** @type {Map<string, Record<string, number>>} */
  const byModel = new Map();
  const add = (map, key, totals) => {
    const current = map.get(key) ?? { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };
    for (const field of MIX_FIELDS) current[field] += totals[field];
    map.set(key, current);
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const key = modelKey(column(row, ['model_key', 'modelKey']));
    if (!key) continue;
    /** @type {Record<string, number>} */
    const totals = {
      cacheRead: tokens(column(row, ['cache_read', 'cacheRead'])),
      cacheWrite: tokens(column(row, ['cache_write', 'cacheWrite'])),
      input: tokens(column(row, ['input', 'inputTokens'])),
      output: tokens(column(row, ['output', 'outputTokens'])),
    };
    add(byModel, key, totals);
    const path = column(row, ['path_id', 'pathId']).trim();
    if (path) add(byPath, `${key}\u0000${path}`, totals);
  }
  return { byPath, byModel };
}

/**
 * Shares and total tokens for a totals record, or null when it holds nothing.
 *
 * @param {Record<string, number>|undefined} totals
 * @returns {{ mix: Record<string, number>, tokens: number }|null}
 */
function sharesOf(totals) {
  if (!totals) return null;
  const total = MIX_FIELDS.reduce((sum, field) => sum + tokens(totals[field]), 0);
  if (total <= 0) return null;
  /** @type {Record<string, number>} */
  const mix = {};
  for (const field of MIX_FIELDS) mix[field] = tokens(totals[field]) / total;
  return { mix, tokens: total };
}

/**
 * The global fallback mix: the configured `costBlend` weights, unchanged.
 *
 * `cache` is the cache-READ weight (it multiplies the registry's cache-hit
 * price) and cache writes are 0 unless the config sets `cacheWrite`, because
 * the ROI pipeline never priced them.
 *
 * @param {{ cache?: number, cacheWrite?: number, input?: number, output?: number }|null|undefined} costBlend
 * @returns {Record<string, number>|null} null when no usable weights exist
 */
function defaultMix(costBlend) {
  if (!costBlend || typeof costBlend !== 'object') return null;
  const cacheRead = typeof costBlend.cache === 'number' && Number.isFinite(costBlend.cache) ? costBlend.cache : null;
  const input = typeof costBlend.input === 'number' && Number.isFinite(costBlend.input) ? costBlend.input : null;
  const output = typeof costBlend.output === 'number' && Number.isFinite(costBlend.output) ? costBlend.output : null;
  if (cacheRead === null || input === null || output === null) return null;
  const cacheWrite = typeof costBlend.cacheWrite === 'number' && Number.isFinite(costBlend.cacheWrite)
    ? costBlend.cacheWrite
    : 0;
  return { cacheRead, cacheWrite, input, output };
}

/**
 * The mix a cost for (modelKey, path) uses, with the level it came from.
 *
 * @param {ReturnType<typeof mixIndex>|null} index
 * @param {{ modelKey: string|null|undefined, path: string|null|undefined, costBlend?: Record<string, any>|null }} input
 * @returns {{ mix: Record<string, number>|null, mixSource: 'observed-path'|'observed-model'|'default', mixTokens: number|null }}
 */
function mixFor(index, { modelKey: key, path, costBlend = null }) {
  const normalized = key ? modelKey(key) : '';
  const levels = [
    { totals: normalized && path ? index?.byPath?.get(`${normalized}\u0000${path}`) : undefined, source: 'observed-path' },
    { totals: normalized ? index?.byModel?.get(normalized) : undefined, source: 'observed-model' },
  ];
  for (const level of levels) {
    const shares = sharesOf(level.totals);
    if (shares && shares.tokens >= MIN_MIX_TOKENS) {
      return { mix: shares.mix, mixSource: /** @type {'observed-path'|'observed-model'} */ (level.source), mixTokens: shares.tokens };
    }
  }
  return { mix: defaultMix(costBlend), mixSource: 'default', mixTokens: null };
}

module.exports = { MIN_MIX_TOKENS, MIX_FIELDS, parseCsv, mixIndex, sharesOf, defaultMix, mixFor };
