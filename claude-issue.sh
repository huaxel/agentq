#!/usr/bin/env bash
# claude-issue.sh — compatibility wrapper. The executor is claude-task.sh now;
# this name is kept because docs and supervised scripts invoke it directly with
# an issue number, which claude-task.sh still accepts.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/claude-task.sh" "$@"
