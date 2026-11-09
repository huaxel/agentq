'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildCapacityView, parsePiCatalog, validateInventory } = require('./capacity-view.js');
const { observeNative } = require('./native-observations.js');

function executableExists(name) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return false;
  return (process.env.PATH || '').split(path.delimiter).some(directory => {
    if (!directory) return false;
    try {
      const file = path.join(directory, name);
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch { return false; }
  });
}

function collectCapacity(inventory, { snapshot = null, machine, cwd, offline = false, catalogText = null } = {}) {
  validateInventory(inventory);
  const installed = new Set(inventory.paths.filter(p => executableExists(p.harness)).map(p => p.harness));
  let piModels = catalogText === null ? null : parsePiCatalog(catalogText);
  if (catalogText === null && !offline && installed.has('pi')) {
    try {
      piModels = parsePiCatalog(execFileSync('pi', ['--list-models'], {
        cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }));
    } catch { /* Observation failure is unknown; no CLI diagnostics forwarded. */ }
  }
  const localNative = new Set(inventory.paths
    .filter(p => (p.machine === 'local' || p.machine === machine) && p.catalog !== 'pi' && installed.has(p.harness))
    .map(p => p.harness));
  const nativeObservations = offline ? {} : observeNative(localNative, { cwd });
  return buildCapacityView(inventory, { installed, snapshot, piModels, nativeObservations, machine });
}

module.exports = { collectCapacity, executableExists };
