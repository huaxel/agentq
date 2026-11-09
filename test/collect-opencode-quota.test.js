'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const COLLECTOR = require.resolve('../bin/collect-opencode-quota.js');

// AUTH_PATH is resolved at load time, so each case loads the module in a
// fresh process with its own PI_CODING_AGENT_DIR.
function accountsFor(auth) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-auth-'));
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth));
  const out = execFileSync(process.execPath, ['-e', `
    const { loadAccounts } = require(${JSON.stringify(COLLECTOR)});
    process.stdout.write(JSON.stringify(loadAccounts().map(a => ({ label: a.label, hasKey: Boolean(a.key) }))));
  `], { env: { ...process.env, PI_CODING_AGENT_DIR: dir }, encoding: 'utf8' });
  return JSON.parse(out);
}

test('a single pi opencode-go key is used when there is no failover list', () => {
  assert.deepEqual(accountsFor({ 'opencode-go': { type: 'api_key', key: 'k-single' } }), [{ label: 'gosingle', hasKey: true }]);
});

test('a failover list wins over the single key', () => {
  const accounts = accountsFor({
    'opencode-go': { type: 'api_key', key: 'k-single' },
    'opencode-go-failover': { accounts: [{ key: 'k1', label: 'a' }, { key: 'k2', label: 'b' }] },
  });
  assert.deepEqual(accounts.map(a => a.label), ['a', 'b']);
});

test('no opencode key configured yields no accounts', () => {
  assert.deepEqual(accountsFor({ xai: { key: 'x' } }), []);
});
