// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as s3 from "aws-cdk-lib/aws-s3";
import { beforeAll, describe, expect, it } from "vitest";
import { AppStack, pageCorpora, siteDomain } from "../../infra/lib/appStack.mjs";

const env = { account: "111111111111", region: "eu-west-2" };
const CLUSTER = "arn:aws:rds:eu-west-2:111111111111:cluster:concordance";
const SECRET = "arn:aws:secretsmanager:eu-west-2:111111111111:secret:concordance-db-AbCdEf";
const DOMAIN = "concordance.polycode.co.uk";
const CERTIFICATE =
  "arn:aws:acm:us-east-1:111111111111:certificate/0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";

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
      "GET /facts/groups",
      "GET /facts/matrix",
      "GET /facts/timeline",
      "GET /facts/witness/{id}",
      "GET /reports",
      "GET /reports/{filename}",
      "GET /spend",
      "GET /spend/history",
      "POST /export",
      "POST /facts/accept",
      "POST /facts/hypothesis",
      "POST /facts/override",
    ]);
    expect(routes.find((r) => r.RouteKey === "$connect").AuthorizationType).toBe("CUSTOM");
    expect(routes.find((r) => r.RouteKey === "GET /doc/{id}").AuthorizationType).toBe("JWT");
    for (const key of [
      "GET /spend",
      "GET /spend/history",
      "GET /conversations",
      "GET /conversations/{id}",
      "GET /reports",
      "GET /reports/{filename}",
      "DELETE /reports/{filename}",
      "POST /export",
      "GET /facts/groups",
      "GET /facts/matrix",
      "GET /facts/timeline",
      "GET /facts/witness/{id}",
      "POST /facts/override",
      "POST /facts/accept",
      "POST /facts/hypothesis",
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

  it("reads the project budget and the store's usage for the spend routes and nothing else", () => {
    const spend = Object.values(template.findResources("AWS::Lambda::Function"))
      .map((r) => r.Properties)
      .find((p) => p.Environment?.Variables?.BUDGET_NAME);
    expect(spend.Environment.Variables).toEqual({
      DB_RESOURCE_ARN: CLUSTER,
      DB_SECRET_ARN: SECRET,
      DB_NAME: "concordance",
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

  it("runs eleven arm64 Node 24 functions, the turn function for ten minutes", () => {
    const fns = Object.values(template.findResources("AWS::Lambda::Function"))
      .map((r) => r.Properties)
      .filter((p) => p.Runtime === "nodejs24.x" && p.Environment);
    expect(fns).toHaveLength(11);
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

  it("gives the facts routes' function the database and nothing else", () => {
    const fn = functionNamed("FactsFunction")[1].Properties;
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

  it("runs a comparison for up to fifteen minutes on one vCPU with the store and Bedrock", () => {
    const [compareId, { Properties: fn }] = functionNamed("CompareFunction");
    expect(fn.Timeout).toBe(900);
    expect(fn.MemorySize).toBe(1769);
    expect(fn.ReservedConcurrentExecutions).toBe(1);
    expect(fn.Environment.Variables).toEqual({
      MODEL_PROVIDER: "bedrock",
      DB_RESOURCE_ARN: CLUSTER,
      DB_SECRET_ARN: SECRET,
      DB_NAME: "concordance",
    });
    expect(
      roleStatements(fn)
        .flatMap((s) => [s.Action].flat())
        .sort(),
    ).toEqual([
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "rds-data:BeginTransaction",
      "rds-data:CommitTransaction",
      "rds-data:ExecuteStatement",
      "rds-data:RollbackTransaction",
      "secretsmanager:GetSecretValue",
    ]);
    expect(template.findOutputs("CompareFunctionName").CompareFunctionName.Value).toEqual({
      Ref: compareId,
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

  it("writes the corpora of the drop list into config.json", () => {
    const configs = assetFiles("config.json").map((file) => readFileSync(file, "utf8"));
    expect(configs).toHaveLength(1);
    expect(configs[0]).toContain(
      '"corpora":[{"id":"grenfell","name":"Grenfell Tower Inquiry"},{"id":"ucpi","name":"Undercover Policing Inquiry"}]',
    );
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
    const factsMarker = /"factsUrl":<<marker:0xbaba:(\d+)>>/.exec(configs[0])[1];
    expect(markers[`<<marker:0xbaba:${factsMarker}>>`]["Fn::Join"][1].at(-1)).toBe('/facts"');
  });

  it("lets the export function write and read notes/ and nothing else in the bucket", () => {
    const fn = Object.entries(template.findResources("AWS::Lambda::Function")).find(([id]) =>
      id.startsWith("ExportFunction"),
    )[1].Properties;
    expect(fn.Environment.Variables).toMatchObject({
      DB_RESOURCE_ARN: CLUSTER,
      DB_SECRET_ARN: SECRET,
      DB_NAME: "concordance",
      CORPORA: JSON.stringify([
        { id: "grenfell", name: "Grenfell Tower Inquiry" },
        { id: "ucpi", name: "Undercover Policing Inquiry" },
      ]),
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
        "CompareFunctionName",
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

  it("gives the document route the store, to read a document's corpus", () => {
    const fn = functionNamed("DocFunction")[1].Properties;
    expect(fn.Environment.Variables).toMatchObject({
      DB_RESOURCE_ARN: CLUSTER,
      DB_SECRET_ARN: SECRET,
      DB_NAME: "concordance",
    });
    const actions = roleStatements(fn).flatMap((s) => [s.Action].flat());
    expect(actions).toEqual(expect.arrayContaining(["rds-data:ExecuteStatement", "s3:GetObject*"]));
  });

  it("serves on the CloudFront name alone when no domain is given", () => {
    const config = template.findResources("AWS::CloudFront::Distribution");
    const distribution = Object.values(config)[0].Properties.DistributionConfig;
    expect(distribution.Aliases).toBeUndefined();
    expect(distribution.ViewerCertificate).toBeUndefined();
    expect(template.findOutputs("SiteUrl").SiteUrl.Value).toEqual({
      "Fn::Join": ["", ["https://", { "Fn::GetAtt": [expect.any(String), "DomainName"] }]],
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      CallbackURLs: ["https://example.com"],
    });
  });
});

describe("AppStack with a domain", () => {
  let domainTemplate;
  let domainAssembly;

  beforeAll(() => {
    const app = new App({ context: { "aws:cdk:bundling-stacks": [] } });
    const data = new Stack(app, "Data", { env });
    const stack = new AppStack(app, "App", {
      env,
      corpusBucket: new s3.Bucket(data, "CorpusBucket"),
      dbResourceArn: CLUSTER,
      dbSecretArn: SECRET,
      dbName: "concordance",
      budgetName: "concordance-sandbox-monthly",
      domainName: DOMAIN,
      certificateArn: CERTIFICATE,
    });
    domainTemplate = Template.fromStack(stack);
    domainAssembly = app.synth();
  }, 120000);

  const origins = (t) =>
    Object.values(t.findResources("AWS::ApiGatewayV2::Api")).find(
      (r) => r.Properties.ProtocolType === "HTTP",
    ).Properties.CorsConfiguration.AllowOrigins;

  it("answers on the domain with the us-east-1 certificate over SNI", () => {
    domainTemplate.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: [DOMAIN],
        ViewerCertificate: Match.objectLike({
          AcmCertificateArn: CERTIFICATE,
          SslSupportMethod: "sni-only",
        }),
      }),
    });
  });

  it("names the domain as the site URL and keeps the CloudFront name as an output", () => {
    expect(domainTemplate.findOutputs("SiteUrl").SiteUrl.Value).toBe(`https://${DOMAIN}`);
    expect(
      domainTemplate.findOutputs("DistributionDomainName").DistributionDomainName.Value,
    ).toEqual({ "Fn::GetAtt": [expect.any(String), "DomainName"] });
  });

  it("lets the page call the HTTP API from the domain and from the CloudFront name", () => {
    const allowed = origins(domainTemplate);
    expect(allowed).toHaveLength(2);
    expect(allowed[0]).toBe(`https://${DOMAIN}`);
    expect(JSON.stringify(allowed[1])).toContain("DomainName");
  });

  it("adds the domain's origin to the client's callback and logout URLs", () => {
    const client = Object.values(domainTemplate.findResources("AWS::Cognito::UserPoolClient"))[0]
      .Properties;
    for (const urls of [client.CallbackURLs, client.LogoutURLs]) {
      expect(urls).toHaveLength(2);
      expect(urls[0]).toBe(`https://${DOMAIN}`);
      expect(JSON.stringify(urls[1])).toContain("DomainName");
    }
    expect(client.ExplicitAuthFlows).toContain("ALLOW_USER_PASSWORD_AUTH");
  });

  it("writes the domain into config.json as the site URL", () => {
    const configs = readdirSync(domainAssembly.directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("asset."))
      .map((entry) => path.join(domainAssembly.directory, entry.name, "config.json"))
      .filter((file) => existsSync(file))
      .map((file) => readFileSync(file, "utf8"));
    expect(configs).toHaveLength(1);
    expect(configs[0]).toContain(`"siteUrl":"https://${DOMAIN}"`);
  });
});

describe("siteDomain", () => {
  it("is null without either value", () => {
    expect(siteDomain({})).toBeNull();
    expect(siteDomain({ domainName: "", certificateArn: undefined })).toBeNull();
  });

  it("refuses one value without the other", () => {
    expect(() => siteDomain({ domainName: DOMAIN })).toThrow(/both/);
    expect(() => siteDomain({ certificateArn: CERTIFICATE })).toThrow(/both/);
  });

  it("refuses a certificate outside us-east-1 and a name that is not a host", () => {
    expect(() =>
      siteDomain({
        domainName: DOMAIN,
        certificateArn: CERTIFICATE.replace("us-east-1", "eu-west-2"),
      }),
    ).toThrow(/us-east-1/);
    expect(() =>
      siteDomain({ domainName: "https://x.example", certificateArn: CERTIFICATE }),
    ).toThrow(/host name/);
  });
});

describe("pageCorpora", () => {
  it("keeps the drop list in order and refuses a malformed one", () => {
    expect(pageCorpora([{ id: "ucpi", name: " Undercover Policing Inquiry " }])).toEqual([
      { id: "ucpi", name: "Undercover Policing Inquiry" },
    ]);
    expect(() => pageCorpora([])).toThrow(/at least one/);
    expect(() => pageCorpora([{ id: "Bad/x", name: "x" }])).toThrow(/invalid/);
    expect(() => pageCorpora([{ id: "ucpi", name: "" }])).toThrow(/no name/);
    expect(() =>
      pageCorpora([
        { id: "ucpi", name: "a" },
        { id: "ucpi", name: "b" },
      ]),
    ).toThrow(/twice/);
  });
});
