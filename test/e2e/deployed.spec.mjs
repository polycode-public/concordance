// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { appendFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

const SITE_URL = (process.env.SITE_URL ?? "").replace(/\/$/, "");
const ABSTENTION = "the corpus does not say";
const TURN_TIMEOUT_MS = 60_000;

const PILL_LISTS = ["#suggestions", "#documents-suggestions", "#evidence-suggestions"];
const OFF_CORPUS = "What is the capital of France?";

const REPORT_FILENAME = "first-awareness.md";
const REPORT_DOCUMENTS = ["IWS00000913", "IWS00000990"];
const REPORT_EDIT = `Add a short section on the 999 calls to ${REPORT_FILENAME}`;
const REPORT_TIMEOUT_MS = 5 * 60_000;

test.skip(
  process.env.CONCORDANCE_DEPLOYED_TESTS !== "1" || SITE_URL === "",
  "Set CONCORDANCE_DEPLOYED_TESTS=1 and SITE_URL (plus DEMO_USER and DEMO_PASSWORD for a site behind sign-in) to run the deployed-page test.",
);

const report = [];

function emit(markdown) {
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

async function signIn(page) {
  const user = process.env.DEMO_USER;
  const password = process.env.DEMO_PASSWORD;
  if (!password) {
    await expect(page.locator("#signin")).toBeHidden();
    return;
  }
  await expect(page.locator("#signin")).toBeVisible({ timeout: 30_000 });
  await page.locator("#signin-user").fill(user ?? "demo");
  await page.locator("#signin-password").fill(password);
  await page.locator('#signin button[type="submit"]').click();
  await expect(page.locator("#signin")).toBeHidden({ timeout: 30_000 });
  await expect(page.locator("#signin-message")).toHaveText("");
}

async function newConversation(page) {
  await page.locator("#conversations-open").click();
  await page.locator("#conversations-new").click();
  await expect(page.locator("article.turn")).toHaveCount(0);
}

// A pill is visible only on an empty conversation, so every turn but the first starts a new one.
async function ask(page, submit, label) {
  await expect(page.locator("#connection")).toHaveText("connected", { timeout: 30_000 });
  const turns = page.locator("article.turn");
  const before = await turns.count();
  await submit();
  await expect(turns).toHaveCount(before + 1, { timeout: 15_000 });
  const turn = turns.last();
  const states = turn.locator("ol.stages li[data-state]");
  await expect
    .poll(
      async () =>
        (await states.evaluateAll((items) => items.map((li) => li.dataset.state))).join(","),
      {
        timeout: TURN_TIMEOUT_MS,
        message: `turn for "${label}" reaches done`,
      },
    )
    .toMatch(/^done(,done)*$/);
  const answer = (await turn.locator(".answer").innerText()).trim();
  const score = (await turn.locator(".score").innerText()).trim();
  return { turn, answer, score };
}

async function typeQuestion(page, question) {
  await page.locator("#question").fill(question);
  await page.locator("#ask").evaluate((form) => form.requestSubmit());
}

const reportEntry = (page) => page.locator(`#reports-list li[data-filename="${REPORT_FILENAME}"]`);

// The status line keeps its "done" level until the next request replaces it, so completion is read
// from the version count the list shows after the refresh that follows "done".
async function waitForVersions(page, versions, label) {
  await expect
    .poll(
      async () => {
        if ((await page.locator("#report-status").getAttribute("data-level")) === "error") {
          return `error: ${(await page.locator("#report-status").innerText()).trim()}`;
        }
        return await reportEntry(page).locator("button.version").count();
      },
      { timeout: REPORT_TIMEOUT_MS, intervals: [2_000], message: label },
    )
    .toBe(versions);
}

async function deleteReport(page) {
  const entry = reportEntry(page);
  await entry.locator("button.delete").click();
  await expect(entry.locator("button.confirm-yes")).toBeVisible();
  return entry;
}

test("signs in, clicks every pill and asks one off-corpus question", async ({ page }) => {
  test.setTimeout(20 * 60_000);
  await page.goto(`${SITE_URL}/`);
  await signIn(page);
  await expect(page.locator("#question")).toBeVisible();
  await expect(page.locator("#suggestions button.pill").first()).toBeVisible({ timeout: 30_000 });

  emit("## concordance deployed page\n");
  let firstChip = null;
  let started = false;

  for (const list of PILL_LISTS) {
    const count = await page.locator(`${list} button.pill`).count();
    expect(count, `pills in ${list}`).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      if (started) await newConversation(page);
      started = true;
      const pill = page.locator(`${list} button.pill`).nth(index);
      await expect(pill).toBeVisible();
      const question = (await pill.innerText()).trim();
      const { turn, answer, score } = await ask(page, () => pill.click(), question);
      const chips = turn.locator("button.cite");
      expect(await chips.count(), `citation chips for "${question}"`).toBeGreaterThan(0);
      expect(
        answer.toLowerCase().replace(ABSTENTION, "").trim().length,
        `an answer beyond the abstention for "${question}"`,
      ).toBeGreaterThan(0);
      expect(score).toMatch(/\d+ of \d+ sentences supported/);
      firstChip ??= chips.first();
      report.push({ question: `${list} pill: ${question}`, answer, score });
    }
  }

  await firstChip.click();
  await expect(page.locator("#viewer")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#viewer-title")).not.toHaveText("");
  await expect(page.locator("#viewer-page")).not.toHaveText("");
  const locator = {
    title: (await page.locator("#viewer-title").innerText()).trim(),
    page: (await page.locator("#viewer-page").innerText()).trim(),
  };

  await newConversation(page);
  const off = await ask(page, () => typeQuestion(page, OFF_CORPUS), OFF_CORPUS);
  expect(off.answer.toLowerCase()).toContain(ABSTENTION);
  report.push({ question: OFF_CORPUS, answer: off.answer, score: off.score });

  if (await page.locator("#viewer").isVisible()) await page.locator("#viewer-close").click();
  await expect(page.locator("#reports-list")).toBeAttached();
  if ((await reportEntry(page).count()) > 0) {
    const stale = await deleteReport(page);
    await stale.locator("button.confirm-yes").click();
    await expect(reportEntry(page)).toHaveCount(0, { timeout: 30_000 });
  }

  const reportPill = page.locator("#reports-suggestions button.pill");
  await expect(reportPill).toHaveCount(1);
  const reportTopic = (await reportPill.innerText()).trim();
  await reportPill.click();
  await expect(page.locator("#report-topic")).toHaveValue(reportTopic);
  await expect(page.locator("#report-filename")).toHaveValue(REPORT_FILENAME);
  await page.locator("#report-other-ids").fill(REPORT_DOCUMENTS.join(" "));
  await page.locator("#report-submit").click();
  await waitForVersions(page, 1, "the report reaches version 1");
  await expect(page.locator("#report-status")).toHaveAttribute("data-level", "done");

  const entry = reportEntry(page);
  await entry.locator("button.version").first().click();
  const view = page.locator("#report-view");
  await expect(view).toBeVisible({ timeout: 30_000 });
  expect(await view.locator("h4").count(), "section headings in the report").toBeGreaterThan(0);
  expect(await view.locator("button.cite").count(), "chips in the report").toBeGreaterThan(0);
  const uncited = await view
    .locator(".answer p")
    .evaluateAll(
      (items, abstention) =>
        items
          .filter(
            (p) =>
              !p.querySelector("button.cite") && !p.textContent.toLowerCase().includes(abstention),
          )
          .map((p) => p.textContent.trim()),
      ABSTENTION,
    );
  expect(uncited, "report paragraphs with neither a chip nor the abstention").toEqual([]);
  const first = {
    title: (await view.locator("summary").innerText()).trim(),
    checks: (await view.locator("p.score").innerText()).trim(),
  };
  await view.locator("button.cite").first().click();
  await expect(page.locator("#viewer")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#viewer-title")).not.toHaveText("");
  await page.locator("#viewer-close").click();

  await page.locator("#question").fill(REPORT_EDIT);
  await page.locator("#ask").evaluate((form) => form.requestSubmit());
  await waitForVersions(page, 2, "the edit reaches version 2");
  await expect(page.locator("#report-status")).toHaveAttribute("data-level", "done");
  const secondTitle = (await page.locator("#report-status").innerText()).trim();
  await reportEntry(page).locator("button.version").nth(1).click();
  await expect(view.locator("summary")).toContainText("v2");
  const second = {
    title: secondTitle,
    checks: (await view.locator("p.score").innerText()).trim(),
  };

  const doomed = await deleteReport(page);
  await doomed.locator("button.confirm-no").click();
  await expect(reportEntry(page)).toHaveCount(1);
  await expect(reportEntry(page).locator("button.confirm-yes")).toHaveCount(0);
  await deleteReport(page);
  await reportEntry(page).locator("button.confirm-yes").click();
  await expect(reportEntry(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator("#reports-empty")).toBeVisible();

  report.forEach(({ question, answer, score }, index) => {
    emit(`### ${question}\n\n> ${answer.replace(/\n+/g, "\n> ")}\n\n- Score: ${score}`);
    if (index === 0) emit(`- Opened source: ${locator.title}, ${locator.page}`);
    emit("");
  });
  emit(`## Generated report\n`);
  emit(`- Topic: ${reportTopic}`);
  emit(`- Documents: ${REPORT_DOCUMENTS.join(", ")}`);
  emit(`- Version 1: ${first.title}; ${first.checks}`);
  emit(`- Version 2 (${REPORT_EDIT}): ${second.title}; ${second.checks}`);
  emit(`- Delete: cancel kept the entry, confirm removed it and the empty message returned\n`);
});
