// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The REQUEST authorizer on the WebSocket $connect route. A browser cannot set headers on a
// WebSocket, so the Cognito id token arrives as the `token` query string parameter.

const policy = (principalId, effect, resource, context) => ({
  principalId,
  policyDocument: {
    Version: "2012-10-17",
    Statement: [{ Action: "execute-api:Invoke", Effect: effect, Resource: resource }],
  },
  ...(context ? { context } : {}),
});

/** @param {{ verifier: { verify: (token: string) => Promise<Record<string, unknown>> } }} deps */
export function createHandler({ verifier }) {
  return async function handler(event) {
    const token = event.queryStringParameters?.token;
    if (!token) return policy("anonymous", "Deny", event.methodArn);
    try {
      const claims = await verifier.verify(token);
      return policy(String(claims.sub), "Allow", event.methodArn, {
        username: String(claims["cognito:username"] ?? claims.sub),
      });
    } catch {
      return policy("anonymous", "Deny", event.methodArn);
    }
  };
}

let realHandler;
export async function handler(event) {
  if (!realHandler) {
    const { CognitoJwtVerifier } = await import("aws-jwt-verify");
    const verifier = CognitoJwtVerifier.create({
      userPoolId: process.env.USER_POOL_ID,
      clientId: process.env.USER_POOL_CLIENT_ID,
      tokenUse: "id",
    });
    realHandler = createHandler({ verifier });
  }
  return realHandler(event);
}
