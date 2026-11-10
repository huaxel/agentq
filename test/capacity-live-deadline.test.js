'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { ownStderr } = require('./helpers/stderr.js');
const helper = path.resolve(__dirname, '../bin/capacity-live.js');

function run(body) {
  return spawnSync(process.execPath, ['-e', `const { withHelperDeadline } = require(${JSON.stringify(helper)}); ${body}`], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('a stalled helper exits itself without relying on a parent timeout', () => {
  const result = run("withHelperDeadline(() => new Promise(() => {}), { timeoutMs: 30 });");
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(ownStderr(result.stderr), '');
});

test('the deadline remains active after the parent exits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-deadline-'));
  const marker = path.join(dir, 'exit-code');
  const started = path.join(dir, 'started');
  try {
    const child = `const fs = require('node:fs'); const { withHelperDeadline } = require(${JSON.stringify(helper)}); process.once('exit', code => fs.writeFileSync(${JSON.stringify(marker)}, String(code))); withHelperDeadline(() => new Promise(() => {}), { timeoutMs: 150 }); fs.writeFileSync(${JSON.stringify(started)}, 'started');`;
    const parent = spawnSync(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' }).unref();`], { timeout: 3000, encoding: 'utf8' });
    assert.equal(parent.error, undefined);
    assert.equal(parent.status, 0);
    // Bounded wait for our fixture only; no live providers or credentials.
    for (let attempt = 0; attempt < 100 && !fs.existsSync(marker); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(started));
    assert.equal(fs.readFileSync(marker, 'utf8'), '1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('completed helpers clear their deadline and exit successfully', () => {
  const result = run("withHelperDeadline(async () => 'ok', { timeoutMs: 30 }).then(value => process.stdout.write(value));");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ok');
  assert.equal(ownStderr(result.stderr), '');
});

test('CLI flushes summaries and closes retained handles on success and failure', () => {
  for (const failing of [false, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-live-cli-'));
    try {
      const bin = path.join(dir, 'bin');
      const lib = path.join(dir, 'src', 'lib');
      const pkg = path.join(dir, 'node_modules', '@juanbenjumea', 'pi-provider-usage-fetcher');
      for (const folder of [bin, lib, pkg]) fs.mkdirSync(folder, { recursive: true });
      fs.copyFileSync(helper, path.join(bin, 'capacity-live.js'));
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ type: 'module', exports: { './usage-api.ts': './mock.js', './openference.ts': './mock.js', './auth.ts': './mock.js' } }));
      fs.writeFileSync(path.join(pkg, 'mock.js'), 'export const fetchUsageApi = () => {}; export const fetchOpenferenceUsage = () => {};');
      fs.writeFileSync(path.join(lib, 'capacity-live-quota.js'), `module.exports = { observeLiveQuota: async () => { setInterval(() => {}, 1000); ${failing ? "throw new Error('private-sentinel');" : "return { go: { state: 'unknown' } };"} } };`);
      const result = spawnSync(process.execPath, [path.join(bin, 'capacity-live.js')], { encoding: 'utf8', timeout: 3000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, failing ? 1 : 0);
      assert.equal(result.stdout, failing ? '' : JSON.stringify({ go: { state: 'unknown' } }));
      assert.equal(ownStderr(result.stderr), '');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('failed helpers clear their deadline without exposing diagnostics', () => {
  const result = run("withHelperDeadline(async () => { throw new Error('private-sentinel'); }, { timeoutMs: 30 }).catch(() => { process.exitCode = 2; });");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(ownStderr(result.stderr), '');
});
