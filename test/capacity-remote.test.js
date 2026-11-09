'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Script } = require('node:vm');
const { selectMachines, readMachineCatalog, portableObserver, collectRemote } = require('../src/lib/capacity-remote.js');
const { mergeObservations } = require('../src/lib/capacity-observations.js');
const profile = { id: 'abc123', label: 'wsl', target: 'devbox', enabled: true };
const inventory = { schemaVersion: 1, paths: [{ id: 'pi', machine: 'local', subscription: 'codex', accountRef: null, harness: 'pi', provider: 'openai-codex', catalog: 'pi', quotaPath: 'codex', constraints: [] }] };

test('selection uses unique saved enabled machine IDs/labels and deduplicates', () => {
  assert.equal(selectMachines([profile], ['wsl', 'abc123']).length, 1);
  assert.throws(() => selectMachines([profile, { ...profile, id: 'other' }], ['wsl']), /ambiguous/);
  assert.throws(() => selectMachines([{ ...profile, enabled: false }], ['wsl']), /enabled/);
  assert.throws(() => selectMachines([{ ...profile, target: '-oProxyCommand=bad' }], ['wsl']), /valid saved/);
  assert.throws(() => selectMachines([{ ...profile, target: 'host;bad' }], ['wsl']), /valid saved/);
});

test('catalog discovery is fixed bounded and exposes no CLI diagnostics', () => {
  const catalog = readMachineCatalog({ run: (command, args, options) => {
    assert.equal(command, 'herdr');
    assert.deepEqual(args, ['machine', 'list', '--json']);
    assert.equal(options.timeout, 5000);
    return { status: 0, stdout: JSON.stringify([profile]) };
  } });
  assert.equal(catalog[0].id, profile.id);
  assert.throws(() => readMachineCatalog({ run: () => ({ status: 1, stderr: 'private-sentinel' }) }), error => !error.message.includes('private-sentinel'));
});

test('portable source compiles and JSON metadata cannot escape into code', () => {
  const data = JSON.parse(JSON.stringify(inventory));
  data.paths[0].constraints = ['"}); throw new Error("INJECTED"); //'];
  assert.doesNotThrow(() => new Script(portableObserver(data, 'herdr-abc123', true)));
});

test('portable observer runs without remote installation and does not forward raw quota', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-portable-'));
  try {
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data/quota.json'), JSON.stringify({ paths: { codex: { updatedAt: new Date().toISOString(), windows: [{ usedPercent: 12.345, secret: 'private-sentinel' }] } } }));
    const before = fs.readdirSync(dir);
    const output = execFileSync(process.execPath, ['-'], { input: portableObserver(inventory, 'herdr-abc123', true), encoding: 'utf8', env: { ...process.env, AGENTQ_ROOT: dir, PATH: '' } });
    const report = JSON.parse(output);
    assert.equal(report.observedMachine, 'herdr-abc123');
    assert.equal(report.paths[0].accessReason, 'executable-not-found');
    assert.ok(!output.includes('12.345'));
    assert.ok(!output.includes('private-sentinel'));
    assert.equal(mergeObservations([report]).paths.length, 1);
    assert.deepEqual(fs.readdirSync(dir), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SSH command uses saved target, strict host keys, batch mode and fixed node stdin', () => {
  const result = collectRemote(profile, inventory, { run: (command, args, options) => {
    assert.equal(command, 'ssh');
    assert.ok(args.includes('StrictHostKeyChecking=yes'));
    assert.ok(args.includes('BatchMode=yes'));
    assert.deepEqual(args.slice(-2), ['devbox', 'node -']);
    assert.equal(options.timeout, 100000);
    assert.ok(options.input.includes('collectCapacity'));
    return { status: 0, stdout: JSON.stringify({ observedMachine: 'herdr-abc123' }) };
  } });
  assert.equal(result.collection.status, 'observed');
});

test('timeouts, malformed output and mismatched remote identity stay unknown and private', () => {
  for (const output of [{ status: 1, stderr: 'private-sentinel' }, { status: 0, stdout: 'private-sentinel' }, { status: 0, stdout: '{"observedMachine":"other"}' }]) {
    const result = collectRemote(profile, inventory, { run: () => output });
    assert.equal(result.collection.status, 'unknown');
    assert.equal(result.report, null);
    assert.ok(!JSON.stringify(result).includes('private-sentinel'));
  }
  const result = collectRemote(profile, inventory, { run: () => { throw new Error('private-sentinel'); } });
  assert.equal(result.collection.status, 'unknown');
  assert.ok(!JSON.stringify(result).includes('private-sentinel'));
});

test('unsafe target is rejected before SSH runs', () => {
  assert.throws(() => collectRemote({ ...profile, target: '-unsafe' }, inventory, { run: () => { throw new Error('should not run'); } }), /Invalid saved/);
});

test('offline and merge modes cannot trigger remote connections', () => {
  const cli = path.join(__dirname, '../bin/capacity.js');
  assert.throws(() => execFileSync(process.execPath, [cli, '--offline', '--collect', 'wsl'], { encoding: 'utf8', env: { ...process.env, PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] }), error => error.stderr.includes('cannot be combined'));
  assert.throws(() => execFileSync(process.execPath, [cli, '--collect', 'wsl'], { encoding: 'utf8', env: { ...process.env, HERDR_ENV: '', PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] }), error => error.stderr.includes('inside Herdr'));
});
