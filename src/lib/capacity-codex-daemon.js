'use strict';
const { spawn, execFile } = require('node:child_process');
const { summarizeQuota } = require('./capacity-view.js');
const VERSION = '0.156.0';
const SOURCE = 'native-codex-daemon-rpc';
const ownedChildren = new Set();
process.once('exit', () => { for (const child of ownedChildren) child.kill('SIGKILL'); });
const REQUESTS = Object.freeze({
  // This version's non-originating name avoids changing the shared daemon's
  // originator/user-agent suffix. Never impersonate a TUI or Desktop client.
  initialize: { clientInfo: { name: 'codex-backend', version: 'agentq-metadata-1' }, capabilities: { experimentalApi: false, requestAttestation: false } },
  'account/read': { refreshToken: false },
  'model/list': { limit: 64, includeHidden: false },
  'account/rateLimits/read': {},
});
function unknownDaemon(reason = 'native-daemon-unavailable') {
  return { harness: 'codex', provider: null, transport: 'existing-local-daemon-only', source: SOURCE,
    sourceVersion: null, state: 'unknown', reason, observedAt: null,
    authentication: { state: 'unknown', mode: null, source: SOURCE },
    catalog: { state: 'unknown', source: SOURCE, partial: null }, models: null,
    quota: { ...summarizeQuota(null, 'codex'), scope: 'native-reported-pools', source: SOURCE,
      accountIdentity: 'daemon-account-not-linked-to-cli-or-pi', ordinaryUsageAllowed: null, pools: [], poolsOmitted: 0 } };
}
function versionReport() {
  return new Promise((resolve, reject) => {
    const child = execFile('codex', ['app-server', 'daemon', 'version'],
      { timeout: 3000, maxBuffer: 16 * 1024, encoding: 'utf8' }, (error, stdout) => {
        ownedChildren.delete(child);
        if (error) return reject(new Error('native-daemon-unavailable'));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error('native-daemon-unavailable')); }
      });
    ownedChildren.add(child);
  });
}
function openDaemon({ spawnImpl = spawn, timeoutMs = 18000, maxBytes = 1024 * 1024 } = {}) {
  // The control socket speaks WebSocket, not the stdio JSON-lines protocol.
  // Load only at explicit opt-in, using the already installed reviewed library.
  if (require('ws/package.json').version !== '8.21.3') throw new Error('native-transport-version-unsupported');
  const WebSocket = require('ws');
  const { Duplex } = require('node:stream');
  const child = spawnImpl('codex', ['app-server', 'proxy'], { stdio: ['pipe', 'pipe', 'ignore'] });
  ownedChildren.add(child);
  let pending = null;
  let bytes = 0;
  let id = 0;
  let closed = false;
  let websocket;
  const channel = new Duplex({ read() {}, write(chunk, encoding, callback) { child.stdin.write(chunk, encoding, callback); } });
  // Only the owned proxy is the connection. No TCP listener, DNS, socket-path
  // override, redirects, compression, startup or lifecycle fallback.
  channel.setTimeout = () => channel;
  channel.setNoDelay = () => channel;
  channel.setKeepAlive = () => channel;
  function close() {
    if (closed) return;
    closed = true;
    ownedChildren.delete(child);
    clearTimeout(timer);
    if (pending) { pending.reject(new Error('native-daemon-unavailable')); pending = null; }
    websocket?.terminate();
    channel.destroy();
    child.stdin.destroy();
    child.stdout.destroy();
    // Proxy has no descendants. Never signal the daemon or its process group.
    child.kill('SIGKILL');
  }
  const timer = setTimeout(close, timeoutMs);
  child.on('error', close);
  child.on('close', close);
  child.stdin.on('error', close);
  child.stdout.on('error', close);
  channel.on('error', close);
  child.stdout.on('data', chunk => {
    if (closed) return;
    bytes += chunk.length;
    if (bytes > maxBytes) return close();
    channel.push(chunk);
  });
  try {
    websocket = new WebSocket('ws://localhost/', {
      createConnection: () => channel, followRedirects: false, perMessageDeflate: false,
      maxPayload: maxBytes, maxFragments: 256, maxBufferedChunks: 256, maxHeaderSize: 8192,
      handshakeTimeout: timeoutMs,
    });
  } catch { close(); throw new Error('native-daemon-unavailable'); }
  websocket.on('error', close);
  websocket.on('close', close);
  websocket.on('message', (data, binary) => {
    if (closed) return;
    if (binary) return close();
    let packet;
    try { packet = JSON.parse(data.toString('utf8')); } catch { return close(); }
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return close();
    // Unsolicited notifications carry no facts. Server requests (including
    // auth refresh, attestation, tools and approval) are never answered.
    if (typeof packet.method === 'string') {
      if (Object.hasOwn(packet, 'id')) return close();
      return;
    }
    if (!pending || packet.id !== pending.id || Object.hasOwn(packet, 'error') || !Object.hasOwn(packet, 'result')) return close();
    const { resolve } = pending;
    pending = null;
    resolve(packet.result);
  });
  return { close, initialized() {
    if (closed || websocket.readyState !== WebSocket.OPEN) throw new Error('native-daemon-unavailable');
    websocket.send(JSON.stringify({ method: 'initialized' }), error => { if (error) close(); });
  }, request(method) {
    if (closed || pending || !Object.hasOwn(REQUESTS, method)) return Promise.reject(new Error('native-daemon-unavailable'));
    return new Promise((resolve, reject) => {
      pending = { id: ++id, resolve, reject };
      const packet = JSON.stringify({ id, method, params: REQUESTS[method] });
      const send = () => { if (!closed) websocket.send(packet, error => { if (error) close(); }); };
      if (websocket.readyState === WebSocket.OPEN) send();
      else websocket.once('open', send);
    });
  } };
}
function normalizeModels(response) {
  if (!Array.isArray(response?.data) || response.data.length > 64) return null;
  const models = new Map();
  for (const row of response.data) {
    if (!row || typeof row.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(row.model)) continue;
    models.set(row.model, { id: row.model,
      reasoning: Array.isArray(row.supportedReasoningEfforts) && row.supportedReasoningEfforts.every(option => typeof option?.reasoningEffort === 'string' && option.reasoningEffort.length > 0)
        ? row.supportedReasoningEfforts.some(option => option.reasoningEffort !== 'none') : null,
      images: Array.isArray(row.inputModalities) && row.inputModalities.every(value => ['text', 'image', 'audio'].includes(value)) ? row.inputModalities.includes('image') : null, privacy: 'unverified' });
  }
  return { models: [...models.values()], partial: typeof response.nextCursor === 'string' ? true : response.nextCursor === null ? false : null };
}
function normalizeQuota(response, now) {
  const quota = unknownDaemon().quota;
  if (!response || typeof response !== 'object' || !response.rateLimits) return quota;
  const permission = typeof response.ordinaryUsageAllowed === 'boolean' ? response.ordinaryUsageAllowed : null;
  const map = response.rateLimitsByLimitId;
  const groups = map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).length ? Object.values(map) : [response.rateLimits];
  const observedAt = new Date(now).toISOString();
  let total = 0;
  const pools = [];
  groups.forEach((group, index) => {
    for (const key of ['primary', 'secondary']) {
      if (!group?.[key]) continue;
      total++;
      if (pools.length === 16) continue;
      const window = group[key];
      const seconds = window.resetsAt;
      const reset = Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 8640000000000 ? new Date(seconds * 1000).toISOString() : null;
      const fact = summarizeQuota({ paths: { codex: { updatedAt: observedAt, windows: [{ usedPercent: window.usedPercent, resetsAt: reset }] } } }, 'codex', { now });
      // The protocol explicitly forbids recovering included-usage permission
      // from percentages. Missing/denied permission and spend controls stay unknown.
      if (permission !== true || group.spendControlReached !== false || group.rateLimitReachedType != null) {
        fact.state = 'unknown'; fact.reason = 'native-included-usage-permission-or-controls-unresolved';
      }
      pools.push({ poolRef: `observed-codex-pool-${index + 1}-${key}`, label: `Reported pool ${index + 1} ${key}`,
        window: Number.isSafeInteger(window.windowDurationMins) ? ({ 300: 'five-hour', 1440: 'daily', 10080: 'weekly' })[window.windowDurationMins] ?? null : null,
        state: fact.state, freshness: fact.freshness, observedAt: fact.observedAt,
        nextResetAt: fact.nextResetAt, recheckAt: fact.recheckAt, reason: fact.reason });
    }
  });
  return { ...quota, ordinaryUsageAllowed: permission, observedAt, freshness: 'fresh',
    reason: 'daemon-pools-not-execution-path-capacity', pools, poolsOmitted: total - pools.length };
}
async function observeCodexDaemon({ runVersion = versionReport, connect = openDaemon, now = () => Date.now() } = {}) {
  let client;
  try {
    const versions = await runVersion();
    if (versions?.cliVersion !== VERSION || versions.appServerVersion !== VERSION) return unknownDaemon('native-daemon-version-unsupported-or-not-running');
    client = connect();
    const initialized = await client.request('initialize');
    // Recheck the connected server to fail closed across daemon restart races.
    if (typeof initialized?.userAgent !== 'string' || !/^[^\s/]+\/0\.156\.0(?:\s|$)/.test(initialized.userAgent)) return unknownDaemon('native-daemon-version-unsupported');
    client.initialized?.();
    const account = await client.request('account/read');
    const result = { ...unknownDaemon(), sourceVersion: VERSION, state: 'observed', reason: 'daemon-facts-not-linked-to-execution-paths', observedAt: new Date(now()).toISOString() };
    if (!['chatgpt', 'apiKey'].includes(account?.account?.type)) return result;
    result.authentication = { state: 'configured', mode: account.account.type === 'chatgpt' ? 'subscription' : 'api-key', source: 'native-daemon-cached-account-read' };
    // Never perform API-key or auth-independent catalog/usage requests here.
    // requiresOpenaiAuth does not establish the configured model provider;
    // provider identity and linkage to execution paths remain unresolved.
    if (account.account.type !== 'chatgpt' || account.requiresOpenaiAuth !== true) return result;
    const catalog = normalizeModels(await client.request('model/list'));
    if (catalog) { result.models = catalog.models; result.catalog = { state: 'advertised', source: SOURCE, partial: catalog.partial }; }
    try { result.quota = normalizeQuota(await client.request('account/rateLimits/read'), now()); } catch { /* Catalog facts survive unavailable usage. */ }
    return result;
  } catch { return unknownDaemon(); }
  finally { client?.close(); }
}
module.exports = { observeCodexDaemon, unknownDaemon, openDaemon, normalizeModels, normalizeQuota };
