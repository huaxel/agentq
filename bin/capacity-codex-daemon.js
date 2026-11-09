#!/usr/bin/env node
'use strict';
const { withHelperDeadline } = require('./capacity-live.js');
// Use the reviewed pure-JS transport and Node's built-in UTF-8 validation.
process.env.WS_NO_BUFFER_UTIL = '1';
process.env.WS_NO_UTF_8_VALIDATE = '1';
const { observeCodexDaemon } = require('../src/lib/capacity-codex-daemon.js');
process.once('SIGTERM', () => process.exit(1));
process.once('SIGINT', () => process.exit(1));
async function main() {
  return withHelperDeadline(async () => {
    const report = await observeCodexDaemon();
    await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(report), error => error ? reject(error) : resolve()));
  });
}
if (require.main === module) main().then(() => process.exit(0), () => process.exit(1));
module.exports = { main };
