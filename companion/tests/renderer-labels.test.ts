import { describe, expect, it } from "vitest";

import {
  contextPercentValue,
  formatClaudePhase,
  formatModelName,
  projectNameFromPath
} from "../renderer/labels";
import { parseModelId } from "../shared/model-name";

describe("renderer labels", () => {
  it("derives the project label from the configured project root path", () => {
    expect(projectNameFromPath("D:\\work\\my-project")).toBe("my-project");
    expect(projectNameFromPath("/Users/me/demo/")).toBe("demo");
    expect(projectNameFromPath("")).toBe("project");
  });

  it("exposes the context percentage as a clamped number for the meter", () => {
    expect(contextPercentValue({ context: { usedPercentage: 47.6 } })).toBe(48);
    expect(contextPercentValue({ contextPercentage: 120 })).toBe(100);
    expect(contextPercentValue({ contextPercentage: -5 })).toBe(0);
    expect(contextPercentValue({ context: null })).toBeNull();
    expect(contextPercentValue({})).toBeNull();
  });

  it("shows only the model family and version", () => {
    expect(formatModelName("Opus 4.8 (1M context)")).toBe("Opus 4.8");
    expect(formatModelName(undefined)).toBe("Claude Code");
  });

  it("derives family and versioned label from a raw model id", () => {
    expect(parseModelId("claude-opus-4-8[1m]")).toEqual({ family: "opus", label: "Opus 4.8" });
    expect(parseModelId("claude-sonnet-5")).toEqual({ family: "sonnet", label: "Sonnet 5" });
    expect(parseModelId("claude-haiku-4-5")).toEqual({ family: "haiku", label: "Haiku 4.5" });
    expect(parseModelId("gpt-4")).toBeNull();
    expect(parseModelId(undefined)).toBeNull();
  });
});

describe("Claude status labels", () => {
  /**
   * Claude buffers stdin from spawn, `system/init` only arrives after the first
   * message, and one SessionStart hook is async — so the hook count can sit at
   * 8/9 forever. Booting must never read as "wait before typing".
   */
  it("invites input while booting and keeps hook progress as detail", () => {
    expect(formatClaudePhase("booting", "8/9")).toEqual({
      text: "메시지를 입력하세요",
      detail: "준비 중 8/9",
      busy: true
    });
    expect(formatClaudePhase("booting")).toEqual({
      text: "메시지를 입력하세요",
      detail: "준비 중",
      busy: true
    });
  });

  it("marks idle phases as not busy so the indicator stops pulsing", () => {
    expect(formatClaudePhase("ready").busy).toBe(false);
    expect(formatClaudePhase("waiting").busy).toBe(false);
    expect(formatClaudePhase("thinking").busy).toBe(true);
    expect(formatClaudePhase("tool").busy).toBe(true);
  });

  it("tells the user it is their turn whenever Claude is not working", () => {
    expect(formatClaudePhase("waiting").text).toBe("메시지를 입력하세요");
    expect(formatClaudePhase("ready").text).toBe("메시지를 입력하세요");
    expect(formatClaudePhase("booting").text).toBe("메시지를 입력하세요");
  });

  it("carries the running tool as the detail", () => {
    expect(formatClaudePhase("tool", "Read package.json")).toEqual({
      text: "작업 진행 중",
      detail: "Read package.json",
      busy: true
    });
  });
});
