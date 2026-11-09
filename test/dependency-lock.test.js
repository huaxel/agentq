'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

test('declared production dependencies are recorded in the root lock and package graph', () => {
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  for (const name of Object.keys(manifest.dependencies)) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `Missing locked production dependency: ${name}`);
    assert.equal(typeof entry.version, 'string');
    assert.notEqual(entry.dev, true, `Production dependency marked dev-only: ${name}`);
  }
});

test('Tokscale wrapper and optional native platform packages use their exact locked versions', () => {
  const wrapper = lock.packages['node_modules/tokscale'];
  const cli = lock.packages['node_modules/@tokscale/cli'];
  assert.ok(wrapper && cli);
  assert.equal(wrapper.dependencies['@tokscale/cli'], cli.version);
  for (const [name, version] of Object.entries(cli.optionalDependencies)) {
    const platform = lock.packages[`node_modules/${name}`];
    assert.ok(platform, `Missing optional Tokscale platform: ${name}`);
    assert.equal(platform.version, version);
    assert.equal(platform.optional, true);
    assert.ok(platform.integrity, `Missing integrity for Tokscale platform: ${name}`);
  }
});
