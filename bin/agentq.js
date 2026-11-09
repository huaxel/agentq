#!/usr/bin/env node
'use strict';

/**
 * agentq CLI entry point.
 *
 * The implementation lives in src/interfaces/cli/agentq.js. This file is the
 * stable path used by the package "bin" map, the npm scripts, and the MCP
 * dispatcher (which spawns `node bin/agentq.js … run --id …`), so moving the
 * CLI inside src/ does not break any of them.
 */

const { main } = require('../src/interfaces/cli/agentq.js');

main().then((exitCode) => {
  process.exitCode = exitCode ?? 0;
}).catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
