'use strict';
/**
 * The xAI quota entry wraps the fetcher package's `fetchGrokUsage`, which reads
 * the Grok billing endpoint. These tests pin the agentq-side contract: window
 * shape, error passthrough, and that the bearer token never leaks into a
 * result or an error message. All tokens below are synthetic fixtures; the real
 * credential is only ever read by the default getter from `pi auth`.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { fetchXaiQuotaEntry } = require('../src/lib/provider-usage.js');

const SYNTHETIC_TOKEN = 'fixture-token-not-a-credential';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function grokBillingBody(overrides = {}) {
  const now = Date.now();
  return {
    config: {
      creditUsagePercent: 37,
      currentPeriod: {
        start: new Date(now - 2 * 86_400_000).toISOString(),
        end: new Date(now + 5 * 86_400_000).toISOString(),
      },
      ...overrides,
    },
  };
}

test('maps the grok billing payload onto an agentq quota entry', async () => {
  let seenUrl;
  let seenAuth;
  const result = await fetchXaiQuotaEntry({
    getToken: async () => SYNTHETIC_TOKEN,
    fetchImpl: async (url, init) => {
      seenUrl = String(url);
      seenAuth = init.headers.Authorization;
      return jsonResponse(grokBillingBody());
    },
  });

  assert.equal(seenUrl, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits');
  assert.equal(seenAuth, `Bearer ${SYNTHETIC_TOKEN}`);
  assert.equal(result.error, undefined);
  assert.equal(result.windows.length, 1);
  const [window] = result.windows;
  assert.equal(window.label, 'Week');
  assert.equal(window.usedPercent, 37);
  assert.match(window.resetsAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof window.resetDescription, 'string');
  assert.match(result.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('derives usedPercent from the on-demand cap when the credit percent is absent', async () => {
  const result = await fetchXaiQuotaEntry({
    getToken: async () => SYNTHETIC_TOKEN,
    fetchImpl: async () => jsonResponse(grokBillingBody({
      creditUsagePercent: undefined,
      onDemandCap: { val: 100 },
      onDemandUsed: { val: 25 },
    })),
  });

  assert.equal(result.error, undefined);
  assert.equal(result.windows[0].usedPercent, 25);
});

test('labels a monthly billing period as Month and clamps the percentage', async () => {
  const now = Date.now();
  const result = await fetchXaiQuotaEntry({
    getToken: async () => SYNTHETIC_TOKEN,
    fetchImpl: async () => jsonResponse(grokBillingBody({
      creditUsagePercent: 104.5,
      currentPeriod: {
        start: new Date(now - 10 * 86_400_000).toISOString(),
        end: new Date(now + 20 * 86_400_000).toISOString(),
      },
    })),
  });

  assert.equal(result.windows[0].label, 'Month');
  assert.equal(result.windows[0].usedPercent, 100);
});

test('a past billing period yields no resetsAt instead of a stale reset', async () => {
  const now = Date.now();
  const result = await fetchXaiQuotaEntry({
    getToken: async () => SYNTHETIC_TOKEN,
    fetchImpl: async () => jsonResponse(grokBillingBody({
      currentPeriod: {
        start: new Date(now - 10 * 86_400_000).toISOString(),
        end: new Date(now - 3 * 86_400_000).toISOString(),
      },
    })),
  });

  assert.equal(result.windows[0].resetsAt, null);
});

test('a 401 becomes an error entry, not a throw', async () => {
  const result = await fetchXaiQuotaEntry({
    getToken: async () => SYNTHETIC_TOKEN,
    fetchImpl: async () => jsonResponse({ error: 'unauthorized' }, 401),
  });

  assert.equal(result.error, 'HTTP 401');
  assert.equal(result.windows, undefined);
});

test('an aborted request reports timeout', async () => {
  const result = await fetchXaiQuotaEntry({
    getToken: async () => SYNTHETIC_TOKEN,
    fetchImpl: async () => { throw new DOMException('aborted', 'AbortError'); },
  });

  assert.equal(result.error, 'timeout');
});

test('a failing token getter falls back to the fetcher credential sources', async () => {
  // The default getter shells out to `pi auth`; a broken CLI must not crash the
  // collector. The fetcher then resolves its own sources (env, ~/.grok/auth.json)
  // and either fetches or reports no-auth.
  const result = await fetchXaiQuotaEntry({
    getToken: async () => { throw new Error('pi not found'); },
    fetchImpl: async () => jsonResponse({}, 401),
  });

  assert.equal(typeof result.error, 'string');
});

test('the bearer token never appears in results or error messages', async () => {
  const ok = await fetchXaiQuotaEntry({
    getToken: async () => SYNTHETIC_TOKEN,
    fetchImpl: async () => jsonResponse(grokBillingBody()),
  });
  assert.ok(!JSON.stringify(ok).includes(SYNTHETIC_TOKEN));

  const unauthorized = await fetchXaiQuotaEntry({
    getToken: async () => SYNTHETIC_TOKEN,
    fetchImpl: async () => jsonResponse({ message: `bad key ${SYNTHETIC_TOKEN}` }, 401),
  });
  assert.ok(!JSON.stringify(unauthorized).includes(SYNTHETIC_TOKEN));

  const invalidBody = await fetchXaiQuotaEntry({
    getToken: async () => SYNTHETIC_TOKEN,
    fetchImpl: async () => jsonResponse({ config: null }),
  });
  assert.equal(typeof invalidBody.error, 'string');
  assert.ok(!JSON.stringify(invalidBody).includes(SYNTHETIC_TOKEN));
});
