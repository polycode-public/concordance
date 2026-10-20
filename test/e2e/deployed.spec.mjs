// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { appendFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

const SITE_URL = (process.env.SITE_URL ?? "").replace(/\/$/, "");
const ABSTENTION = "the corpus does not say";
const TURN_TIMEOUT_MS = 60_000;

const PILL_LISTS = ["#suggestions", "#documents-suggestions", "#evidence-suggestions"];
const OFF_CORPUS = "What is the capital of France?";

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

test("signs in, clicks every pill and asks one off-corpus question", async ({ page }) => {
  test.setTimeout(15 * 60_000);
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

  report.forEach(({ question, answer, score }, index) => {
    emit(`### ${question}\n\n> ${answer.replace(/\n+/g, "\n> ")}\n\n- Score: ${score}`);
    if (index === 0) emit(`- Opened source: ${locator.title}, ${locator.page}`);
    emit("");
  });
});
