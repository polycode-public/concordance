#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026 Polycode Limited

# Prints, and does not run, the one-time AWS and GitHub setup for deploying this repository to
# polycode-sandbox from github.com/polycode-public/concordance. Every command writes to AWS or
# GitHub, so each is the operator's to approve.
#
#   bash scripts/bootstrap-sandbox.sh
#
# Run the printed commands from the repository root.

set -euo pipefail

ACCOUNT=687443513271
REGION=eu-west-2
PROFILE=polycode-sandbox
ROLE=concordance-github-deploy
REPO=polycode-public/concordance

cat <<COMMANDS
# 1. Sign in to the sandbox account and to GitHub.
aws sso login --profile ${PROFILE}
gh auth status

# 2. The GitHub OIDC provider, the deploy role ${ROLE} and its two inline policies.
#    Idempotent; it prints the role ARN and the gh command for step 3.
AWS_PROFILE=${PROFILE} bash infra/provision-github-oidc.sh

# 3. The repository variable the deploy job reads. deploy.yml skips until it exists.
gh variable set CONCORDANCE_DEPLOY_ROLE_ARN --repo ${REPO} \\
  --body arn:aws:iam::${ACCOUNT}:role/${ROLE}

# 4. The sandbox environment, deployable from main only. A job in this environment presents
#    the subject repo:${REPO}:environment:sandbox, which the role trusts.
gh api -X PUT repos/${REPO}/environments/sandbox \\
  -F 'deployment_branch_policy[protected_branches]=false' \\
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/${REPO}/environments/sandbox/deployment-branch-policies \\
  -f name=main -f type=branch

# 5. CDK bootstrap is already present: aws://${ACCOUNT}/${REGION} and aws://${ACCOUNT}/us-east-1,
#    qualifier hnb659fds. This read confirms it; no bootstrap command is needed.
aws cloudformation describe-stacks --profile ${PROFILE} --region ${REGION} \\
  --stack-name CDKToolkit --query 'Stacks[0].StackStatus' --output text

# 6. The cost allocation tag the project budget filters on, in the management account.
aws ce update-cost-allocation-tags-status --profile polycode-management \\
  --cost-allocation-tags-status TagKey=project,Status=Active

# 7. The first deploy.
gh workflow run deploy.yml --repo ${REPO} --ref main
COMMANDS
