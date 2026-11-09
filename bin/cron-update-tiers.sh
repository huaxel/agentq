#!/usr/bin/env bash
# cron-update-tiers.sh — Update workflow tiers before drain.
# Add to crontab: */15 * * * * $HOME/path/to/agentq/bin/cron-update-tiers.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Runtime data lives in AGENTQ_HOME (default ${XDG_CONFIG_HOME:-~/.config}/agentq).
AGENTQ_HOME_DIR="${AGENTQ_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/agentq}"
mkdir -p "${AGENTQ_HOME_DIR}/data"
LOG="${AGENTQ_HOME_DIR}/data/tier-updates.log"

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) updating tiers" >> "$LOG"
"$SCRIPT_DIR/update-workflow-tiers.sh" >> "$LOG" 2>&1
