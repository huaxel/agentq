#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hostname } = require('node:os');
const { mergeObservations } = require('../src/lib/capacity-observations.js');
const { validateInventory } = require('../src/lib/capacity-view.js');
const { collectCapacity, executableExists } = require('../src/lib/capacity-collect.js');
const { selectMachines, readMachineCatalog, collectRemote } = require('../src/lib/capacity-remote.js');
const { fetchLiveQuota, applyLiveQuota, fetchNativeQuota, fetchNativeDaemon } = require('../src/lib/capacity-live-client.js');
const { applyNativeQuota } = require('../src/lib/capacity-native-quota.js');
const { unknownDaemon } = require('../src/lib/capacity-codex-daemon.js');
const { homeConfigPath, homeDataPath } = require('../src/lib/home.js');
const ROOT = path.join(__dirname, '..');

function readJson(file, optional = false) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw new Error(`Cannot read valid JSON: ${file}`);
  }
}

function main(args = process.argv.slice(2)) {
  const options = { inventory: homeConfigPath('execution-paths.json'), quota: homeDataPath('quota.json'), machine: hostname() };
  const observationFiles = [];
  const machineSelectors = [];
  let offline = false;
  let liveQuota = false;
  let nativeQuota = false;
  let nativeDaemon = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') {
      console.log('Usage: node bin/capacity.js [--offline] [--inventory PATH] [--quota PATH] [--catalog-file PATH] [--machine ID] [--merge FILE ...] [--collect HERDR-ID-OR-LABEL ...] [--live-quota] [--native-quota agy] [--native-daemon codex]\n--native-daemon codex explicitly reads an existing local Codex daemon; no startup or lifecycle changes, separate nativeServices facts, no execution-path entitlement.\n--native-quota agy explicitly queries local version-guarded AGY /usage; separate pools, no entitlement or aggregate availability claim.\n--live-quota explicitly queries local Go/Openference usage via existing credentials; sanitized facts only, no snapshot writes.\n--collect may repeat; explicitly observes saved enabled Herdr machines over existing SSH targets, no installs.\n--merge may repeat; merge mode reads only observation files and performs no subprocess probes.\nJSON facts only; no selection, dispatch, snapshot writes, profile changes or inference.\nDefault probes pi --list-models, agy models and codex login status. Offline skips all subprocess probes. Native catalog listing does not prove model entitlement.');
      return;
    }
    if (arg === '--offline') { offline = true; continue; }
    if (arg === '--live-quota') { liveQuota = true; continue; }
    if (arg === '--native-daemon') {
      if (args[++i] !== 'codex') throw new Error('--native-daemon currently supports codex only');
      nativeDaemon = true;
      continue;
    }
    if (arg === '--native-quota') {
      if (args[++i] !== 'agy') throw new Error('--native-quota currently supports agy only');
      nativeQuota = true;
      continue;
    }
    if (arg === '--collect') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing Herdr machine selector');
      machineSelectors.push(args[++i]);
      continue;
    }
    if (arg === '--merge') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing observation file');
      observationFiles.push(args[++i]);
      continue;
    }
    const key = { '--inventory': 'inventory', '--quota': 'quota', '--catalog-file': 'catalog', '--machine': 'machine' }[arg];
    if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown option or missing value; use --help');
    options[key] = args[++i];
  }
  if (nativeDaemon && (offline || observationFiles.length)) throw new Error('--native-daemon cannot be combined with --offline or --merge');
  if (nativeQuota && (offline || observationFiles.length)) throw new Error('--native-quota cannot be combined with --offline or --merge');
  if (liveQuota && (offline || observationFiles.length)) throw new Error('--live-quota cannot be combined with --offline or --merge');
  if (machineSelectors.length && (offline || observationFiles.length)) throw new Error('--collect cannot be combined with --offline or --merge');
  if (machineSelectors.length && process.env.HERDR_ENV !== '1') throw new Error('Run saved-machine collection inside Herdr');
  const selectedMachines = machineSelectors.length ? selectMachines(readMachineCatalog(), machineSelectors) : [];
  if (observationFiles.length) {
    const reports = observationFiles.map(file => {
      try { if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error('oversize'); }
      catch { throw new Error('Cannot read bounded capacity observation file'); }
      return readJson(file);
    });
    console.log(JSON.stringify(mergeObservations(reports), null, 2));
    return;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(options.machine) || options.machine === 'local') throw new Error('Use a concrete machine ID, not local');
  const inventory = readJson(options.inventory);
  validateInventory(inventory);
  const snapshot = readJson(options.quota, true);
  let catalogText = null;
  if (options.catalog) {
    try { catalogText = fs.readFileSync(options.catalog, 'utf8'); }
    catch { throw new Error('Cannot read catalog file'); }
  }
  const local = collectCapacity(inventory, { snapshot, machine: options.machine, cwd: ROOT, offline, catalogText });
  if (liveQuota) applyLiveQuota(local, fetchLiveQuota(ROOT));
  if (nativeQuota) applyNativeQuota(local, fetchNativeQuota(ROOT));
  const nativeServices = nativeDaemon ? [{ ...(fetchNativeDaemon(ROOT) ?? unknownDaemon()), machine: options.machine }] : [];
  if (nativeDaemon) local.nativeServices = nativeServices;
  if (!selectedMachines.length) {
    console.log(JSON.stringify(local, null, 2));
    return;
  }
  const reports = [local];
  const collection = [];
  for (const profile of selectedMachines) {
    const result = collectRemote(profile, inventory);
    collection.push(result.collection);
    if (result.report) {
      try { mergeObservations([result.report]); reports.push(result.report); }
      catch { collection[collection.length - 1] = { ...result.collection, status: 'unknown', reason: 'invalid-remote-observation' }; }
    }
  }
  console.log(JSON.stringify({ ...mergeObservations(reports), collection, ...(nativeDaemon ? { nativeServices } : {}) }, null, 2));
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main, executableExists };
