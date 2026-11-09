'use strict';
const { spawnSync } = require('node:child_process');

function parseAgyCatalog(text) {
  const models = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split('\t');
    if (fields.length < 2 || !/^(gemini|claude|gpt-oss)-[a-z0-9.-]+$/.test(fields[0])) continue;
    // Catalog listing is not proof of per-model entitlement or remaining quota.
    models.push({ id: fields[0], reasoning: null, images: null, privacy: 'unverified' });
  }
  return models;
}

function codexAuthentication(result) {
  if (result.error || result.status === null) return { state: 'unknown', mode: null, source: 'codex-login-status-failed' };
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status === 0 && /Logged in using ChatGPT/i.test(text)) {
    return { state: 'authenticated', mode: 'subscription', source: 'codex-login-status' };
  }
  if (result.status === 0 && /Logged in using an API key/i.test(text)) {
    return { state: 'authenticated', mode: 'api-key', source: 'codex-login-status' };
  }
  if (/^Not logged in\s*$/im.test(text)) return { state: 'not-authenticated', mode: null, source: 'codex-login-status' };
  return { state: 'unknown', mode: null, source: 'codex-login-status-unrecognized' };
}

function observeNative(installed, { run = spawnSync, cwd, now = Date.now() } = {}) {
  const observations = {};
  const execute = (command, args) => {
    try {
      return run(command, args, { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return { status: null }; }
  };
  if (installed.has('agy')) {
    const result = execute('agy', ['models']);
    const models = result.status === 0 ? parseAgyCatalog(result.stdout || '') : [];
    observations.agy = {
      observedAt: new Date(now).toISOString(),
      authentication: { state: 'unknown', mode: null, source: 'no-supported-status-probe' },
      catalog: { state: models.length ? 'advertised' : 'unknown', source: 'agy-models', models: models.length ? models : null },
    };
  }
  if (installed.has('codex')) {
    const result = execute('codex', ['login', 'status']);
    observations.codex = {
      observedAt: new Date(now).toISOString(), authentication: codexAuthentication(result),
      catalog: { state: 'unknown', source: 'no-supported-catalog-probe', models: null },
    };
  }
  // Copilot's login command performs authentication; never invoke it to probe.
  // ACP session creation is not used as a supposedly side-effect-free check.
  if (installed.has('copilot')) {
    observations.copilot = {
      observedAt: new Date(now).toISOString(),
      authentication: { state: 'unknown', mode: null, source: 'no-supported-status-probe' },
      catalog: { state: 'native-auto', source: 'declared-access-constraint', models: null },
    };
  }
  return observations;
}

module.exports = { parseAgyCatalog, codexAuthentication, observeNative };
