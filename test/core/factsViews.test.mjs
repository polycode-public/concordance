// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { beforeEach, describe, expect, it } from "vitest";
import { runComparison } from "../../packages/core/facts/compare.mjs";
import { factsResponse, latestPerPair } from "../../packages/core/facts/views.mjs";
import { createCompareStore } from "./compareFakeStore.mjs";
import { OTHER_SESSION, SESSION, compareProvider, compareSeed } from "./compareFixture.mjs";

const USER = "sub-1";
let store;

const call = (method, path, { query = {}, body, userId = USER } = {}) =>
  factsResponse(store, { method, path, query, body, userId });

const comparisonId = (a, b) =>
  store.tables.assertion_comparisons.find(
    (c) => c.assertion_a === a && c.assertion_b === b && c.model !== "operator",
  ).id;

beforeEach(async () => {
  store = createCompareStore(compareSeed());
  const { provider } = compareProvider();
  await runComparison({ corpus: "grenfell", db: store, provider, log: () => {} });
});

describe("the groups", () => {
  it("lists every group with its pair and contradiction counts, most contradictions first", async () => {
    const res = await call("GET", "/facts/groups");
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([
      { eventId: "7", name: "smoke in the lobby", topic: null, pairs: 6, contradictions: 4 },
      { eventId: "8", name: "the fire alarm", topic: null, pairs: 1, contradictions: 1 },
      { eventId: null, name: null, topic: "dark", pairs: 1, contradictions: 0 },
      { eventId: "9", name: "leaving the flat", topic: null, pairs: 1, contradictions: 0 },
      { eventId: null, name: null, topic: "told", pairs: 1, contradictions: 0 },
    ]);
  });
});

describe("the matrix", () => {
  it("puts the witnesses on both axes with a cell per pair of witnesses", async () => {
    const { status, body } = await call("GET", "/facts/matrix", { query: { event: "7" } });
    expect(status).toBe(200);
    expect(body.group).toEqual({ eventId: "7", name: "smoke in the lobby", topic: null });
    expect(body.witnesses).toEqual([
      { id: "C123", cipherOnly: true },
      { id: "IWS-A", cipherOnly: false },
      { id: "IWS-B", cipherOnly: false },
    ]);
    expect(body.cells.map((c) => [c.witnessA, c.witnessB, c.label, c.counts])).toEqual([
      ["C123", "IWS-A", "contradict", { agree: 1, contradict: 1, unrelated: 0 }],
      ["C123", "IWS-B", "contradict", { agree: 0, contradict: 1, unrelated: 0 }],
      ["IWS-A", "IWS-A", "contradict", { agree: 0, contradict: 1, unrelated: 0 }],
      ["IWS-A", "IWS-B", "contradict", { agree: 1, contradict: 1, unrelated: 0 }],
    ]);
    const dispute = body.pairs.find((p) => p.a.assertionId === "1" && p.b.assertionId === "3");
    expect(dispute).toMatchObject({
      kind: "cross",
      label: "contradict",
      spanA: "about 1.00 am",
      spanB: "1.30 am",
      model: "rules-v1",
      identityRevealing: false,
      a: {
        witnessId: "IWS-A",
        documentId: "IWS-A1",
        chunkId: "101",
        locator: { page: 2, paragraph: 5 },
        sentence: "I first saw smoke in the lobby at about 1.00 am.",
      },
      b: { witnessId: "C123", cipherOnly: true, documentId: "C123-1" },
    });
    expect(body.pairs[0].label).toBe("contradict");
  });

  it("leaves out the sentences of a pair whose documents reveal an identity together", async () => {
    const { body } = await call("GET", "/facts/matrix", { query: { event: "7" } });
    const pair = body.pairs.find((p) => p.a.assertionId === "2" && p.b.assertionId === "3");
    expect(pair).toMatchObject({
      identityRevealing: true,
      label: "contradict",
      a: { documentId: "IWS-B1", sentence: null },
      b: { documentId: "C123-1", sentence: null },
    });
  });

  it("reads a group with no event by its predicate", async () => {
    const { body } = await call("GET", "/facts/matrix", { query: { topic: "dark" } });
    expect(body.group).toEqual({ eventId: null, name: null, topic: "dark" });
    expect(body.pairs).toHaveLength(1);
    expect(body.pairs[0]).toMatchObject({ label: "unrelated", model: "fake-extract" });
  });

  it("answers 404 for an unknown event and 400 for no group", async () => {
    expect((await call("GET", "/facts/matrix", { query: { event: "99" } })).status).toBe(404);
    expect((await call("GET", "/facts/matrix")).status).toBe(400);
    expect((await call("GET", "/facts/matrix", { query: { event: "7; drop" } })).status).toBe(400);
  });
});

describe("a person's relabel", () => {
  it("stores a new row that wins, keeps the machine label beside it, and survives a later run", async () => {
    const id = comparisonId("4", "5");
    const res = await call("POST", "/facts/override", {
      body: { comparisonId: id, label: "agree", reason: "Both describe the same alarm." },
    });
    expect(res.status).toBe(201);
    expect(res.body.comparison).toMatchObject({
      overrides: id,
      label: "agree",
      model: "operator",
      decidedBy: USER,
      previous: { label: "contradict", model: "fake-extract" },
    });
    const { provider } = compareProvider();
    store.tables.assertions[0].confidence = 0.95;
    expect(
      (await runComparison({ corpus: "grenfell", db: store, provider, log: () => {} })).status,
    ).toBe("complete");
    const { body } = await call("GET", "/facts/matrix", { query: { event: "8" } });
    expect(body.pairs).toHaveLength(1);
    expect(body.pairs[0]).toMatchObject({
      label: "agree",
      reason: "Both describe the same alarm.",
      model: "operator",
      decidedBy: USER,
      machine: { label: "contradict", model: "fake-extract" },
      spanA: "did not sound",
    });
    expect(body.cells[0].label).toBe("agree");
  });

  it("refuses a label the pair's kind does not take, an empty reason and an unknown pair", async () => {
    const id = comparisonId("4", "5");
    const bad = await call("POST", "/facts/override", {
      body: { comparisonId: id, label: "consistent", reason: "x" },
    });
    expect(bad).toEqual({
      status: 400,
      body: { message: "A cross pair takes agree, contradict, unrelated." },
    });
    expect(
      (await call("POST", "/facts/override", { body: { comparisonId: id, label: "agree" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/facts/override", {
          body: { comparisonId: "777", label: "agree", reason: "x" },
        })
      ).status,
    ).toBe(404);
  });
});

describe("promotion and hypotheses", () => {
  it("promotes an assertion with its citation and the person who promoted it", async () => {
    const res = await call("POST", "/facts/accept", {
      body: { assertionId: "2", sourceCitation: "Phase 1 report, fixture paragraph" },
    });
    expect(res.status).toBe(201);
    expect(res.body.fact).toMatchObject({
      assertionId: "2",
      text: "I saw smoke in the lobby at about 1.00 am when I opened the door.",
      sourceCitation: "Phase 1 report, fixture paragraph",
      promotedBy: USER,
      isHypothesis: false,
      sessionId: null,
    });
    expect(store.tables.accepted_facts).toHaveLength(1);
  });

  it("refuses a promotion with no citation and an unknown assertion", async () => {
    expect((await call("POST", "/facts/accept", { body: { assertionId: "2" } })).status).toBe(400);
    expect(
      (await call("POST", "/facts/accept", { body: { assertionId: "404", sourceCitation: "c" } }))
        .status,
    ).toBe(404);
    expect((await call("POST", "/facts/accept", { body: { sourceCitation: "c" } })).status).toBe(
      400,
    );
  });

  it("stores a hypothesis in the user's own session only and shows it to that user only", async () => {
    const other = await call("POST", "/facts/hypothesis", {
      body: { sessionId: OTHER_SESSION, text: "Assume smoke at 1.00 am." },
    });
    expect(other.status).toBe(404);
    const res = await call("POST", "/facts/hypothesis", {
      body: { sessionId: SESSION, text: "Assume the smoke reached the lobby at about 1.00 am." },
    });
    expect(res.status).toBe(201);
    expect(res.body.fact).toMatchObject({
      isHypothesis: true,
      sessionId: SESSION,
      sourceCitation: "session hypothesis",
    });
    const { provider } = compareProvider({
      answer: (pairs) => ({
        labels: pairs.map(({ pair, a }) => ({
          pair,
          label: a.includes("1.30") ? "inconsistent" : "consistent",
          reason: "fixture",
          span_a: "smoke",
          span_b: "smoke",
        })),
      }),
    });
    await runComparison({ corpus: "grenfell", db: store, provider, log: () => {} });
    const mine = await call("GET", "/facts/matrix", { query: { event: "7" } });
    expect(mine.body.accepted.map((p) => [p.a.assertionId, p.label]).sort()).toEqual([
      ["1", "consistent"],
      ["2", "consistent"],
      ["3", "inconsistent"],
      ["6", "inconsistent"],
    ]);
    expect(mine.body.accepted[0].fact).toMatchObject({ isHypothesis: true });
    const theirs = await call("GET", "/facts/matrix", { query: { event: "7" }, userId: "sub-2" });
    expect(theirs.body.accepted).toEqual([]);
  });
});

describe("the witness report and the timeline", () => {
  it("orders a witness's own pairs by statement date and counts their cross labels", async () => {
    const { status, body } = await call("GET", "/facts/witness/IWS-A");
    expect(status).toBe(200);
    expect(body.witness).toEqual({ id: "IWS-A", cipherOnly: false, role: "Resident" });
    expect(body.documents).toEqual([
      { id: "IWS-A1", statementDate: "2017-09-01" },
      { id: "IWS-A2", statementDate: "2018-03-01" },
    ]);
    expect(body.self).toHaveLength(1);
    expect(body.self[0]).toMatchObject({
      label: "contradict",
      a: { statementDate: "2017-09-01", timeText: "about 1.00 am" },
      b: { statementDate: "2018-03-01", timeText: "1.30 am" },
    });
    expect(body.cross).toEqual([
      { witnessId: "IWS-B", cipherOnly: false, counts: { agree: 2, contradict: 2, unrelated: 0 } },
      { witnessId: "C123", cipherOnly: true, counts: { agree: 1, contradict: 1, unrelated: 1 } },
    ]);
    expect((await call("GET", "/facts/witness/NOBODY")).status).toBe(404);
    expect((await call("GET", "/facts/witness/..%2Fx")).status).toBe(400);
  });

  it("places each timed assertion on its window, filtered by event and witness", async () => {
    const all = await call("GET", "/facts/timeline");
    expect(all.body.points.map((p) => [p.assertionId, p.window.startClock])).toEqual([
      ["1", "00:50"],
      ["2", "00:50"],
      ["3", "01:25"],
      ["6", "01:25"],
      ["8", "02:05"],
    ]);
    const one = await call("GET", "/facts/timeline", { query: { event: "7", witness: "IWS-A" } });
    expect(one.body.points.map((p) => p.assertionId)).toEqual(["1", "6"]);
    expect(one.body.points[0]).toMatchObject({
      documentId: "IWS-A1",
      locator: { page: 2, paragraph: 5 },
    });
  });
});

describe("routing", () => {
  it("answers 404 for an unknown route and 405 for the wrong method", async () => {
    expect((await call("GET", "/facts/nothing")).status).toBe(404);
    expect((await call("POST", "/facts/groups", { body: {} })).status).toBe(405);
    expect((await call("GET", "/facts/accept")).status).toBe(405);
    expect((await call("POST", "/facts/accept", { body: [] })).status).toBe(400);
  });
});

describe("latestPerPair", () => {
  it("shows the newest person's row over a newer machine row", () => {
    const row = (id, model, label, runAt) => ({
      id,
      kind: "cross",
      assertionA: "1",
      assertionB: "2",
      factId: null,
      model,
      label,
      runAt,
    });
    const [{ shown, machine }] = latestPerPair([
      row("1", "rules-v1", "contradict", "2026-01-01T00:00:00.000Z"),
      row("2", "operator", "agree", "2026-01-02T00:00:00.000Z"),
      row("3", "operator", "unrelated", "2026-01-03T00:00:00.000Z"),
      row("4", "m", "contradict", "2026-01-04T00:00:00.000Z"),
    ]);
    expect([shown.id, machine.id]).toEqual(["3", "4"]);
  });
});
