// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Polycode Limited
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve("scripts/model-profile-env.sh");

async function runWithAws(body) {
  const bin = await mkdtemp(path.join(tmpdir(), "aws-"));
  await writeFile(path.join(bin, "aws"), `#!/bin/bash\n${body}\n`);
  await chmod(path.join(bin, "aws"), 0o755);
  return spawnSync("/bin/bash", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
}

describe("model-profile-env.sh", () => {
  it("prints one export line for each profile output", async () => {
    const result = await runWithAws(
      'case "$*" in *ChatProfileArn*) echo arn:chat;; *ExtractProfileArn*) echo arn:extract;; *) echo arn:embed;; esac',
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      [
        "export BEDROCK_CHAT_PROFILE_ARN=arn:chat",
        "export BEDROCK_EXTRACT_PROFILE_ARN=arn:extract",
        "export BEDROCK_EMBED_PROFILE_ARN=arn:embed",
        "",
      ].join("\n"),
    );
  });

  it("fails naming the output the stack lacks", async () => {
    const result = await runWithAws("echo None");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("output ChatProfileArn missing");
  });
});
