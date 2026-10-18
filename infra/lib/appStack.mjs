// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

// The serving layer: the chat WebSocket on API Gateway with a Lambda per route, the turn
// function it invokes asynchronously, the cancel table, GET /doc/{id} on an HTTP API, one
// Cognito user, and the page on CloudFront with a generated config.json. Every resource is
// destroyable and nothing costs money at idle.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AWS_DIR = path.join(ROOT, "packages", "aws");
const UI_DIR = path.join(ROOT, "packages", "ui");

export const DEMO_USER = "demo";
export const STAGE_NAME = "prod";

// The bundle is ESM; pg and other CommonJS dependencies call require().
const REQUIRE_BANNER =
  "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);";

export class AppStack extends Stack {
  /**
   * @param {import('constructs').Construct} scope
   * @param {string} id
   * @param {import('aws-cdk-lib').StackProps & { corpusBucket: s3.Bucket, dbResourceArn: string,
   *   dbSecretArn: string, dbName: string, corpusId?: string, corpusTitle?: string,
   *   corpusSubtitle?: string }} props
   */
  constructor(scope, id, props) {
    super(scope, id, props);
    const { corpusBucket, dbResourceArn, dbSecretArn, dbName } = props;
    const {
      corpusId = "grenfell",
      corpusTitle = "Grenfell Tower Inquiry",
      corpusSubtitle = "witness statements",
    } = props;
    if (typeof corpusBucket?.addCorsRule !== "function") {
      throw new Error("AppStack needs the corpus Bucket construct, to add its CORS rule");
    }

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
    const fn = (name, { timeout = Duration.seconds(30), memorySize = 256, environment }) =>
      new NodejsFunction(this, `${name[0].toUpperCase()}${name.slice(1)}Function`, {
        entry: path.join(AWS_DIR, `${name}.mjs`),
        handler: "handler",
        projectRoot: ROOT,
        depsLockFilePath: path.join(ROOT, "package-lock.json"),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        timeout,
        memorySize,
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
      environment: dbEnv,
    });
    const wsRoutesFn = fn("wsRoutes", {
      environment: { ...dbEnv, TURN_FUNCTION_NAME: turnFn.functionName },
    });
    const docFn = fn("doc", { environment: { CORPUS_BUCKET: corpusBucket.bucketName } });

    // A failed turn has already told the client; a retry would answer the question twice.
    new lambda.EventInvokeConfig(this, "TurnInvokeConfig", {
      function: turnFn,
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

    const httpApi = new apigwv2.HttpApi(this, "DocApi");
    httpApi.addRoutes({
      path: "/doc/{id}",
      methods: [apigwv2.HttpMethod.GET],
      integration: new HttpLambdaIntegration("DocIntegration", docFn),
      authorizer: new HttpUserPoolAuthorizer("DocAuthorizer", userPool, {
        userPoolClients: [client],
      }),
    });

    for (const f of [turnFn, wsRoutesFn]) {
      webSocketApi.grantManageConnections(f);
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
    turnFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          "arn:aws:bedrock:*::foundation-model/*",
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
        ],
      }),
    );
    cancelTable.grantReadWriteData(turnFn);
    cancelTable.grantReadWriteData(wsRoutesFn);
    turnFn.grantInvoke(wsRoutesFn);
    corpusBucket.grantRead(wsRoutesFn, "*/raw/*");
    corpusBucket.grantRead(docFn, "*/raw/*");

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
    });

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
        s3deploy.Source.jsonData("config.json", {
          wsUrl: stage.url,
          httpUrl: httpApi.apiEndpoint,
          auth: {
            region: this.region,
            userPoolId: userPool.userPoolId,
            clientId: client.userPoolClientId,
          },
          corpus: { id: corpusId, title: corpusTitle, subtitle: corpusSubtitle },
        }),
      ],
      distribution,
      distributionPaths: ["/*"],
    });

    new CfnOutput(this, "SiteUrl", { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, "WebSocketUrl", { value: stage.url });
    new CfnOutput(this, "HttpApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: client.userPoolClientId });
    new CfnOutput(this, "DemoUserName", { value: demoUser.username });
  }
}
