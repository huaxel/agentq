#!/usr/bin/env bash
# update-subagent-models.sh — Update Pi subagent models based on live quota.
#
# Reads provider headroom from agentq's quota data, resolves the best model
# for each agent role, and writes the result into Pi settings.json as
# subagents.agentOverrides.
#
# Run manually or hook into cron alongside update-workflow-tiers.sh:
#   ./bin/update-subagent-models.sh
#
# Then reload Pi: /reload

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
SETTINGS="${HOME}/dotfiles/pi/agent/settings.json"

if [ ! -f "$SETTINGS" ]; then
  echo "ERROR: Pi settings.json not found at $SETTINGS" >&2
  exit 1
fi

# Map agent role → resolver tier
# Adjust tiers as your quality/cost tradeoffs evolve
declare -A TIERS
TIERS[worker]="small"
TIERS[disciplined-worker]="medium"
TIERS[reviewer]="big"

# Resolve model for each role
UPDATES="{}"
ANY_MODEL=false
for role in worker disciplined-worker reviewer; do
  tier="${TIERS[$role]}"
  result=$("${SCRIPT_DIR}/resolve-model.sh" "$tier" 2>/dev/null || echo '{"model":null}')
  model=$(echo "$result" | jq -r '.model // empty')
  if [ -n "$model" ]; then
    UPDATES=$(echo "$UPDATES" | jq \
      --arg role "$role" \
      --arg model "$model" \
      '. + {($role): {"model": $model}}')
    ANY_MODEL=true
  fi
done

if [ "$ANY_MODEL" = false ]; then
  echo "ERROR: No models resolved — did agentq quota data get generated?" >&2
  exit 1
fi

# Merge agentOverrides into settings.json, preserving existing keys
jq --argjson overrides "$UPDATES" \
  '.subagents.agentOverrides = (.subagents.agentOverrides // {}) * $overrides' \
  "$SETTINGS" > "${SETTINGS}.tmp" && mv "${SETTINGS}.tmp" "$SETTINGS"

echo "✓ Updated subagents.agentOverrides in $SETTINGS"
echo "  Run /reload in Pi to apply."
echo ""
echo "$UPDATES" | jq '.'
