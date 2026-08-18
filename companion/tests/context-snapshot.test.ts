import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildContextSnapshot,
  displayModelName,
  snapshotSessionId,
  writeContextSnapshot,
  writeRuntimeActivity
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

describe("writeRuntimeActivity", () => {
  it("writes the schemaVersion-2 runtime record the key parser expects", async () => {
    const { mkdtemp, readFile: read, rm: remove } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { createHash } = await import("node:crypto");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "companion-runtime-"));
    try {
      await writeRuntimeActivity({
        dataDir,
        bindingId: "binding-1",
        launchId: "launch-1",
        activity: "waiting",
        capturedAt: 123
      });
      const digest = (value: string): string =>
        createHash("sha256").update(value, "utf8").digest("hex");
      const target = path.join(
        dataDir, "context-sessions", digest("binding-1"), `${digest("launch-1")}.state.json`
      );
      expect(JSON.parse(await read(target, "utf8"))).toEqual({
        schemaVersion: 2,
        actionId: "binding-1",
        launchId: "launch-1",
        activity: "waiting",
        capturedAt: 123
      });
    } finally {
      await remove(dataDir, { recursive: true, force: true });
    }
  });
});

describe("snapshotSessionId", () => {
  it("names the live conversation whenever one has reported in", () => {
    expect(
      snapshotSessionId({
        liveSessionId: "live",
        resumeSessionId: "resumed",
        launchId: "launch",
        conversationEnded: false
      })
    ).toBe("live");
  });

  it("falls back to the folder's resume id before the first message", () => {
    expect(
      snapshotSessionId({
        resumeSessionId: "resumed",
        launchId: "launch",
        conversationEnded: false
      })
    ).toBe("resumed");
  });

  it("stands the launch id in once the conversation was ended", () => {
    // The resume id names the conversation the user just discarded; reviving it
    // here would restore the key's pointer to it.
    expect(
      snapshotSessionId({
        resumeSessionId: "resumed",
        launchId: "launch",
        conversationEnded: true
      })
    ).toBe("launch");
  });

  it("uses the launch id when the folder has no resume id at all", () => {
    expect(snapshotSessionId({ launchId: "launch", conversationEnded: false })).toBe("launch");
  });
});
