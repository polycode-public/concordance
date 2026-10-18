// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

// The store: an Aurora Serverless v2 Postgres cluster with pgvector, reached over the RDS Data
// API, so no caller needs a VPC route to it. The VPC has isolated subnets only (no NAT gateway,
// no internet gateway). The cluster scales to zero and pauses when idle. A trigger applies
// db/migrations on every deploy. The stack is a sandbox: a destroy removes the cluster and its
// data.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, Token } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as triggers from "aws-cdk-lib/triggers";

export const DATABASE_NAME = "concordance";
export const DATABASE_USER = "concordance";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLED_MIGRATIONS = "migrations";

export class StoreStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    if (Token.isUnresolved(this.region)) throw new Error("StoreStack needs an explicit region");

    // Naming the zones keeps synth free of an availability-zone lookup.
    const vpc = new ec2.Vpc(this, "Vpc", {
      availabilityZones: [`${this.region}a`, `${this.region}b`],
      natGateways: 0,
      subnetConfiguration: [
        { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    this.cluster = new rds.DatabaseCluster(this, "Cluster", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_13,
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      defaultDatabaseName: DATABASE_NAME,
      credentials: rds.Credentials.fromGeneratedSecret(DATABASE_USER),
      writer: rds.ClusterInstance.serverlessV2("writer"),
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 2,
      serverlessV2AutoPauseDuration: Duration.minutes(10),
      enableDataApi: true,
      storageEncrypted: true,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.secret = this.cluster.secret;

    const migrateFn = new NodejsFunction(this, "MigrateFunction", {
      entry: path.join(ROOT, "packages", "aws", "migrate.mjs"),
      handler: "handler",
      projectRoot: ROOT,
      depsLockFilePath: path.join(ROOT, "package-lock.json"),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.minutes(5),
      memorySize: 256,
      environment: {
        DB_RESOURCE_ARN: this.cluster.clusterArn,
        DB_SECRET_ARN: this.secret.secretArn,
        DB_NAME: DATABASE_NAME,
        MIGRATIONS_DIR: `/var/task/${BUNDLED_MIGRATIONS}`,
        // A new value on every synth changes the function, so the trigger runs on every deploy.
        DEPLOY_STAMP: String(Date.now()),
      },
      bundling: {
        format: OutputFormat.ESM,
        target: "node24",
        // pg requires Node built-ins through require(), which an ESM bundle lacks.
        banner:
          "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        externalModules: ["@aws-sdk/*", "pg-native"],
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (inputDir, outputDir) => [
            `cp -R "${path.join(inputDir, "db", "migrations")}" "${path.join(outputDir, BUNDLED_MIGRATIONS)}"`,
          ],
        },
      },
    });
    this.cluster.grantDataApiAccess(migrateFn);

    new triggers.Trigger(this, "MigrateTrigger", {
      handler: migrateFn,
      executeAfter: [this.cluster],
      executeOnHandlerChange: true,
      timeout: Duration.minutes(5),
    });

    new CfnOutput(this, "ClusterArn", {
      value: this.cluster.clusterArn,
      description: "Aurora cluster ARN (DB_RESOURCE_ARN)",
    });
    new CfnOutput(this, "SecretArn", {
      value: this.secret.secretArn,
      description: "Database credentials secret ARN (DB_SECRET_ARN)",
    });
    new CfnOutput(this, "DatabaseName", { value: DATABASE_NAME, description: "DB_NAME" });
  }
}
