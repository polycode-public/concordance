// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// The laptop server: static UI over HTTP, /health, /config.json, /spend, /conversations, /export, and
// the chat WebSocket at /ws.
import { randomUUID } from "node:crypto";
import http from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { InvalidThread, NothingToExport, exportConversation, isNoteKey } from "../core/export.mjs";
import { parseClientFrame, serverFrame } from "../core/protocol.mjs";
import { runQuery as defaultRunQuery } from "../core/query.mjs";
import {
  LAPTOP_USER,
  conversationTurns,
  isUuid,
  listConversations,
  recordSession,
  recordTurn,
} from "../core/sessions.mjs";
import { PAGE_ASSETS } from "../../scripts/stage-page-assets.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC = path.resolve(here, "..", "ui");
const DEFAULT_CORPORA = path.resolve(here, "..", "..", "corpora");

export const DEFAULT_CORPUS = {
  id: "grenfell",
  title: "Grenfell Tower Inquiry",
  subtitle: "witness statements",
};

export const NO_DATABASE = "the database is not configured";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".map": "application/json; charset=utf-8",
};

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

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when a value can name one path segment: no separators, no "..". */
export const isSafeSegment = (value) =>
  typeof value === "string" &&
  value.length <= 128 &&
  SAFE_SEGMENT.test(value) &&
  !value.includes("..");

/**
 * Finds the original PDF for a document. Resolves to null when the document or
 * its file does not exist.
 * @param {{ query: Function }} db
 * @param {string} corporaDir
 * @param {string} documentId
 */
export async function findOriginal(db, corporaDir, documentId) {
  const { rows } = await db.query("SELECT corpus, title FROM documents WHERE id = $1", [
    documentId,
  ]);
  if (!rows.length) return null;
  const { corpus, title } = rows[0];
  if (!isSafeSegment(corpus)) throw new Error(`document ${documentId} has an unsafe corpus name`);
  const file = path.join(corporaDir, corpus, "raw", `${documentId}.pdf`);
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    return { file, size: info.size, title: title ?? documentId };
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

const blockFrame = (b) => ({
  evidence: b.evidence,
  documentId: b.documentId,
  locator: b.locator,
  header: b.header,
  text: b.text,
});

/**
 * @param {object} options
 * @param {import('../core/providers/modelProvider.mjs').ModelProvider} options.provider
 * @param {number} [options.port]
 * @param {string} [options.host]
 * @param {string} [options.staticDir]
 * @param {{ query: Function } | null} [options.db]
 * @param {string | null} [options.ollamaUrl]
 * @param {string} [options.corporaDir]
 * @param {typeof defaultRunQuery} [options.runQuery]
 * @param {() => Date} [options.now]
 */
export async function createServer({
  provider,
  port = 0,
  host = "127.0.0.1",
  staticDir = DEFAULT_STATIC,
  db = null,
  ollamaUrl = null,
  corporaDir = DEFAULT_CORPORA,
  runQuery = defaultRunQuery,
  now = () => new Date(),
}) {
  const root = path.resolve(staticDir);

  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      if (req.method === "POST" && pathname === "/export") {
        await serveExport(req, res);
        return;
      }
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
      if (pathname === "/config.json") {
        const body = JSON.stringify({
          wsUrl: `ws://${req.headers.host}/ws`,
          httpUrl: "",
          auth: null,
          corpus: DEFAULT_CORPUS,
          spendUrl: "/spend",
          conversationsUrl: "/conversations",
          exportUrl: "/export",
        });
        res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      if (pathname === "/spend") {
        // The laptop has no budget; null hides the spend strip.
        res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
        res.end(req.method === "HEAD" ? undefined : "null");
        return;
      }
      if (pathname === "/conversations" || pathname.startsWith("/conversations/")) {
        await serveConversations(req, res, pathname, new URL(req.url, "http://localhost"));
        return;
      }
      if (pathname.startsWith("/notes/")) {
        await serveNote(req, res, decodeURIComponent(pathname.slice(1)));
        return;
      }
      if (pathname.startsWith("/doc/")) {
        await serveOriginal(req, res, decodeURIComponent(pathname.slice("/doc/".length)));
        return;
      }
      const rel =
        pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
      const file = PAGE_ASSETS[rel] ?? path.resolve(root, rel);
      if (!PAGE_ASSETS[rel] && file !== root && !file.startsWith(root + path.sep)) {
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
      if (err instanceof URIError) res.writeHead(400).end();
      else if (err.code === "ENOENT" || err.code === "EISDIR") res.writeHead(404).end();
      else if (!res.headersSent) res.writeHead(500).end();
    }
  });

  async function serveConversations(req, res, pathname, url) {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": MIME[".json"], "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
    };
    if (!db) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end(NO_DATABASE);
      return;
    }
    if (pathname === "/conversations") {
      json(200, { conversations: await listConversations(db, LAPTOP_USER) });
      return;
    }
    const sessionId = decodeURIComponent(pathname.slice("/conversations/".length));
    if (!isUuid(sessionId)) {
      res.writeHead(400).end();
      return;
    }
    const thread = url.searchParams.get("thread");
    const conversation = await conversationTurns(db, { sessionId, userId: LAPTOP_USER, thread });
    if (!conversation) {
      res.writeHead(404).end();
      return;
    }
    json(200, conversation);
  }

  const notePath = (key) => path.join(path.resolve(corporaDir), DEFAULT_CORPUS.id, key);

  async function serveExport(req, res) {
    const json = (status, body) => {
      res.writeHead(status, { "content-type": MIME[".json"], "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (!db) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end(NO_DATABASE);
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096) {
        json(413, { message: "The request body is too large." });
        return;
      }
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      json(400, { message: "The request body is not JSON." });
      return;
    }
    if (!isUuid(body?.sessionId) || typeof body?.thread !== "string") {
      json(400, { message: "The request needs a sessionId (UUID) and a thread." });
      return;
    }
    try {
      const result = await exportConversation({
        db,
        which: { sessionId: body.sessionId, userId: LAPTOP_USER, thread: body.thread },
        corpus: DEFAULT_CORPUS,
        now: now(),
        write: async (key, markdown) => {
          const file = notePath(key);
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(file, markdown, { flag: "wx" });
          return { key, bytes: Buffer.byteLength(markdown), url: `/${key}` };
        },
      });
      json(200, result);
    } catch (err) {
      if (err instanceof NothingToExport) json(404, { message: err.message });
      else if (err instanceof InvalidThread) json(400, { message: err.message });
      else if (err.code === "EEXIST") json(409, { message: "That document already exists." });
      else {
        console.error("export: the write failed", err);
        json(500, { message: `The document could not be written: ${err.message}` });
      }
    }
  }

  async function serveNote(req, res, key) {
    if (!isNoteKey(key)) {
      res.writeHead(400).end();
      return;
    }
    const data = await readFile(notePath(key));
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  }

  async function serveOriginal(req, res, documentId) {
    if (!isSafeSegment(documentId)) {
      res.writeHead(400).end();
      return;
    }
    if (!db) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" }).end(NO_DATABASE);
      return;
    }
    const original = await findOriginal(db, path.resolve(corporaDir), documentId);
    if (!original) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": original.size,
      "cache-control": "no-cache",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(original.file)
      .on("error", () => res.destroy())
      .pipe(res);
  }

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

    const sessionId = randomUUID();
    // The session log is a queue beside the chat: a failed write is logged with its cause and
    // the turn's frames have already reached the client.
    const sessionWritten = db
      ? recordSession(db, { id: sessionId, userId: LAPTOP_USER }).catch((err) =>
          console.error(`session log: session ${sessionId} was not written`, err),
        )
      : null;
    const logTurn = async (turn) => {
      try {
        await sessionWritten;
        await recordTurn(db, { sessionId, ...turn });
      } catch (err) {
        console.error(
          `session log: turn ${turn.turnId} of session ${sessionId} was not written`,
          err,
        );
      }
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
        openDocument(frame);
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

    async function openDocument({ docId, locator }) {
      try {
        if (!isSafeSegment(docId)) throw new Error(`unsafe document id ${JSON.stringify(docId)}`);
        if (!db) throw new Error(NO_DATABASE);
        const original = await findOriginal(db, path.resolve(corporaDir), docId);
        if (!original) throw new Error(`no original PDF for ${docId}`);
        const page = Number.isInteger(locator?.page) && locator.page > 0 ? locator.page : 1;
        send(
          serverFrame.opened(docId, {
            url: `/doc/${encodeURIComponent(docId)}`,
            title: original.title,
            page,
            locator,
          }),
        );
      } catch (err) {
        send(serverFrame.error(err.message));
      }
    }

    async function runTurn({ thread, turnId, text }) {
      if (!db) {
        send(serverFrame.error(NO_DATABASE, thread, turnId));
        return;
      }
      const controller = new AbortController();
      const { signal } = controller;
      threads.set(thread, { turnId, controller });
      const live = () => !signal.aborted;
      const frames = [];
      const emit = (frame) => {
        frames.push(frame);
        send(frame);
      };
      let finished = null;
      try {
        const result = await runQuery({
          question: text,
          provider,
          db,
          signal,
          onStage: (stage) => {
            if (live()) emit(serverFrame.status(thread, turnId, stage));
          },
          onEvidence: (blocks) => {
            if (live()) emit(serverFrame.evidence(thread, turnId, blocks.map(blockFrame)));
          },
          onToken: (piece) => {
            if (live()) emit(serverFrame.token(thread, turnId, piece));
          },
        });
        signal.throwIfAborted();
        emit(
          serverFrame.done(
            thread,
            turnId,
            { ...result.checks, abstained: result.abstained },
            result.citations,
            sessionId,
          ),
        );
        finished = result;
      } catch (err) {
        if (signal.aborted) emit(serverFrame.cancelled(thread, turnId));
        else emit(serverFrame.error(err.message, thread, turnId));
      } finally {
        if (threads.get(thread)?.turnId === turnId) threads.delete(thread);
      }
      await logTurn({ thread, turnId, userText: text, result: finished, frames });
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
