// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { describe, expect, it } from "vitest";
import {
  createDataApiDb,
  openDbFromEnv,
  toArrayLiteral,
  toNamedParameters,
} from "../../packages/core/db.mjs";

const ARNS = {
  resourceArn: "arn:aws:rds:eu-west-2:111111111111:cluster:store",
  secretArn: "arn:aws:secretsmanager:eu-west-2:111111111111:secret:store",
  database: "concordance",
};

function command(kind) {
  return class {
    constructor(input) {
      this.kind = kind;
      this.input = input;
    }
  };
}

const sdk = {
  ExecuteStatementCommand: command("execute"),
  BeginTransactionCommand: command("begin"),
  CommitTransactionCommand: command("commit"),
  RollbackTransactionCommand: command("rollback"),
};

function fakeClient(respond = () => ({})) {
  const sent = [];
  return {
    sent,
    send: async (cmd) => {
      sent.push(cmd);
      if (cmd.kind === "begin") return { transactionId: `tx-${sent.length}` };
      return respond(cmd);
    },
  };
}

const open = (client, extra = {}) => createDataApiDb({ ...ARNS, sdk, client, ...extra });

describe("toNamedParameters", () => {
  it("rewrites $n to :pn and keeps the cast", () => {
    expect(toNamedParameters("ORDER BY embedding <=> $1::halfvec LIMIT $12")).toBe(
      "ORDER BY embedding <=> :p1::halfvec LIMIT :p12",
    );
  });

  it("leaves strings, quoted identifiers and comments alone", () => {
    const sql = `SELECT '$1', "a$2", $3 -- $4\n/* $5 */ FROM t WHERE x = 'it''s $6'`;
    expect(toNamedParameters(sql)).toBe(
      `SELECT '$1', "a$2", :p3 -- $4\n/* $5 */ FROM t WHERE x = 'it''s $6'`,
    );
  });
});

describe("toArrayLiteral", () => {
  it("serialises text[] with quoting and NULL", () => {
    expect(toArrayLiteral(["a", null, 'say "hi", {ok} \\ end'])).toBe(
      '{"a",NULL,"say \\"hi\\", {ok} \\\\ end"}',
    );
  });

  it("serialises bigint[] and int[] bare", () => {
    expect(toArrayLiteral(["12", "13"])).toBe('{"12","13"}');
    expect(toArrayLiteral([1, 2, null])).toBe("{1,2,NULL}");
  });

  it("serialises jsonb[] elements as quoted JSON text", () => {
    const locator = JSON.stringify({ page: 3, note: 'a "b", c} \\ d' });
    expect(toArrayLiteral([locator, { page: 4 }])).toBe(
      `{"{\\"page\\":3,\\"note\\":\\"a \\\\\\"b\\\\\\", c} \\\\\\\\ d\\"}","{\\"page\\":4}"}`,
    );
  });

  it("serialises the empty array", () => {
    expect(toArrayLiteral([])).toBe("{}");
  });
});

describe("createDataApiDb", () => {
  it("sends one ExecuteStatement with typed parameters", async () => {
    const client = fakeClient();
    const db = open(client);
    await db.query("SELECT $1, $2, $3, $4, $5, $6", ["text", 7, 1.5, true, null, [1, 2]]);
    expect(client.sent).toHaveLength(1);
    const [cmd] = client.sent;
    expect(cmd.kind).toBe("execute");
    expect(cmd.input).toEqual({
      ...ARNS,
      sql: "SELECT :p1, :p2, :p3, :p4, :p5, :p6",
      parameters: [
        { name: "p1", value: { stringValue: "text" } },
        { name: "p2", value: { longValue: 7 } },
        { name: "p3", value: { doubleValue: 1.5 } },
        { name: "p4", value: { booleanValue: true } },
        { name: "p5", value: { isNull: true } },
        { name: "p6", value: { stringValue: "{1,2}" } },
      ],
      includeResultMetadata: true,
      formatRecordsAs: "JSON",
    });
  });

  it("maps formattedRecords to rows with jsonb parsed and int8 as strings", async () => {
    const client = fakeClient(() => ({
      formattedRecords: JSON.stringify([{ id: 41, n: 2, locator: '{"page":3}', text: "x" }]),
      columnMetadata: [
        { name: "id", typeName: "int8" },
        { name: "n", typeName: "int4" },
        { name: "locator", typeName: "jsonb" },
        { name: "text", typeName: "text" },
      ],
    }));
    const { rows, rowCount } = await open(client).query("SELECT 1");
    expect(rows).toEqual([{ id: "41", n: 2, locator: { page: 3 }, text: "x" }]);
    expect(rowCount).toBe(1);
  });

  it("returns no rows for a statement without records", async () => {
    const client = fakeClient(() => ({ numberOfRecordsUpdated: 3 }));
    expect(await open(client).query("DELETE FROM t")).toEqual({ rows: [], rowCount: 3 });
  });

  it("maps BEGIN and COMMIT to the transaction calls and threads the id", async () => {
    const client = fakeClient();
    const db = open(client);
    await db.query("BEGIN");
    await db.query("INSERT INTO t VALUES ($1)", ["a"]);
    await db.query("COMMIT");
    await db.query("SELECT 1");
    expect(client.sent.map((c) => c.kind)).toEqual(["begin", "execute", "commit", "execute"]);
    expect(client.sent[0].input).toEqual(ARNS);
    expect(client.sent[1].input.transactionId).toBe("tx-1");
    expect(client.sent[2].input).toEqual({
      resourceArn: ARNS.resourceArn,
      secretArn: ARNS.secretArn,
      transactionId: "tx-1",
    });
    expect(client.sent[3].input).not.toHaveProperty("transactionId");
  });

  it("maps ROLLBACK to RollbackTransaction", async () => {
    const client = fakeClient();
    const db = open(client);
    await db.query("BEGIN");
    await db.query("ROLLBACK");
    expect(client.sent.map((c) => c.kind)).toEqual(["begin", "rollback"]);
    expect(client.sent[1].input.transactionId).toBe("tx-1");
  });

  it("throws on COMMIT with no transaction and on a nested BEGIN", async () => {
    const db = open(fakeClient());
    await expect(db.query("COMMIT")).rejects.toThrow(/no open transaction/);
    await db.query("BEGIN");
    await expect(db.query("BEGIN")).rejects.toThrow(/already open/);
  });

  it("gives each pool session its own transaction", async () => {
    const client = fakeClient();
    const db = open(client);
    const session = await db.pool.connect();
    await session.query("BEGIN");
    await db.query("SELECT 1");
    await session.query("SELECT 2");
    expect(client.sent[1].input).not.toHaveProperty("transactionId");
    expect(client.sent[2].input.transactionId).toBe("tx-1");
    session.release();
  });

  it("retries while the cluster resumes", async () => {
    let calls = 0;
    const client = {
      send: async () => {
        calls++;
        if (calls < 3)
          throw Object.assign(new Error("resuming"), { name: "DatabaseResumingException" });
        return {};
      },
    };
    await open(client, { wait: async () => {} }).query("SELECT 1");
    expect(calls).toBe(3);
  });

  it("does not retry other errors", async () => {
    const client = {
      send: async () => {
        throw Object.assign(new Error("bad sql"), { name: "BadRequestException" });
      },
    };
    await expect(open(client, { wait: async () => {} }).query("SELEC")).rejects.toThrow("bad sql");
  });
});

describe("openDbFromEnv", () => {
  it("opens the Data API when DB_RESOURCE_ARN is set", () => {
    const db = openDbFromEnv({
      DB_RESOURCE_ARN: ARNS.resourceArn,
      DB_SECRET_ARN: ARNS.secretArn,
      DB_NAME: ARNS.database,
    });
    expect(db.pool).not.toHaveProperty("end");
    expect(typeof db.pool.connect).toBe("function");
  });

  it("opens the pg pool when DATABASE_URL is set", async () => {
    const db = openDbFromEnv({ DATABASE_URL: "postgres://u:p@localhost:1/x" });
    expect(typeof db.pool.end).toBe("function");
    await db.close();
  });

  it("throws when both are set", () => {
    expect(() =>
      openDbFromEnv({ DB_RESOURCE_ARN: ARNS.resourceArn, DATABASE_URL: "postgres://x" }),
    ).toThrow(/both/);
  });

  it("throws when neither is set", () => {
    expect(() => openDbFromEnv({})).toThrow(/DB_RESOURCE_ARN/);
  });
});
