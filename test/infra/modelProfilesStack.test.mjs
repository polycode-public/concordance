// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ModelProfilesStack,
  foundationModelOf,
  profileEnvironment,
  profileInvokeResources,
} from "../../infra/lib/modelProfilesStack.mjs";

const env = { account: "111111111111", region: "eu-west-2" };
let stack;
let template;
beforeAll(() => {
  stack = new ModelProfilesStack(new App(), "Profiles", {
    env,
    envName: "sandbox",
    project: "concordance",
  });
  template = Template.fromStack(stack);
});

const profiles = () =>
  Object.values(template.findResources("AWS::Bedrock::ApplicationInferenceProfile")).map(
    (r) => r.Properties,
  );

describe("ModelProfilesStack", () => {
  it("creates one profile per model, each tagged project=concordance", () => {
    expect(profiles()).toHaveLength(3);
    for (const p of profiles()) {
      expect(p.Tags).toContainEqual({ Key: "project", Value: "concordance" });
      expect(p.Tags).toContainEqual({ Key: "concordance", Value: "sandbox" });
    }
    expect(profiles().map((p) => p.InferenceProfileName)).toEqual([
      "concordance-sandbox-chat",
      "concordance-sandbox-extract",
      "concordance-sandbox-embed",
    ]);
  });

  it("gives every profile a name and a description that CloudFormation accepts", () => {
    const pattern = /^([0-9a-zA-Z:.][ _-]?)+$/;
    for (const p of profiles()) {
      expect(p.InferenceProfileName).toMatch(/^([0-9a-zA-Z][ _-]?)+$/);
      expect(p.Description).toMatch(pattern);
    }
  });

  it("copies the EU system profiles for Claude and the foundation model for Titan", () => {
    expect(profiles().map((p) => p.ModelSource.CopyFrom)).toEqual([
      "arn:aws:bedrock:eu-west-2:111111111111:inference-profile/eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
      "arn:aws:bedrock:eu-west-2:111111111111:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0",
      "arn:aws:bedrock:eu-west-2::foundation-model/amazon.titan-embed-text-v2:0",
    ]);
  });

  it("outputs each profile ARN for the stacks that call through it", () => {
    for (const name of ["ChatProfileArn", "ExtractProfileArn", "EmbedProfileArn"]) {
      expect(template.toJSON().Outputs[name].Value).toEqual({
        "Fn::GetAtt": [expect.stringContaining(name.replace("Arn", "")), "InferenceProfileArn"],
      });
    }
  });

  it("refuses a missing project", () => {
    expect(() => new ModelProfilesStack(new App(), "Bad", { env, envName: "sandbox" })).toThrow(
      /envName and project/,
    );
  });
});

describe("profile helpers", () => {
  it("strips a geography prefix and leaves a foundation model id", () => {
    expect(foundationModelOf("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(
      "anthropic.claude-haiku-4-5-20251001-v1:0",
    );
    expect(foundationModelOf("amazon.titan-embed-text-v2:0")).toBe("amazon.titan-embed-text-v2:0");
  });

  it("names only the profiles a function uses", () => {
    expect(profileEnvironment(stack, { embed: true })).toEqual({
      BEDROCK_EMBED_PROFILE_ARN: stack.embed.arn,
    });
    expect(profileInvokeResources(stack, stack, { embed: true })).toEqual([
      stack.embed.arn,
      "arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0",
    ]);
  });
});
