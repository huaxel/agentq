'use strict';
/**
 * Tests for scripts/migrate-path-coverage.js: the one-shot move from registry
 * `on*` columns + `paths[].availKey` to `paths[].models`.
 *
 * The old shape is rebuilt here from the tracked fixture home, so the test does
 * not depend on a legacy file staying in the repository.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { migrate, ON_COLUMN } = require('../scripts/migrate-path-coverage.js');
const { modelKey } = require('../src/lib/model-key.js');

const ROOT = path.join(__dirname, '..');
const FIXTURE_HOME = path.join(ROOT, 'testdata', 'home');
const SCRIPT = path.join(ROOT, 'scripts', 'migrate-path-coverage.js');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * A temp home in the pre-migration shape: the fixture registry with `on*`
 * columns rebuilt from each path's current `models`, and `availKey` restored on
 * every path. Returns the paths of the two files.
 */
function legacyHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-migrate-'));
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  const registryPath = path.join(home, 'data', 'benchmark-inputs.json');
  const configPath = path.join(home, 'config', 'roi.config.json');

  const registry = readJson(path.join(FIXTURE_HOME, 'data', 'benchmark-inputs.json'));
  const config = readJson(path.join(FIXTURE_HOME, 'config', 'roi.config.json'));

  // availKey per path, in the order the old registry carried the columns. The
  // names are the historical ones (onClaudeMax, not onClaudemax).
  const LEGACY_COLUMNS = {
    local: 'onLocal', go: 'onGo', codex: 'onCodex',
    claudemax: 'onClaudeMax', openrouter: 'onOpenRouter',
  };
  const columns = config.paths.map((entry, index) => ({
    id: entry.id,
    availKey: LEGACY_COLUMNS[entry.id] || `on${entry.id[0].toUpperCase()}${entry.id.slice(1)}`,
    models: entry.models,
    index,
  }));
  registry.models = registry.models.map((row) => {
    const out = {};
    let inserted = false;
    for (const [key, value] of Object.entries(row)) {
      out[key] = value;
      // The exporter put the availability block after `speed`.
      if (key === 'speed') {
        for (const column of columns) {
          const covered = column.models.includes('*') || column.models.includes(modelKey(row.model));
          out[column.availKey] = covered ? 1 : null;
        }
        inserted = true;
      }
    }
    assert.ok(inserted, 'fixture row should carry a speed column');
    return out;
  });
  config.paths = config.paths.map((entry, index) => {
    const out = {};
    const column = columns[index];
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'models') out.availKey = column.availKey;
      else out[key] = value;
    }
    return out;
  });

  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { home, registryPath, configPath, columns };
}

function runScript(args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('the rebuilt legacy home carries on* columns and availKey', () => {
  const { registryPath, configPath } = legacyHome();
  const registry = readJson(registryPath);
  for (const row of registry.models) {
    assert.ok(Object.keys(row).some(key => ON_COLUMN.test(key)), `${row.model} should carry an on* column`);
  }
  assert.ok(readJson(configPath).paths.every(entry => typeof entry.availKey === 'string'));
});

test('migrate moves each column to models and drops availKey', () => {
  const { registryPath, configPath } = legacyHome();
  const result = migrate({ registry: readJson(registryPath), config: readJson(configPath) });

  assert.deepEqual(result.columns, ['onLocal', 'onGo', 'onCodex', 'onClaudeMax', 'onOpenRouter']);
  const byId = new Map(result.config.paths.map(entry => [entry.id, entry]));
  for (const entry of result.config.paths) assert.ok(!('availKey' in entry), `${entry.id}: availKey removed`);
  assert.deepEqual(byId.get('local').models, ['tiny-7b']);
  assert.deepEqual(byId.get('go').models, ['atlas-flash', 'atlas-mini', 'o-mini']);
  assert.deepEqual(byId.get('codex').models, ['atlas-flash', 'nimbus-coder']);
  assert.deepEqual(byId.get('claudemax').models, ['atlas-large']);
  // Keys are normalized: nimbus/nimbus-free folds to `nimbus` (modelKey strips
  // the -free variant suffix), which is what coverage matching compares.
  assert.deepEqual(byId.get('openrouter').models, ['atlas-large', 'atlas-flash', 'atlas-mini', 'o-pro', 'o-mini', 'nimbus']);
  for (const row of result.registry.models) {
    assert.ok(!Object.keys(row).some(key => ON_COLUMN.test(key)), `${row.model}: on* columns dropped`);
  }
});

test('a column that is 1 for every row becomes ["*"]', () => {
  const registry = { models: [{ model: 'a/one', onMetered: 1 }, { model: 'b/two', onMetered: 1 }] };
  const config = { paths: [{ id: 'metered', fee: 0, availKey: 'onMetered' }] };
  const result = migrate({ registry, config });

  assert.deepEqual(result.config.paths[0].models, ['*']);
  assert.equal(result.paths[0].wildcard, true);
  assert.deepEqual(result.registry.models, [{ model: 'a/one' }, { model: 'b/two' }]);
});

test('a column that is 1 for all but one row stays an explicit list', () => {
  const registry = { models: [{ model: 'a/one', onMetered: 1 }, { model: 'b/two', onMetered: null }] };
  const config = { paths: [{ id: 'metered', fee: 0, availKey: 'onMetered' }] };
  const result = migrate({ registry, config });

  assert.deepEqual(result.config.paths[0].models, ['one']);
  assert.equal(result.paths[0].wildcard, false);
});

test('a dry run prints the summary and writes nothing', () => {
  const { home, registryPath, configPath } = legacyHome();
  const before = [fs.readFileSync(registryPath, 'utf8'), fs.readFileSync(configPath, 'utf8')];

  const out = runScript(['--home', home]);

  assert.match(out, /drop columns: onLocal, onGo, onCodex, onClaudeMax, onOpenRouter/);
  assert.match(out, /go: onGo → 3 model\(s\)/);
  assert.match(out, /dry run: pass --write/);
  assert.deepEqual([fs.readFileSync(registryPath, 'utf8'), fs.readFileSync(configPath, 'utf8')], before);
});

test('--write applies the migration and reproduces the fixture home', () => {
  const { home, registryPath, configPath } = legacyHome();

  runScript(['--home', home, '--write']);

  // Round trip: the tracked fixture home is the migrated shape, so rebuilding
  // the old shape and migrating it must give the fixture content back, with
  // every key in its original position.
  const fixtureRegistry = readJson(path.join(FIXTURE_HOME, 'data', 'benchmark-inputs.json'));
  const fixtureConfig = readJson(path.join(FIXTURE_HOME, 'config', 'roi.config.json'));
  const registry = readJson(registryPath);
  const config = readJson(configPath);
  assert.deepEqual(registry, fixtureRegistry);
  assert.deepEqual(config, fixtureConfig);
  assert.deepEqual(
    registry.models.map(row => Object.keys(row)),
    fixtureRegistry.models.map(row => Object.keys(row)),
  );
  assert.deepEqual(
    config.paths.map(entry => Object.keys(entry)),
    fixtureConfig.paths.map(entry => Object.keys(entry)),
  );
  // 2-space JSON with a final newline.
  for (const raw of [fs.readFileSync(registryPath, 'utf8'), fs.readFileSync(configPath, 'utf8')]) {
    assert.ok(raw.endsWith('}\n'));
    assert.match(raw, /\n\s+"models": \[\n/);
  }
});

test('running the migration twice is a no-op', () => {
  const { home, registryPath, configPath } = legacyHome();
  runScript(['--home', home, '--write']);
  const once = [fs.readFileSync(registryPath, 'utf8'), fs.readFileSync(configPath, 'utf8')];

  const out = runScript(['--home', home, '--write']);

  assert.match(out, /nothing to migrate/);
  assert.deepEqual([fs.readFileSync(registryPath, 'utf8'), fs.readFileSync(configPath, 'utf8')], once);
});

test('a home with no --home flag is a usage error', () => {
  assert.throws(() => runScript([]), /status 2|--home/);
});
