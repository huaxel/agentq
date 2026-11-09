'use strict';

/** Shared provider usage fetchers (ESM) for agentq collectors. */

const { execFile } = require('node:child_process');

// pi stores the xAI credential under the `xai` provider (OAuth device flow at
// auth.x.ai), while the fetcher package resolves `grok`/`supergrok` entries and
// the grok CLI's ~/.grok/auth.json. Passing pi's token explicitly is what makes
// the Grok billing endpoint reachable from agentq at all.
const XAI_TOKEN_TIMEOUT_MS = 10_000;
const XAI_TOKEN_ARGS = ['auth', 'print-bearer-token', '--provider', 'xai', '--min-expiry', '5m'];

/**
 * Default token getter: pi's OAuth bearer token for the xai provider. Resolves
 * undefined instead of throwing so the fetcher can fall back to its own
 * credential sources. The token is never logged or included in results.
 * @returns {Promise<string|undefined>}
 */
function piXaiToken() {
  return new Promise(resolve => {
    execFile('pi', XAI_TOKEN_ARGS, { encoding: 'utf8', timeout: XAI_TOKEN_TIMEOUT_MS }, (err, stdout) => {
      if (err) return resolve(undefined);
      const token = String(stdout || '').trim();
      resolve(token || undefined);
    });
  });
}

async function loadUsage() {
  return import('@juanbenjumea/pi-provider-usage-fetcher');
}

async function loadFormat() {
  return import('@juanbenjumea/pi-provider-usage-fetcher/format.ts');
}

async function fetchCursorQuotaEntry() {
  const [{ fetchCursorUsage }, { clampPercent }] = await Promise.all([loadUsage(), loadFormat()]);
  const result = await fetchCursorUsage({ labelStyle: 'agentq' });
  if (result.error) return { error: result.error };
  if (!result.windows?.length) return { error: 'no windows from billing API' };
  return {
    windows: result.windows.map(w => ({
      slot: w.slot || undefined,
      label: w.label,
      usedPercent: clampPercent(w.usedPercent),
      resetsAt: w.resetsAt || null,
      resetDescription: w.resetDescription || null,
    })),
    updatedAt: new Date(result.fetchedAt).toISOString(),
  };
}

async function fetchCommandCodeQuotaEntry() {
  const [{ fetchCommandCodeUsage }, { clampPercent }] = await Promise.all([loadUsage(), loadFormat()]);
  const result = await fetchCommandCodeUsage();
  if (result.error) return { error: result.error };
  if (!result.windows?.length) return { error: 'no windows from billing API' };
  return {
    windows: result.windows.map(w => ({
      label: w.label,
      usedPercent: clampPercent(w.usedPercent),
      resetsAt: w.resetsAt || null,
      resetDescription: w.resetDescription || null,
    })),
    updatedAt: new Date(result.fetchedAt).toISOString(),
  };
}

/**
 * xAI (Grok) subscription usage. The fetcher reads
 * https://cli-chat-proxy.grok.com/v1/billing?format=credits, which reports the
 * SuperGrok/X Premium credit allowance as a percentage plus the billing period.
 *
 * @param {{ getToken?: () => Promise<string|undefined>, fetchImpl?: typeof fetch }} [options]
 *   Injectable token getter and fetch so tests never touch the network or a
 *   real credential.
 */
async function fetchXaiQuotaEntry({ getToken = piXaiToken, fetchImpl } = {}) {
  const [{ fetchGrokUsage }, { clampPercent }] = await Promise.all([loadUsage(), loadFormat()]);

  let token;
  try {
    token = await getToken();
  } catch {
    token = undefined;
  }

  const result = await fetchGrokUsage({
    ...(token ? { apiKey: token } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  if (result.error) return { error: result.error };
  if (!result.windows?.length) return { error: 'no windows from grok billing API' };

  return {
    windows: result.windows.map(w => ({
      label: w.label,
      usedPercent: clampPercent(w.usedPercent),
      resetsAt: w.resetsAt || null,
      resetDescription: w.resetDescription || w.resetsIn || null,
    })),
    updatedAt: new Date(result.fetchedAt).toISOString(),
  };
}

/**
 * Mistral (Le Chat / Vibe) included allowance via the fetcher's
 * fetchMistralUsage: GET api.mistral.ai/v1/billing/budget with pi's mistral
 * API key, falling back to an admin.mistral.ai session from quota-sessions.json.
 * Requires @juanbenjumea/pi-provider-usage-fetcher >= 0.3.6; an older install
 * reports that instead of inventing a window.
 *
 * @param {{ load?: () => Promise<Record<string, any>> }} [options]
 */
async function fetchMistralQuotaEntry({ load = loadUsage } = {}) {
  const [usage, { clampPercent }] = await Promise.all([load(), loadFormat()]);
  if (typeof usage.fetchMistralUsage !== 'function') {
    return { error: 'mistral: installed usage fetcher lacks fetchMistralUsage (needs >= 0.3.6)' };
  }
  const result = await usage.fetchMistralUsage();
  if (result.error) return { error: result.error };
  if (!result.windows?.length) return { error: 'no windows from mistral billing API' };
  return {
    windows: result.windows.map(w => ({
      label: w.label,
      usedPercent: clampPercent(w.usedPercent),
      resetsAt: w.resetsAt || null,
      resetDescription: w.resetDescription || w.resetsIn || null,
    })),
    updatedAt: new Date(result.fetchedAt).toISOString(),
  };
}

module.exports = {
  fetchCursorQuotaEntry,
  fetchCommandCodeQuotaEntry,
  fetchXaiQuotaEntry,
  fetchMistralQuotaEntry,
};
