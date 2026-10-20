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
    budgetName: "concordance-sandbox-monthly",
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
      "DELETE /reports/{filename}",
      "GET /conversations",
      "GET /conversations/{id}",
      "GET /doc/{id}",
      "GET /reports",
      "GET /reports/{filename}",
      "GET /spend",
      "POST /export",
    ]);
    expect(routes.find((r) => r.RouteKey === "$connect").AuthorizationType).toBe("CUSTOM");
    expect(routes.find((r) => r.RouteKey === "GET /doc/{id}").AuthorizationType).toBe("JWT");
    for (const key of [
      "GET /spend",
      "GET /conversations",
      "GET /conversations/{id}",
      "GET /reports",
      "GET /reports/{filename}",
      "DELETE /reports/{filename}",
      "POST /export",
    ]) {
      expect(routes.find((r) => r.RouteKey === key).AuthorizationType).toBe("JWT");
    }
    template.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 2);
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

  it("lets the page call the HTTP API with its token from the distribution's origin", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      ProtocolType: "HTTP",
      CorsConfiguration: {
        AllowHeaders: ["authorization", "content-type"],
        AllowMethods: ["GET", "POST", "DELETE"],
        AllowOrigins: [Match.anyValue()],
      },
    });
  });

  it("reads the project budget for the spend route and nothing else", () => {
    const spend = Object.values(template.findResources("AWS::Lambda::Function"))
      .map((r) => r.Properties)
      .find((p) => p.Environment?.Variables?.BUDGET_NAME);
    expect(spend.Environment.Variables).toEqual({
      BUDGET_ACCOUNT_ID: "111111111111",
      BUDGET_NAME: "concordance-sandbox-monthly",
    });
    const statements = Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
      (r) => r.Properties.PolicyDocument.Statement,
    );
    expect(statements.filter((s) => String(s.Action).startsWith("budgets:"))).toEqual([
      {
        Action: "budgets:ViewBudget",
        Effect: "Allow",
        Resource: "arn:aws:budgets::111111111111:budget/concordance-sandbox-monthly",
      },
    ]);
  });

  it("gives the conversations function the database and nothing else", () => {
    const fn = Object.entries(template.findResources("AWS::Lambda::Function")).find(([id]) =>
      id.startsWith("ConversationsFunction"),
    )[1].Properties;
    expect(fn.Environment.Variables).toEqual({
      DB_RESOURCE_ARN: CLUSTER,
      DB_SECRET_ARN: SECRET,
      DB_NAME: "concordance",
    });
    const role = fn.Role["Fn::GetAtt"][0];
    const statements = Object.values(template.findResources("AWS::IAM::Policy"))
      .filter((r) => r.Properties.Roles.some((ref) => ref.Ref === role))
      .flatMap((r) => r.Properties.PolicyDocument.Statement);
    expect(statements.flatMap((s) => [s.Action].flat()).sort()).toEqual([
      "rds-data:BeginTransaction",
      "rds-data:CommitTransaction",
      "rds-data:ExecuteStatement",
      "rds-data:RollbackTransaction",
      "secretsmanager:GetSecretValue",
    ]);
  });

  it("runs nine arm64 Node 24 functions, the turn function for ten minutes", () => {
    const fns = Object.values(template.findResources("AWS::Lambda::Function"))
      .map((r) => r.Properties)
      .filter((p) => p.Runtime === "nodejs24.x" && p.Environment);
    expect(fns).toHaveLength(9);
    for (const p of fns) expect(p.Architectures).toEqual(["arm64"]);
    const turn = fns.find((p) => p.Timeout === 600);
    expect(turn.MemorySize).toBe(1024);
    expect(turn.Environment.Variables).toMatchObject({
      MODEL_PROVIDER: "bedrock",
      DB_RESOURCE_ARN: CLUSTER,
      DB_SECRET_ARN: SECRET,
      DB_NAME: "concordance",
    });
    template.resourceCountIs("AWS::Lambda::EventInvokeConfig", 2);
    for (const config of Object.values(template.findResources("AWS::Lambda::EventInvokeConfig")))
      expect(config.Properties.MaximumRetryAttempts).toBe(0);
  });

  const functionNamed = (prefix) =>
    Object.entries(template.findResources("AWS::Lambda::Function")).find(([id]) =>
      id.startsWith(prefix),
    );
  const roleStatements = (fn) => {
    const role = fn.Role["Fn::GetAtt"][0];
    return Object.values(template.findResources("AWS::IAM::Policy"))
      .filter((r) => r.Properties.Roles.some((ref) => ref.Ref === role))
      .flatMap((r) => r.Properties.PolicyDocument.Statement);
  };

  it("runs a report for up to fifteen minutes with the turn's store, Bedrock and connections", () => {
    const [reportId, { Properties: fn }] = functionNamed("ReportFunction");
    expect(fn.Timeout).toBe(900);
    expect(fn.MemorySize).toBe(1024);
    expect(fn.Environment.Variables).toMatchObject({
      MODEL_PROVIDER: "bedrock",
      DB_RESOURCE_ARN: CLUSTER,
      DB_SECRET_ARN: SECRET,
      DB_NAME: "concordance",
    });
    const actions = roleStatements(fn).flatMap((s) => [s.Action].flat());
    expect(actions).toEqual(
      expect.arrayContaining([
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "execute-api:ManageConnections",
        "rds-data:ExecuteStatement",
        "secretsmanager:GetSecretValue",
      ]),
    );
    const routes = functionNamed("WsRoutesFunction")[1].Properties;
    expect(routes.Environment.Variables.REPORT_FUNCTION_NAME).toEqual({ Ref: reportId });
    const invoke = roleStatements(routes).filter((s) =>
      [s.Action].flat().includes("lambda:InvokeFunction"),
    );
    expect(JSON.stringify(invoke)).toContain(reportId);
  });

  it("gives the reports routes' function the database and nothing else", () => {
    const fn = functionNamed("ReportsFunction")[1].Properties;
    expect(fn.Environment.Variables).toEqual({
      DB_RESOURCE_ARN: CLUSTER,
      DB_SECRET_ARN: SECRET,
      DB_NAME: "concordance",
    });
    expect(
      roleStatements(fn)
        .flatMap((s) => [s.Action].flat())
        .sort(),
    ).toEqual([
      "rds-data:BeginTransaction",
      "rds-data:CommitTransaction",
      "rds-data:ExecuteStatement",
      "rds-data:RollbackTransaction",
      "secretsmanager:GetSecretValue",
    ]);
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
    const marker = /"spendUrl":<<marker:0xbaba:(\d+)>>/.exec(configs[0])[1];
    const deployment = Object.values(template.findResources("Custom::CDKBucketDeployment"))[0];
    const markers = deployment.Properties.SourceMarkers.find((m) => Object.keys(m).length);
    expect(markers[`<<marker:0xbaba:${marker}>>`]["Fn::Join"][1].at(-1)).toBe('/spend"');
    const listMarker = /"conversationsUrl":<<marker:0xbaba:(\d+)>>/.exec(configs[0])[1];
    expect(markers[`<<marker:0xbaba:${listMarker}>>`]["Fn::Join"][1].at(-1)).toBe(
      '/conversations"',
    );
    const exportMarker = /"exportUrl":<<marker:0xbaba:(\d+)>>/.exec(configs[0])[1];
    expect(markers[`<<marker:0xbaba:${exportMarker}>>`]["Fn::Join"][1].at(-1)).toBe('/export"');
    const reportsMarker = /"reportsUrl":<<marker:0xbaba:(\d+)>>/.exec(configs[0])[1];
    expect(markers[`<<marker:0xbaba:${reportsMarker}>>`]["Fn::Join"][1].at(-1)).toBe('/reports"');
  });

  it("lets the export function write and read notes/ and nothing else in the bucket", () => {
    const fn = Object.entries(template.findResources("AWS::Lambda::Function")).find(([id]) =>
      id.startsWith("ExportFunction"),
    )[1].Properties;
    expect(fn.Environment.Variables).toMatchObject({
      DB_RESOURCE_ARN: CLUSTER,
      DB_SECRET_ARN: SECRET,
      DB_NAME: "concordance",
      CORPUS_ID: "grenfell",
      CORPUS_TITLE: "Grenfell Tower Inquiry",
    });
    const role = fn.Role["Fn::GetAtt"][0];
    const statements = Object.values(template.findResources("AWS::IAM::Policy"))
      .filter((r) => r.Properties.Roles.some((ref) => ref.Ref === role))
      .flatMap((r) => r.Properties.PolicyDocument.Statement);
    const s3Statements = statements.filter((s) =>
      [s.Action].flat().some((a) => a.startsWith("s3:")),
    );
    expect(s3Statements).toHaveLength(1);
    expect(s3Statements[0].Action).toEqual(["s3:PutObject", "s3:GetObject"]);
    expect(JSON.stringify(s3Statements[0].Resource)).toMatch(/notes\/\*/);
    expect(statements.flatMap((s) => [s.Action].flat()).sort()).toEqual([
      "rds-data:BeginTransaction",
      "rds-data:CommitTransaction",
      "rds-data:ExecuteStatement",
      "rds-data:RollbackTransaction",
      "s3:GetObject",
      "s3:PutObject",
      "secretsmanager:GetSecretValue",
    ]);
  });

  it("stages PDF.js and the faces beside the page", () => {
    const staged = assetFiles("vendor");
    expect(staged).toHaveLength(1);
    const root = path.dirname(staged[0]);
    expect(readdirSync(path.join(root, "vendor")).sort()).toEqual([
      "pdf.min.mjs",
      "pdf.worker.min.mjs",
      "wasm",
    ]);
    expect(readdirSync(path.join(root, "vendor", "wasm")).sort()).toEqual([
      "jbig2.wasm",
      "openjpeg.wasm",
    ]);
    expect(readdirSync(path.join(root, "fonts")).sort()).toEqual([
      "source-sans-3-latin-400-normal.woff2",
      "source-sans-3-latin-600-normal.woff2",
      "source-serif-4-latin-400-normal.woff2",
    ]);
    const deployment = Object.values(template.findResources("Custom::CDKBucketDeployment"))[0];
    expect(deployment.Properties.SourceBucketNames).toHaveLength(3);
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
          budgetName: "concordance-sandbox-monthly",
        }),
    ).toThrow(/CORS/);
  });

  it("refuses a stack without the budget name", () => {
    const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
    const data = new Stack(app, "Data2", { env });
    expect(
      () =>
        new AppStack(app, "NoBudget", {
          env,
          corpusBucket: new s3.Bucket(data, "CorpusBucket"),
          dbResourceArn: CLUSTER,
          dbSecretArn: SECRET,
          dbName: "concordance",
        }),
    ).toThrow(/budgetName/);
  });
});
