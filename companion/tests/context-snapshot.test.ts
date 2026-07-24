import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildContextSnapshot,
  displayModelName,
  writeContextSnapshot
} from "../main/context-snapshot";

describe("displayModelName", () => {
  it("formats a raw model id as family and version", () => {
    expect(displayModelName("claude-opus-4-8[1m]")).toBe("Opus 4.8");
    expect(displayModelName("claude-sonnet-5-0")).toBe("Sonnet 5.0");
    expect(displayModelName("claude-haiku-4-5")).toBe("Haiku 4.5");
  });

  it("returns undefined for unknown shapes", () => {
    expect(displayModelName("gpt-4")).toBeUndefined();
    expect(displayModelName(undefined)).toBeUndefined();
  });
});

describe("buildContextSnapshot", () => {
  it("produces the schema the Code Start key parser expects", () => {
    const record = buildContextSnapshot({
      dataDir: "d",
      bindingId: "b",
      launchId: "l",
      sessionId: "conv-1",
      projectDir: "D:\\repo",
      model: "claude-opus-4-8[1m]",
      usedTokens: 200_000,
      windowTokens: 1_000_000,
      capturedAt: 123
    });
    expect(record).toEqual({
      schemaVersion: 2,
      actionId: "b",
      launchId: "l",
      sessionId: "conv-1",
      projectDir: "D:\\repo",
      capturedAt: 123,
      model: { displayName: "Opus 4.8" },
      context: { usedPercentage: 20, totalInputTokens: 200_000, contextWindowSize: 1_000_000 }
    });
  });

  it("clamps an overflowing context to 100 percent", () => {
    const record = buildContextSnapshot({
      dataDir: "d", bindingId: "b", launchId: "l", sessionId: "s",
      usedTokens: 250_000, windowTokens: 200_000, capturedAt: 1
    });
    expect((record.context as { usedPercentage: number }).usedPercentage).toBe(100);
  });

  it("writes a null percentage when usage is not known yet (fresh launch)", () => {
    const record = buildContextSnapshot({
      dataDir: "d", bindingId: "b", launchId: "l", sessionId: "s",
      model: "claude-opus-4-8",
      usedTokens: null, windowTokens: 1_000_000, capturedAt: 1
    });
    expect(record.model).toEqual({ displayName: "Opus 4.8" });
    expect(record.context).toEqual({ usedPercentage: null, contextWindowSize: 1_000_000 });
  });
});

describe("writeContextSnapshot", () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("writes to the hashed path the Stream Deck key reads", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ctx-snap-"));
    await writeContextSnapshot({
      dataDir: dir, bindingId: "binding-1", launchId: "launch-1", sessionId: "conv-9",
      model: "claude-opus-4-8", usedTokens: 100_000, windowTokens: 1_000_000, capturedAt: 5
    });
    const hash = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");
    const target = path.join(dir, "context-sessions", hash("binding-1"), `${hash("launch-1")}.json`);
    const written = JSON.parse(await readFile(target, "utf8"));
    expect(written).toMatchObject({
      actionId: "binding-1",
      launchId: "launch-1",
      model: { displayName: "Opus 4.8" },
      context: { usedPercentage: 10 }
    });
  });
});
