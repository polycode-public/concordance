---
paths: infra/**/*.mjs
---

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright 2026 Polycode Limited; adapted from DIY Accounting Limited's factory skills -->

# CDK Infrastructure Rules

The laptop path is the build focus. The AWS stacks are a thin sandbox in `polycode-sandbox`
(`687443513271`, `eu-west-2`, profile `polycode-sandbox`). The account record is `AWS_ACCOUNT.md`.

## Stack Pattern

CDK in plain JavaScript (ESM). One file per stack in `infra/lib/`, one app in `infra/bin/app.mjs`.

```js
export class ExampleStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    // 1. Create the data resources (bucket, table)
    // 2. Create IAM roles (least privilege)
    // 3. Create the compute (only when the plan names it)
    // 4. Output names and ARNs through CfnOutput
  }
}
```

## Context, not constants

- The app reads `env`, `account` and `region` from CDK context (`-c env=<name>`,
  `-c account=<id>`, `-c region=<region>`). The defaults are `sandbox`, the credentials in use
  (`CDK_DEFAULT_ACCOUNT`) and `eu-west-2`.
- Never write an account id, a zone id or an ARN into a stack. Pass it in through props from the
  app, which reads it from context or the environment.
- Stack names are `concordance-<env>-<name>`, built by the app's `stackName()` helper.
- Tag every resource through `Tags.of(app)` (`project`, `env`), not per construct.

## Sandbox lifecycle

- Set `removalPolicy: RemovalPolicy.DESTROY` on every stateful resource (and `autoDeleteObjects:
true` on a bucket), so a destroy removes the stack and leaves nothing behind.
- Keep log groups to a short retention (`RetentionDays.ONE_WEEK`).
- Choose resources that scale to zero. Do not add a database that has a standing hourly cost.

## IAM Best Practices

- Follow least privilege. Grant by the construct's `grant*` method before writing a policy by hand.
- Avoid `Resource: "*"`. Use a specific ARN, or a condition key when the service has no ARN.
- A trust policy for GitHub OIDC lives in `infra/iam-trust-policies/` and names the repository
  `polycode-public/concordance` and the branch or environment it allows.
- Block public access, enforce SSL and encrypt every bucket.

## Before you call it done

- `npx cdk synth --quiet` passes (`npm run check:synth`).
- `npx prettier --check infra` and `npx eslint infra` pass.
- A change to a resource name, a stack name or a removal policy says what a deploy will replace.
- A deploy runs only through `deploy.yml` on `main`. Do not run `cdk deploy` from a session.
