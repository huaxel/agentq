#!/usr/bin/env bash
# pi-issue.sh — compatibility wrapper. The executor is pi-task.sh now; this
# name is kept because docs, skills and supervised scripts invoke it directly
# with an issue number, which pi-task.sh still accepts.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pi-task.sh" "$@"
