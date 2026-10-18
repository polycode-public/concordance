// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
//
// Measures the laptop models: embed throughput and chat latency. Prints one JSON
// line and a Markdown table row. Needs a running Ollama with the models pulled.
import { existsSync } from "node:fs";
import { providerFromEnv } from "../packages/core/providers/index.mjs";

if (existsSync(".env")) process.loadEnvFile(".env");
const provider = providerFromEnv({ ...process.env, MODEL_PROVIDER: "laptop" });

const words =
  "river tower stair smoke corridor lift door window floor call night light fire door".split(" ");
const passage = (i) =>
  Array.from(
    { length: 120 },
    (_, k) => words[(i * 7 + k * 3) % words.length] + (k % 17 === 0 ? ` ${i}` : ""),
  ).join(" ");
const passages = Array.from({ length: 200 }, (_, i) => passage(i));

await provider.embed([passages[0]]);
const embedStart = performance.now();
for (let i = 0; i < passages.length; i += 32) await provider.embed(passages.slice(i, i + 32));
const embedMinutes = (performance.now() - embedStart) / 60000;
const embedChunksPerMin = Math.round(passages.length / embedMinutes);

const chatStart = performance.now();
let firstToken = null;
let tokens = 0;
await provider.chat({
  messages: [{ role: "user", content: "Write about 300 words on the history of lighthouses." }],
  onToken: () => {
    if (firstToken === null) firstToken = performance.now();
    tokens += 1;
  },
});
const chatEnd = performance.now();
const firstTokenS = +((firstToken - chatStart) / 1000).toFixed(1);
const tokensPerS = +(tokens / ((chatEnd - firstToken) / 1000)).toFixed(1);

console.log(JSON.stringify({ embedChunksPerMin, firstTokenS, tokensPerS, tokens }));
console.log(
  `| Intel i9, 64 GB | ${embedChunksPerMin} | ${firstTokenS} | ${tokensPerS} | not measured | ${new Date().toISOString().slice(0, 10)} |`,
);
