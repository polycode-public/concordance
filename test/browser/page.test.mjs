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
}));

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
      const base = printable
        ? { key, text: key }
        : { key, code: key, windowsVirtualKeyCode: key === "Escape" ? 27 : 0 };
      await cdp("Input.dispatchKeyEvent", { type: printable ? "keyDown" : "rawKeyDown", ...base });
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
      for (const id of ["IWS00000169", "IWS00000342"]) {
        await writeFile(path.join(corpora, "grenfell", "raw", `${id}.pdf`), PDF);
      }
      app = await createServer({
        corporaDir: corpora,
        provider: createFakeProvider({ tokens: TOKENS, delayMs: 5 }),
        db: fakeDb,
        runQuery: stubQuery,
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

    for (const dark of [false, true]) {
      it(`keeps the answer text at 4.5:1 contrast or better in ${dark ? "dark" : "light"}`, async () => {
        await open({ width: 1280, height: 800, dark });
        await ask();
        const { ink, paper } = await evaluate(`(() => {
        const answer = document.querySelector(".answer");
        let node = answer;
        let paper = "rgba(0, 0, 0, 0)";
        while (node) {
          paper = getComputedStyle(node).backgroundColor;
          if (!/rgba\\(.*, 0\\)$/.test(paper) && paper !== "transparent") break;
          node = node.parentElement;
        }
        return { ink: getComputedStyle(answer).color, paper };
      })()`);
        expect(contrast(parseColour(ink), parseColour(paper))).toBeGreaterThanOrEqual(4.5);
        await shot(dark ? "laptop-dark" : "laptop-light");
      });
    }

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
  },
);
