import { describe, expect, it } from "vitest";

import { ClaudeStreamParser, encodeClaudeUserMessage } from "../shared/claude-stream";

describe("Claude stream protocol", () => {
  it("encodes text and image turns as stream-json user messages", () => {
    expect(JSON.parse(encodeClaudeUserMessage("describe this", ["data:image/png;base64,AAAA"]))).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" }
          }
        ]
      },
      parent_tool_use_id: null
    });
  });

  it("renders assistant text deltas and ignores terminal/system messages", () => {
    const parser = new ClaudeStreamParser();
    expect(parser.push(`${JSON.stringify({ type: "system", subtype: "init" })}\n`)).toBe("");
    expect(parser.push(`${JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } }
    })}\n`)).toBe("hello");
    expect(parser.push(`${JSON.stringify({
      type: "user",
      message: { role: "user", content: "input" }
    })}\n`)).toBe("");
    expect(parser.push(`${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }] }
    })}\n`)).toBe("");

    const completeParser = new ClaudeStreamParser();
    expect(completeParser.push(`${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }] }
    })}\n`)).toBe("done\n");
  });

  it("handles chunks split across lines and reports error results", () => {
    const parser = new ClaudeStreamParser();
    const line = JSON.stringify({ type: "result", is_error: true, result: "auth failed" });
    expect(parser.push(line.slice(0, 10))).toBe("");
    expect(parser.push(`${line.slice(10)}\n`)).toBe("[Claude Code error] auth failed\n");
  });
});
