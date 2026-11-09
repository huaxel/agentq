#!/usr/bin/env bash
# check-quota.sh — Check quota headroom for a tier or specific model.
#
# Usage:
#   ./check-quota.sh                    # show all tiers with current model + headroom
#   ./check-quota.sh medium             # show details for 'medium' tier
#   ./check-quota.sh check "opencode-go/deepseek-v4-flash"  # check a specific model
#
# Output is human-readable with emoji indicators:
#   ✅  has headroom
#   ⚠️  approaching limit (≥85%)
#   ❌  saturated
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
ROOT="$(cd "$SKILL_DIR/../../.." && pwd)"
QUOTA_RESOLVER="$ROOT/src/lib/quota-resolver.js"

if [ ! -f "$QUOTA_RESOLVER" ]; then
  echo "ERROR: quota-resolver.js not found at $QUOTA_RESOLVER" >&2
  echo "Run this script from within the agentq repo." >&2
  exit 1
fi

show_tier() {
  local tier="$1"
  local result
  result=$(node "$QUOTA_RESOLVER" --tier "$tier" --json 2>/dev/null) || true

  if [ -z "$result" ] || [ "$result" = "null" ]; then
    echo "  ❌ $tier — no model with headroom"
    return
  fi

  local model path headroom source
  model=$(echo "$result" | jq -r '.model // "none"')
  path=$(echo "$result" | jq -r '.path // "?"')
  headroom=$(echo "$result" | jq -r '.headroom // "?"')
  source=$(echo "$result" | jq -r '.source // "?"')

  # Integer comparison: headroom can be fractional (e.g. 60.8) and bash
  # [-ge silently errors on floats, falling through to the saturated branch.
  # Truncate for the comparison; display keeps full precision.
  headroom_int="${headroom%%.*}"
  if [ "$headroom" = "null" ] || [ -z "$headroom" ] || [ "$headroom" = "?" ]; then
    echo "  ⚠️  $tier → $model (path: $path, source: $source, headroom: unknown)"
  elif [ "$headroom_int" -ge 15 ]; then
    echo "  ✅ $tier → $model (path: $path, ${headroom}% headroom)"
  elif [ "$headroom_int" -ge 0 ]; then
    echo "  ⚠️  $tier → $model (path: $path, only ${headroom}% headroom)"
  else
    echo "  ❌ $tier → $model (path: $path, saturated)"
  fi
}

check_model() {
  local model="$1"
  local result
  result=$(node "$QUOTA_RESOLVER" --check "$model" --json 2>/dev/null) || {
    echo "❌ Could not check model: $model"
    return 1
  }

  local path headroom used
  path=$(echo "$result" | jq -r '.path // "?"')
  headroom=$(echo "$result" | jq -r '.headroom // "?"')
  used=$(echo "$result" | jq -r '.usedPercent // "?"')

  echo "Model: $model"
  echo "  Path: $path"
  if [ "$headroom" = "true" ]; then
    echo "  ✅ Has headroom (used: ${used}%)"
  elif [ "$headroom" = "false" ]; then
    echo "  ❌ Saturated (used: ${used}%)"
  else
    echo "  ⚠️  Headroom unknown (used: ${used:-unknown}%)"
  fi
}

# --- Main ---

case "${1:-}" in
  check)
    if [ -z "${2:-}" ]; then
      echo "Usage: $0 check <model-id>" >&2
      exit 1
    fi
    check_model "$2"
    ;;
  "")
    echo "=== Quota Headroom Status ==="
    echo ""
    for tier in small medium big; do
      show_tier "$tier"
    done
    echo ""
    echo "Last updated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "Data source: $ROOT/data/quota.json"
    ;;
  *)
    if [ "$1" = "small" ] || [ "$1" = "medium" ] || [ "$1" = "big" ]; then
      show_tier "$1"
    else
      echo "Usage: $0 [small|medium|big|check <model>]" >&2
      exit 1
    fi
    ;;
esac
