import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConversationHistoryReader,
  readConversationMessages,
  readLastContextUsage
} from "../main/transcript-history";

let root: string;

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

const jsonl = (...records: unknown[]): string =>
  records.map((record) => JSON.stringify(record)).join("\n") + "\n";

async function writeTranscript(folder: string, sessionId: string, body: string): Promise<string> {
  root = root ?? (await mkdtemp(path.join(os.tmpdir(), "hist-")));
  const configDir = path.join(root, "config");
  const projectDir = path.join(configDir, "projects", folder.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(projectDir, { recursive: true });
  await writeFile(path.join(projectDir, `${sessionId}.jsonl`), body, "utf8");
  return configDir;
}

describe("readConversationMessages", () => {
  it("keeps only user/assistant text and drops thinking, tools and attachments", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hist-"));
    const file = path.join(root, "t.jsonl");
    await writeFile(file, jsonl(
      { type: "queue-operation", operation: "x" },
      { type: "attachment", attachment: { data: "AAAA".repeat(1000) } },
      { type: "user", message: { role: "user", content: "안녕 Claude" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }] } },
      { type: "assistant", message: { role: "assistant", content: [
        { type: "thinking", thinking: "reasoning" },
        { type: "text", text: "안녕하세요" }
      ] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] } }
    ), "utf8");

    expect(await readConversationMessages(file)).toEqual([
      { role: "user", text: "안녕 Claude" },
      { role: "assistant", text: "안녕하세요" }
    ]);
  });

  it("renders an image-only user turn as a placeholder, never base64", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hist-"));
    const file = path.join(root, "t.jsonl");
    await writeFile(file, jsonl(
      { type: "user", message: { role: "user", content: [
        { type: "image", source: { data: "SECRETBASE64" } }
      ] } },
      { type: "user", message: { role: "user", content: [
        { type: "text", text: "이거 봐" },
        { type: "image", source: { data: "SECRETBASE64" } }
      ] } }
    ), "utf8");

    const messages = await readConversationMessages(file);
    expect(messages).toEqual([
      { role: "user", text: "[이미지 1장]" },
      { role: "user", text: "이거 봐\n[이미지 1장]" }
    ]);
    expect(JSON.stringify(messages)).not.toContain("SECRETBASE64");
  });

  it("skips malformed lines without failing", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "hist-"));
    const file = path.join(root, "t.jsonl");
    await writeFile(file, "not json\n" + jsonl({ type: "user", message: { role: "user", content: "ok" } }), "utf8");
    expect(await readConversationMessages(file)).toEqual([{ role: "user", text: "ok" }]);
  });
});

describe("ConversationHistoryReader paging", () => {
  const folder = "D:\\repo";
  const body = jsonl(
    ...Array.from({ length: 5 }, (_unused, i) => ({
      type: "user",
      message: { role: "user", content: `m${i}` }
    }))
  );

  it("returns the newest page first and reports more above it", async () => {
    const configDir = await writeTranscript(folder, "sess", body);
    const reader = new ConversationHistoryReader({ configDir, folder });

    const newest = await reader.page("sess", 0, 2);
    expect(newest).toEqual({
      messages: [{ role: "user", text: "m3" }, { role: "user", text: "m4" }],
      total: 5,
      hasMore: true
    });
  });

  it("returns a contiguous older window and stops at the top", async () => {
    const configDir = await writeTranscript(folder, "sess", body);
    const reader = new ConversationHistoryReader({ configDir, folder });

    const older = await reader.page("sess", 2, 2);
    expect(older.messages).toEqual([{ role: "user", text: "m1" }, { role: "user", text: "m2" }]);
    expect(older.hasMore).toBe(true);

    const oldest = await reader.page("sess", 4, 2);
    expect(oldest.messages).toEqual([{ role: "user", text: "m0" }]);
    expect(oldest.hasMore).toBe(false);
  });

  it("returns an empty page for an unknown session", async () => {
    const configDir = await writeTranscript(folder, "sess", body);
    const reader = new ConversationHistoryReader({ configDir, folder });
    expect(await reader.page("missing", 0, 20)).toEqual({ messages: [], total: 0, hasMore: false });
  });

  it("rejects path traversal in the session id", async () => {
    const configDir = await writeTranscript(folder, "sess", body);
    const reader = new ConversationHistoryReader({ configDir, folder });
    expect(await reader.page("../secret", 0, 20)).toEqual({ messages: [], total: 0, hasMore: false });
  });
});

describe("readLastContextUsage", () => {
  it("returns the newest assistant usage and model from the transcript tail", async () => {
    const folder = "D:\proj";
    const configDir = await writeTranscript(folder, "sess-usage", jsonl(
      { type: "user", message: { role: "user", content: "first" } },
      {
        type: "assistant",
        message: {
          role: "assistant", model: "claude-opus-4-8",
          usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 40 }
        }
      },
      {
        type: "assistant",
        message: {
          role: "assistant", model: "claude-sonnet-5",
          usage: { input_tokens: 2, cache_creation_input_tokens: 70444, cache_read_input_tokens: 36205 }
        }
      },
      { type: "user", message: { role: "user", content: "trailing user turn" } }
    ));
    const reader = new ConversationHistoryReader({ configDir, folder });

    expect(await reader.lastContextUsage("sess-usage")).toEqual({
      usedTokens: 2 + 70444 + 36205,
      model: "claude-sonnet-5"
    });
  });

  it("returns undefined for missing transcripts, unsafe ids and usage-less files", async () => {
    const folder = "D:\proj";
    const configDir = await writeTranscript(folder, "no-usage", jsonl(
      { type: "user", message: { role: "user", content: "only user text" } }
    ));
    const reader = new ConversationHistoryReader({ configDir, folder });

    expect(await reader.lastContextUsage("no-usage")).toBeUndefined();
    expect(await reader.lastContextUsage("missing-session")).toBeUndefined();
    expect(await reader.lastContextUsage("../secret")).toBeUndefined();
    expect(await readLastContextUsage(configDir + "/nope.jsonl")).toBeUndefined();
  });
});
