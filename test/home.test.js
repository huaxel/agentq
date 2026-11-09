'use strict';
/**
 * Home directory: one source of runtime paths. These tests pin the override
 * order (AGENTQ_HOME, then XDG_CONFIG_HOME, then ~/.config), the merge rules
 * between the method defaults and the user's setup, and the bootstrap layout.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  agentqHome,
  deepMerge,
  exampleConfigFiles,
  homeConfigPath,
  homeDataPath,
  initHome,
  loadRoiConfig,
  roiDefaults,
} = require('../src/lib/home.js');

function tmpdir(prefix = 'agentq-home-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeHomeConfig(home, value) {
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  const file = path.join(home, 'config', 'roi.config.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

test('AGENTQ_HOME wins and is resolved to an absolute path', () => {
  const home = tmpdir();
  assert.equal(agentqHome({ env: { AGENTQ_HOME: home }, home: '/ignored' }), home);
  assert.equal(
    agentqHome({ env: { AGENTQ_HOME: 'relative/dir' }, home: '/ignored' }),
    path.resolve('relative/dir'),
  );
  // A blank override is not an override.
  assert.equal(
    agentqHome({ env: { AGENTQ_HOME: '   ' }, home: '/home/tester' }),
    path.join('/home/tester', '.config', 'agentq'),
  );
});

test('XDG_CONFIG_HOME is the fallback, then ~/.config', () => {
  assert.equal(
    agentqHome({ env: { XDG_CONFIG_HOME: '/xdg' }, home: '/home/tester' }),
    path.join('/xdg', 'agentq'),
  );
  assert.equal(
    agentqHome({ env: { XDG_CONFIG_HOME: '  ' }, home: '/home/tester' }),
    path.join('/home/tester', '.config', 'agentq'),
  );
  assert.equal(agentqHome({ env: {}, home: '/home/tester' }), path.join('/home/tester', '.config', 'agentq'));
});

test('config and data paths hang off the same home', () => {
  const home = tmpdir();
  assert.equal(homeConfigPath('runnables.json', { env: { AGENTQ_HOME: home } }), path.join(home, 'config', 'runnables.json'));
});

test('deepMerge merges objects recursively and replaces arrays and scalars', () => {
  const base = { a: { b: 1, c: 2 }, list: [1, 2, 3], keep: 'base', scalar: 1 };
  const merged = deepMerge(base, { a: { c: 9, d: 3 }, list: [7], scalar: 2 });
  assert.deepEqual(merged, { a: { b: 1, c: 9, d: 3 }, list: [7], keep: 'base', scalar: 2 });
  // The inputs are not mutated.
  assert.deepEqual(base, { a: { b: 1, c: 2 }, list: [1, 2, 3], keep: 'base', scalar: 1 });
});

test('the method defaults carry only method keys', () => {
  const defaults = roiDefaults();
  assert.deepEqual(
    Object.keys(defaults).sort(),
    ['costBlend', 'lambdaCostAversion', 'partitionMap', 'reconWeights', 'tierThresholds'],
  );
  assert.equal(defaults.costBlend.cache, 0.9174);
  assert.equal(defaults.partitionMap.coding.terminalBench, 0.667);
});

test('loadRoiConfig merges the setup over the defaults', () => {
  const home = tmpdir();
  writeHomeConfig(home, {
    paths: [{ id: 'codex', type: 'Wallet', fee: 20 }],
    profiles: { tax: { agents: 0.5 }, hobby: { coding: 0.5 } },
    // A method key the user overrides: objects merge, so the other weights stay.
    costBlend: { cache: 0.5 },
  });
  const config = loadRoiConfig({ home });
  assert.deepEqual(config.paths, [{ id: 'codex', type: 'Wallet', fee: 20 }]);
  assert.equal(config.profiles.tax.agents, 0.5);
  assert.equal(config.costBlend.cache, 0.5);
  assert.equal(config.costBlend.input, 0.0781, 'unmentioned default keys survive the merge');
  assert.equal(config.lambdaCostAversion, 0.3);
});

test('a missing user file returns the defaults alone', () => {
  const home = tmpdir();
  const config = loadRoiConfig({ home });
  assert.deepEqual(config, roiDefaults());
  assert.equal(config.paths, undefined);
});

test('invalid JSON in the user file names the path', () => {
  const home = tmpdir();
  const file = writeHomeConfig(home, '{ not json');
  assert.throws(() => loadRoiConfig({ home }), (err) => {
    assert.match(err.message, /invalid JSON in /);
    assert.ok(err.message.includes(file), `error should name ${file}: ${err.message}`);
    return true;
  });
});

test('initHome creates the layout and seeds the examples once', () => {
  const home = tmpdir();
  const first = initHome({ home });
  assert.equal(first.home, home);
  assert.ok(fs.statSync(path.join(home, 'config')).isDirectory());
  assert.ok(fs.statSync(path.join(home, 'data')).isDirectory());
  assert.deepEqual(first.created.sort(), exampleConfigFiles());
  assert.deepEqual(first.kept, []);
  for (const name of exampleConfigFiles()) {
    assert.ok(fs.existsSync(path.join(home, 'config', name)), `${name} should be seeded`);
  }

  // A second run never overwrites.
  const target = path.join(home, 'config', 'runnables.json');
  fs.writeFileSync(target, '{"schemaVersion":1,"runnables":[]}');
  const second = initHome({ home });
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.kept.sort(), exampleConfigFiles());
  assert.equal(fs.readFileSync(target, 'utf8'), '{"schemaVersion":1,"runnables":[]}');

  // --force overwrites.
  const forced = initHome({ home, force: true });
  assert.deepEqual(forced.created.sort(), exampleConfigFiles());
  assert.notEqual(fs.readFileSync(target, 'utf8'), '{"schemaVersion":1,"runnables":[]}');
});

test('the seeded example config validates against the method defaults', () => {
  const home = tmpdir();
  initHome({ home });
  const config = loadRoiConfig({ home });
  const { configProblems } = require('../src/lib/validate-config.js');
  assert.deepEqual(configProblems(config), []);
});

test('the examples never carry the real setup', () => {
  const files = exampleConfigFiles();
  assert.deepEqual(files, ['execution-paths.json', 'roi.config.json', 'runnables.json']);
  const setup = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'home', 'config', 'roi.config.json'), 'utf8'));
  // Fictional subscriptions only: no real fee/name from the user's setup.
  assert.ok(setup.paths.length >= 2 && setup.paths.length <= 3);
  for (const p of setup.paths) {
    assert.match(p.id, /^(claudemax|codex|openrouter)$/);
  }
  assert.equal(setup.paths.find((p) => p.id === 'claudemax').fee, 200);
});
