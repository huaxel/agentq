'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { observeCodexDaemon, openDaemon, normalizeQuota, normalizeModels } = require('../src/lib/capacity-codex-daemon.js');
const { fetchNativeDaemon } = require('../src/lib/capacity-live-client.js');
const { main } = require('../bin/capacity.js');
const now = Date.parse('2026-10-06T12:00:00Z');
function fixture(overrides = {}) {
  const calls = []; let closed = false;
  const replies = {
    initialize: { userAgent: 'codex_cli_rs/0.156.0 (Linux)' },
    'account/read': { account: { type: 'chatgpt', email: 'private-sentinel', planType: 'pro' }, requiresOpenaiAuth: true, workspaceRouting: { chatgptAccountId: 'private-sentinel' } },
    'model/list': { data: [{ id: 'picker-id', model: 'gpt-test', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }], secret: 'private-sentinel' }], nextCursor: null },
    'account/rateLimits/read': { ordinaryUsageAllowed: true, accountId: 'private-sentinel', rateLimits: { primary: { usedPercent: 0, resetsAt: now / 1000 + 3600, windowDurationMins: 300 }, spendControlReached: false, credits: { balance: 'private-sentinel' } }, rateLimitResetCredits: { credits: [{ id: 'private-sentinel' }] } },
    ...overrides,
  };
  return { calls, closed: () => closed,
    runVersion: async () => ({ cliVersion: '0.156.0', appServerVersion: '0.156.0' }),
    connect: () => ({ request: async method => { calls.push(method); const value = replies[method]; if (value instanceof Error) throw value; return value; }, close: () => { closed = true; } }), now: () => now };
}
test('fixed RPC sequence yields separate daemon facts and no identity or entitlement claim', async () => {
  const f = fixture(); const result = await observeCodexDaemon(f);
  assert.deepEqual(f.calls, ['initialize', 'account/read', 'model/list', 'account/rateLimits/read']);
  assert.equal(f.closed(), true);
  assert.equal(result.provider, null);
  assert.equal(result.authentication.state, 'configured');
  assert.equal(result.catalog.state, 'advertised');
  assert.equal(result.models[0].id, 'gpt-test');
  assert.equal(result.quota.state, 'unknown');
  assert.equal(result.quota.accountResolved, false);
  assert.equal(result.quota.modelResolved, false);
  assert.equal(result.quota.ordinaryUsageAllowed, true);
  assert.equal(result.quota.pools[0].state, 'headroom-observed');
  assert.ok(!JSON.stringify(result).includes('private-sentinel'));
  assert.ok(!JSON.stringify(result).includes('usedPercent'));
});
test('unknown versions and missing daemon never connect or start a service', async () => {
  for (const versions of [null, {}, { cliVersion: '0.156.0' }, { cliVersion: '0.156.0', appServerVersion: '0.157.0' }, { cliVersion: '0.156.1', appServerVersion: '0.156.0' }]) {
    let connected = false;
    const result = await observeCodexDaemon({ runVersion: async () => versions, connect: () => { connected = true; throw new Error('private-sentinel'); } });
    assert.equal(result.state, 'unknown'); assert.equal(connected, false);
  }
});
test('connected server version is checked again before account metadata', async () => {
  const f = fixture({ initialize: { userAgent: 'codex_cli_rs/0.157.0 (Linux)' } });
  const result = await observeCodexDaemon(f);
  assert.equal(result.state, 'unknown'); assert.deepEqual(f.calls, ['initialize']); assert.equal(f.closed(), true);
});
test('cached API-key, missing account and custom auth contexts do not query catalogs or usage', async () => {
  for (const account of [{ account: { type: 'apiKey' }, requiresOpenaiAuth: true }, { account: null }, { account: { type: 'chatgpt' }, requiresOpenaiAuth: false }]) {
    const f = fixture({ 'account/read': account });
    const result = await observeCodexDaemon(f);
    assert.deepEqual(f.calls, ['initialize', 'account/read']);
    assert.equal(result.models, null); assert.equal(result.quota.state, 'unknown');
  }
});
test('failed quota preserves catalog facts but withholds native diagnostics', async () => {
  const f = fixture({ 'account/rateLimits/read': new Error('private-sentinel') });
  const result = await observeCodexDaemon(f);
  assert.equal(result.catalog.state, 'advertised'); assert.equal(result.quota.state, 'unknown');
  assert.ok(!JSON.stringify(result).includes('private-sentinel')); assert.equal(f.closed(), true);
});
test('missing or denied backend permission never infers recovery from window percentages', () => {
  for (const permission of [null, undefined, false, 'true']) {
    const result = normalizeQuota({ ordinaryUsageAllowed: permission, rateLimits: { primary: { usedPercent: 0 } } }, now);
    assert.equal(result.pools[0].state, 'unknown'); assert.equal(result.state, 'unknown');
  }
  const blocked = normalizeQuota({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 0 }, spendControlReached: true } }, now);
  assert.equal(blocked.pools[0].state, 'unknown');
});
test('invalid and expired resets remain conservative and pools are bounded', () => {
  const result = normalizeQuota({ ordinaryUsageAllowed: true, rateLimits: {}, rateLimitsByLimitId: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`private-${i}`, { primary: { usedPercent: 0, resetsAt: now / 1000 - 1 }, secondary: { usedPercent: -1, resetsAt: Infinity } }])) }, now);
  assert.equal(result.pools.length, 16); assert.equal(result.poolsOmitted, 24);
  assert.ok(result.pools.every(pool => pool.state === 'unknown'));
  assert.ok(!JSON.stringify(result).includes('private-'));
});
test('catalog uses only supplied capabilities and never fills schema defaults', () => {
  const result = normalizeModels({ data: [{ model: 'gpt-test' }, { model: 'not a model' }], nextCursor: 'private-sentinel' });
  assert.deepEqual(result.models, [{ id: 'gpt-test', images: null, reasoning: null, privacy: 'unverified' }]);
  assert.equal(result.partial, true); assert.ok(!JSON.stringify(result).includes('private-sentinel'));
  assert.equal(normalizeModels({ data: Array.from({ length: 65 }, () => ({ model: 'gpt-test' })) }), null);
});
function proxyFixture(reply, options = {}) {
  const { Duplex } = require('node:stream');
  const { WebSocketServer } = require('ws');
  const writes = []; const kills = [];
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
  const serverSocket = new Duplex({ read() {}, write(chunk, _encoding, callback) { if (!child.stdout.destroyed) child.stdout.write(chunk); callback(); } });
  serverSocket.setTimeout = () => serverSocket; serverSocket.setNoDelay = () => serverSocket;
  let peer; let header = Buffer.alloc(0);
  child.kill = signal => { kills.push(signal); peer?.terminate(); serverSocket.destroy(); return true; };
  child.stdin.on('data', chunk => {
    if (peer) { serverSocket.push(chunk); return; }
    header = Buffer.concat([header, chunk]); const end = header.indexOf('\r\n\r\n'); if (end === -1) return;
    const lines = header.subarray(0, end).toString().split('\r\n'); const headers = {};
    for (const line of lines.slice(1)) { const index = line.indexOf(':'); headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim(); }
    const server = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    server.handleUpgrade({ method: 'GET', url: '/', headers }, serverSocket, header.subarray(end + 4), ws => {
      peer = ws; peer.on('error', () => {});
      peer.on('message', data => {
        const packet = JSON.parse(data.toString()); writes.push(packet);
        const response = reply(packet);
        for (const line of response.split('\n').filter(Boolean)) peer.send(line);
      });
    });
  });
  const client = openDaemon({ ...options, spawnImpl: (command, args, opts) => { assert.equal(command, 'codex'); assert.deepEqual(args, ['app-server', 'proxy']); assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'ignore']); return child; } });
  return { client, writes, kills, child };
}
test('proxy sends fixed read-only methods, no token refresh and a non-originating identity', async () => {
  const f = proxyFixture(packet => `${JSON.stringify({ id: packet.id, result: {} })}\n`);
  await f.client.request('initialize'); await f.client.request('account/read');
  assert.equal(f.writes[0].params.clientInfo.name, 'codex-backend');
  assert.equal(f.writes[0].params.capabilities.requestAttestation, false);
  assert.deepEqual(f.writes[1].params, { refreshToken: false });
  await assert.rejects(f.client.request('thread/start')); await assert.rejects(f.client.request('account/login/start'));
  assert.equal(f.writes.length, 2); f.client.close(); assert.deepEqual(f.kills, ['SIGKILL']);
});
test('server requests, malformed packets, wrong IDs and oversized stdout fail closed', async () => {
  for (const reply of [() => 'INVALID\n', () => '{"id":999,"result":{}}\n', () => '{"id":1,"method":"account/chatgptAuthTokens/refresh"}\n', () => 'x'.repeat(2000)]) {
    const f = proxyFixture(reply, { maxBytes: 1024 });
    await assert.rejects(f.client.request('initialize')); assert.equal(f.writes.length, 1); assert.deepEqual(f.kills, ['SIGKILL']);
  }
});
test('unsolicited notifications are ignored and proxy deadlines kill only owned proxy', async () => {
  const f = proxyFixture(packet => `${JSON.stringify({ method: 'private-notification', params: 'private-sentinel' })}\n${JSON.stringify({ id: packet.id, result: { userAgent: 'ok' } })}\n`);
  assert.deepEqual(await f.client.request('initialize'), { userAgent: 'ok' }); f.client.close();
  const timed = proxyFixture(() => '', { timeoutMs: 10 });
  await assert.rejects(timed.client.request('initialize')); assert.deepEqual(timed.kills, ['SIGKILL']);
});
test('parent requires successful bounded helper output and withholds diagnostics', () => {
  let called;
  assert.equal(fetchNativeDaemon('/repo', { run: (...args) => { called = args; return { status: 1, stdout: 'private-sentinel' }; } }), null);
  assert.equal(called[1][0], '/repo/bin/capacity-codex-daemon.js'); assert.equal(called[2].timeout, 25000); assert.equal(called[2].maxBuffer, 65536);
  assert.deepEqual(fetchNativeDaemon('/repo', { run: () => ({ status: 0, stdout: '{"state":"unknown"}' }) }), { state: 'unknown' });
});
test('offline, merge and unsupported daemon options fail before collecting anything', () => {
  for (const args of [['--offline', '--native-daemon', 'codex'], ['--merge', 'unused', '--native-daemon', 'codex'], ['--native-daemon', 'copilot']]) assert.throws(() => main(args));
});

test('real helper and CLI fixtures leave paths unchanged and terminate only their proxy', async t => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-daemon-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'codex'); const calls = path.join(dir, 'calls'); const pidFile = path.join(dir, 'proxy-pid');
  fs.writeFileSync(fake, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args.join(' ')==='app-server daemon version'){console.log(JSON.stringify({cliVersion:'0.156.0',appServerVersion:'0.156.0',socketPath:'private-sentinel'}));process.exit(0)}
if(args.join(' ')==='login status'){console.log('Logged in using ChatGPT');process.exit(0)}
if(args.join(' ')==='app-server proxy'){fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));const replies={initialize:{userAgent:'codex_cli_rs/0.156.0 (Linux)'},'account/read':{account:{type:'chatgpt',email:'private-sentinel'},requiresOpenaiAuth:true},'model/list':{data:[{model:'gpt-fixture'}],nextCursor:null},'account/rateLimits/read':{ordinaryUsageAllowed:true,accountId:'private-sentinel',rateLimits:{spendControlReached:false,primary:{usedPercent:0}}}};const {Duplex}=require('node:stream');const {WebSocketServer}=require(${JSON.stringify(require.resolve('ws'))});const socket=new Duplex({read(){},write(chunk,encoding,cb){process.stdout.write(chunk,cb)}});socket.setTimeout=()=>socket;socket.setNoDelay=()=>socket;let peer;let header=Buffer.alloc(0);process.stdin.on('data',chunk=>{if(peer){socket.push(chunk);return}header=Buffer.concat([header,chunk]);const end=header.indexOf('\\r\\n\\r\\n');if(end<0)return;const lines=header.subarray(0,end).toString().split('\\r\\n');const headers={};for(const line of lines.slice(1)){const index=line.indexOf(':');headers[line.slice(0,index).toLowerCase()]=line.slice(index+1).trim()}new WebSocketServer({noServer:true}).handleUpgrade({method:'GET',url:'/',headers},socket,header.subarray(end+4),ws=>{peer=ws;peer.on('message',data=>{const p=JSON.parse(data.toString());fs.appendFileSync(${JSON.stringify(calls)},p.method+'\\n');if(p.id)peer.send(JSON.stringify({id:p.id,result:replies[p.method]}))})})});setInterval(()=>{},1000)}else{console.error('private-sentinel');process.exit(1)}\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  const root = path.join(__dirname, '..');
  const result = spawnSync(process.execPath, [path.join(root, 'bin/capacity-codex-daemon.js')], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0); const report = JSON.parse(result.stdout); assert.equal(report.state, 'observed');
  assert.equal(report.quota.state, 'unknown'); assert.equal(report.models[0].id, 'gpt-fixture');
  assert.ok(!result.stdout.includes('private-sentinel'));
  const proxyPid = Number(fs.readFileSync(pidFile, 'utf8'));
  const proxyAlive = () => {
    try { process.kill(proxyPid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    // Linux may briefly retain a terminated orphan as a zombie until init reaps it.
    try {
      const stat = fs.readFileSync(`/proc/${proxyPid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
    } catch { return true; }
  };
  const exitDeadline = Date.now() + 1000;
  while (proxyAlive() && Date.now() < exitDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(proxyAlive(), false, 'owned proxy should terminate after the helper exits');
  fs.writeFileSync(path.join(dir, 'inventory.json'), JSON.stringify({ schemaVersion: 1, paths: [{ id: 'native-codex', machine: 'local', subscription: 'chatgpt-plus', accountRef: null, harness: 'codex', provider: 'openai-codex', catalog: 'native', quotaPath: 'codex', constraints: [] }] }));
  const args = [path.join(root, 'bin/capacity.js'), '--inventory', path.join(dir, 'inventory.json'), '--quota', path.join(dir, 'missing'), '--machine', 'fixture-host'];
  const baseline = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(baseline.status, 0); const before = JSON.parse(baseline.stdout);
  const queried = spawnSync(process.execPath, [...args, '--native-daemon', 'codex'], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(queried.status, 0); const after = JSON.parse(queried.stdout);
  assert.deepEqual(after.paths[0].quota, before.paths[0].quota);
  assert.equal(after.nativeServices[0].machine, 'fixture-host');
  assert.equal(after.nativeServices[0].quota.state, 'unknown');
  assert.ok(!queried.stdout.includes('private-sentinel'));
  const commands = fs.readFileSync(calls, 'utf8').trim().split('\n');
  assert.ok(commands.every(line => line === '["app-server","daemon","version"]' || line === '["app-server","proxy"]' || line === '["login","status"]' || ['initialize','initialized','account/read','model/list','account/rateLimits/read'].includes(line)));
});
