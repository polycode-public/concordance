// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

// The serving layer: the chat WebSocket on API Gateway with a Lambda per route, the turn
// function and the report function it invokes asynchronously, the cancel table, GET /doc/{id},
// GET /spend, the conversation, report and fact-store routes and POST /export on an HTTP API,
// the comparison function invoked with { corpus }, one Cognito user, and the page on CloudFront
// with a generated config.json. Every resource is destroyable and nothing costs money at idle.
// With a domain name and the ARN of its us-east-1 certificate, the distribution answers on that
// name too, and the site URL, the API's allowed origins and the client's callback URLs use it.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import {
  HttpUserPoolAuthorizer,
  WebSocketLambdaAuthorizer,
} from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import {
  HttpLambdaIntegration,
  WebSocketLambdaIntegration,
} from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { profileEnvironment, profileInvokeResources } from "./modelProfilesStack.mjs";
import { stagePageAssets } from "../../scripts/stage-page-assets.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AWS_DIR = path.join(ROOT, "packages", "aws");
const UI_DIR = path.join(ROOT, "packages", "ui");

export const DEMO_USER = "demo";
export const STAGE_NAME = "prod";

// The bundle is ESM; pg and other CommonJS dependencies call require().
const REQUIRE_BANNER =
  "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

/** The corpora the page lists, in drop-list order; the first is the default. */
export const DEFAULT_CORPORA = Object.freeze([
  Object.freeze({ id: "grenfell", name: "Grenfell Tower Inquiry" }),
  Object.freeze({ id: "ucpi", name: "Undercover Policing Inquiry" }),
]);

const CORPUS_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Checks the corpora the page lists: at least one, each a corpus id and a display name, no id
 * twice.
 * @param {unknown} corpora
 * @returns {{ id: string, name: string }[]}
 */
export function pageCorpora(corpora) {
  if (!Array.isArray(corpora) || corpora.length === 0) {
    throw new Error("AppStack needs at least one corpus");
  }
  const ids = new Set();
  return corpora.map((c) => {
    if (!CORPUS_ID.test(c?.id ?? ""))
      throw new Error(`corpus id ${JSON.stringify(c?.id)} is invalid`);
    if (typeof c.name !== "string" || !c.name.trim()) throw new Error(`corpus ${c.id} has no name`);
    if (ids.has(c.id)) throw new Error(`corpus ${c.id} is listed twice`);
    ids.add(c.id);
    return { id: c.id, name: c.name.trim() };
  });
}

const CERTIFICATE_ARN = /^arn:aws:acm:us-east-1:\d{12}:certificate\/[0-9a-f-]+$/;
const DOMAIN_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * The custom domain of the distribution, or null. A CloudFront certificate lives in us-east-1
 * whatever the stack's region, so it arrives as an ARN.
 * @param {{ domainName?: string, certificateArn?: string }} props
 * @returns {{ domainName: string, certificateArn: string } | null}
 */
export function siteDomain({ domainName, certificateArn }) {
  if (!domainName && !certificateArn) return null;
  if (!domainName || !certificateArn) {
    throw new Error("AppStack needs both domainName and certificateArn, or neither");
  }
  if (!DOMAIN_NAME.test(domainName)) {
    throw new Error(`domainName ${JSON.stringify(domainName)} is not a lower-case host name`);
  }
  if (!CERTIFICATE_ARN.test(certificateArn)) {
    throw new Error(
      `certificateArn ${JSON.stringify(certificateArn)} is not an ACM certificate in us-east-1`,
    );
  }
  return { domainName, certificateArn };
}

export class AppStack extends Stack {
  /**
   * @param {import('constructs').Construct} scope
   * @param {string} id
   * @param {import('aws-cdk-lib').StackProps & { corpusBucket: s3.Bucket, dbResourceArn: string,
   *   dbSecretArn: string, dbName: string, budgetNames: string[],
   *   corpora?: { id: string, name: string }[], domainName?: string,
   *   certificateArn?: string }} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);
    const { corpusBucket, dbResourceArn, dbSecretArn, dbName, budgetNames, modelProfiles } = props;
    const corpora = pageCorpora(props.corpora ?? DEFAULT_CORPORA);
    if (typeof corpusBucket?.addCorsRule !== "function") {
      throw new Error("AppStack needs the corpus Bucket construct, to add its CORS rule");
    }
    if (!budgetNames?.length)
      throw new Error("AppStack needs the budgetNames the spend route reads");
    if (!modelProfiles?.chat?.arn) {
      throw new Error("AppStack needs the modelProfiles of the ModelProfilesStack");
    }
    const allModels = { chat: true, extract: true, embed: true };
    const modelEnv = profileEnvironment(modelProfiles, allModels);
    const domain = siteDomain(props);

    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const distribution = new cloudfront.Distribution(this, "Site", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      ...(domain && {
        domainNames: [domain.domainName],
        certificate: acm.Certificate.fromCertificateArn(
          this,
          "SiteCertificate",
          domain.certificateArn,
        ),
      }),
    });
    const distributionOrigin = `https://${distribution.distributionDomainName}`;
    const siteUrl = domain ? `https://${domain.domainName}` : distributionOrigin;
    const siteOrigins = domain ? [siteUrl, distributionOrigin] : [distributionOrigin];

    const userPool = new cognito.UserPool(this, "Users", {
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const client = userPool.addClient("PageClient", {
      authFlows: { userPassword: true },
      generateSecret: false,
      preventUserExistenceErrors: true,
      ...(domain && { oAuth: { callbackUrls: siteOrigins, logoutUrls: siteOrigins } }),
    });
    const demoUser = new cognito.CfnUserPoolUser(this, "DemoUser", {
      userPoolId: userPool.userPoolId,
      username: DEMO_USER,
      messageAction: "SUPPRESS",
    });

    const cancelTable = new dynamodb.Table(this, "CancelTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const dbEnv = {
      MODEL_PROVIDER: "bedrock",
      DB_RESOURCE_ARN: dbResourceArn,
      DB_SECRET_ARN: dbSecretArn,
      DB_NAME: dbName,
      CANCEL_TABLE: cancelTable.tableName,
      CORPUS_BUCKET: corpusBucket.bucketName,
    };
    const fn = (
      name,
      {
        timeout = Duration.seconds(30),
        memorySize = 256,
        reservedConcurrentExecutions,
        environment,
      },
    ) =>
      new NodejsFunction(this, `${name[0].toUpperCase()}${name.slice(1)}Function`, {
        entry: path.join(AWS_DIR, `${name}.mjs`),
        handler: "handler",
        projectRoot: ROOT,
        depsLockFilePath: path.join(ROOT, "package-lock.json"),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        timeout,
        memorySize,
        reservedConcurrentExecutions,
        environment,
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        bundling: {
          format: OutputFormat.ESM,
          target: "node24",
          banner: REQUIRE_BANNER,
          minify: true,
          sourceMap: true,
          externalModules: ["@aws-sdk/*", "pg-native"],
        },
      });

    const authorizerFn = fn("authorizer", {
      environment: {
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: client.userPoolClientId,
      },
    });
    const turnFn = fn("turn", {
      timeout: Duration.minutes(10),
      memorySize: 1024,
      environment: { ...dbEnv, ...modelEnv },
    });
    const reportFn = fn("report", {
      timeout: Duration.minutes(15),
      memorySize: 1024,
      environment: { ...dbEnv, ...modelEnv },
    });
    const wsRoutesFn = fn("wsRoutes", {
      environment: {
        ...dbEnv,
        TURN_FUNCTION_NAME: turnFn.functionName,
        REPORT_FUNCTION_NAME: reportFn.functionName,
      },
    });
    const storeEnv = {
      DB_RESOURCE_ARN: dbResourceArn,
      DB_SECRET_ARN: dbSecretArn,
      DB_NAME: dbName,
    };
    const docFn = fn("doc", {
      environment: { ...storeEnv, CORPUS_BUCKET: corpusBucket.bucketName },
    });
    const conversationsFn = fn("conversations", {
      environment: { DB_RESOURCE_ARN: dbResourceArn, DB_SECRET_ARN: dbSecretArn, DB_NAME: dbName },
    });
    const reportsFn = fn("reports", {
      environment: { DB_RESOURCE_ARN: dbResourceArn, DB_SECRET_ARN: dbSecretArn, DB_NAME: dbName },
    });
    const factsFn = fn("facts", {
      environment: { DB_RESOURCE_ARN: dbResourceArn, DB_SECRET_ARN: dbSecretArn, DB_NAME: dbName },
    });
    // Alignment compares every pair of claim vectors in memory; 1769 MB is one full vCPU.
    // One at a time: a second invoke is refused with a 429 before it reads anything, so a retried
    // invoke cannot share the Bedrock quota with a run in progress.
    const compareFn = fn("compare", {
      reservedConcurrentExecutions: 1,
      timeout: Duration.minutes(15),
      memorySize: 1769,
      environment: {
        MODEL_PROVIDER: "bedrock",
        ...modelEnv,
        DB_RESOURCE_ARN: dbResourceArn,
        DB_SECRET_ARN: dbSecretArn,
        DB_NAME: dbName,
      },
    });
    const exportFn = fn("export", {
      environment: {
        DB_RESOURCE_ARN: dbResourceArn,
        DB_SECRET_ARN: dbSecretArn,
        DB_NAME: dbName,
        CORPUS_BUCKET: corpusBucket.bucketName,
        CORPORA: JSON.stringify(corpora),
      },
    });
    const spendFn = fn("spend", {
      environment: {
        ...storeEnv,
        BUDGET_ACCOUNT_ID: this.account,
        BUDGET_NAMES: budgetNames.join(","),
      },
    });
    spendFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["budgets:ViewBudget"],
        resources: budgetNames.map((name) => `arn:aws:budgets::${this.account}:budget/${name}`),
      }),
    );

    // A failed turn has already told the client; a retry would answer the question twice.
    new lambda.EventInvokeConfig(this, "TurnInvokeConfig", {
      function: turnFn,
      retryAttempts: 0,
    });
    // A retried report would store a second version of the same request.
    new lambda.EventInvokeConfig(this, "ReportInvokeConfig", {
      function: reportFn,
      retryAttempts: 0,
    });

    const webSocketApi = new apigwv2.WebSocketApi(this, "ChatApi", {
      connectRouteOptions: {
        integration: new WebSocketLambdaIntegration("ConnectIntegration", wsRoutesFn),
        authorizer: new WebSocketLambdaAuthorizer("TokenAuthorizer", authorizerFn, {
          identitySource: ["route.request.querystring.token"],
        }),
      },
      disconnectRouteOptions: {
        integration: new WebSocketLambdaIntegration("DisconnectIntegration", wsRoutesFn),
      },
      defaultRouteOptions: {
        integration: new WebSocketLambdaIntegration("DefaultIntegration", wsRoutesFn),
      },
    });
    const stage = new apigwv2.WebSocketStage(this, "ChatStage", {
      webSocketApi,
      stageName: STAGE_NAME,
      autoDeploy: true,
    });

    for (const f of [turnFn, reportFn, wsRoutesFn]) webSocketApi.grantManageConnections(f);
    for (const f of [
      turnFn,
      reportFn,
      wsRoutesFn,
      conversationsFn,
      reportsFn,
      factsFn,
      compareFn,
      exportFn,
      docFn,
      spendFn,
    ]) {
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: [
            "rds-data:ExecuteStatement",
            "rds-data:BeginTransaction",
            "rds-data:CommitTransaction",
            "rds-data:RollbackTransaction",
          ],
          resources: [dbResourceArn],
        }),
      );
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["secretsmanager:GetSecretValue"],
          resources: [dbSecretArn],
        }),
      );
    }
    for (const f of [turnFn, reportFn, compareFn]) {
      f.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
          resources: profileInvokeResources(this, modelProfiles, allModels),
        }),
      );
    }
    cancelTable.grantReadWriteData(turnFn);
    cancelTable.grantReadWriteData(wsRoutesFn);
    turnFn.grantInvoke(wsRoutesFn);
    reportFn.grantInvoke(wsRoutesFn);
    corpusBucket.grantRead(wsRoutesFn, "*/raw/*");
    corpusBucket.grantRead(docFn, "*/raw/*");
    exportFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:GetObject"],
        resources: [corpusBucket.arnForObjects("notes/*")],
      }),
    );

    // The page fetches these routes with the id token from the distribution's origin.
    const httpApi = new apigwv2.HttpApi(this, "DocApi", {
      corsPreflight: {
        allowOrigins: siteOrigins,
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.DELETE,
        ],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.hours(1),
      },
    });
    const userAuthorizer = new HttpUserPoolAuthorizer("DocAuthorizer", userPool, {
      userPoolClients: [client],
    });
    httpApi.addRoutes({
      path: "/doc/{id}",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("DocIntegration", docFn),
      authorizer: userAuthorizer,
    });
    const spendIntegration = new HttpLambdaIntegration("SpendIntegration", spendFn);
    for (const routePath of ["/spend", "/spend/history"]) {
      httpApi.addRoutes({
        path: routePath,
        methods: [apigwv2.HttpMethod.GET],
        integration: spendIntegration,
        authorizer: userAuthorizer,
      });
    }
    httpApi.addRoutes({
      path: "/export",
      methods: [apigwv2.HttpMethod.POST],
      integration: new HttpLambdaIntegration("ExportIntegration", exportFn),
      authorizer: userAuthorizer,
    });
    const conversationsIntegration = new HttpLambdaIntegration(
      "ConversationsIntegration",
      conversationsFn,
    );
    for (const routePath of ["/conversations", "/conversations/{id}"]) {
      httpApi.addRoutes({
        path: routePath,
        methods: [apigwv2.HttpMethod.GET],
        integration: conversationsIntegration,
        authorizer: userAuthorizer,
      });
    }

    const reportsIntegration = new HttpLambdaIntegration("ReportsIntegration", reportsFn);
    httpApi.addRoutes({
      path: "/reports",
      methods: [apigwv2.HttpMethod.GET],
      integration: reportsIntegration,
      authorizer: userAuthorizer,
    });
    httpApi.addRoutes({
      path: "/reports/{filename}",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.DELETE],
      integration: reportsIntegration,
      authorizer: userAuthorizer,
    });

    const factsIntegration = new HttpLambdaIntegration("FactsIntegration", factsFn);
    for (const [routePath, method] of [
      ["/facts/groups", apigwv2.HttpMethod.GET],
      ["/facts/matrix", apigwv2.HttpMethod.GET],
      ["/facts/timeline", apigwv2.HttpMethod.GET],
      ["/facts/witness/{id}", apigwv2.HttpMethod.GET],
      ["/facts/override", apigwv2.HttpMethod.POST],
      ["/facts/accept", apigwv2.HttpMethod.POST],
      ["/facts/hypothesis", apigwv2.HttpMethod.POST],
    ]) {
      httpApi.addRoutes({
        path: routePath,
        methods: [method],
        integration: factsIntegration,
        authorizer: userAuthorizer,
      });
    }

    // The presigned GET is the access control, and a holder of the URL can fetch it outside a
    // browser anyway. A rule naming the distribution's domain would make the data stack
    // depend on this one, which already depends on it for the bucket.
    corpusBucket.addCorsRule({
      allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
      allowedOrigins: ["*"],
      allowedHeaders: ["Range"],
      exposedHeaders: ["Accept-Ranges", "Content-Range", "Content-Length", "ETag"],
      maxAge: 3600,
    });

    new s3deploy.BucketDeployment(this, "Page", {
      destinationBucket: siteBucket,
      sources: [
        s3deploy.Source.asset(UI_DIR),
        s3deploy.Source.asset(stagePageAssets()),
        s3deploy.Source.jsonData("config.json", {
          wsUrl: stage.url,
          httpUrl: httpApi.apiEndpoint,
          spendUrl: `${httpApi.apiEndpoint}/spend`,
          conversationsUrl: `${httpApi.apiEndpoint}/conversations`,
          reportsUrl: `${httpApi.apiEndpoint}/reports`,
          factsUrl: `${httpApi.apiEndpoint}/facts`,
          exportUrl: `${httpApi.apiEndpoint}/export`,
          siteUrl,
          auth: {
            region: this.region,
            userPoolId: userPool.userPoolId,
            clientId: client.userPoolClientId,
          },
          corpora,
        }),
      ],
      distribution,
      distributionPaths: ["/*"],
    });

    new CfnOutput(this, "SiteUrl", { value: siteUrl });
    new CfnOutput(this, "DistributionDomainName", { value: distribution.distributionDomainName });
    new CfnOutput(this, "WebSocketUrl", { value: stage.url });
    new CfnOutput(this, "HttpApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: client.userPoolClientId });
    new CfnOutput(this, "DemoUserName", { value: demoUser.username });
    new CfnOutput(this, "CompareFunctionName", { value: compareFn.functionName });
  }
}
