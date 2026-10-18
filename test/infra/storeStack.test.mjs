// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, it } from "vitest";
import { StoreStack } from "../../infra/lib/storeStack.mjs";

describe("StoreStack", () => {
  let template;
  beforeAll(() => {
    // Skipping asset bundling keeps the test offline and fast; cdk synth bundles the function.
    const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
    const stack = new StoreStack(app, "concordance-test-store", {
      env: { account: "111111111111", region: "eu-west-2" },
    });
    template = Template.fromStack(stack);
  });

  it("builds a Serverless v2 cluster that scales to zero behind the Data API", () => {
    template.hasResource("AWS::RDS::DBCluster", {
      DeletionPolicy: "Delete",
      Properties: Match.objectLike({
        Engine: "aurora-postgresql",
        DatabaseName: "concordance",
        EnableHttpEndpoint: true,
        DeletionProtection: false,
        ServerlessV2ScalingConfiguration: Match.objectLike({ MinCapacity: 0, MaxCapacity: 2 }),
      }),
    });
    template.resourceCountIs("AWS::RDS::DBInstance", 1);
    template.hasResourceProperties("AWS::RDS::DBInstance", { DBInstanceClass: "db.serverless" });
  });

  it("has no NAT gateway and no internet gateway", () => {
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
    template.resourceCountIs("AWS::EC2::InternetGateway", 0);
  });

  it("runs the migrations from one Node 24 arm64 function", () => {
    const fns = template.findResources("AWS::Lambda::Function", {
      Properties: { Runtime: "nodejs24.x", Architectures: ["arm64"] },
    });
    expect(Object.keys(fns)).toHaveLength(1);
    const [fn] = Object.values(fns);
    expect(fn.Properties.Timeout).toBe(300);
    expect(Object.keys(fn.Properties.Environment.Variables).sort()).toEqual([
      "DB_NAME",
      "DB_RESOURCE_ARN",
      "DB_SECRET_ARN",
      "DEPLOY_STAMP",
      "MIGRATIONS_DIR",
    ]);
  });

  it("triggers the migration function after the cluster", () => {
    const resources = template.findResources("Custom::Trigger");
    expect(Object.keys(resources)).toHaveLength(1);
    const [trigger] = Object.values(resources);
    const cluster = Object.keys(template.findResources("AWS::RDS::DBCluster"))[0];
    const writer = Object.keys(template.findResources("AWS::RDS::DBInstance"))[0];
    expect(trigger.DependsOn).toEqual(expect.arrayContaining([cluster, writer]));
    expect(trigger.Properties.ExecuteOnHandlerChange).toBe(true);
  });

  it("grants the function the Data API and the secret", () => {
    const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
      (p) => p.Properties.PolicyDocument.Statement,
    );
    const actions = statements.flatMap((s) => [s.Action].flat());
    expect(actions).toEqual(expect.arrayContaining(["rds-data:ExecuteStatement"]));
    expect(actions).toEqual(expect.arrayContaining(["secretsmanager:GetSecretValue"]));
  });

  it("outputs the cluster ARN, the secret ARN and the database name", () => {
    template.hasOutput("ClusterArn", {});
    template.hasOutput("SecretArn", {});
    template.hasOutput("DatabaseName", { Value: "concordance" });
  });
});
