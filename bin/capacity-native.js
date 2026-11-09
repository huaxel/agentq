#!/usr/bin/env node
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const { homedir } = require('node:os');
const fs = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const { createHash } = require('node:crypto');
// Reviewed pi-agy 0.7.6 pure leaf. Updating this pin requires source review.
const REVIEWED_PARSER_SHA256 = 'c015a72f19263b7c13ea277c0b251379cf13cac62b6c90fbf0a54e22719215d0';
const { withHelperDeadline } = require('./capacity-live.js');
const { observeAgyQuota } = require('../src/lib/capacity-native-quota.js');
const ownedGroups = new Set();

function killGroup(pid) {
  try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch { /* Already exited. */ }
}
process.once('exit', () => { for (const pid of ownedGroups) killGroup(pid); });
process.once('SIGTERM', () => process.exit(1));
process.once('SIGINT', () => process.exit(1));

function runAgy(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('agy', args, { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'ignore'] });
    if (child.pid) ownedGroups.add(child.pid);
    const chunks = [];
    let bytes = 0;
    let failed = false;
    const fail = () => { failed = true; if (child.pid) killGroup(child.pid); };
    const timer = setTimeout(fail, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) fail();
      else chunks.push(chunk);
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error('native-command-unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (child.pid) { killGroup(child.pid); ownedGroups.delete(child.pid); }
      if (failed || code !== 0) reject(new Error('native-command-failed'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

async function main() {
  return withHelperDeadline(async () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), '.pi', 'agent');
    // Import only the reviewed pure parser, not the extension or routing policy.
    const parser = require.resolve('@juanbenjumea/pi-agy/extensions/lib/usage.ts', { paths: [path.join(agentDir, 'npm')] });
    // Node intentionally refuses automatic TS stripping inside node_modules.
    // This reviewed leaf has no imports; explicitly strip it without loading
    // Pi, the extension, SDK dependencies or its provider/routing registration.
    const bytes = fs.readFileSync(parser);
    if (createHash('sha256').update(bytes).digest('hex') !== REVIEWED_PARSER_SHA256) throw new Error('native-parser-unreviewed');
    const source = stripTypeScriptTypes(bytes.toString('utf8'));
    const { parseAgyUsage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const result = await observeAgyQuota({ run: runAgy, parseUsage: parseAgyUsage });
    await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(result), error => error ? reject(error) : resolve()));
  });
}
if (require.main === module) main().then(() => process.exit(0), () => process.exit(1));
module.exports = { main, runAgy };
