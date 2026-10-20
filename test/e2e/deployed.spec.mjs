// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { appendFileSync } from "node:fs";
import { test, expect } from "@playwright/test";

const SITE_URL = (process.env.SITE_URL ?? "").replace(/\/$/, "");
const ABSTENTION = "the corpus does not say";
const TURN_TIMEOUT_MS = 60_000;

const QUESTIONS = [
  "When did residents on floors 16 to 20 first see smoke outside their windows?",
  "What did residents say they were told by the fire service to do about leaving their flats?",
  "What did residents report about calling 999 from their flats?",
];
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

async function ask(page, question) {
  await expect(page.locator("#connection")).toHaveText("connected", { timeout: 30_000 });
  const turns = page.locator("article.turn");
  const before = await turns.count();
  await page.locator("#question").fill(question);
  await page.locator("#ask").evaluate((form) => form.requestSubmit());
  await expect(turns).toHaveCount(before + 1, { timeout: 15_000 });
  const turn = turns.last();
  const states = turn.locator("ol.stages li[data-state]");
  await expect
    .poll(
      async () =>
        (await states.evaluateAll((items) => items.map((li) => li.dataset.state))).join(","),
      {
        timeout: TURN_TIMEOUT_MS,
        message: `turn for "${question}" reaches done`,
      },
    )
    .toMatch(/^done(,done)*$/);
  const answer = (await turn.locator("p.answer").innerText()).trim();
  const score = (await turn.locator("p.score").innerText()).trim();
  return { turn, answer, score };
}

test("signs in, asks three observation questions and one off-corpus question", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  await page.goto(`${SITE_URL}/`);
  await signIn(page);
  await expect(page.locator("#question")).toBeVisible();

  emit("## concordance deployed page\n");
  let firstChip = null;

  for (const question of QUESTIONS) {
    const { turn, answer, score } = await ask(page, question);
    const chips = turn.locator("button.cite");
    expect(await chips.count(), `citation chips for "${question}"`).toBeGreaterThan(0);
    expect(answer.toLowerCase()).not.toContain(ABSTENTION);
    expect(score).toMatch(/\d+ of \d+ sentences supported/);
    firstChip ??= chips.first();
    report.push({ question, answer, score });
  }

  await firstChip.click();
  await expect(page.locator("#viewer")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#viewer-title")).not.toHaveText("");
  await expect(page.locator("#viewer-page")).not.toHaveText("");
  const locator = {
    title: (await page.locator("#viewer-title").innerText()).trim(),
    page: (await page.locator("#viewer-page").innerText()).trim(),
  };

  const off = await ask(page, OFF_CORPUS);
  expect(off.answer.toLowerCase()).toContain(ABSTENTION);
  report.push({ question: OFF_CORPUS, answer: off.answer, score: off.score });

  report.forEach(({ question, answer, score }, index) => {
    emit(`### ${question}\n\n> ${answer.replace(/\n+/g, "\n> ")}\n\n- Score: ${score}`);
    if (index === 0) emit(`- Opened source: ${locator.title}, ${locator.page}`);
    emit("");
  });
});
