#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright 2026 Polycode Limited
# Prints export lines for the three application inference profile ARNs of the model-profiles
# stack. Use: eval "$(scripts/model-profile-env.sh)"
# STACK, AWS_PROFILE and AWS_REGION override the defaults. bash 3.2.
set -euo pipefail
stack="${STACK:-concordance-sandbox-model-profiles}"
profile="${AWS_PROFILE:-polycode-sandbox}"
region="${AWS_REGION:-eu-west-2}"

output() { # output key -> value
  aws cloudformation describe-stacks --stack-name "$stack" --profile "$profile" --region "$region" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

for pair in CHAT:ChatProfileArn EXTRACT:ExtractProfileArn EMBED:EmbedProfileArn; do
  value="$(output "${pair#*:}")"
  if [ -z "$value" ] || [ "$value" = "None" ]; then
    echo "model-profile-env: output ${pair#*:} missing from $stack" >&2
    exit 1
  fi
  echo "export BEDROCK_${pair%%:*}_PROFILE_ARN=$value"
done
