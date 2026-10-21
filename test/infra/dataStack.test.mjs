// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { DataStack, EXTRACTION_BATCH_PREFIX } from "../../infra/lib/dataStack.mjs";

describe("DataStack", () => {
  it("expires the extraction's batch files after 30 days and keeps the corpus files", () => {
    const app = new App();
    const template = Template.fromStack(new DataStack(app, "Data"));
    const [bucket] = Object.values(template.findResources("AWS::S3::Bucket"));
    const rules = bucket.Properties.LifecycleConfiguration.Rules;
    expect(rules).toContainEqual({
      Id: "ExpireExtractionBatchFiles",
      Prefix: EXTRACTION_BATCH_PREFIX,
      ExpirationInDays: 30,
      Status: "Enabled",
    });
    expect(rules.filter((r) => r.ExpirationInDays)).toHaveLength(1);
  }, 120_000);
});
