import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readCompanionSessionStatus } from "../main/session-status";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("readCompanionSessionStatus", () => {
  it("reads the model and bounded context percentage from the launch snapshot", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "companion-session-status-"));
    temporaryDirectories.push(dataDir);
    const bindingId = "binding-1";
    const launchId = "launch-1";
    const directory = path.join(dataDir, "context-sessions", digest(bindingId));
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${digest(launchId)}.json`),
      JSON.stringify({ model: { displayName: "Opus 4.8 (1M context)" }, context: { usedPercentage: 143 }, capturedAt: 123 }),
      "utf8"
    );

    await expect(readCompanionSessionStatus({ dataDir, bindingId, launchId })).resolves.toEqual({
      model: "Opus 4.8 (1M context)",
      contextPercentage: 100,
      capturedAt: 123
    });
  });

  it("returns the fallback when the snapshot is not available", async () => {
    await expect(readCompanionSessionStatus({
      dataDir: path.join(os.tmpdir(), "missing-companion-session-status"),
      bindingId: "binding-1",
      launchId: "launch-1",
      fallback: { model: "Claude Code", contextPercentage: null }
    })).resolves.toEqual({ model: "Claude Code", contextPercentage: null });
  });
});
