#!/usr/bin/env node
'use strict';

/**
 * Config loading shared by agentq and the orchestrator.
 *
 * The model ladder that used to live here is gone: auto routing is decided by
 * src/core/routing.js from the runnables list + ROI scores + quota freshness
 * (see src/core/auto-model.js). Only config loading remains.
 *
 * With no explicit path the effective config is the method defaults merged with
 * the user's setup in AGENTQ_HOME (src/lib/home.js).
 */

const path = require('node:path');

const { loadRoiConfig } = require('./home.js');
const { makeLoader } = require('./load.js');

/**
 * @param {string|null} [configPath] an explicit config file; null means
 *   "defaults merged with <home>/config/roi.config.json".
 * @returns {Record<string, any>}
 */
function loadConfig(configPath = null) {
  if (!configPath) return loadRoiConfig();
  const { load } = makeLoader(path.dirname(configPath));
  return load(path.basename(configPath));
}

module.exports = { loadConfig };
