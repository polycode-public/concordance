// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import { createHandler } from "../../packages/aws/authorizer.mjs";

const ARN = "arn:aws:execute-api:eu-west-2:111111111111:abc123/prod/$connect";

const handler = createHandler({
  verifier: {
    verify: async (token) => {
      if (token !== "good") throw new Error("invalid signature");
      return { sub: "user-1", "cognito:username": "demo" };
    },
  },
});

const connect = (token) =>
  handler({ methodArn: ARN, queryStringParameters: token === undefined ? undefined : { token } });

const statement = (effect) => [{ Action: "execute-api:Invoke", Effect: effect, Resource: ARN }];

describe("WebSocket authorizer", () => {
  it("allows a valid id token", async () => {
    expect(await connect("good")).toEqual({
      principalId: "user-1",
      policyDocument: { Version: "2012-10-17", Statement: statement("Allow") },
      context: { username: "demo" },
    });
  });

  it("denies a bad or missing token", async () => {
    for (const token of ["forged", undefined]) {
      const result = await connect(token);
      expect(result.principalId).toBe("anonymous");
      expect(result.policyDocument.Statement).toEqual(statement("Deny"));
    }
  });
});
