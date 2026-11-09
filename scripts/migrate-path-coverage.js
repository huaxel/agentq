#!/usr/bin/env node
'use strict';

/**
 * One-shot migration: move model coverage out of the registry and onto the
 * paths that offer it.
 *
 * The registry (`<home>/data/benchmark-inputs.json`) used to carry one column
 * per subscription (`onLocal`, `onGo`, `onCodex`, `onClaudeMax`,
 * `onOpenRouter`, …), set to 1 when that subscription served the model, and
 * `config.paths[].availKey` named the column scoring read. That mixed public
 * facts about a model with the user's setup, and every new subscription meant a
 * new column on every row.
 *
 * This script converts a legacy home in place:
 *
 *   - each path that has an `availKey` gets `models`: the model keys whose
 *     column is 1, normalized with modelKey() (src/lib/model-key.js);
 *   - a column that is 1 for every registry row becomes `["*"]` (every model in
 *     the registry — the metered pay-per-token case);
 *   - `availKey` is removed from the config and every `on*` column from the
 *     registry.
 *
 * Usage:
 *   node scripts/migrate-path-coverage.js --home <dir>            # dry run
 *   node scripts/migrate-path-coverage.js --home <dir> --write    # apply
 *
 * Both files are written as 2-space JSON with a final newline and their key
 * order preserved. Running it twice changes nothing the second time: with no
 * `availKey` left there is nothing to convert and no `on*` column to drop.
 */

const fs = require('node:fs');
const path = require('node:path');
const { modelKey } = require('../src/lib/model-key.js');

/** The legacy per-subscription registry columns (`onLocal`, `onClaudeMax`, …). */
const ON_COLUMN = /^on[A-Z]/;

/** `--flag value` from argv, or null. */
function flagValue(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

/**
 * The migrated documents plus a summary of what changed.
 *
 * @param {{ registry: any, config: any }} input parsed files
 * @returns {{ registry: any, config: any, columns: string[], paths: Array<{ id: string, availKey: string, models: string[], wildcard: boolean, replaced: boolean }>, unchanged: string[] }}
 */
function migrate({ registry, config }) {
  if (!registry || !Array.isArray(registry.models)) {
    throw new Error('registry: expected { "models": [...] }');
  }
  if (!config || !Array.isArray(config.paths)) {
    throw new Error('config: expected { "paths": [...] }');
  }
  const rows = registry.models;

  // Every legacy column the registry still carries. `on*` is the documented
  // shape; a row that still has one is simply ignored by every reader now.
  const columns = [];
  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      if (ON_COLUMN.test(key) && !columns.includes(key)) columns.push(key);
    }
  }

  const paths = [];
  const unchanged = [];
  const migratedPaths = config.paths.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.availKey !== 'string') {
      if (entry && typeof entry === 'object' && entry.id) unchanged.push(entry.id);
      return entry;
    }
    const availKey = entry.availKey;
    // A column is 1 per row; a row without the column (or with null) does not
    // offer the model. All-ones means "this path serves whatever the registry
    // lists", which is the one wildcard.
    const keys = [];
    let all = rows.length > 0;
    for (const row of rows) {
      if (row?.[availKey] !== 1) { all = false; continue; }
      const key = modelKey(row.model);
      if (key && !keys.includes(key)) keys.push(key);
    }
    const wildcard = all;
    const models = wildcard ? ['*'] : keys;
    const replaced = Array.isArray(entry.models);
    paths.push({ id: entry.id, availKey, models, wildcard, replaced });

    // Replace availKey in place so the path's key order is preserved, and a
    // path that already declared `models` is rewritten from the column (the
    // legacy column is the truth being migrated).
    const out = {};
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'availKey') out.models = models;
      else if (key !== 'models') out[key] = value;
    }
    return out;
  });

  const migratedRegistry = {
    ...registry,
    models: rows.map((row) => {
      const out = {};
      for (const [key, value] of Object.entries(row || {})) {
        if (ON_COLUMN.test(key)) continue;
        out[key] = value;
      }
      return out;
    }),
  };

  return {
    registry: migratedRegistry,
    config: { ...config, paths: migratedPaths },
    columns,
    paths,
    unchanged,
  };
}

/** The dry-run summary: one line per migrated path, plus what would be dropped. */
function renderSummary({ columns, paths, unchanged, modelCount }) {
  const lines = [];
  lines.push(`registry: ${modelCount} models`);
  lines.push(`  drop columns: ${columns.length ? columns.join(', ') : '(none)'}`);
  lines.push('paths:');
  for (const entry of paths) {
    const coverage = entry.wildcard ? `* (all ${modelCount} models)` : `${entry.models.length} model(s)`;
    const replaced = entry.replaced ? ', replaces existing models' : '';
    lines.push(`  ${entry.id}: ${entry.availKey} → ${coverage}${replaced}`);
  }
  if (unchanged.length) lines.push(`  no availKey (unchanged): ${unchanged.join(', ')}`);
  return lines.join('\n');
}

function writeJson(file, doc) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function main(argv = process.argv.slice(2)) {
  const home = flagValue(argv, '--home');
  const write = argv.includes('--write');
  if (!home) {
    process.stderr.write('usage: node scripts/migrate-path-coverage.js --home <dir> [--write]\n');
    return 2;
  }
  const registryPath = path.join(home, 'data', 'benchmark-inputs.json');
  const configPath = path.join(home, 'config', 'roi.config.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const result = migrate({ registry, config });
  process.stdout.write(`${renderSummary({ ...result, modelCount: registry.models.length })}\n`);
  if (!result.paths.length && !result.columns.length) {
    process.stdout.write('nothing to migrate\n');
    return 0;
  }
  if (!write) {
    process.stdout.write(`dry run: pass --write to update ${registryPath} and ${configPath}\n`);
    return 0;
  }
  writeJson(registryPath, result.registry);
  writeJson(configPath, result.config);
  process.stdout.write(`wrote ${registryPath}\nwrote ${configPath}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`migrate-path-coverage: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { migrate, renderSummary, ON_COLUMN };
