// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import { beforeAll, describe, expect, it } from "vitest";
import { AppStack } from "../../infra/lib/appStack.mjs";

const env = { account: "111111111111", region: "eu-west-2" };
const CLUSTER = "arn:aws:rds:eu-west-2:111111111111:cluster:concordance";
const SECRET = "arn:aws:secretsmanager:eu-west-2:111111111111:secret:concordance-db-AbCdEf";

let template;
let dataTemplate;
let assembly;

function assetFiles(name) {
  return readdirSync(assembly.directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("asset."))
    .map((entry) => path.join(assembly.directory, entry.name, name))
    .filter((file) => existsSync(file));
}

beforeAll(() => {
  const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
  const data = new Stack(app, "Data", { env });
  const corpusBucket = new s3.Bucket(data, "CorpusBucket");
  const stack = new AppStack(app, "App", {
    env,
    corpusBucket,
    dbResourceArn: CLUSTER,
    dbSecretArn: SECRET,
    dbName: "concordance",
  });
  template = Template.fromStack(stack);
  dataTemplate = Template.fromStack(data);
  assembly = app.synth();
}, 120000);

describe("AppStack", () => {
  it("routes the WebSocket API through a REQUEST authorizer on $connect", () => {
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 2);
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "WEBSOCKET",
    });
    const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route")).map(
      (r) => r.Properties,
    );
    expect(routes.map((r) => r.RouteKey).sort()).toEqual([
      "$connect",
      "$default",
      "$disconnect",
      "GET /doc/{id}",
    ]);
    expect(routes.find((r) => r.RouteKey === "$connect").AuthorizationType).toBe("CUSTOM");
    expect(routes.find((r) => r.RouteKey === "GET /doc/{id}").AuthorizationType).toBe("JWT");
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "REQUEST",
      IdentitySource: ["route.request.querystring.token"],
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      StageName: "prod",
      AutoDeploy: true,
    });
  });

  it("has one user pool without self sign-up, the demo user and a password client", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolUser", {
      Username: "demo",
      MessageAction: "SUPPRESS",
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      ExplicitAuthFlows: Match.arrayWith(["ALLOW_USER_PASSWORD_AUTH"]),
      GenerateSecret: false,
    });
  });

  it("keeps cancel flags in an on-demand table that expires them", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
    });
    template.hasResource("AWS::DynamoDB::Table", { DeletionPolicy: "Delete" });
  });

  it("runs four arm64 Node 24 functions, the turn function for ten minutes", () => {
    const fns = Object.values(template.findResources("AWS::Lambda::Function"))
      .map((r) => r.Properties)
      .filter((p) => p.Runtime === "nodejs24.x" && p.Environment);
    expect(fns).toHaveLength(4);
    for (const p of fns) expect(p.Architectures).toEqual(["arm64"]);
    const turn = fns.find((p) => p.Timeout === 600);
    expect(turn.MemorySize).toBe(1024);
    expect(turn.Environment.Variables).toMatchObject({
      MODEL_PROVIDER: "bedrock",
      DB_RESOURCE_ARN: CLUSTER,
      DB_SECRET_ARN: SECRET,
      DB_NAME: "concordance",
    });
    template.hasResourceProperties("AWS::Lambda::EventInvokeConfig", {
      MaximumRetryAttempts: 0,
    });
  });

  it("lets the turn function call Bedrock and manage the connections", () => {
    const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
      (r) => r.Properties.PolicyDocument.Statement,
    );
    const actions = statements.flatMap((s) => [s.Action].flat());
    expect(actions).toEqual(
      expect.arrayContaining([
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "execute-api:ManageConnections",
        "rds-data:ExecuteStatement",
        "secretsmanager:GetSecretValue",
        "lambda:InvokeFunction",
      ]),
    );
  });

  it("serves the page from a private bucket through CloudFront with index.html as root", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: "index.html",
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
      }),
    });
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    template.resourceCountIs("Custom::CDKBucketDeployment", 1);
  });

  it("writes the corpus into config.json", () => {
    const configs = assetFiles("config.json").map((file) => readFileSync(file, "utf8"));
    expect(configs).toHaveLength(1);
    expect(configs[0]).toContain('"corpus":{"id":"grenfell"');
    expect(configs[0]).toContain('"title":"Grenfell Tower Inquiry"');
    expect(configs[0]).toContain('"subtitle":"witness statements"');
  });

  it("lets a browser range-read the presigned originals", () => {
    dataTemplate.hasResourceProperties("AWS::S3::Bucket", {
      CorsConfiguration: {
        CorsRules: [
          Match.objectLike({
            AllowedMethods: ["GET", "HEAD"],
            AllowedHeaders: ["Range"],
            ExposedHeaders: Match.arrayWith(["Content-Range"]),
          }),
        ],
      },
    });
  });

  it("outputs the URLs, the pool, the client and the demo user", () => {
    const outputs = Object.keys(template.findOutputs("*"));
    expect(outputs).toEqual(
      expect.arrayContaining([
        "SiteUrl",
        "WebSocketUrl",
        "HttpApiUrl",
        "UserPoolId",
        "UserPoolClientId",
        "DemoUserName",
      ]),
    );
  });

  it("refuses a bucket it cannot add the CORS rule to", () => {
    const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
    const scope = new Stack(app, "Other", { env });
    expect(
      () =>
        new AppStack(app, "Bad", {
          env,
          corpusBucket: s3.Bucket.fromBucketName(scope, "Imported", "corpus"),
          dbResourceArn: CLUSTER,
          dbSecretArn: SECRET,
          dbName: "concordance",
        }),
    ).toThrow(/CORS/);
  });
});
