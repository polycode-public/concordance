#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory scripts

# Gate git pushes to main: markdown-only changes may go direct, anything else needs a PR.
# Runs as a PreToolUse hook; receives the tool call as JSON on stdin.
set -u

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
[ -z "$cmd" ] && exit 0
printf '%s' "$cmd" | grep -q 'git push' || exit 0

deny() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}
allow() {
  jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:$r}}'
  exit 0
}

repo=${cwd:-.}
branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

targets_main=false
if printf '%s' "$cmd" | grep -qE 'git push[^&|;]*[[:space:]](origin[[:space:]]+main|HEAD:main|main)([[:space:]]|$)'; then
  targets_main=true
elif printf '%s' "$cmd" | grep -qE 'git push([[:space:]]+(-u[[:space:]]+)?origin)?[[:space:]]*$' && [ "$branch" = "main" ]; then
  targets_main=true
fi
[ "$targets_main" = "true" ] || exit 0

# The check below reads commits already ahead of origin/main, so the push must be
# a standalone command; in a compound command the commit would not exist yet.
if printf '%s' "$cmd" | grep -qE '&&|\|\||;'; then
  deny "Push to main must be a standalone command: commit first, then push, so the pushed files can be checked."
fi

files=$(git -C "$repo" diff --name-only origin/main..HEAD 2>/dev/null)
if [ -z "$files" ]; then
  allow "No commits ahead of origin/main; push is a no-op."
fi

nonmd=$(printf '%s\n' "$files" | grep -v -E '\.md$' || true)
if [ -z "$nonmd" ]; then
  allow "Docs-only push to main: every changed file is .md."
else
  deny "Push to main blocked, non-markdown files in the commits: $(printf '%s' "$nonmd" | head -5 | tr '\n' ' '). Open a PR so CI deploys and tests the change."
fi
