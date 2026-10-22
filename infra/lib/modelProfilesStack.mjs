// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

// One Bedrock application inference profile per model, tagged project=<project>. A call that
// names the profile's ARN bills to the profile, so Cost Explorer shows the cost allocation tag on
// the model line and the project budget sees model spend. The Claude profiles copy the EU
// cross-Region system profiles, so the regional price and the routing stay as they were; the
// embedding profile copies the Titan foundation model in this stack's Region.

import { CfnOutput, Stack, Tags } from "aws-cdk-lib";
import * as bedrock from "aws-cdk-lib/aws-bedrock";

/** The model names the rows record and the price table reads; also the batch job's model id. */
export const CHAT_MODEL = "eu.anthropic.claude-sonnet-4-5-20250929-v1:0";
export const EXTRACT_MODEL = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
export const EMBED_MODEL = "amazon.titan-embed-text-v2:0";

/** The foundation model behind a model id: a geography prefix such as `eu.` comes off. */
export const foundationModelOf = (modelId) =>
  /^(eu|us|jp|au|global)\./.test(modelId) ? modelId.slice(modelId.indexOf(".") + 1) : modelId;

export class ModelProfilesStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { envName, project } = props;
    if (!envName || !project) throw new Error("ModelProfilesStack needs envName and project");

    const systemProfileArn = (modelId) =>
      `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${modelId}`;
    const profile = (logicalId, kind, modelId, copyFrom) => {
      const resource = new bedrock.CfnApplicationInferenceProfile(this, logicalId, {
        inferenceProfileName: `${project}-${envName}-${kind}`,
        description: `${project} ${envName} ${kind} model tagged for cost allocation`,
        modelSource: { copyFrom },
        tags: [
          { key: "project", value: project },
          { key: project, value: envName },
        ],
      });
      new CfnOutput(this, `${logicalId}Arn`, { value: resource.attrInferenceProfileArn });
      return { arn: resource.attrInferenceProfileArn, modelId };
    };

    this.chat = profile("ChatProfile", "chat", CHAT_MODEL, systemProfileArn(CHAT_MODEL));
    this.extract = profile(
      "ExtractProfile",
      "extract",
      EXTRACT_MODEL,
      systemProfileArn(EXTRACT_MODEL),
    );
    this.embed = profile(
      "EmbedProfile",
      "embed",
      EMBED_MODEL,
      `arn:aws:bedrock:${this.region}::foundation-model/${EMBED_MODEL}`,
    );
    Tags.of(this).add("project", project);
  }
}

/**
 * The environment variables that point a Lambda's model calls at the profiles.
 * @param {{ chat?: boolean, extract?: boolean, embed?: boolean }} uses
 * @param {{ chat: { arn: string }, extract: { arn: string }, embed: { arn: string } }} profiles
 */
export function profileEnvironment(profiles, { chat = false, extract = false, embed = false }) {
  return {
    ...(chat && { BEDROCK_CHAT_PROFILE_ARN: profiles.chat.arn }),
    ...(extract && { BEDROCK_EXTRACT_PROFILE_ARN: profiles.extract.arn }),
    ...(embed && { BEDROCK_EMBED_PROFILE_ARN: profiles.embed.arn }),
  };
}

/**
 * The resources an invoke through the profiles needs: each profile, its system profile where the
 * model is served through one, and the foundation model in every Region the system profile routes
 * to (the Region is a wildcard because the destination list belongs to the profile).
 */
export function profileInvokeResources(
  { region, account },
  profiles,
  { chat = false, extract = false, embed = false },
) {
  const picked = [
    ...(chat ? [profiles.chat] : []),
    ...(extract ? [profiles.extract] : []),
    ...(embed ? [profiles.embed] : []),
  ];
  return picked.flatMap(({ arn, modelId }) => [
    arn,
    ...(foundationModelOf(modelId) === modelId
      ? []
      : [`arn:aws:bedrock:${region}:${account}:inference-profile/${modelId}`]),
    `arn:aws:bedrock:*::foundation-model/${foundationModelOf(modelId)}`,
  ]);
}
