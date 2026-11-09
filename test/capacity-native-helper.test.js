'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

function fixture(version = '1.3.1') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-native-fixture-'));
  const bin = path.join(dir, 'bin');
  const lib = path.join(dir, 'src', 'lib');
  const agent = path.join(dir, 'agent');
  const pkg = path.join(agent, 'npm', 'node_modules', '@juanbenjumea', 'pi-agy');
  for (const folder of [bin, lib, path.join(pkg, 'extensions', 'lib')]) fs.mkdirSync(folder, { recursive: true });
  for (const name of ['capacity-native.js', 'capacity-live.js']) fs.copyFileSync(path.join(__dirname, '../bin', name), path.join(bin, name));
  for (const name of ['capacity-native-quota.js', 'capacity-live-quota.js', 'capacity-view.js', 'native-observations.js']) fs.copyFileSync(path.join(__dirname, '../src/lib', name), path.join(lib, name));
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ type: 'module' }));
  const parser = path.join(pkg, 'extensions', 'lib', 'usage.ts');
  const fixtureSource = 'export function parseAgyUsage(text: string) { return JSON.parse(text); }';
  fs.writeFileSync(parser, fixtureSource);
  // Only this copied helper trusts the credential-free parser fixture. There
  // is no production flag/environment bypass for the reviewed-source pin.
  const nativeHelper = path.join(bin, 'capacity-native.js');
  const copiedSource = fs.readFileSync(nativeHelper, 'utf8');
  const hash = createHash('sha256').update(fixtureSource).digest('hex');
  const pinned = copiedSource.replace(/const REVIEWED_PARSER_SHA256 = '[a-f0-9]{64}';/, `const REVIEWED_PARSER_SHA256 = '${hash}';`);
  assert.notEqual(pinned, copiedSource);
  fs.writeFileSync(nativeHelper, pinned);
  const trace = path.join(dir, 'commands');
  const executable = path.join(bin, 'agy');
  fs.writeFileSync(executable, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args)+'\\n'); if(args[0]==='--version') process.stdout.write(${JSON.stringify(version)}); else if(args[0]==='models') process.stdout.write('gemini-1-flash\\tGemini'); else if(JSON.stringify(args)===JSON.stringify(['--output-format','json','-p','/usage'])) process.stdout.write(JSON.stringify({models:[{model:'Gemini Models',remaining_fraction:0.12345}],secret:'private-sentinel'})); else process.exit(1);\n`);
  fs.chmodSync(executable, 0o700);
  return { dir, bin, agent, trace, executable, parser };
}
function run(f) {
  return spawnSync(process.execPath, ['--experimental-strip-types', path.join(f.bin, 'capacity-native.js')], {
    env: { ...process.env, PI_CODING_AGENT_DIR: f.agent, PATH: f.bin + path.delimiter + process.env.PATH }, encoding: 'utf8', timeout: 5000,
  });
}

test('native helper imports only the parser and emits sanitized non-aggregate facts', () => {
  const f = fixture();
  try {
    const result = run(f);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    const quota = JSON.parse(result.stdout);
    assert.equal(quota.state, 'unknown');
    assert.equal(quota.pools[0].state, 'headroom-observed');
    assert.ok(!result.stdout.includes('private-sentinel'));
    assert.ok(!result.stdout.includes('0.12345'));
    assert.deepEqual(fs.readFileSync(f.trace, 'utf8').trim().split('\n').map(JSON.parse), [['--version'], ['models'], ['--output-format', 'json', '-p', '/usage']]);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('changed parser source is rejected before any module code or native command runs', () => {
  const f = fixture();
  try {
    fs.appendFileSync(f.parser, "; process.stdout.write('private-sentinel');");
    const result = run(f);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(f.trace), false);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('old CLI versions never receive a usage prompt', () => {
  const f = fixture('1.1.10');
  try {
    const result = run(f);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).state, 'unknown');
    assert.deepEqual(fs.readFileSync(f.trace, 'utf8').trim().split('\n').map(JSON.parse), [['--version']]);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('normal helper cancellation kills its owned native process group', async () => {
  if (process.platform === 'win32') return;
  const f = fixture();
  const pidFile = path.join(f.dir, 'native-pid');
  const kills = path.join(f.dir, 'kills');
  const preload = path.join(f.dir, 'trace-kills.cjs');
  let child;
  try {
    fs.writeFileSync(f.executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => process.exit(0), 30000);\n`);
    fs.writeFileSync(preload, `const fs = require('node:fs'); const original = process.kill.bind(process); process.kill = (pid, signal) => { fs.appendFileSync(${JSON.stringify(kills)}, JSON.stringify({pid,signal})+'\\n'); return original(pid,signal); };`);
    child = spawn(process.execPath, ['--experimental-strip-types', '--require', preload, path.join(f.bin, 'capacity-native.js')], {
      env: { ...process.env, PI_CODING_AGENT_DIR: f.agent, PATH: f.bin + path.delimiter + process.env.PATH }, stdio: 'ignore',
    });
    const closed = new Promise(resolve => child.once('close', resolve));
    // Startup under a loaded machine can take seconds: wait up to 15 s for the
    // native process, and keep it alive (30 s) until the helper cancels it.
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(pidFile));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    child.kill('SIGTERM');
    await closed;
    const records = fs.readFileSync(kills, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(records.some(record => record.pid === -pid && record.signal === 'SIGKILL'));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test('oversized native command output is rejected without echoing diagnostics', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.executable, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(2*1024*1024));\n`);
    const result = run(f);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).state, 'unknown');
    assert.ok(result.stdout.length < 1000);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
