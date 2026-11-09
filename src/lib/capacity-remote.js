'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function selectMachines(catalog, selectors) {
  if (!Array.isArray(catalog) || catalog.length > 100 || !Array.isArray(selectors) || selectors.length > 10) throw new Error('Invalid machine collection request');
  const selected = [];
  for (const selector of selectors) {
    const matches = catalog.filter(p => p.id === selector || p.label === selector);
    if (matches.length !== 1) throw new Error('Machine selector is missing or ambiguous');
    const profile = matches[0];
    if (profile.enabled !== true || typeof profile.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(profile.id) ||
        typeof profile.target !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,255}$/.test(profile.target) || typeof profile.label !== 'string') {
      throw new Error('Machine must be enabled with a valid saved SSH target');
    }
    if (!selected.some(p => p.id === profile.id)) selected.push({ id: profile.id, label: profile.label, target: profile.target });
  }
  return selected;
}

function readMachineCatalog({ run = spawnSync } = {}) {
  const result = run('herdr', ['machine', 'list', '--json'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error('Cannot read Herdr machine catalog');
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('Invalid Herdr machine catalog'); }
}

function portableObserver(inventory, machine, offline = false) {
  const names = ['capacity-view.js', 'native-observations.js', 'capacity-collect.js'];
  const wrappers = names.map(name => `${JSON.stringify(name)}: function(require, module, exports) {\n${fs.readFileSync(path.join(__dirname, name), 'utf8')}\n}`).join(',\n');
  // Only reviewed repository modules are code. Inventory is JSON data. No
  // imported report or shell target is evaluated as source or shell syntax.
  return `'use strict';
const factories = {${wrappers}};
const cache = {};
function load(name) {
  if (name.startsWith('node:')) return require(name);
  const key = name.startsWith('./') ? name.slice(2) : name;
  if (!Object.hasOwn(factories, key)) throw new Error('Unsupported observer module');
  if (!cache[key]) { cache[key] = { exports: {} }; factories[key](load, cache[key], cache[key].exports); }
  return cache[key].exports;
}
const fs = require('node:fs');
const path = require('node:path');
const homeDir = require('node:os').homedir();
const root = process.env.AGENTQ_ROOT || path.join(homeDir, 'projects', 'agentq');
const agentqHome = process.env.AGENTQ_HOME || path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'agentq');
let snapshot = null;
let quotaRead = 'missing';
try { snapshot = JSON.parse(fs.readFileSync(path.join(agentqHome, 'data', 'quota.json'), 'utf8')); quotaRead = 'read'; }
catch { /* No collector contents or errors are sent over the transport. */ }
const cwd = fs.existsSync(root) ? root : homeDir;
const view = load('capacity-collect.js').collectCapacity(${JSON.stringify(inventory)}, { snapshot, machine: ${JSON.stringify(machine)}, cwd, offline: ${JSON.stringify(offline)} });
view.quotaObservation = quotaRead;
process.stdout.write(JSON.stringify(view));
`;
}

function collectRemote(profile, inventory, { run = spawnSync, offline = false } = {}) {
  if (!profile || typeof profile.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(profile.id) ||
      typeof profile.target !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,255}$/.test(profile.target)) throw new Error('Invalid saved SSH profile');
  const machine = `herdr-${profile.id}`;
  const collection = { machine, profileId: profile.id, label: profile.label, status: 'unknown', reason: 'remote-observation-failed' };
  try {
    const result = run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5', profile.target, 'node -'], {
      input: portableObserver(inventory, machine, offline), encoding: 'utf8', timeout: 100000,
      maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) return { report: null, collection };
    const report = JSON.parse(result.stdout);
    if (report.observedMachine !== machine) return { report: null, collection: { ...collection, reason: 'remote-identity-mismatch' } };
    return { report, collection: { ...collection, status: 'observed', reason: 'existing-ssh-target-portable-observer' } };
  } catch { return { report: null, collection }; }
}

module.exports = { selectMachines, readMachineCatalog, portableObserver, collectRemote };
