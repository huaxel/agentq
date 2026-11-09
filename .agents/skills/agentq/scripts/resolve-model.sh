#!/usr/bin/env bash
# resolve-model.sh — Resolve a tier to a concrete quota-aware model.
#
# This is the skill-level equivalent of bin/resolve-model.sh, designed for
# agents spawning subagents. Outputs a bare model string suitable for
# passing to subagent or workflow calls.
#
# Usage:
#   ./resolve-model.sh small     # → cheapest small-tier model with headroom
#   ./resolve-model.sh medium    # (e.g. mistral/deepseek-v4-1-flash-1017)
#   ./resolve-model.sh big       # (e.g. openai-codex/gpt-5.6-luna)
#   ./resolve-model.sh           # → resolve 'medium' by default
#
# Concrete outputs depend on live data: config/runnables.json (model -> quota
# path), data/roi-output.json (intelligence/cost) and data/quota.json (freshness).
# Unknown or stale quota is never treated as available.
#
# Set AGENTQ_MODEL_THRESHOLD to override the headroom threshold (default 85).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
QUOTA_RESOLVER="$ROOT/src/lib/quota-resolver.js"

if [ ! -f "$QUOTA_RESOLVER" ]; then
  echo "ERROR: quota-resolver.js not found at $QUOTA_RESOLVER" >&2
  exit 1
fi

TIER="${1:-medium}"
THRESHOLD="${AGENTQ_MODEL_THRESHOLD:-85}"

# Check if quota data exists
if [ ! -f "$ROOT/data/quota.json" ]; then
  echo "ERROR: No quota data found. Run 'npm run collect-quota' first." >&2
  exit 1
fi

result=$(node "$QUOTA_RESOLVER" --tier "$TIER" --threshold "$THRESHOLD" --json 2>/dev/null) || {
  echo "ERROR: Failed to resolve tier '$TIER'" >&2
  echo "  Check that quota.json has data and the tier name is valid (small/medium/big)." >&2
  exit 1
}

model=$(echo "$result" | jq -r '.model // empty')

if [ -z "$model" ]; then
  echo "ERROR: No model available for auto routing (tier '$TIER')" >&2
  echo "  Every runnable may be saturated, unscored, or have stale quota. Try a different tier or lower threshold." >&2
  exit 1
fi

echo "$model"
