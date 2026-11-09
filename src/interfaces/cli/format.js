'use strict';

/**
 * Pure formatting and presentation helpers for the agentq CLI: model/capacity
 * rows, job summary blocks, and cost formatting. No I/O; every function is
 * exported for direct testing.
 *
 * Model rows are built from the routing core's own inputs (catalog + capacity)
 * so the CLI can never show a model the router would not consider.
 */

const path = require('node:path');
const { capacityFor } = require('../../core/capacity.js');

/**
 * @param {import('../../core/capacity.js').CapacityEntry|undefined} entry
 * @returns {string}
 */
function capacityText(entry) {
  if (!entry || entry.state === 'unknown') return `unknown (${(entry && entry.reason) || 'no data'})`;
  if (entry.state === 'saturated') return `saturated (${entry.headroomPct}% left)`;
  return entry.headroomPct == null ? 'available' : `available (${entry.headroomPct}% left)`;
}

/**
 * Join catalog entries with capacity and the routing decision.
 *
 * @param {{
 *   catalog?: import('../../core/catalog.js').CatalogEntry[],
 *   capacity?: Map<string, import('../../core/capacity.js').CapacityEntry>|null,
 *   decision?: { choice: any, rejected: any[] }|null,
 * }} [input]
 * @returns {Array<{ model: string, path: string, intelligence: number|null, costPerMTok: number|null, capacity: any, recommended: boolean, reasons: string[] }>}
 */
function buildModelRows({ catalog = [], capacity = null, decision = null } = {}) {
  const recommendedId = decision && decision.choice ? decision.choice.id : null;
  const rejected = new Map(((decision && decision.rejected) || []).map((item) => [item.id, item.reasons || []]));

  return catalog.map((entry) => {
    const recommended = entry.id === recommendedId;
    const reasons = rejected.get(entry.id) ?? (recommended ? decision.choice.reasons || [] : []);
    return {
      model: entry.id,
      path: entry.path,
      intelligence: entry.intelligence,
      intelligenceSource: entry.intelligenceSource ?? null,
      costPerMTok: entry.costPerMTok,
      costSource: entry.costSource ?? null,
      capacity: capacityFor(capacity, entry.path),
      recommended,
      reasons,
    };
  });
}

/**
 * @param {ReturnType<typeof buildModelRows>[number]} row
 * @param {number|string} index
 * @returns {string}
 */
function formatModelRow(row, index) {
  // An AA-derived estimate is marked `~` so it is never read as a real score.
  const intel = row.intelligence == null
    ? '—'
    : row.intelligenceSource === 'aa-estimate' ? `~${row.intelligence.toFixed(1)}` : row.intelligence.toFixed(1);
  // An AA list price is marked `~` like the estimate it travels with.
  const cost = row.costPerMTok == null
    ? '—'
    : row.costSource === 'aa-price' ? `~$${row.costPerMTok.toFixed(2)}` : `$${row.costPerMTok.toFixed(2)}`;
  const mark = row.recommended ? '→' : ' ';
  const note = row.recommended ? 'recommended' : ((row.reasons || []).at(-1) || 'eligible');
  return `  ${mark} ${index}  ${row.model.padEnd(44)} ${(row.path || '—').padEnd(12)} ${intel.padStart(5)} ${cost.padStart(7)}  ${capacityText(row.capacity).padEnd(30)} ${note}`;
}

/**
 * @param {{
 *   catalog?: import('../../core/catalog.js').CatalogEntry[],
 *   capacity?: Map<string, import('../../core/capacity.js').CapacityEntry>|null,
 *   decision?: { choice: any, rejected: any[], policy?: { floor: number } }|null,
 *   title?: string,
 * }} [input]
 * @returns {string}
 */
function formatModelTable({ catalog = [], capacity = null, decision = null, title = 'models' } = {}) {
  const floor = decision && decision.policy ? ` (intelligence floor ${decision.policy.floor})` : '';
  const lines = [
    `${title} — auto = cheapest eligible first${floor}`,
    '',
    `  #  ${'model'.padEnd(44)} ${'path'.padEnd(12)} ${'intel'.padStart(5)} ${'$/MTok'.padStart(7)}  capacity`,
  ];
  buildModelRows({ catalog, capacity, decision }).forEach((row, i) => lines.push(formatModelRow(row, i + 1)));
  return lines.join('\n');
}

function truncateRepo(repoPath) {
  return path.basename(repoPath || '');
}

function formatCost(usageJson) {
  if (!usageJson) return null;
  let usage;
  try { usage = JSON.parse(usageJson); } catch { return null; }
  const cost = usage.totalCost ?? usage.cost;
  if (typeof cost !== 'number') return null;
  return `$${cost.toFixed(4)}`;
}

function formatJobBlock(job) {
  const repo = truncateRepo(job.repo_path);
  const verify = job.verified === 1 ? ' ✓ verified' : job.verified === 0 ? ' ✗ tests failed' : '';
  const exitInfo = job.exit_code != null && job.exit_code !== 0 ? ` · exit=${job.exit_code}` : '';
  const lines = [
    `#${job.id}  ${job.status}${verify}${exitInfo}`,
    `    ${repo}#${job.issue_number}  ·  ${job.model}`,
  ];
  if (job.input_error) lines.push(`    input: ${job.input_error}`);
  if (job.branch) lines.push(`    branch: ${job.branch}`);
  const cost = formatCost(job.usage_json);
  if (cost) lines.push(`    cost: ${cost}`);
  if (job.worktree_path) lines.push(`    worktree: ${job.worktree_path}`);
  if (job.log_path) lines.push(`    log: ${job.log_path}`);
  return lines.join('\n');
}

function summarizeCosts(jobs) {
  let total = 0;
  let count = 0;
  for (const j of jobs) {
    if (!j.usage_json) continue;
    let parsed;
    try { parsed = JSON.parse(j.usage_json); } catch { continue; }
    const cost = parsed.totalCost ?? parsed.cost ?? null;
    if (typeof cost !== 'number') continue;
    total += cost;
    count += 1;
  }
  return { jobs: count, total: Math.round(total * 10000) / 10000 };
}

module.exports = {
  capacityText,
  buildModelRows,
  formatModelRow,
  formatModelTable,
  truncateRepo,
  formatCost,
  formatJobBlock,
  summarizeCosts,
};
