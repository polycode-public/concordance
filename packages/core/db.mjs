// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import pg from "pg";

export const DEFAULT_DATABASE_URL = "postgres://concordance:concordance@localhost:5432/concordance";

/**
 * Creates a connection pool. The pool connects on the first query.
 * @param {string} [connectionString]
 */
export function createDb(connectionString = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000 });
  return {
    pool,
    /** @param {string} text @param {unknown[]} [params] */
    query: (text, params) => pool.query(text, params),
    close: () => pool.end(),
  };
}

const RESUME_ATTEMPTS = 12;
const RESUME_WAIT_MS = 5000;
const INT8_TYPES = new Set(["int8", "bigserial", "serial8"]);
const JSON_TYPES = new Set(["jsonb", "json"]);

/**
 * Rewrites `$n` placeholders to the Data API's `:pn` names. Text inside single-quoted strings,
 * double-quoted identifiers and comments is left as it is; a `::type` cast after the
 * placeholder stays in place.
 * @param {string} text
 */
export function toNamedParameters(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    let end = i + 1;
    if (ch === "'" || ch === '"') {
      end = text.indexOf(ch, i + 1);
      while (end !== -1 && text[end + 1] === ch) end = text.indexOf(ch, end + 2);
      end = end === -1 ? text.length : end + 1;
    } else if (ch === "-" && next === "-") {
      end = text.indexOf("\n", i);
      end = end === -1 ? text.length : end;
    } else if (ch === "/" && next === "*") {
      end = text.indexOf("*/", i + 2);
      end = end === -1 ? text.length : end + 2;
    } else if (ch === "$" && /[0-9]/.test(next ?? "")) {
      const digits = /^[0-9]+/.exec(text.slice(i + 1))[0];
      out += `:p${digits}`;
      i += 1 + digits.length;
      continue;
    }
    out += text.slice(i, end);
    i = end;
  }
  return out;
}

function quoteArrayElement(value) {
  if (value === null || value === undefined) return "NULL";
  if (Array.isArray(value)) return toArrayLiteral(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`array element ${value} is not a finite number`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/**
 * Serialises a JavaScript array to a Postgres array literal. The Data API takes no array
 * parameters, so an array travels as this string and the SQL's `::type[]` cast parses it;
 * an array parameter without a cast reaches Postgres as varchar and fails.
 * @param {unknown[]} values
 */
export function toArrayLiteral(values) {
  return `{${values.map(quoteArrayElement).join(",")}}`;
}

/**
 * One Data API parameter for one positional value.
 * @param {string} name
 * @param {unknown} value
 */
export function toDataApiParameter(name, value) {
  if (value === null || value === undefined) return { name, value: { isNull: true } };
  if (typeof value === "string") return { name, value: { stringValue: value } };
  if (typeof value === "boolean") return { name, value: { booleanValue: value } };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`parameter ${name} is not a finite number`);
    return Number.isInteger(value)
      ? { name, value: { longValue: value } }
      : { name, value: { doubleValue: value } };
  }
  if (typeof value === "bigint") return { name, value: { stringValue: String(value) } };
  if (Array.isArray(value)) return { name, value: { stringValue: toArrayLiteral(value) } };
  if (value instanceof Date) {
    return {
      name,
      value: { stringValue: value.toISOString().replace("T", " ").replace("Z", "") },
      typeHint: "TIMESTAMP",
    };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { name, value: { blobValue: value } };
  }
  if (typeof value === "object") {
    return { name, value: { stringValue: JSON.stringify(value) }, typeHint: "JSON" };
  }
  throw new Error(`parameter ${name} has the unsupported type ${typeof value}`);
}

/**
 * Maps a Data API result to the `pg` result shape: int8 columns as strings and jsonb
 * columns parsed, as `pg` returns them.
 */
export function toRows(result) {
  if (result.formattedRecords === undefined) return [];
  const rows = JSON.parse(result.formattedRecords);
  const metadata = result.columnMetadata ?? [];
  const json = metadata.filter((c) => JSON_TYPES.has(c.typeName)).map((c) => c.name);
  const int8 = metadata.filter((c) => INT8_TYPES.has(c.typeName)).map((c) => c.name);
  for (const row of rows) {
    for (const column of json) {
      if (typeof row[column] === "string") row[column] = JSON.parse(row[column]);
    }
    for (const column of int8) {
      if (typeof row[column] === "number") row[column] = String(row[column]);
    }
  }
  return rows;
}

const TRANSACTION_CONTROL = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK)\s*;?\s*$/i;

/**
 * A database over the Aurora RDS Data API with the `createDb` shape: `query(text, params)`
 * resolves to `{ rows, rowCount }`, and `pool.connect()` gives a session with its own
 * transaction. `BEGIN`, `COMMIT` and `ROLLBACK` map to the Data API transaction calls.
 * A request is at most 64 KB and a response at most 1 MB: a batch insert with many
 * embeddings, or a select of many full chunk rows, must stay under those limits.
 * @param {{ resourceArn: string, secretArn: string, database: string, region?: string,
 *   sdk?: object, client?: { send: Function }, wait?: (ms: number) => Promise<void> }} options
 */
export function createDataApiDb({
  resourceArn,
  secretArn,
  database,
  region,
  sdk,
  client,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!resourceArn || !secretArn || !database) {
    throw new Error("createDataApiDb needs resourceArn, secretArn and database");
  }
  let ready;
  const load = () =>
    (ready ??= (async () => {
      const lib = sdk ?? (await import("@aws-sdk/client-rds-data"));
      return { lib, client: client ?? new lib.RDSDataClient(region ? { region } : {}) };
    })());

  // A paused Serverless v2 cluster answers DatabaseResumingException until it is up.
  const send = async (make) => {
    const { lib, client: c } = await load();
    for (let attempt = 1; ; attempt++) {
      try {
        return await c.send(make(lib));
      } catch (err) {
        if (err?.name !== "DatabaseResumingException" || attempt >= RESUME_ATTEMPTS) throw err;
        await wait(RESUME_WAIT_MS);
      }
    }
  };

  const session = () => {
    let transactionId;
    return async (text, params = []) => {
      const control = TRANSACTION_CONTROL.exec(text)?.[1].toUpperCase();
      if (control === "BEGIN" || control?.startsWith("START")) {
        if (transactionId) throw new Error("a transaction is already open in this session");
        ({ transactionId } = await send(
          (lib) => new lib.BeginTransactionCommand({ resourceArn, secretArn, database }),
        ));
        return { rows: [], rowCount: 0 };
      }
      if (control) {
        if (!transactionId) throw new Error(`${control} with no open transaction`);
        const id = transactionId;
        transactionId = undefined;
        await send((lib) =>
          control === "ROLLBACK"
            ? new lib.RollbackTransactionCommand({ resourceArn, secretArn, transactionId: id })
            : new lib.CommitTransactionCommand({ resourceArn, secretArn, transactionId: id }),
        );
        return { rows: [], rowCount: 0 };
      }
      const input = {
        resourceArn,
        secretArn,
        database,
        sql: toNamedParameters(text),
        parameters: params.map((value, i) => toDataApiParameter(`p${i + 1}`, value)),
        includeResultMetadata: true,
        formatRecordsAs: "JSON",
        ...(transactionId ? { transactionId } : {}),
      };
      const result = await send((lib) => new lib.ExecuteStatementCommand(input));
      const rows = toRows(result);
      return {
        rows,
        rowCount: result.formattedRecords ? rows.length : result.numberOfRecordsUpdated,
      };
    };
  };

  return {
    pool: {
      connect: async () => ({ query: session(), release: () => {} }),
    },
    query: session(),
    close: async () => {},
  };
}

/**
 * Opens the database the environment names: the Data API when `DB_RESOURCE_ARN` is set,
 * the `pg` pool when `DATABASE_URL` is set.
 * @param {Record<string, string | undefined>} [env]
 */
export function openDbFromEnv(env = process.env) {
  if (env.DB_RESOURCE_ARN && env.DATABASE_URL) {
    throw new Error("both DB_RESOURCE_ARN and DATABASE_URL are set; set one");
  }
  if (env.DATABASE_URL) return createDb(env.DATABASE_URL);
  if (env.DB_RESOURCE_ARN) {
    return createDataApiDb({
      resourceArn: env.DB_RESOURCE_ARN,
      secretArn: env.DB_SECRET_ARN,
      database: env.DB_NAME,
      region: env.AWS_REGION,
    });
  }
  throw new Error("set DB_RESOURCE_ARN (the Data API) or DATABASE_URL (Postgres)");
}
