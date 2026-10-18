// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The laptop server: static UI over HTTP, /health, and the chat WebSocket at /ws.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { parseClientFrame, serverFrame } from "../core/protocol.mjs";
import { markUnsupported } from "../core/checks/citations.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC = path.resolve(here, "..", "ui");

export const PROMPT_VERSION = "answer-closed-world-v1";

export const SYSTEM_PROMPT = [
  "You answer questions about a corpus of witness statements.",
  "Answer only from the evidence blocks you are given.",
  "If the evidence blocks do not cover the question, say 'the corpus does not say'.",
  "Never use prior knowledge about the real event.",
  "Write [En] after every sentence that relies on evidence, where n is the number of the evidence block.",
].join(" ");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const WARNING_RATIO = 0.3;

/**
 * Probes a URL with a short timeout. Never throws.
 * @returns {Promise<'ok' | 'down'>}
 */
async function probeHttp(url, timeoutMs = 500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? "ok" : "down";
  } catch {
    return "down";
  }
}

async function probeDb(db, timeoutMs = 500) {
  if (!db) return "unknown";
  try {
    await Promise.race([
      db.query("SELECT 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs).unref()),
    ]);
    return "ok";
  } catch {
    return "down";
  }
}

/**
 * Formats evidence blocks for the prompt as [E1] ... [En].
 * @param {{ header?: string, text: string }[]} blocks
 */
export function evidencePrompt(blocks) {
  if (!blocks.length) return "Evidence blocks: none.";
  return blocks.map((b, i) => `[E${i + 1}] ${b.header ?? ""}\n${b.text}`).join("\n\n");
}

/**
 * @param {object} options
 * @param {import('../core/providers/modelProvider.mjs').ModelProvider} options.provider
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {string} [options.staticDir]
 * @param {{ query: Function } | null} [options.db]
 * @param {string | null} [options.ollamaUrl]
 */
export async function createServer({
  provider,
  port = 0,
  host = "127.0.0.1",
  staticDir = DEFAULT_STATIC,
  db = null,
  ollamaUrl = null,
}) {
  const root = path.resolve(staticDir);

  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" }).end();
        return;
      }
      if (pathname === "/health") {
        const [dbState, ollamaState] = await Promise.all([
          probeDb(db),
          ollamaUrl ? probeHttp(new URL("/api/version", ollamaUrl)) : "unknown",
        ]);
        const body = JSON.stringify({
          ok: true,
          provider: provider.name,
          db: dbState,
          ollama: ollamaState,
        });
        res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
        res.end(body);
        return;
      }
      const rel =
        pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
      const file = path.resolve(root, rel);
      if (file !== root && !file.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const type = MIME[path.extname(file)];
      if (!type) {
        res.writeHead(404).end();
        return;
      }
      const data = await readFile(file);
      res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "EISDIR") res.writeHead(404).end();
      else if (!res.headersSent) res.writeHead(500).end();
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    /** @type {Map<string, { turnId: string, controller: AbortController }>} */
    const threads = new Map();
    const send = (frame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };

    const cancel = (thread, turnId) => {
      const inFlight = threads.get(thread);
      if (!inFlight || inFlight.turnId !== turnId) return false;
      inFlight.controller.abort();
      return true;
    };

    ws.on("message", (data) => {
      let frame;
      try {
        frame = parseClientFrame(data);
      } catch (err) {
        send(serverFrame.error(err.message));
        return;
      }
      if (frame.type === "cancel") {
        if (!cancel(frame.thread, frame.turnId))
          send(serverFrame.cancelled(frame.thread, frame.turnId));
        return;
      }
      if (frame.type === "open") {
        send(serverFrame.error("open is not built yet"));
        return;
      }
      const previous = threads.get(frame.thread);
      if (previous) cancel(frame.thread, previous.turnId);
      runTurn(frame);
    });

    ws.on("close", () => {
      for (const { controller } of threads.values()) controller.abort();
      threads.clear();
    });

    async function runTurn({ thread, turnId, text }) {
      const controller = new AbortController();
      const { signal } = controller;
      threads.set(thread, { turnId, controller });
      const live = () => !signal.aborted;
      try {
        send(serverFrame.status(thread, turnId, "rewriting"));
        send(serverFrame.status(thread, turnId, "retrieving"));
        const blocks = [];
        send(serverFrame.evidence(thread, turnId, blocks));
        send(serverFrame.status(thread, turnId, "answering"));
        const result = await provider.chat({
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `${evidencePrompt(blocks)}\n\nQuestion: ${text}` },
          ],
          signal,
          temperature: 0,
          promptVersion: PROMPT_VERSION,
          onToken: (piece) => {
            if (live()) send(serverFrame.token(thread, turnId, piece));
          },
        });
        signal.throwIfAborted();
        send(serverFrame.status(thread, turnId, "checking"));
        const marked = markUnsupported(result.text);
        send(
          serverFrame.done(thread, turnId, {
            sentences: marked.total,
            supported: marked.supported,
            flaggedRatio: marked.flaggedRatio,
            warning: marked.flaggedRatio > WARNING_RATIO,
            marks: marked.sentences.map((s) => ({ text: s.text, supported: s.supported })),
            model: result.model,
            promptVersion: result.promptVersion,
          }),
        );
      } catch (err) {
        if (signal.aborted) send(serverFrame.cancelled(thread, turnId));
        else send(serverFrame.error(err.message, thread, turnId));
      } finally {
        if (threads.get(thread)?.turnId === turnId) threads.delete(thread);
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    server,
    port: server.address().port,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export async function main(env = process.env) {
  if (env === process.env) {
    try {
      process.loadEnvFile(path.resolve(here, "..", "..", ".env"));
    } catch {
      // No .env file: the defaults and the shell environment apply.
    }
  }
  const { providerFromEnv } = await import("../core/providers/index.mjs");
  const { createDb } = await import("../core/db.mjs");
  const provider = providerFromEnv(env);
  const db = createDb(env.DATABASE_URL || undefined);
  db.pool.on("error", () => {});
  const port = env.PORT ? Number(env.PORT) : 8787;
  const app = await createServer({
    provider,
    port,
    host: env.HOST || "127.0.0.1",
    db,
    ollamaUrl: provider.name === "laptop" ? env.OLLAMA_URL || "http://localhost:11434" : null,
  });
  console.log(`concordance listening on http://localhost:${app.port} (provider ${provider.name})`);
  const stop = async () => {
    await app.close();
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
