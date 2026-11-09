#!/usr/bin/env bash
# update-workflow-tiers.sh — Regenerate pi-dynamic-workflows model tiers from
# the routing core (<home>/config/runnables.json + ROI scores + quota freshness).
# Run this periodically or before drain.
#
# Usage:
#   ./bin/update-workflow-tiers.sh           # update tiers
#   ./bin/update-workflow-tiers.sh --dry-run # show what would be written
#
# A tier that does not resolve is never replaced by a hard-coded model: the
# existing value for that tier is kept, a warning names the tier and the
# resolver's message, and the script exits non-zero.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
TIERS_FILE="${HOME}/.pi/workflows/model-tiers.json"
RESOLVER="$ROOT/src/lib/quota-resolver.js"
DRY_RUN=false

if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
fi

# Resolve one tier. The model goes to stdout; on failure a warning goes to
# stderr and nothing is printed, so the caller can tell the two apart.
resolve_tier() {
  local tier="$1" err_file model message
  err_file="$(mktemp)"
  if model="$(node "$RESOLVER" --tier "$tier" 2>"$err_file")" && [ -n "$model" ]; then
    rm -f "$err_file"
    printf '%s' "$model"
    return 0
  fi
  message="$(tr '\n' ' ' < "$err_file" | sed -e 's/[[:space:]]*$//')"
  rm -f "$err_file"
  echo "update-workflow-tiers: tier '$tier' did not resolve: ${message:-no model available}" >&2
  echo "  keeping the existing value for '$tier' in $TIERS_FILE" >&2
  return 1
}

SMALL=""
MEDIUM=""
BIG=""
FAILED=0

SMALL="$(resolve_tier small)" || { SMALL=""; FAILED=1; }
MEDIUM="$(resolve_tier medium)" || { MEDIUM=""; FAILED=1; }
BIG="$(resolve_tier big)" || { BIG=""; FAILED=1; }

# Merge resolved tiers over the existing file so a failed tier keeps its value.
merge_args=("$TIERS_FILE")
if [ -n "$SMALL" ]; then merge_args+=("small=$SMALL"); fi
if [ -n "$MEDIUM" ]; then merge_args+=("medium=$MEDIUM"); fi
if [ -n "$BIG" ]; then merge_args+=("big=$BIG"); fi

merged="$(node - "${merge_args[@]}" <<'NODE'
const fs = require('node:fs');
const [file, ...pairs] = process.argv.slice(2);

let existing = {};
if (fs.existsSync(file)) {
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`cannot read existing ${file}: ${error.message}`);
    process.exit(3);
  }
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    console.error(`cannot read existing ${file}: expected a JSON object`);
    process.exit(3);
  }
}

const next = { ...existing };
for (const pair of pairs) {
  const at = pair.indexOf('=');
  next[pair.slice(0, at)] = pair.slice(at + 1);
}
next.updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

const tiers = ['small', 'medium', 'big'].filter((tier) => typeof next[tier] === 'string' && next[tier]);
if (!tiers.length) {
  console.error(`no tier resolved and ${file} has no usable values; refusing to write an empty tiers file`);
  process.exit(4);
}

process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
NODE
)"

if $DRY_RUN; then
  echo "Would write to ${TIERS_FILE}:"
  echo "$merged"
else
  mkdir -p "$(dirname "$TIERS_FILE")"
  printf '%s\n' "$merged" > "$TIERS_FILE"
  echo "Updated ${TIERS_FILE}"
fi

echo ""
echo "Current tiers:"
echo "  small  → ${SMALL:-(unresolved; existing value kept)}"
echo "  medium → ${MEDIUM:-(unresolved; existing value kept)}"
echo "  big    → ${BIG:-(unresolved; existing value kept)}"

if [ "$FAILED" -ne 0 ]; then
  echo "update-workflow-tiers: at least one tier did not resolve; existing values were kept" >&2
  exit 1
fi
