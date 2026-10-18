#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026 Polycode Limited

# Provisions the GitHub OIDC provider and the deploy role in polycode-sandbox (687443513271).
# Idempotent: every step reads before it writes. Run from the repository root after
# `aws sso login --profile polycode-sandbox`:
#
#   bash infra/provision-github-oidc.sh
#
# The role's permissions are two inline policies:
#   assume-cdk-bootstrap-roles  sts:AssumeRole on cdk-hnb659fds-* only; the CDK roles deploy.
#   concordance-operations      the reads and the kill-switch write the workflows make
#                               outside CDK (stack describe, the agent kill switch, Bedrock
#                               for the agent workflows).
# The trust lets in polycode-public/concordance's main branch and its sandbox environment
# only. A job that names `environment: sandbox` presents the environment subject, so the
# environment's deployment-branch rule (main only) is part of the trust.
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-polycode-sandbox}"
export AWS_REGION=eu-west-2
ACCOUNT=687443513271
REPO=polycode-public/concordance
ROLE=concordance-github-deploy
TP=infra/iam-trust-policies
PROVIDER_URL=https://token.actions.githubusercontent.com
PROVIDER_ARN="arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"

caller=$(aws sts get-caller-identity --query Account --output text)
if [ "$caller" != "$ACCOUNT" ]; then
  echo "profile ${AWS_PROFILE} is account ${caller}, not ${ACCOUNT}; stopping" >&2
  exit 1
fi
echo "account ${ACCOUNT} via profile ${AWS_PROFILE}"

# 1. The GitHub OIDC provider.
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then
  echo "oidc provider present: ${PROVIDER_ARN}"
else
  aws iam create-open-id-connect-provider --url "$PROVIDER_URL" \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1c58a3a8518e8759bf075b76b750d4f2df264fcd \
    >/dev/null
  echo "oidc provider created: ${PROVIDER_ARN}"
fi

# 2. The deploy role and its trust.
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE" \
    --policy-document "file://${TP}/github-oidc-deploy-role.json" >/dev/null
  echo "role present, trust updated: ${ROLE}"
else
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document "file://${TP}/github-oidc-deploy-role.json" \
    --max-session-duration 3600 \
    --tags Key=project,Value=concordance Key=env,Value=sandbox \
    --description "GitHub Actions deploys of ${REPO} (main and the sandbox environment only)" \
    >/dev/null
  echo "role created: ${ROLE}"
fi

# 3. Its permissions. put-role-policy replaces a policy of the same name, so a re-run is safe.
aws iam put-role-policy --role-name "$ROLE" \
  --policy-name assume-cdk-bootstrap-roles \
  --policy-document "file://${TP}/github-deploy-assume-cdk-roles.json"
aws iam put-role-policy --role-name "$ROLE" \
  --policy-name concordance-operations \
  --policy-document "file://${TP}/github-deploy-operations.json"
echo "inline policies set: assume-cdk-bootstrap-roles, concordance-operations"

ROLE_ARN=$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)
echo
echo "role arn: ${ROLE_ARN}"
echo "set the repository variable the deploy and agent workflows read:"
echo "  gh variable set CONCORDANCE_DEPLOY_ROLE_ARN --repo ${REPO} --body ${ROLE_ARN}"
