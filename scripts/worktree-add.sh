#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory scripts

# Create a git worktree on a new branch and link node_modules from the main checkout.
# Usage: scripts/worktree-add.sh <path> <branch> <base>
# Exits 1 when the node_modules link is missing afterwards, so a test run never
# starts in a worktree without dependencies.

set -e

if [ "$#" -ne 3 ]; then
    echo "Usage: $0 <path> <branch> <base>" >&2
    exit 1
fi

worktree_path="$1"
branch="$2"
base="$3"

git_common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
main_checkout="$(dirname "$git_common_dir")"

git worktree add -b "$branch" "$worktree_path" "$base"

if [ -d "$main_checkout/node_modules" ]; then
    ln -sfn "$main_checkout/node_modules" "$worktree_path/node_modules"
fi

if [ ! -L "$worktree_path/node_modules" ]; then
    echo "ERROR: $worktree_path/node_modules is not a symlink; $main_checkout/node_modules is missing. Run npm ci in $main_checkout first." >&2
    exit 1
fi
