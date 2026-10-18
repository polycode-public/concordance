// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited

// The corpus bucket: off-site copies of the corpus files the laptop path builds, under the
// prefixes raw/ (the source documents), text/ (the extracted text), chunks/ (the retrieval
// chunks) and media/ (images and audio). Versioned, so an overwrite keeps the old copy for 30
// days. The stack is a sandbox: a destroy removes the bucket and its objects.

import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";

export const CORPUS_PREFIXES = ["raw/", "text/", "chunks/", "media/"];

export class DataStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, "CorpusBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        { id: "ExpireNoncurrentVersions", noncurrentVersionExpiration: Duration.days(30) },
      ],
    });

    new CfnOutput(this, "CorpusBucketName", {
      value: this.bucket.bucketName,
      description: `Corpus copies under ${CORPUS_PREFIXES.join(", ")}`,
    });
  }
}
