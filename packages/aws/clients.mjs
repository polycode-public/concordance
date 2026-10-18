// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The AWS clients behind the Lambda handlers. Each SDK loads on first use, so the offline
// tests, which inject fakes, never load one.

const once = (load) => {
  let promise;
  return () => (promise ??= load());
};

const dynamoSdk = once(() => import("@aws-sdk/client-dynamodb"));
const s3Sdk = once(() => import("@aws-sdk/client-s3"));
const presignerSdk = once(() => import("@aws-sdk/s3-request-presigner"));
const lambdaSdk = once(() => import("@aws-sdk/client-lambda"));
const managementSdk = once(() => import("@aws-sdk/client-apigatewaymanagementapi"));

const requireEnv = (env, name) => {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

/** The partition key of a thread's cancel item. */
export const cancelKey = (connectionId, thread) => `${connectionId}#${thread}`;

/**
 * The cancel table: one item per connection and thread, `{ pk, turnId, cancelled, ttl }`.
 * A running Lambda cannot be aborted from outside, so the turn function polls this item.
 */
export function cancelTable(env = process.env) {
  const TableName = requireEnv(env, "CANCEL_TABLE");
  const client = once(async () => new (await dynamoSdk()).DynamoDBClient({}));
  const send = async (command, input) => {
    const sdk = await dynamoSdk();
    return (await client()).send(new sdk[command](input));
  };
  const conditionFailed = (err) => err?.name === "ConditionalCheckFailedException";
  return {
    async start(pk, turnId, ttl) {
      await send("PutItemCommand", {
        TableName,
        Item: {
          pk: { S: pk },
          turnId: { S: turnId },
          cancelled: { BOOL: false },
          ttl: { N: String(ttl) },
        },
      });
    },
    /** Resolves true when the turn was in flight and is now flagged. */
    async cancel(pk, turnId) {
      try {
        await send("UpdateItemCommand", {
          TableName,
          Key: { pk: { S: pk } },
          UpdateExpression: "SET cancelled = :t",
          ConditionExpression: "turnId = :id AND cancelled = :f",
          ExpressionAttributeValues: {
            ":t": { BOOL: true },
            ":f": { BOOL: false },
            ":id": { S: turnId },
          },
        });
        return true;
      } catch (err) {
        if (conditionFailed(err)) return false;
        throw err;
      }
    },
    async read(pk) {
      const { Item } = await send("GetItemCommand", {
        TableName,
        Key: { pk: { S: pk } },
        ConsistentRead: true,
      });
      return Item ? { turnId: Item.turnId.S, cancelled: Item.cancelled.BOOL } : null;
    },
    async finish(pk, turnId) {
      try {
        await send("DeleteItemCommand", {
          TableName,
          Key: { pk: { S: pk } },
          ConditionExpression: "turnId = :id",
          ExpressionAttributeValues: { ":id": { S: turnId } },
        });
      } catch (err) {
        if (!conditionFailed(err)) throw err;
      }
    },
  };
}

/** Posts one JSON frame to a WebSocket connection. Throws GoneException when it has closed. */
export function connectionPoster() {
  const clients = new Map();
  return async ({ domainName, stage, connectionId }, frame) => {
    const sdk = await managementSdk();
    const endpoint = `https://${domainName}/${stage}`;
    let client = clients.get(endpoint);
    if (!client) {
      client = new sdk.ApiGatewayManagementApiClient({ endpoint });
      clients.set(endpoint, client);
    }
    await client.send(
      new sdk.PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: new TextEncoder().encode(JSON.stringify(frame)),
      }),
    );
  };
}

/** The original PDFs in the corpus bucket: an existence check and a presigned GET. */
export function originalsBucket(env = process.env, expiresIn = 600) {
  const Bucket = requireEnv(env, "CORPUS_BUCKET");
  const client = once(async () => new (await s3Sdk()).S3Client({}));
  return {
    async exists(key) {
      const sdk = await s3Sdk();
      try {
        await (await client()).send(new sdk.HeadObjectCommand({ Bucket, Key: key }));
        return true;
      } catch (err) {
        if (err?.name === "NotFound" || err?.$metadata?.httpStatusCode === 404) return false;
        throw err;
      }
    },
    async presign(key) {
      const [sdk, { getSignedUrl }] = await Promise.all([s3Sdk(), presignerSdk()]);
      return getSignedUrl(await client(), new sdk.GetObjectCommand({ Bucket, Key: key }), {
        expiresIn,
      });
    },
  };
}

/** Invokes the turn function asynchronously, so the WebSocket route returns at once. */
export function turnInvoker(env = process.env) {
  const FunctionName = requireEnv(env, "TURN_FUNCTION_NAME");
  const client = once(async () => new (await lambdaSdk()).LambdaClient({}));
  return async (payload) => {
    const sdk = await lambdaSdk();
    await (
      await client()
    ).send(
      new sdk.InvokeCommand({
        FunctionName,
        InvocationType: "Event",
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
      }),
    );
  };
}

/** Opens the database the store provides. Loaded lazily because it is a deploy-time seam. */
export async function openDatabase(env = process.env) {
  const { openDbFromEnv } = await import("../core/db.mjs");
  return openDbFromEnv(env);
}
