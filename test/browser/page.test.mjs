// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Drives the page in headless Chrome over the DevTools protocol against the local server with the
// fake provider: CONCORDANCE_BROWSER_TESTS=1 npm test. Chrome comes from CHROME_BIN, then the
// default macOS and Linux locations. CONCORDANCE_BROWSER_SHOTS=1 saves screenshots to
// test/browser/.shots/.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../packages/local/server.mjs";
import { createFakeProvider } from "../../packages/core/providers/fakeProvider.mjs";
import { PROMPT_VERSION, answerMessages } from "../../packages/core/prompt.mjs";
import { checkAnswer } from "../../packages/core/query.mjs";
import { requestReport } from "../../packages/core/reports.mjs";
import { createReportsStore } from "../core/reportsFakeStore.mjs";
import { runComparison } from "../../packages/core/facts/compare.mjs";
import { REFUSAL } from "../../packages/ui/facts.js";
import { createCompareStore } from "../core/compareFakeStore.mjs";
import { compareProvider, compareSeed } from "../core/compareFixture.mjs";

const CHROME_PATHS = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];
const chromeBin = CHROME_PATHS.find((p) => p && existsSync(p));
const switchedOn = process.env.CONCORDANCE_BROWSER_TESTS === "1";
if (!switchedOn) {
  console.log("browser tier skipped: set CONCORDANCE_BROWSER_TESTS=1 to run it");
} else if (!chromeBin) {
  console.log(
    "browser tier skipped: no Chrome found; set CHROME_BIN to a Chrome or Chromium binary",
  );
}
const enabled = switchedOn && Boolean(chromeBin);

const SHOTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), ".shots");
const QUESTION = "When did residents first see smoke outside their windows?";
const TOKENS = [
  "Residents saw smoke outside their windows at about 01:14 ",
  "[E1]. ",
  "The stairwell was dark and filling with smoke ",
  "[E2]. ",
  "One resident shouted from the window ",
  "\n\n**Window:**\n- ",
  "One resident shouted from the window [E1][E3].",
];
const BLOCKS = [
  ["IWS00000169", 3, 11, "I looked out of the window at about 01:14 and saw thick black smoke."],
  ["IWS00000342", 7, 4, "When we opened the door to the stairwell it was dark and full of smoke."],
  ["IWS00000169", 5, 20, "We waited in the hallway because we had been told to stay put."],
].map(([documentId, page, paragraph, text], i) => ({
  evidence: i + 1,
  documentId,
  locator: { page, paragraph },
  header: `[Grenfell Inquiry | Witness ${documentId} | p.${page} para ${paragraph}]`,
  text,
  document: {
    title: `Statement of ${documentId}`,
    witnessId: documentId,
    cipherOnly: false,
    role: "Resident",
    statementDate: "2018-02-14",
    type: "pdf",
    pages: 20,
  },
}));

const KEY_CODES = { Escape: 27, Tab: 9, Enter: 13 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stubQuery({ question, provider, signal, onStage, onEvidence, onToken }) {
  onStage("rewriting");
  onStage("retrieving");
  onEvidence(BLOCKS);
  onStage("answering");
  const result = await provider.chat({
    messages: answerMessages(question, BLOCKS),
    signal,
    temperature: 0,
    promptVersion: PROMPT_VERSION,
    onToken,
  });
  onStage("checking");
  const { citations, checks } = checkAnswer(result.text, BLOCKS);
  return {
    answer: result.text,
    abstained: false,
    citations,
    checks: { ...checks, model: result.model, promptVersion: PROMPT_VERSION },
  };
}

const PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 60 >> stream
BT /F1 14 Tf 72 770 Td (IWS00000169) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`;

const fakeDb = {
  query: async (text, params) =>
    /FROM documents/.test(text)
      ? { rows: [{ corpus: "grenfell", title: `Statement of ${params[0]}` }] }
      : { rows: [] },
};

const reportStore = createReportsStore();

const factsStore = createCompareStore(compareSeed());
const FACT_DOCUMENTS = ["IWS-A1", "IWS-A2", "IWS-B1", "C123-1"];

/** The reports tables and the facts answer from their fake stores; the rest from fakeDb. */
const reportsDb = {
  ...reportStore,
  query: async (text, params) => {
    if (factsStore.answers(text)) return factsStore.query(text, params);
    if (/FROM documents WHERE id/.test(text)) return fakeDb.query(text, params);
    try {
      return await reportStore.query(text, params);
    } catch (err) {
      if (/does not answer/.test(err.message)) return { rows: [] };
      throw err;
    }
  },
};

const REPORT_BODY = (change) =>
  [
    "# Smoke on the stairs",
    "",
    "## The stairs",
    "The stairwell was dark and full of smoke [E1].",
    "",
    "## The lift",
    `The lift stopped at the fourth floor [E2].${change ? ` Changed: ${change}` : ""}`,
  ].join("\n");

/** The real request path with a report writer that needs no model. */
const stubRequestReport = (args) =>
  requestReport({
    ...args,
    run: async ({ changePrompt, onStage }) => {
      for (const stage of ["drafting", "writing", "reviewing"]) {
        onStage(stage);
        await sleep(120);
      }
      return {
        title: "Smoke on the stairs",
        body: REPORT_BODY(changePrompt),
        citations: [
          { evidence: 1, locator: { document: "IWS00000169", page: 3, paragraph: 11 } },
          { evidence: 2, locator: { document: "IWS00000342", page: 7, paragraph: 4 } },
        ],
        checks: { sentences: 2, supported: 2, abstained: 0, removed: 0, droppedCitations: 0 },
        promptVersion: "stub",
        model: "fake",
      };
    },
  });

/** Parses `rgb(r, g, b)`, `rgba(...)` and `color(srgb r g b / a)` into [r, g, b, a] in 0..255. */
function parseColour(value) {
  const numbers = value.match(/-?\d*\.?\d+/g).map(Number);
  if (value.startsWith("color(")) {
    const [r, g, b, a = 1] = numbers;
    return [r * 255, g * 255, b * 255, a];
  }
  const [r, g, b, a = 1] = numbers;
  return [r, g, b, a];
}

function luminance([r, g, b]) {
  const linear = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe.skipIf(!enabled)(
  "the page in headless Chrome (CONCORDANCE_BROWSER_TESTS=1)",
  { timeout: 30_000 },
  () => {
    let app;
    let base;
    let chrome;
    let profile;
    let corpora;
    let socket;
    let nextId = 0;
    const pending = new Map();

    const cdp = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject, method });
        socket.send(JSON.stringify({ id, method, params }));
      });

    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await cdp("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text} ${expression}`);
      return result.value;
    };

    const until = async (expression, timeoutMs = 10_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await evaluate(expression)) return;
        await sleep(50);
      }
      throw new Error(`timed out waiting for: ${expression}`);
    };

    const press = async (key) => {
      const printable = key.length === 1;
      const text = printable ? key : key === "Enter" ? "\r" : undefined;
      const base = printable
        ? { key, text }
        : { key, code: key, windowsVirtualKeyCode: KEY_CODES[key] ?? 0, text };
      await cdp("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key });
    };

    const shot = async (name) => {
      if (process.env.CONCORDANCE_BROWSER_SHOTS !== "1") return;
      await mkdir(SHOTS_DIR, { recursive: true });
      const { data } = await cdp("Page.captureScreenshot", { format: "png" });
      await writeFile(path.join(SHOTS_DIR, `${name}.png`), Buffer.from(data, "base64"));
    };

    const open = async ({ width, height, query = "", dark = false }) => {
      await cdp("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: width < 600,
      });
      await cdp("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }],
      });
      await cdp("Page.navigate", { url: `${base}/${query}` });
      await until(`document.getElementById("connection")?.textContent === "connected"`);
    };

    const ask = async () => {
      await evaluate(
        `document.getElementById("question").value = ${JSON.stringify(QUESTION)};
       document.getElementById("ask").requestSubmit(); true`,
      );
      await until(`document.querySelector(".score")?.textContent.length > 0`);
      await evaluate(`document.activeElement?.blur(); true`);
    };

    beforeAll(async () => {
      corpora = await mkdtemp(path.join(tmpdir(), "concordance-browser-corpora-"));
      await mkdir(path.join(corpora, "grenfell", "raw"), { recursive: true });
      for (const id of ["IWS00000169", "IWS00000342", ...FACT_DOCUMENTS]) {
        await writeFile(path.join(corpora, "grenfell", "raw", `${id}.pdf`), PDF);
      }
      await runComparison({
        corpus: "grenfell",
        db: factsStore,
        provider: compareProvider().provider,
        log: () => {},
      });
      app = await createServer({
        corporaDir: corpora,
        provider: createFakeProvider({ tokens: TOKENS, delayMs: 5 }),
        db: reportsDb,
        runQuery: stubQuery,
        requestReport: stubRequestReport,
      });
      base = `http://127.0.0.1:${app.port}`;
      profile = await mkdtemp(path.join(tmpdir(), "concordance-browser-"));
      chrome = spawn(
        chromeBin,
        [
          "--headless=new",
          "--remote-debugging-port=0",
          `--user-data-dir=${profile}`,
          "--no-first-run",
          "--no-sandbox",
          "--hide-scrollbars",
          "about:blank",
        ],
        { stdio: "ignore" },
      );
      const portFile = path.join(profile, "DevToolsActivePort");
      let port;
      for (let i = 0; i < 200 && !port; i++) {
        if (existsSync(portFile)) port = (await readFile(portFile, "utf8")).split("\n")[0];
        else await sleep(100);
      }
      if (!port) throw new Error("Chrome did not publish a DevTools port");
      let target;
      for (let i = 0; i < 50 && !target; i++) {
        try {
          const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
          target = targets.find((t) => t.type === "page");
        } catch {
          await sleep(100);
        }
        if (!target) await sleep(100);
      }
      if (!target) throw new Error("Chrome has no page target");
      socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        const call = pending.get(message.id);
        if (!call) return;
        pending.delete(message.id);
        if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`));
        else call.resolve(message.result);
      });
      await cdp("Page.enable");
      await cdp("Runtime.enable");
    }, 60_000);

    afterAll(async () => {
      socket?.close();
      chrome?.kill();
      await app?.close();
      if (corpora) await rm(corpora, { recursive: true, force: true }).catch(() => {});
      if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
    });

    it("loads at laptop size and names the inquiry in the header", async () => {
      await open({ width: 1280, height: 800 });
      expect(await evaluate(`document.querySelector("header .inquiry").textContent`)).toContain(
        "Grenfell Tower Inquiry",
      );
      expect(await evaluate(`document.title`)).toContain("Grenfell Tower Inquiry");
      await shot("laptop-empty");
    });

    it("shows the stages, the streamed answer, the score line and an evidence chip for a turn", async () => {
      await open({ width: 1280, height: 800 });
      await ask();
      expect(await evaluate(`document.querySelector(".stages").textContent`)).not.toBe("");
      expect(await evaluate(`document.querySelector(".answer").textContent`)).toContain(
        "Residents saw smoke",
      );
      expect(await evaluate(`document.querySelector(".score").textContent.length`)).toBeGreaterThan(
        0,
      );
      expect(await evaluate(`document.querySelectorAll(".answer .cite").length`)).toBeGreaterThan(
        0,
      );
      await shot("laptop-done");
    });

    it("shows four suggestion pills that submit their text and hide after the first turn", async () => {
      await open({ width: 1280, height: 800 });
      expect(await evaluate(`document.querySelectorAll("#suggestions button.pill").length`)).toBe(
        4,
      );
      expect(await evaluate(`document.getElementById("suggestions").hidden`)).toBe(false);
      await evaluate(`document.querySelector("#suggestions button.pill").click(); true`);
      await until(`document.querySelector(".score")?.textContent.length > 0`);
      expect(await evaluate(`document.querySelector(".turn .question p").textContent`)).toBe(
        "What did residents on floor 16 see when they first noticed the fire?",
      );
      expect(await evaluate(`document.getElementById("suggestions").hidden`)).toBe(true);
    });

    for (const [panel, text] of [
      ["documents", "List the statements in the corpus"],
      ["evidence", "Show the evidence about smoke in the stairwell"],
    ]) {
      it(`shows a pill in the empty ${panel} panel that submits and hides once the panel fills`, async () => {
        await open({ width: 1280, height: 800 });
        const list = `document.getElementById("${panel}-suggestions")`;
        expect(await evaluate(`${list}.hidden`)).toBe(false);
        expect(await evaluate(`!document.getElementById("${panel}-empty").hidden`)).toBe(true);
        expect(
          await evaluate(`[...${list}.querySelectorAll("button.pill")].map((b) => b.textContent)`),
        ).toEqual([text]);
        await evaluate(`${list}.querySelector("button.pill").click(); true`);
        await until(`document.querySelector(".score")?.textContent.length > 0`);
        expect(await evaluate(`document.querySelector(".turn .question p").textContent`)).toBe(
          text,
        );
        expect(
          await evaluate(`document.getElementById("${panel}").children.length`),
        ).toBeGreaterThan(0);
        expect(await evaluate(`${list}.hidden`)).toBe(true);
        await evaluate(`document.getElementById("conversations-new").click(); true`);
        expect(await evaluate(`document.getElementById("${panel}").children.length`)).toBe(0);
        expect(await evaluate(`${list}.hidden`)).toBe(false);
      });
    }

    it("folds each evidence block, toggles it from the keyboard and opens the block a chip names", async () => {
      await open({ width: 1280, height: 800 });
      await ask();
      const state = () =>
        evaluate(
          `[...document.querySelectorAll("#evidence details")].map((d) => d.open).join(",")`,
        );
      expect(await state()).toBe("false,false,false");
      expect(
        await evaluate(`document.querySelector("#evidence summary .first-line").textContent`),
      ).toContain("thick black smoke");
      await evaluate(`document.querySelector("#evidence summary").focus(); true`);
      await press(" ");
      await until(`document.querySelector("#evidence details").open`);
      expect(await state()).toBe("true,false,false");
      await press(" ");
      await until(`!document.querySelector("#evidence details").open`);
      await evaluate(`document.querySelector(".answer .cite").click(); true`);
      await until(`document.querySelector("#evidence details").open`);
      expect(await state()).toBe("true,false,false");
    });

    it("shows the document facts in the referenced-documents row", async () => {
      await open({ width: 1280, height: 800 });
      await ask();
      const facts = await evaluate(`document.querySelector("#documents .facts").textContent`);
      expect(facts).toContain("Statement of IWS00000169");
      expect(facts).toContain("Resident");
      expect(facts).toContain("14 Feb 2018");
      expect(facts).toContain("pdf, 20 pages");
    });

    it("names a locator past the end of the document as a defect in the viewer bar", async () => {
      await open({ width: 1280, height: 800 });
      await ask();
      await evaluate(`document.querySelector(".answer .cite").click(); true`);
      await until(`document.querySelector("#viewer-page.defect")`);
      expect(await evaluate(`document.getElementById("viewer-page").textContent`)).toContain(
        "past the end",
      );
      expect(await evaluate(`document.getElementById("viewer-message").textContent`)).toContain(
        "names page 3",
      );
    });

    it("renders bold text and a bullet list in the answer, with chips inside the list", async () => {
      await open({ width: 1280, height: 800 });
      await ask();
      expect(await evaluate(`document.querySelector(".answer strong").textContent`)).toBe(
        "Window:",
      );
      expect(await evaluate(`document.querySelectorAll(".answer ul > li").length`)).toBe(1);
      expect(await evaluate(`document.querySelectorAll(".answer li .cite").length`)).toBe(2);
      expect(await evaluate(`document.querySelector(".answer").textContent`)).not.toContain("**");
    });

    it("renders two chips for a tag with two numbers", async () => {
      await open({ width: 1280, height: 800 });
      await ask();
      expect(
        await evaluate(`(() => {
          const li = document.querySelector(".answer li");
          return [...li.querySelectorAll(".cite")].map((c) => c.textContent).join(",");
        })()`),
      ).toBe("1,3");
    });

    it("opens the viewer with its bar and a link to the original when a chip is clicked", async () => {
      await open({ width: 1280, height: 800 });
      await ask();
      expect(await evaluate(`document.getElementById("viewer").hidden`)).toBe(true);
      await evaluate(`document.querySelector(".answer .cite").click(); true`);
      await until(`!document.getElementById("viewer").hidden`);
      await until(`document.getElementById("viewer-title").textContent !== ""`);
      expect(await evaluate(`document.getElementById("viewer-title").textContent`)).toContain(
        "IWS00000169",
      );
      expect(
        await evaluate(`getComputedStyle(document.querySelector(".viewer-bar")).display`),
      ).not.toBe("none");
      await until(`!document.getElementById("viewer-original").hidden`, 15_000);
      expect(await evaluate(`document.getElementById("viewer-original").href`)).toContain(
        "IWS00000169",
      );
      await shot("laptop-viewer");
    });

    it("sets the root font size to 20 px in projector mode at 1920 by 1080", async () => {
      await open({ width: 1920, height: 1080, query: "?present=1" });
      expect(await evaluate(`getComputedStyle(document.documentElement).fontSize`)).toBe("20px");
      await ask();
      await shot("projector-done");
    });

    it("fixes the composer at the foot of a phone screen with no horizontal scroll", async () => {
      await open({ width: 390, height: 844 });
      await ask();
      expect(await evaluate(`getComputedStyle(document.querySelector(".ask")).position`)).toBe(
        "fixed",
      );
      const box = await evaluate(
        `(() => { const r = document.querySelector(".ask").getBoundingClientRect(); return { bottom: r.bottom, height: innerHeight }; })()`,
      );
      expect(Math.round(box.bottom)).toBe(box.height);
      expect(
        await evaluate(
          `document.documentElement.scrollWidth <= document.documentElement.clientWidth`,
        ),
      ).toBe(true);
      await shot("phone-done");
    });

    /**
     * The text colour, the colour under it (its own or the nearest painted ancestor's) and the
     * outline colour of each element a selector matches, from the computed styles.
     */
    const paints = (selector) =>
      evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((node) => {
        const own = getComputedStyle(node);
        let at = node;
        let paper = "rgba(0, 0, 0, 0)";
        while (at) {
          paper = getComputedStyle(at).backgroundColor;
          if (!/rgba\\(.*, 0\\)$/.test(paper) && paper !== "transparent") break;
          at = at.parentElement;
        }
        return { ink: own.color, paper, outline: own.outlineColor, edge: own.borderTopColor };
      })`);

    const lowest = async (selector, key = "ink") => {
      const found = await paints(selector);
      expect(found.length, selector).toBeGreaterThan(0);
      return Math.min(...found.map((p) => contrast(parseColour(p[key]), parseColour(p.paper))));
    };

    for (const dark of [false, true]) {
      it(`keeps every text and evidence colour at 4.5:1 and every control edge at 3:1 in ${dark ? "dark" : "light"}`, async () => {
        await open({ width: 1280, height: 800, dark });
        for (const selector of [
          ".bar h1",
          "header .inquiry",
          "#suggestions button.pill",
          "#documents-suggestions button.pill",
          "#evidence-suggestions button.pill",
          ".bundle .empty",
          "#send",
          ".keys",
        ]) {
          expect(await lowest(selector), selector).toBeGreaterThanOrEqual(4.5);
        }
        for (const selector of ["button.pill", "#question"]) {
          expect(await lowest(selector, "edge"), selector).toBeGreaterThanOrEqual(3);
        }
        await ask();
        for (const selector of [
          ".answer",
          ".answer .supported",
          ".answer .cite",
          ".score",
          "#evidence .reference",
          "#documents .facts",
        ]) {
          expect(await lowest(selector), selector).toBeGreaterThanOrEqual(4.5);
        }
        // The fake answer cites every sentence and every block, so the grey of an unsupported
        // sentence and of an uncited block is measured on a probe in each one's container.
        const probe = (container, className) =>
          evaluate(`(() => {
            const span = document.createElement("span");
            span.className = ${JSON.stringify(className)};
            span.textContent = "probe";
            const host = document.querySelector(${JSON.stringify(container)});
            host.append(span);
            let at = span;
            let paper;
            do {
              paper = getComputedStyle(at).backgroundColor;
              at = at.parentElement;
            } while (at && /rgba\\(.*, 0\\)$/.test(paper));
            const style = getComputedStyle(span);
            const found = { ink: style.color, paper, line: style.textDecorationLine };
            span.remove();
            return found;
          })()`);
        const unsupported = await probe(".answer p", "unsupported");
        expect(
          contrast(parseColour(unsupported.ink), parseColour(unsupported.paper)),
        ).toBeGreaterThanOrEqual(4.5);
        expect(unsupported.line).toBe("underline");
        await evaluate(`document.querySelector("#evidence .block").dataset.cited = "no"; true`);
        const uncited = await probe("#evidence .block details", "quote");
        expect(
          contrast(parseColour(uncited.ink), parseColour(uncited.paper)),
        ).toBeGreaterThanOrEqual(4.5);
        await shot(dark ? "laptop-dark" : "laptop-light");
      });
    }

    it("puts the skip link first in the tab order, lands on the main landmark and reaches a pill with Tab", async () => {
      await open({ width: 1280, height: 800 });
      await press("Tab");
      expect(await evaluate(`document.activeElement.className`)).toBe("skip-link");
      expect(await evaluate(`document.activeElement.textContent`)).toBe("Skip to main content");
      expect(await evaluate(`document.activeElement.getBoundingClientRect().top >= 0`)).toBe(true);
      await press("Enter");
      await until(`document.activeElement?.id === "main"`);
      expect(await evaluate(`document.activeElement.tagName`)).toBe("MAIN");
      for (let i = 0; i < 10; i++) {
        await press("Tab");
        if (await evaluate(`document.activeElement.classList.contains("pill")`)) break;
      }
      expect(await evaluate(`document.activeElement.classList.contains("pill")`)).toBe(true);
      expect(await evaluate(`getComputedStyle(document.activeElement).outlineStyle`)).toBe("solid");
      const [ring] = (await paints(":focus")).map((p) =>
        contrast(parseColour(p.outline), parseColour(p.paper)),
      );
      expect(ring).toBeGreaterThanOrEqual(3);
      await press("Enter");
      await until(`document.querySelector(".score")?.textContent.length > 0`);
      expect(await evaluate(`document.querySelector(".turn .question p").textContent`)).toBe(
        "What did residents on floor 16 see when they first noticed the fire?",
      );
    });

    it("names the landmarks: the banner, the main conversation and the labelled panels", async () => {
      await open({ width: 1280, height: 800 });
      expect(await evaluate(`document.querySelectorAll("main").length`)).toBe(1);
      expect(await evaluate(`document.querySelector("main").getAttribute("aria-label")`)).toBe(
        "Conversation",
      );
      expect(await evaluate(`document.querySelector("body > header") !== null`)).toBe(true);
      expect(
        await evaluate(
          `[...document.querySelectorAll(".bundle section")].map((s) => document.getElementById(s.getAttribute("aria-labelledby")).textContent.trim())`,
        ),
      ).toEqual([
        "Referenced documents",
        "Evidence this turn",
        expect.stringMatching(/^Contradictions/),
        "Generated reports",
      ]);
      expect(await evaluate(`document.querySelector(".bundle").getAttribute("aria-label")`)).toBe(
        "Evidence bundle",
      );
    });

    it("drops transitions under prefers-reduced-motion", async () => {
      await cdp("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "reduce" }],
      });
      await cdp("Page.navigate", { url: `${base}/` });
      await until(`document.getElementById("connection")?.textContent === "connected"`);
      await ask();
      expect(
        await evaluate(
          `getComputedStyle(document.querySelector(".answer .cite")).transitionDuration`,
        ),
      ).toBe("0s");
    });

    const requestReportFromForm = async (topic, filename) => {
      await evaluate(
        `document.getElementById("report-request").open = true;
         document.getElementById("report-topic").value = ${JSON.stringify(topic)};
         document.getElementById("report-filename").value = ${JSON.stringify(filename)};
         document.getElementById("report-form").requestSubmit(); true`,
      );
    };
    const listed = (filename) =>
      `document.querySelector('#reports-list li[data-filename="${filename}"]')`;
    const resetReports = () => reportStore.reports.splice(0);

    it("shows the Generated reports panel with its empty state and the pill", async () => {
      resetReports();
      await open({ width: 1280, height: 800 });
      await until(`!document.getElementById("reports-empty").hidden`);
      expect(await evaluate(`document.getElementById("reports-title").textContent.trim()`)).toBe(
        "Generated reports",
      );
      expect(await evaluate(`document.getElementById("reports-list").children.length`)).toBe(0);
      expect(
        await evaluate(
          `[...document.querySelectorAll("#reports-suggestions button.pill")].map((b) => b.textContent)`,
        ),
      ).toEqual(["Write me a report on how residents first became aware of the fire"]);
    });

    it("fills the request form from the pill without sending, and hides the pill once a report is listed", async () => {
      resetReports();
      await open({ width: 1280, height: 800 });
      await until(`!document.getElementById("reports-empty").hidden`);
      await evaluate(`document.querySelector("#reports-suggestions button.pill").click(); true`);
      expect(await evaluate(`document.getElementById("report-request").open`)).toBe(true);
      expect(await evaluate(`document.getElementById("report-topic").value`)).toBe(
        "Write me a report on how residents first became aware of the fire",
      );
      expect(await evaluate(`document.getElementById("report-filename").value`)).toBe(
        "first-awareness.md",
      );
      expect(
        await evaluate(`document.querySelectorAll("#report-documents input:checked").length`),
      ).toBe(0);
      expect(await evaluate(`document.getElementById("report-status").textContent`)).toBe("");
      await evaluate(`document.getElementById("report-form").requestSubmit(); true`);
      await until(`${listed("first-awareness.md")}`);
      expect(await evaluate(`document.getElementById("reports-suggestions").hidden`)).toBe(true);
      expect(await evaluate(`document.getElementById("reports-empty").hidden`)).toBe(true);
    });

    it("sends a report frame, follows the stages and lists the stored report", async () => {
      resetReports();
      await open({ width: 1280, height: 800 });
      await until(`!document.getElementById("reports-empty").hidden`);
      await ask();
      await requestReportFromForm("The stairs and the lift", "stairs.md");
      const seen = new Set();
      await until(
        `(() => { const t = document.getElementById("report-status").textContent; window.__seen = (window.__seen ?? "") + "|" + t; return Boolean(document.querySelector('#reports-list li[data-filename="stairs.md"]')); })()`,
      );
      for (const part of (await evaluate(`window.__seen`)).split("|")) seen.add(part);
      expect([...seen].some((t) => /Drafting|Writing|Checking/.test(t))).toBe(true);
      expect(await evaluate(`document.getElementById("report-status").textContent`)).toContain(
        "Stored stairs.md version 1",
      );
      expect(await evaluate(`${listed("stairs.md")}.textContent`)).toContain("Smoke on the stairs");
      expect(await evaluate(`${listed("stairs.md")}.textContent`)).toContain("v1");
      expect(await evaluate(`document.getElementById("report-submit").disabled`)).toBe(false);
      expect(reportStore.reports[0].document_ids).toEqual([]);
    });

    it("sends the documents ticked from the referenced-documents row", async () => {
      resetReports();
      await open({ width: 1280, height: 800 });
      await until(`!document.getElementById("reports-empty").hidden`);
      await ask();
      await evaluate(
        `document.getElementById("report-request").open = true;
         document.querySelector('#report-documents input[value="IWS00000342"]').click(); true`,
      );
      await requestReportFromForm("The stairs", "ticked.md");
      await until(`${listed("ticked.md")}`);
      expect(reportStore.reports[0].document_ids).toEqual(["IWS00000342"]);
    });

    it("opens a version as headings, a sentence and a chip that opens the viewer", async () => {
      resetReports();
      await open({ width: 1280, height: 800 });
      await until(`!document.getElementById("reports-empty").hidden`);
      await requestReportFromForm("The stairs and the lift", "stairs.md");
      await until(`${listed("stairs.md")}`);
      await evaluate(`${listed("stairs.md")}.querySelector(".version").click(); true`);
      await until(`!document.getElementById("report-view").hidden`);
      expect(await evaluate(`document.querySelector("#report-view h3").textContent`)).toBe(
        "Smoke on the stairs",
      );
      expect(await evaluate(`document.querySelector("#report-view h4").textContent`)).toBe(
        "The stairs",
      );
      expect(await evaluate(`document.querySelector("#report-view p").textContent`)).toContain(
        "The stairwell was dark",
      );
      expect(await evaluate(`document.querySelector("#report-view .score").textContent`)).toBe(
        "2 of 2 sentences supported",
      );
      await shot("laptop-report");
      await evaluate(`document.querySelector("#report-view .cite").click(); true`);
      await until(`!document.getElementById("viewer").hidden`);
      expect(await evaluate(`document.getElementById("viewer-title").textContent`)).toContain(
        "IWS00000169",
      );
    });

    it("asks for confirmation before it deletes and keeps the report on Cancel", async () => {
      resetReports();
      await open({ width: 1280, height: 800 });
      await until(`!document.getElementById("reports-empty").hidden`);
      await requestReportFromForm("The stairs and the lift", "stairs.md");
      await until(`${listed("stairs.md")}`);
      await evaluate(`${listed("stairs.md")}.querySelector(".delete").click(); true`);
      expect(reportStore.reports.length).toBe(1);
      expect(await evaluate(`document.activeElement.textContent`)).toBe("Confirm");
      await evaluate(`${listed("stairs.md")}.querySelector(".confirm-no").click(); true`);
      expect(await evaluate(`document.activeElement.textContent`)).toBe("Delete");
      expect(reportStore.reports.length).toBe(1);
      await evaluate(
        `${listed("stairs.md")}.querySelector(".delete").click();
         ${listed("stairs.md")}.querySelector(".confirm-yes").click(); true`,
      );
      await until(`!${listed("stairs.md")}`);
      expect(reportStore.reports.length).toBe(0);
      expect(await evaluate(`!document.getElementById("reports-empty").hidden`)).toBe(true);
    });

    it("sends a chat message that names a listed filename as an edit and stores version 2", async () => {
      resetReports();
      await open({ width: 1280, height: 800 });
      await until(`!document.getElementById("reports-empty").hidden`);
      await requestReportFromForm("The stairs and the lift", "stairs.md");
      await until(`${listed("stairs.md")}`);
      await evaluate(
        `document.getElementById("question").value = "In stairs.md, add the time of the first call";
         document.getElementById("ask").requestSubmit(); true`,
      );
      await until(`${listed("stairs.md")}.querySelectorAll(".version").length === 2`);
      expect(await evaluate(`document.querySelector(".turn .note").textContent`)).toContain(
        "Stored stairs.md version 2",
      );
      expect(await evaluate(`document.querySelectorAll(".turn .stages").length`)).toBe(0);
      expect(reportStore.reports.map((r) => r.version)).toEqual([1, 2]);
      expect(reportStore.reports[1].change_prompt).toBe(
        "In stairs.md, add the time of the first call",
      );
    });

    it("moves focus among chips with ], opens with o and closes with Escape", async () => {
      await open({ width: 1280, height: 800 });
      await ask();
      const focused = () =>
        evaluate(
          `(() => { const chips = [...document.querySelectorAll(".answer .cite")]; return chips.indexOf(document.activeElement); })()`,
        );
      await press("]");
      expect(await focused()).toBe(0);
      await press("]");
      expect(await focused()).toBe(1);
      await press("[");
      expect(await focused()).toBe(0);
      await press("o");
      await until(`!document.getElementById("viewer").hidden`);
      await press("Escape");
      await until(`document.getElementById("viewer").hidden`);
    });

    const cellButton = (row, column) =>
      `[...document.querySelectorAll("#facts-matrix tbody tr")].find((tr) => tr.querySelector("th").textContent === ${JSON.stringify(row)}).children[[...document.querySelectorAll("#facts-matrix thead th")].findIndex((th) => th.textContent === ${JSON.stringify(column)}) + 1].querySelector("button")`;
    const chooseGroup = async (value) => {
      await evaluate(
        `(() => { const s = document.getElementById("facts-group"); if (s.value === ${JSON.stringify(value)}) return true; s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change")); return true; })()`,
      );
      await until(
        `document.querySelector("#facts-matrix caption")?.textContent === ${JSON.stringify(
          { "event:7": "smoke in the lobby", "event:8": "the fire alarm" }[value],
        )}`,
      );
    };

    it("shows the Contradictions panel with the groups and the witnesses on both axes", async () => {
      await open({ width: 1280, height: 800 });
      await until(`document.querySelector("#facts-matrix table") !== null`);
      expect(await evaluate(`document.getElementById("facts-title").textContent.trim()`)).toBe(
        "Contradictions 5",
      );
      expect(
        await evaluate(
          `[...document.querySelectorAll("#facts-group option")].map((o) => [o.value, o.textContent])`,
        ),
      ).toEqual([
        ["event:7", "smoke in the lobby: 4 contradict of 6"],
        ["event:8", "the fire alarm: 1 contradict of 1"],
        ["topic:dark", "dark (no event named): 0 contradict of 1"],
        ["event:9", "leaving the flat: 0 contradict of 1"],
        ["topic:told", "told (no event named): 0 contradict of 1"],
      ]);
      expect(
        await evaluate(
          `[...document.querySelectorAll("#facts-matrix thead th")].map((t) => t.textContent)`,
        ),
      ).toEqual(["C123", "IWS-A", "IWS-B"]);
      expect(
        await evaluate(
          `[...document.querySelectorAll("#facts-matrix tbody th")].map((t) => [t.textContent, t.scope])`,
        ),
      ).toEqual([
        ["C123", "row"],
        ["IWS-A", "row"],
        ["IWS-B", "row"],
      ]);
      expect(await evaluate(`${cellButton("IWS-A", "C123")}.textContent`)).toBe("contradict 2");
      expect(await evaluate(`${cellButton("IWS-A", "IWS-A")}.getAttribute("aria-label")`)).toBe(
        "IWS-A and IWS-A: contradict; 1 contradict",
      );
      expect(await evaluate(`${cellButton("IWS-B", "IWS-B")} ?? null`)).toBeNull();
      await shot("laptop-facts");
    });

    for (const dark of [false, true]) {
      it(`keeps the matrix labels and the reason at 4.5:1 in ${dark ? "dark" : "light"}`, async () => {
        await open({ width: 1280, height: 800, dark });
        await until(`document.querySelector("#facts-matrix table") !== null`);
        await evaluate(`${cellButton("IWS-A", "IWS-B")}.click(); true`);
        await until(`!document.getElementById("facts-detail").hidden`);
        for (const selector of [
          "button.facts-cell.label-contradict",
          ".facts-label.label-contradict",
          ".facts-label.label-agree",
          ".facts-reason",
          ".facts-quote",
          "#facts-matrix th",
        ]) {
          expect(await lowest(selector), selector).toBeGreaterThanOrEqual(4.5);
        }
        expect(await lowest("button.facts-cell", "edge")).toBeGreaterThanOrEqual(1);
      });
    }

    it("opens a cell's pairs with the reason, the spans and chips that open each source", async () => {
      await open({ width: 1280, height: 800 });
      await until(`document.querySelector("#facts-matrix table") !== null`);
      await evaluate(`${cellButton("IWS-A", "C123")}.click(); true`);
      await until(`!document.getElementById("facts-detail").hidden`);
      expect(await evaluate(`document.activeElement.textContent`)).toBe("C123 and IWS-A");
      const pairs = await evaluate(
        `[...document.querySelectorAll("#facts-detail .facts-pair")].map((li) => ({ label: li.dataset.label, reason: li.querySelector(".facts-reason").textContent, quotes: [...li.querySelectorAll(".facts-quote")].map((q) => q.textContent) }))`,
      );
      expect(pairs).toEqual([
        {
          label: "contradict",
          reason:
            'time: "about 1.00 am" (00:50-01:10) and "1.30 am" (01:25-01:35) do not overlap for "saw" "smoke"',
          quotes: ["about 1.00 am", "1.30 am"],
        },
        {
          label: "agree",
          reason: expect.stringMatching(/^same predicate, object, polarity and place/),
          quotes: ["saw", "first saw"],
        },
      ]);
      await evaluate(
        `document.querySelectorAll("#facts-detail .facts-pair")[0].querySelectorAll(".cite")[1].click(); true`,
      );
      await until(`!document.getElementById("viewer").hidden`);
      await until(`document.getElementById("viewer-title").textContent.includes("C123-1")`);
    });

    it("shows two sentences side by side, and refuses an identity-revealing pair with the reason", async () => {
      await open({ width: 1280, height: 800 });
      await until(`document.querySelector("#facts-matrix table") !== null`);
      await evaluate(`${cellButton("IWS-A", "IWS-B")}.click(); true`);
      await until(`!document.getElementById("facts-detail").hidden`);
      await evaluate(
        `[...document.querySelectorAll("#facts-detail button")].find((b) => b.textContent === "Show side by side").click(); true`,
      );
      await until(`document.querySelector("#facts-detail .facts-sides") !== null`);
      expect(
        await evaluate(
          `[...document.querySelectorAll("#facts-detail .facts-sentence")].map((p) => p.textContent)`,
        ),
      ).toHaveLength(2);
      await evaluate(`${cellButton("IWS-B", "C123")}.click(); true`);
      await until(
        `document.querySelector("#facts-detail .facts-detail-title")?.textContent === "C123 and IWS-B"`,
      );
      expect(
        await evaluate(`document.querySelector("#facts-detail .facts-pair").dataset.label`),
      ).toBe("contradict");
      expect(
        await evaluate(`document.querySelector("#facts-detail .facts-refusal").textContent`),
      ).toBe(REFUSAL);
      expect(
        await evaluate(
          `[...document.querySelectorAll("#facts-detail button")].some((b) => b.textContent === "Show side by side")`,
        ),
      ).toBe(false);
      expect(
        await evaluate(`document.querySelectorAll("#facts-detail .facts-sentence").length`),
      ).toBe(0);
      await shot("laptop-facts-refusal");
    });

    it("posts a person's relabel and shows it in the cell with the pencil mark", async () => {
      await open({ width: 1280, height: 800 });
      await until(`document.querySelector("#facts-matrix table") !== null`);
      await chooseGroup("event:8");
      expect(await evaluate(`${cellButton("IWS-A", "IWS-B")}.textContent`)).toBe("contradict");
      await evaluate(`${cellButton("IWS-A", "IWS-B")}.click(); true`);
      await until(`!document.getElementById("facts-detail").hidden`);
      await evaluate(`(() => {
        const form = document.querySelector("#facts-detail .facts-pair details .facts-form");
        form.closest("details").open = true;
        form.querySelector("select").value = "agree";
        form.querySelector("textarea").value = "Both describe the same alarm.";
        form.requestSubmit();
        return true;
      })()`);
      await until(`${cellButton("IWS-A", "IWS-B")}.textContent.startsWith("agree")`);
      expect(await evaluate(`${cellButton("IWS-A", "IWS-B")}.textContent`)).toBe("agree ✎");
      expect(await evaluate(`document.getElementById("facts-status").textContent`)).toBe(
        "Labelled agree by laptop.",
      );
      await until(
        `document.querySelector("#facts-detail .facts-by")?.textContent.startsWith("Machine label")`,
      );
      expect(
        await evaluate(`document.querySelector("#facts-detail .facts-reason").textContent`),
      ).toBe("Both describe the same alarm.");
      expect(factsStore.tables.assertion_comparisons.at(-1)).toMatchObject({
        model: "operator",
        decided_by: "laptop",
        label: "agree",
      });
    });

    it("posts a promotion with its citation", async () => {
      await open({ width: 1280, height: 800 });
      await until(`document.querySelector("#facts-matrix table") !== null`);
      await chooseGroup("event:7");
      await evaluate(`${cellButton("IWS-A", "C123")}.click(); true`);
      await until(`!document.getElementById("facts-detail").hidden`);
      const before = factsStore.tables.accepted_facts.length;
      await evaluate(`(() => {
        const form = document.querySelectorAll("#facts-detail .facts-pair")[0].querySelectorAll(".facts-form")[1];
        form.closest("details").open = true;
        form.querySelector("select").selectedIndex = 1;
        form.querySelector("input").value = "Phase 1 report, fixture paragraph";
        form.requestSubmit();
        return true;
      })()`);
      await until(
        `document.getElementById("facts-status").textContent.startsWith("Accepted fact")`,
      );
      expect(factsStore.tables.accepted_facts.slice(before)).toEqual([
        expect.objectContaining({
          assertion_id: "3",
          source_citation: "Phase 1 report, fixture paragraph",
          promoted_by: "laptop",
          is_hypothesis: false,
        }),
      ]);
    });

    it("moves between cells with the arrow keys and opens one with Enter", async () => {
      await open({ width: 1280, height: 800 });
      await until(`document.querySelector("#facts-matrix table") !== null`);
      await chooseGroup("event:7");
      await evaluate(`${cellButton("C123", "IWS-A")}.focus(); true`);
      await press("ArrowRight");
      expect(await evaluate(`document.activeElement === ${cellButton("C123", "IWS-B")}`)).toBe(
        true,
      );
      await press("ArrowDown");
      expect(await evaluate(`document.activeElement === ${cellButton("IWS-A", "IWS-B")}`)).toBe(
        true,
      );
      await press("Enter");
      await until(`document.activeElement?.textContent === "IWS-A and IWS-B"`);
    });

    it("draws the timeline and lists its points in window order with a chip to the source", async () => {
      await open({ width: 1280, height: 800 });
      await until(`document.querySelector("#facts-matrix table") !== null`);
      await chooseGroup("event:7");
      await until(`document.querySelectorAll("#facts-timeline li").length === 4`);
      await evaluate(`document.getElementById("facts-timeline-box").open = true; true`);
      expect(
        await evaluate(
          `[...document.querySelectorAll("#facts-timeline li")].map((li) => li.textContent)`,
        ),
      ).toEqual([
        '00:50–01:10 IWS-A: first saw smoke ("about 1.00 am")',
        '00:50–01:10 IWS-B: saw smoke ("about 1.00 am")',
        '01:25–01:35 C123: saw smoke ("1.30 am")',
        '01:25–01:35 IWS-A: first saw smoke ("1.30 am")',
      ]);
      expect(
        await evaluate(`document.querySelectorAll("#facts-timeline-figure circle").length`),
      ).toBe(4);
      await evaluate(`document.querySelector("#facts-timeline button").click(); true`);
      await until(`document.getElementById("viewer-title").textContent.includes("IWS-A1")`);
    });

    it("keeps the matrix inside a phone screen with no horizontal page scroll", async () => {
      await open({ width: 390, height: 844 });
      await until(`document.querySelector("#facts-matrix table") !== null`);
      expect(
        await evaluate(
          `document.documentElement.scrollWidth <= document.documentElement.clientWidth`,
        ),
      ).toBe(true);
    });
  },
);
