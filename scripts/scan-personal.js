#!/usr/bin/env node
'use strict';
/**
 * scan-personal.js — guard against personal traces in tracked files.
 *
 * The deny list is deliberately NOT tracked: it names real hosts, accounts and
 * home paths, so it lives outside the repository (e.g.
 * `~/agentq-denylist.txt`, one literal term per line, `#` comments allowed).
 *
 * Usage:
 *   node scripts/scan-personal.js --deny ~/agentq-denylist.txt
 *   AGENTQ_DENY_LIST=~/agentq-denylist.txt node scripts/scan-personal.js
 *
 * Scans `git ls-files` (skipping package-lock.json), prints `file:line: term`
 * for every match and exits 1. Without a deny list it prints usage and exits 0,
 * so it is safe to wire into a pipeline before the list exists.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const USAGE = `Usage: node scripts/scan-personal.js --deny <file>
       AGENTQ_DENY_LIST=<file> node scripts/scan-personal.js

<file> lists one literal term per line ('#' starts a comment). The deny list
must stay outside the repository: it contains the personal names it guards.`;

const SKIP_FILES = new Set(['package-lock.json']);

function parseArgs(argv) {
  let denyPath = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--deny') {
      denyPath = argv[++i];
      if (!denyPath) throw new Error('--deny requires a file path');
    } else if (arg.startsWith('--deny=')) {
      denyPath = arg.slice('--deny='.length);
    } else if (arg === '--help' || arg === '-h') {
      return { help: true, denyPath: null };
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { help: false, denyPath: denyPath || process.env.AGENTQ_DENY_LIST || null };
}

/**
 * Read deny-list terms. Blank lines and `#` comments are ignored; terms are
 * matched case-insensitively as literal substrings.
 * @param {string} file
 * @returns {string[]}
 */
function readDenyList(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.toLowerCase());
}

/**
 * Tracked files to scan: everything `git ls-files` reports except lockfiles.
 * @param {string} cwd
 * @returns {string[]}
 */
function trackedFiles(cwd) {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' });
  return out
    .split('\0')
    .filter(Boolean)
    .filter(file => !SKIP_FILES.has(path.basename(file)))
    .filter(file => fs.existsSync(path.join(cwd, file)));
}

/**
 * Find every deny-list hit in the given files.
 * @param {string} cwd
 * @param {string[]} files
 * @param {string[]} terms  lowercased literal terms
 * @returns {Array<{file: string, line: number, term: string}>}
 */
function scanFiles(cwd, files, terms) {
  const hits = [];
  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(cwd, file), 'utf8');
    } catch {
      continue;  // unreadable/binary — nothing to leak as text
    }
    if (content.includes('\0')) continue;  // binary
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      for (const term of terms) {
        if (lower.includes(term)) hits.push({ file, line: i + 1, term });
      }
    }
  }
  return hits;
}

function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    return 1;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  if (!parsed.denyPath) {
    console.log(USAGE);
    return 0;
  }
  let terms;
  try {
    terms = readDenyList(parsed.denyPath);
  } catch (err) {
    console.error(`cannot read deny list ${parsed.denyPath}: ${err.message}`);
    return 1;
  }
  if (!terms.length) {
    console.error(`deny list ${parsed.denyPath} has no terms`);
    return 0;
  }
  const cwd = process.cwd();
  const hits = scanFiles(cwd, trackedFiles(cwd), terms);
  for (const hit of hits) console.log(`${hit.file}:${hit.line}: ${hit.term}`);
  if (hits.length) {
    console.error(`${hits.length} personal trace(s) found in tracked files`);
    return 1;
  }
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parseArgs, readDenyList, trackedFiles, scanFiles, SKIP_FILES };
