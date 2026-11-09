'use strict';
/**
 * The Artificial Analysis snapshot collector must reproduce the gs importer's
 * validation (gscripts/model-catalogs.gs), must never reach the network without
 * a key, and must refuse a key file that is a symlink, loosely permissioned or
 * owned by someone else. Run with `npm test`; no test here touches the live API.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const aa = require('../src/roi-tracker/collect/aa.js');
const { freePages, proPage, page, freeModel } = require('../testdata/aa-fixtures.js');

const FREE_URL = 'https://artificialanalysis.ai/api/v2/language/models/free';
const PRO_URL = 'https://artificialanalysis.ai/api/v2/language/models';

function fakeHttp(responses) {
  const calls = [];
  const impl = async (url, headers) => {
    calls.push({ url, headers });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request: ${url}`);
    if (typeof next === 'function') return next();
    if (next instanceof Error) throw next;
    return next;
  };
  return { http: impl, calls };
}

const json = (payload, status = 200, headers = {}) => ({ status, headers, body: JSON.stringify(payload) });
const quietSleep = () => async () => {};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentq-aa-'));
}

function transportError(code) {
  const error = new Error(`simulated ${code}`);
  error.code = code;
  return error;
}

/** Start a throwaway HTTP server and hand back its URL. */
function startServer(t, handler) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      server.on('clientError', () => {});
      req.on('error', () => {});
      res.on('error', () => {});
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      resolve(`http://127.0.0.1:${server.address().port}/`);
    });
  });
}

test('crawls every page of the Free endpoint and keeps the raw records', async () => {
  const { http: httpImpl, calls } = fakeHttp(freePages().map(p => json(p)));
  const sleeps = [];
  const result = await aa.collectAll({
    apiKey: 'test-key',
    http: httpImpl,
    sleep: async ms => sleeps.push(ms),
    nowMs: () => 0,
  });

  assert.deepEqual(calls.map(c => c.url), [`${FREE_URL}?page=1`, `${FREE_URL}?page=2`]);
  assert.equal(calls[0].headers['x-api-key'], 'test-key');
  assert.equal(calls[0].headers.Accept, 'application/json');
  assert.equal(result.access, 'free');
  assert.equal(result.endpoint, FREE_URL);
  assert.equal(result.intelligenceIndexVersion, 4.1);
  assert.equal(result.pageCount, 2);
  assert.equal(result.models.length, 4);
  // Raw records are preserved verbatim so the mapping stays auditable.
  assert.equal(result.models[0].pricing.price_1m_input_tokens, 2);
  assert.deepEqual(sleeps, [150]);
});

test('Pro is explicit opt-in, uses the non-free endpoint and its own snapshot', async () => {
  const { http: httpImpl, calls } = fakeHttp([json(proPage())]);
  const result = await aa.collectAll({ access: 'pro', apiKey: 'k', http: httpImpl, sleep: quietSleep() });
  assert.equal(calls[0].url, `${PRO_URL}?page=1`);
  assert.equal(result.access, 'pro');
  assert.equal(result.endpoint, PRO_URL);

  // The two tiers answer different questions, so they never share a file.
  assert.equal(aa.defaultOut('free'), aa.freeSnapshotPath());
  assert.equal(aa.defaultOut('pro'), aa.proSnapshotPath());
  assert.notEqual(aa.freeSnapshotPath(), aa.proSnapshotPath());
  assert.match(aa.proSnapshotPath(), /aa-snapshot-pro\.json$/);
  assert.throws(() => aa.defaultOut('commercial'), /access must be one of/);
});

test('unknown access level fails before any request', async () => {
  const { http: httpImpl, calls } = fakeHttp([]);
  await assert.rejects(aa.collectAll({ access: 'commercial', apiKey: 'k', http: httpImpl }), /access must be one of/);
  assert.equal(calls.length, 0);
});

test('a missing key never reaches the network', async () => {
  const { http: httpImpl, calls } = fakeHttp([]);
  await assert.rejects(aa.collectAll({ apiKey: '', http: httpImpl }), /needs an API key/);
  assert.equal(calls.length, 0);
});

test('rejects malformed, repeated, changing or unbounded catalogs', async () => {
  const twoPages = freePages();
  const cases = [
    ['missing pagination', [json({ data: [{ id: 'a' }] })]],
    ['page number mismatch', [json(page([freeModel()], { page: 2, totalPages: 2 }))]],
    ['has_more disagrees with total_pages', [json({ ...page([freeModel()]), pagination: { page: 1, total_pages: 2, has_more: false } })]],
    ['non-integer total_pages', [json({ ...page([freeModel()]), pagination: { page: 1, total_pages: 1.5, has_more: false } })]],
    ['missing data array', [json({ pagination: { page: 1, total_pages: 1, has_more: false } })]],
    ['invalid JSON', [{ status: 200, headers: {}, body: 'not json' }]],
    ['page limit exceeded', [json(page([freeModel()], { totalPages: 101 }))]],
    ['missing index version', [json({ ...page([freeModel()]), intelligence_index_version: 'v4' })]],
    ['empty intermediate page', [json(page([], { page: 1, totalPages: 2 })), json(twoPages[1])]],
    ['duplicate model id', [json(page([freeModel(), freeModel()]))]],
    ['missing model id', [json(page([{ name: 'no id' }]))]],
    ['version change mid-crawl', [json(twoPages[0]), json({ ...twoPages[1], intelligence_index_version: 5 })]],
    ['page count change mid-crawl', [json(twoPages[0]), json({ ...twoPages[1], pagination: { page: 2, total_pages: 3, has_more: true } })]],
    ['empty catalog', [json(page([]))]],
  ];
  for (const [label, responses] of cases) {
    const { http: httpImpl } = fakeHttp(responses);
    await assert.rejects(aa.collectAll({ apiKey: 'k', http: httpImpl, sleep: quietSleep() }), Error, label);
  }
});

test('retries transient HTTP failures with Retry-After, and gives up on the rest', async () => {
  const ok = json(page([freeModel()]));

  const sleeps = [];
  const retryAfter = fakeHttp([{ status: 429, headers: { 'Retry-After': '1' }, body: '' }, ok]);
  await aa.collectAll({ apiKey: 'k', http: retryAfter.http, sleep: async ms => sleeps.push(ms) });
  assert.deepEqual(sleeps, [1000]);

  const backoff = [];
  const serverErrors = fakeHttp([{ status: 500, headers: {}, body: '' }, { status: 503, headers: {}, body: '' }, ok]);
  await aa.collectAll({ apiKey: 'k', http: serverErrors.http, sleep: async ms => backoff.push(ms) });
  assert.deepEqual(backoff, [1000, 2000]);

  const unauthorized = fakeHttp([{ status: 401, headers: {}, body: 'secret-body' }]);
  await assert.rejects(
    aa.collectAll({ apiKey: 'k', http: unauthorized.http, sleep: quietSleep() }),
    error => /HTTP 401/.test(error.message) && !/secret-body/.test(error.message),
  );
  assert.equal(unauthorized.calls.length, 1);

  const cooldown = fakeHttp([{ status: 429, headers: { 'Retry-After': '120' }, body: '' }]);
  const cooldownSleeps = [];
  await assert.rejects(
    aa.collectAll({ apiKey: 'k', http: cooldown.http, sleep: async ms => cooldownSleeps.push(ms) }),
    /retry later after cooldown/,
  );
  assert.deepEqual(cooldownSleeps, []);
  assert.equal(cooldown.calls.length, 1);

  const exhausted = fakeHttp([{ status: 500, headers: {}, body: '' }, { status: 500, headers: {}, body: '' }, { status: 500, headers: {}, body: '' }]);
  await assert.rejects(aa.collectAll({ apiKey: 'k', http: exhausted.http, sleep: quietSleep() }), /HTTP 500/);
  assert.equal(exhausted.calls.length, 3);
});

test('transient transport failures share the same bounded retry budget', async () => {
  const ok = json(page([freeModel()]));

  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']) {
    const sleeps = [];
    const flaky = fakeHttp([transportError(code), ok]);
    const result = await aa.collectAll({ apiKey: 'k', http: flaky.http, sleep: async ms => sleeps.push(ms) });
    assert.equal(result.models.length, 1, code);
    assert.deepEqual(sleeps, [1000], code);
    assert.equal(flaky.calls.length, 2, code);
  }

  // A permanent failure is not retried and never echoes the raw message.
  const denied = fakeHttp([transportError('ENOTFOUND')]);
  await assert.rejects(
    aa.collectAll({ apiKey: 'k', http: denied.http, sleep: quietSleep() }),
    error => /ENOTFOUND/.test(error.message) && !/simulated/.test(error.message),
  );
  assert.equal(denied.calls.length, 1);

  // Three resets exhaust the budget.
  const exhausted = fakeHttp([transportError('ECONNRESET'), transportError('ECONNRESET'), transportError('ECONNRESET')]);
  await assert.rejects(aa.collectAll({ apiKey: 'k', http: exhausted.http, sleep: quietSleep() }), /ECONNRESET/);
  assert.equal(exhausted.calls.length, 3);
});

test('retryDelayMs honours seconds, HTTP dates and the backoff fallback', () => {
  assert.equal(aa.retryDelayMs('2', 0, 0), 2000);
  assert.equal(aa.retryDelayMs(undefined, 0, 0), 1000);
  assert.equal(aa.retryDelayMs(undefined, 2, 0), 4000);
  assert.equal(aa.retryDelayMs('garbage', 1, 0), 2000);
  const now = Date.parse('2026-11-08T10:00:00Z');
  assert.equal(aa.retryDelayMs('Sun, 08 Nov 2026 10:00:05 GMT', 0, now), 5000);
  // A date already in the past must not produce a negative sleep.
  assert.equal(aa.retryDelayMs('Sun, 08 Nov 2026 09:00:00 GMT', 0, now), 0);
});

test('fetchPage has a usable default sleep', async () => {
  const { http: httpImpl } = fakeHttp([{ status: 429, headers: { 'Retry-After': '0' }, body: '' }, json(page([freeModel()]))]);
  const payload = await aa.fetchPage({ page: 1, access: 'free', apiKey: 'k', http: httpImpl });
  assert.equal(payload.pagination.page, 1);
});

test('a response larger than the cap is rejected before parsing', async () => {
  const body = 'x'.repeat(aa.MAX_RESPONSE_BYTES + 1);
  const { http: httpImpl } = fakeHttp([{ status: 200, headers: {}, body }]);
  await assert.rejects(aa.collectAll({ apiKey: 'k', http: httpImpl, sleep: quietSleep() }), /exceeded/);
});

test('defaultHttp enforces the byte cap against a real socket', async t => {
  const url = await startServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(Buffer.alloc(4096, 0x61));
  });
  await assert.rejects(
    aa.defaultHttp(url, {}, { transport: http, maxBytes: 1024 }),
    /response exceeded 1024 bytes/,
  );
});

test('defaultHttp enforces a total deadline even while bytes trickle in', async t => {
  const url = await startServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // Never end the response: only the deadline can stop this.
    const timer = setInterval(() => res.write(' '), 20);
    res.on('close', () => clearInterval(timer));
  });
  const started = Date.now();
  await assert.rejects(
    aa.defaultHttp(url, {}, { transport: http, idleTimeoutMs: 5000, deadlineMs: 150 }),
    /request deadline of 150ms exceeded/,
  );
  assert.ok(Date.now() - started < 4000, 'the deadline, not the idle timeout, ended the request');
});

test('defaultHttp keeps the idle timeout as a separate bound', async t => {
  const url = await startServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    // Headers only, then silence: the socket goes idle.
  });
  await assert.rejects(
    aa.defaultHttp(url, {}, { transport: http, idleTimeoutMs: 100, deadlineMs: 5000 }),
    /request timed out/,
  );
});

test('the key comes from AA_API_KEY or a 0600 key file, never from a looser file', () => {
  const home = tempDir();
  const env = { XDG_CONFIG_HOME: path.join(home, 'xdg') };
  const file = aa.keyFilePath({ env, home });
  assert.equal(file, path.join(home, 'xdg', 'agentq', 'aa-api-key'));

  assert.throws(() => aa.readApiKey({ env, home }), /AA_API_KEY/);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'file-key\n', { mode: 0o600 });
  assert.deepEqual(aa.readApiKey({ env, home }), { key: 'file-key', source: file });

  fs.chmodSync(file, 0o644);
  assert.throws(() => aa.readApiKey({ env, home }), /must be mode 0600/);
  fs.chmodSync(file, 0o640);
  assert.throws(() => aa.readApiKey({ env, home }), /must be mode 0600/);

  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, '   \n');
  assert.throws(() => aa.readApiKey({ env, home }), /is empty/);

  // The environment always wins, so a machine can override a stale file.
  assert.deepEqual(aa.readApiKey({ env: { ...env, AA_API_KEY: ' env-key ' }, home }), { key: 'env-key', source: 'AA_API_KEY' });
});

test('a symlinked key file is refused', () => {
  const home = tempDir();
  const env = { XDG_CONFIG_HOME: path.join(home, 'xdg') };
  const file = aa.keyFilePath({ env, home });
  const real = path.join(home, 'elsewhere', 'key');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, 'file-key\n', { mode: 0o600 });
  fs.symlinkSync(real, file);

  assert.throws(() => aa.readApiKey({ env, home }), /is a symlink/);
});

test('the key file must be a regular file owned by this uid, opened with O_NOFOLLOW', () => {
  const home = tempDir();
  const env = { XDG_CONFIG_HOME: path.join(home, 'xdg') };
  const file = aa.keyFilePath({ env, home });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'file-key\n', { mode: 0o600 });

  // Wrong owner: fstat is mocked because a test cannot chown.
  const foreignOwner = {
    ...fs,
    fstatSync: fd => ({ ...fs.fstatSync(fd), uid: 4242, isFile: () => true }),
  };
  assert.throws(
    () => aa.readApiKey({ env, home, fs: foreignOwner, getuid: () => 0 }),
    /owned by uid 4242, not 0/,
  );

  // A directory at the key path is not a key.
  const dirHome = tempDir();
  const dirEnv = { XDG_CONFIG_HOME: path.join(dirHome, 'xdg') };
  const dirFile = aa.keyFilePath({ env: dirEnv, home: dirHome });
  fs.mkdirSync(dirFile, { recursive: true });
  assert.throws(() => aa.readApiKey({ env: dirEnv, home: dirHome }), /not a regular file/);

  // O_NOFOLLOW is requested and the key is read through the descriptor.
  let openedFlags = null;
  let readFrom = null;
  const spy = {
    ...fs,
    openSync: (target, flags) => {
      openedFlags = flags;
      return fs.openSync(target, flags);
    },
    readFileSync: (target, encoding) => {
      readFrom = target;
      return fs.readFileSync(target, encoding);
    },
  };
  assert.deepEqual(aa.readApiKey({ env, home, fs: spy }), { key: 'file-key', source: file });
  assert.equal(typeof readFrom, 'number', 'the key is read from the open descriptor');
  // O_RDONLY is 0, so compare the whole flag word rather than testing bits.
  assert.equal(openedFlags, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
});

test('keyFilePath falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
  assert.equal(aa.keyFilePath({ env: {}, home: '/home/tester' }), '/home/tester/.config/agentq/aa-api-key');
  assert.equal(aa.keyFilePath({ env: { XDG_CONFIG_HOME: '  ' }, home: '/home/tester' }), '/home/tester/.config/agentq/aa-api-key');
});

test('runSync resolves the key first, then writes an atomic snapshot without the key', async () => {
  const dir = tempDir();
  const out = path.join(dir, 'aa-snapshot.json');
  const { http: httpImpl, calls } = fakeHttp(freePages().map(p => json(p)));

  const snapshot = await aa.runSync({
    env: { AA_API_KEY: 'super-secret-key' },
    home: dir,
    http: httpImpl,
    sleep: quietSleep(),
    out,
    now: new Date('2026-11-08T10:00:00Z'),
  });

  assert.equal(calls.length, 2);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.generatedAt, '2026-11-08T10:00:00.000Z');
  assert.equal(snapshot.source.tier, 'free');
  assert.equal(snapshot.source.endpoint, FREE_URL);
  assert.equal(snapshot.modelCount, 4);
  assert.equal(snapshot.pageCount, 2);

  const onDisk = fs.readFileSync(out, 'utf8');
  assert.ok(!onDisk.includes('super-secret-key'), 'the snapshot must never contain the key');
  assert.deepEqual(aa.readSnapshot(out).models.length, 4);
  assert.deepEqual(fs.readdirSync(dir), ['aa-snapshot.json'], 'no temp file is left behind');
});

test('runSync without a key fails before any request', async () => {
  const dir = tempDir();
  const { http: httpImpl, calls } = fakeHttp([]);
  await assert.rejects(
    aa.runSync({ env: {}, home: dir, http: httpImpl, out: path.join(dir, 'aa-snapshot.json') }),
    /AA_API_KEY/,
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a missing snapshot explains which command creates one', () => {
  assert.throws(() => aa.readSnapshot(path.join(tempDir(), 'nope.json')), /npm run aa-sync/);
  const dir = tempDir();
  const broken = path.join(dir, 'aa-snapshot.json');
  fs.writeFileSync(broken, '{ not json');
  assert.throws(() => aa.readSnapshot(broken), /npm run aa-sync again/);
  fs.writeFileSync(broken, JSON.stringify({ models: 'nope' }));
  assert.throws(() => aa.readSnapshot(broken), /no models array/);
});

test('parseArgs rejects unknown flags and resolves --out', () => {
  assert.deepEqual(aa.parseArgs(['--pro', '--dry-run']), { pro: true, dryRun: true, out: null, help: false });
  assert.equal(aa.parseArgs(['--out', 'tmp/x.json']).out, path.resolve('tmp/x.json'));
  assert.throws(() => aa.parseArgs(['--out']), /--out needs a path/);
  assert.throws(() => aa.parseArgs(['--nope']), /unknown argument/);
});
