import { describe, expect, it, vi } from "vitest";

import {
  createClaudeCommandArgs,
  encodeRuntimeProjectMetadata,
  readRuntimeProjectMetadataArg,
  stripInheritedSessionMarkers
} from "../shared/claude-command";
import { QUESTION_SYSTEM_PROMPT } from "../shared/question-block";

const BASE_ARGS = [
  "--dangerously-skip-permissions",
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--include-partial-messages",
  "--verbose",
  "--append-system-prompt",
  QUESTION_SYSTEM_PROMPT,
  "--max-turns",
  "100"
];

describe("createClaudeCommandArgs", () => {
  it("starts a new Claude session in structured streaming mode", () => {
    expect(createClaudeCommandArgs({ cwd: "D:\\repo", mode: "new" })).toEqual(BASE_ARGS);
  });

  it("resumes a selected Claude session by id", () => {
    expect(
      createClaudeCommandArgs({
        cwd: "D:\\repo",
        mode: "resume",
        sessionId: "session-123"
      })
    ).toEqual([...BASE_ARGS, "--resume", "session-123"]);
  });

  it("rejects invalid resume requests", () => {
    expect(() => createClaudeCommandArgs({ cwd: "D:\\repo", mode: "resume" })).toThrow(
      "sessionId is required"
    );
  });

  it("appends model and effort flags when provided", () => {
    const args = createClaudeCommandArgs({ cwd: "D:\\repo", model: "sonnet", effort: "max" });
    expect(args).toEqual(expect.arrayContaining(["--model", "sonnet", "--effort", "max"]));
    expect(args).not.toContain("--resume");
  });

  it("rejects unknown model or effort values", () => {
    expect(() => createClaudeCommandArgs({ cwd: "D:\\repo", model: "gpt" as never })).toThrow(
      "Unsupported Claude model"
    );
    expect(() => createClaudeCommandArgs({ cwd: "D:\\repo", effort: "turbo" as never })).toThrow(
      "Unsupported Claude effort"
    );
  });
});

describe("runtime metadata args", () => {
  it("round-trips sanitized project metadata for preload", () => {
    const arg = encodeRuntimeProjectMetadata({
      folder: "D:\\프로젝트\\020_Source",
      projectName: "020_Source 프로젝트",
      model: "Opus 4.8",
      effort: "xhigh",
      contextPercent: 42,
      resumeCandidateId: "resume-1"
    });

    expect(readRuntimeProjectMetadataArg(["electron", arg])).toEqual({
      folder: "D:\\프로젝트\\020_Source",
      projectName: "020_Source 프로젝트",
      model: "Opus 4.8",
      effort: "xhigh",
      contextPercent: 42,
      resumeCandidateId: "resume-1"
    });
  });

  it("round-trips from Web APIs when the sandboxed preload has no Buffer", () => {
    vi.stubGlobal("Buffer", undefined);
    try {
      const arg = encodeRuntimeProjectMetadata({
        folder: "D:\\프로젝트",
        projectName: "한글 프로젝트"
      });

      expect(readRuntimeProjectMetadataArg([arg])).toEqual({
        folder: "D:\\프로젝트",
        projectName: "한글 프로젝트"
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("stripInheritedSessionMarkers", () => {
  it("drops the nested-session marker and reports what it dropped", () => {
    const env: Record<string, string | undefined> = {
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ID: "abc",
      PATH: "C:\Windows"
    };

    expect(stripInheritedSessionMarkers(env)).toEqual(["CLAUDE_CODE_CHILD_SESSION"]);
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    // Only the marker. The session id is inert on its own, and PATH obviously
    // has to survive — this runs on the real process environment.
    expect(env.CLAUDE_CODE_SESSION_ID).toBe("abc");
    expect(env.PATH).toBe("C:\Windows");
  });

  it("leaves a deliberate CLAUDE_CODE_SKIP_PROMPT_HISTORY alone", () => {
    // The CLI reports that one separately, and a user who set it meant it.
    const env: Record<string, string | undefined> = { CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1" };
    expect(stripInheritedSessionMarkers(env)).toEqual([]);
    expect(env.CLAUDE_CODE_SKIP_PROMPT_HISTORY).toBe("1");
  });

  it("is a no-op when nothing was inherited", () => {
    const env: Record<string, string | undefined> = {};
    expect(stripInheritedSessionMarkers(env)).toEqual([]);
  });
});
