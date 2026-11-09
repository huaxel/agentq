#!/usr/bin/env node
'use strict';

/**
 * collect-opencode-quota.js — Fetch combined quota for all OpenCode Go accounts.
 *
 * Uses the official usage API (same key as chat). Reads accounts from
 * auth.json opencode-go-failover config.
 *
 * Usage:
 *   node --experimental-strip-types bin/collect-opencode-quota.js
 */

const fs = require('node:fs');
const path = require('node:path');

const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR
  ? path.resolve(process.env.PI_CODING_AGENT_DIR.trim())
  : path.join(require('os').homedir(), '.pi', 'agent');

const AUTH_PATH = path.join(PI_AGENT_DIR, 'auth.json');

function resolveValue(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith('!')) {
    try {
      const { execFileSync } = require('node:child_process');
      return execFileSync('/bin/sh', ['-c', trimmed.slice(1)], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 2000,
      }).trim() || undefined;
    } catch { return undefined; }
  }

  if (trimmed.startsWith('$$')) return trimmed.slice(1);
  if (trimmed.startsWith('$!')) return trimmed.slice(1);
  if (trimmed.startsWith('$')) {
    const name = trimmed.slice(1).replace(/^\{(.*)\}$/, '$1');
    return process.env[name];
  }
  return trimmed;
}

function loadAccounts() {
  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8'));
  } catch { return []; }

  const failover = auth['opencode-go-failover'];
  let rawAccounts = Array.isArray(failover?.accounts) ? failover.accounts : [];
  // A single subscription is configured as pi's own provider entry
  // (`"opencode-go": { "type": "api_key", "key": ... }`) rather than a
  // failover list; use it when there is no failover list.
  if (rawAccounts.length === 0 && auth['opencode-go'] && typeof auth['opencode-go'].key === 'string') {
    rawAccounts = [{ key: auth['opencode-go'].key, label: 'gosingle' }];
  }

  return rawAccounts.map((raw, i) => {
    const key = resolveValue(raw.key);
    return { key, label: String(raw.label || `account-${i + 1}`) };
  }).filter(a => a.key);
}

function windowLabel(kind, accountLabel) {
  const map = { rolling: '5-hour', weekly: 'weekly', monthly: 'monthly' };
  return `${map[kind]} (${accountLabel})`;
}

async function fetchAccountUsage(account, fetchUsageApi) {
  const result = await fetchUsageApi(account.key);
  if (result.error) {
    return { label: account.label, error: result.error };
  }
  return {
    label: account.label,
    rolling: result.rolling,
    weekly: result.weekly,
    monthly: result.monthly,
  };
}

async function main() {
  const { fetchUsageApi } = await import('@juanbenjumea/pi-provider-usage-fetcher/usage-api.ts');

  const accounts = loadAccounts();
  if (accounts.length === 0) {
    console.error('No OpenCode Go accounts with API keys configured');
    process.exit(1);
  }

  const results = await Promise.all(accounts.map(a => fetchAccountUsage(a, fetchUsageApi)));
  const now = Date.now();
  const windows = [];

  for (const acct of results) {
    if (acct.error) {
      windows.push({ label: `error:${acct.label}`, usedPercent: 100, resetDescription: acct.error });
      continue;
    }
    for (const kind of ['rolling', 'weekly', 'monthly']) {
      const w = acct[kind];
      if (!w || !Number.isFinite(w.usagePercent)) continue;
      const resetsAt = w.resetInSec > 0
        ? new Date(now + w.resetInSec * 1000).toISOString()
        : null;
      windows.push({
        label: windowLabel(kind, acct.label),
        usedPercent: w.usagePercent,
        resetsAt,
        resetDescription: w.resetInSec > 0 ? `${w.resetInSec}s` : null,
      });
    }
  }

  const output = {
    provider: 'opencode-go',
    accounts: results.map(r => ({
      label: r.label,
      rolling: r.rolling ? { usedPercent: r.rolling.usagePercent, resetInSec: r.rolling.resetInSec } : null,
      weekly: r.weekly ? { usedPercent: r.weekly.usagePercent, resetInSec: r.weekly.resetInSec } : null,
      monthly: r.monthly ? { usedPercent: r.monthly.usagePercent, resetInSec: r.monthly.resetInSec } : null,
      error: r.error || null,
    })),
    windows,
    updatedAt: new Date().toISOString(),
  };

  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { loadAccounts };
