#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory scripts
# Poll GitHub Actions for main plus every open PR's head branch. Emit each red once, each
# PR's merge-readiness once per head, and one tally when everything in scope is terminal.
# bash 3.2: no associative arrays; state lives in files under $1.
set -uo pipefail
STATE_DIR="${1:-target/watch-ci}"
mkdir -p "$STATE_DIR"
SEEN="$STATE_DIR/seen"          # one "<runid> <conclusion>" per line already reported
READY="$STATE_DIR/ready"        # one "<pr> <headsha>" per line already reported
NOTGATING="$STATE_DIR/notgating"  # one "<branch>:<databaseIds>" per line already reported
touch "$SEEN" "$READY" "$NOTGATING"

scope() {
  { echo main; gh pr list --state open --limit 50 --json headRefName --jq '.[].headRefName' 2>/dev/null; } | sort -u
}

raw_runs() { # branch -> json array of all runs
  gh run list --branch "$1" --limit 60 --json workflowName,status,conclusion,databaseId,headSha,event 2>/dev/null
}

latest_runs() { # branch -> json array of latest run per workflow and event (push or pull_request only)
  # Grouped by event too: a skipped pull_request run must not hide a failed push run of the
  # same workflow. Exits non-zero when gh fails, so a failed read is never taken for "no runs".
  raw_runs "$1" | jq -ec '[.[] | select(.event == "push" or .event == "pull_request")] | group_by([.workflowName, .event]) | map(max_by(.databaseId))' 2>/dev/null
}

non_gating_runs() { # branch -> json array of latest runs that are not push or pull_request
  raw_runs "$1" | jq -c '[.[] | select(.event != "push" and .event != "pull_request")] | group_by(.workflowName) | map(max_by(.databaseId))' 2>/dev/null
}

cycle=0
empty=0
quiet=0
while true; do
  cycle=$((cycle + 1))
  total=0; running=0; red=0; failed=0
  for branch in $(scope); do
    runs=$(latest_runs "$branch") || { failed=1; continue; }
    n=$(echo "$runs" | jq 'length')
    total=$((total + n))
    running=$((running + $(echo "$runs" | jq '[.[] | select(.status != "completed")] | length')))
    echo "$runs" | jq -r '.[] | select(.status == "completed" and (.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "action_required" or .conclusion == "startup_failure")) | "\(.databaseId) \(.conclusion) \(.workflowName)"' \
    | while read -r id concl wf; do
        [ -z "$id" ] && continue

        if ! grep -q "^$id " "$SEEN"; then
          echo "$id $concl" >> "$SEEN"
          [ "$cycle" -gt 1 ] && echo "RED $branch $wf run $id ($concl)"
        fi
      done
    red=$((red + $(echo "$runs" | jq '[.[] | select(.status == "completed" and (.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "action_required" or .conclusion == "startup_failure"))] | length')))

    # Report non-gating runs (workflow_dispatch, schedule, issues, etc.) once per distinct set
    non_gating=$(non_gating_runs "$branch")
    [ -z "$non_gating" ] && continue
    ng=$(echo "$non_gating" | jq 'length')
    if [ "$ng" -gt 0 ]; then
      ng_key=$(echo "$non_gating" | jq -r '.[].databaseId' | sort -n | paste -sd ',' -)
      ng_key_full="$branch:$ng_key"
      if ! grep -q "^$ng_key_full$" "$NOTGATING"; then
        echo "$ng_key_full" >> "$NOTGATING"
        [ "$cycle" -gt 1 ] && echo "NOT GATING $branch: $ng run(s) ($(echo "$non_gating" | jq -r '.[].event' | sort | uniq | paste -sd ',' -))"
      fi
    fi
  done
  if [ "$total" -eq 0 ]; then
    empty=$((empty + 1))
    [ "$empty" -ge 3 ] && { echo "NO DATA after $empty cycles"; exit 1; }
  else
    empty=0
  fi
  # merge-readiness, once per PR per head sha
  gh pr list --state open --limit 50 --json number,headRefName,headRefOid,isDraft --jq '.[] | select(.isDraft | not) | "\(.number) \(.headRefName) \(.headRefOid)"' 2>/dev/null \
  | while read -r num br sha; do
      [ -z "$num" ] && continue
      runs=$(latest_runs "$br")
      [ -z "$runs" ] && continue
      # All latest runs must be on the PR's current head commit
      total=$(echo "$runs" | jq 'length')
      on_head=$(echo "$runs" | jq '[.[] | select(.headSha == "'"$sha"'")] | length')
      # No runs are red/failed
      ok=$(echo "$runs" | jq '[.[] | select(.status != "completed" or .conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "action_required" or .conclusion == "startup_failure")] | length')
      if [ "$on_head" -eq "$total" ] && [ "$ok" -eq 0 ] && ! grep -q "^$num $sha$" "$READY"; then
        echo "$num $sha" >> "$READY"
        echo "MERGEABLE #$num $br ($sha)"
      fi
    done
  if [ "$cycle" -eq 1 ]; then
    echo "SEEDED: $total latest runs in scope, $running in flight, $red red already"
  fi
  if [ "$failed" -eq 1 ]; then
    quiet=0
  elif [ "$running" -eq 0 ]; then
    quiet=$((quiet + 1))
    if [ "$quiet" -ge 2 ]; then
      echo "TALLY: all terminal, $total latest runs, $red red"
      exit 0
    fi
  else
    quiet=0
  fi
  sleep 75
done
