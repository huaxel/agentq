#!/usr/bin/env bash
# resolve-model.sh — Quota-aware model resolver for pi-dynamic-workflows.
#
# Usage:
#   ./bin/resolve-model.sh small    # → cheapest eligible model for the tier
#   ./bin/resolve-model.sh medium
#   ./bin/resolve-model.sh big
#   ./bin/resolve-model.sh check "xai/grok-4.5"
#
# Eligibility comes from <home>/config/runnables.json + <home>/data/roi-output.json
# + <home>/data/quota.json (unknown or stale quota is never available), where
# <home> is AGENTQ_HOME (default ${XDG_CONFIG_HOME:-~/.config}/agentq).
# Output is just the model string (e.g., "mistral/deepseek-v4-1-flash-1017") suitable for
# piping into pi-dynamic-workflows tier config or any other tool.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

TIER="${1:-}"
if [ -z "$TIER" ]; then
  echo "Usage: $0 <small|medium|big|check MODEL>" >&2
  exit 1
fi

if [ "$TIER" = "check" ]; then
  MODEL="${2:-}"
  if [ -z "$MODEL" ]; then
    echo "Usage: $0 check MODEL" >&2
    exit 1
  fi
  exec node "$ROOT/src/lib/quota-resolver.js" --check "$MODEL" --json
fi

exec node "$ROOT/src/lib/quota-resolver.js" --tier "$TIER" --json
