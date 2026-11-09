'use strict';
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { summarizeQuota } = require('./capacity-view.js');

function fetchLiveQuota(root, { run = spawnSync } = {}) {
  try {
    const result = run(process.execPath, [path.join(root, 'bin', 'capacity-live.js')], {
      cwd: root, encoding: 'utf8', timeout: 25000, maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!result.error && result.status === 0) return JSON.parse(result.stdout);
  } catch { /* Auth, HTTP and helper diagnostics never leave this boundary. */ }
  return {};
}

function applyLiveQuota(view, live) {
  const byProvider = { 'opencode-go': 'go', openference: 'openference' };
  for (const execution of view.paths) {
    if (execution.machine !== view.observedMachine) continue;
    const key = byProvider[execution.provider];
    if (!key) continue;
    const fact = live?.[key];
    execution.quota = fact && fact.bucket === key && ['unknown', 'exhausted', 'headroom-observed'].includes(fact.state)
      ? fact : { ...summarizeQuota(null, key), source: 'live-provider-usage', reason: 'live-observation-unavailable' };
  }
  return view;
}
function fetchNativeQuota(root, { run = spawnSync } = {}) {
  try {
    const result = run(process.execPath, ['--experimental-strip-types', path.join(root, 'bin', 'capacity-native.js')], {
      cwd: root, encoding: 'utf8', timeout: 25000, maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!result.error && result.status === 0) return JSON.parse(result.stdout);
  } catch { /* Native diagnostics and private usage never leave the helper. */ }
  return null;
}
function fetchNativeDaemon(root, { run = spawnSync } = {}) {
  try {
    const result = run(process.execPath, [path.join(root, 'bin', 'capacity-codex-daemon.js')], {
      cwd: root, encoding: 'utf8', timeout: 25000, maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!result.error && result.status === 0) return JSON.parse(result.stdout);
  } catch { /* Daemon diagnostics and private protocol fields stay private. */ }
  return null;
}
module.exports = { fetchLiveQuota, applyLiveQuota, fetchNativeQuota, fetchNativeDaemon };
