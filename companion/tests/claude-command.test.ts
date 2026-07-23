import { describe, expect, it, vi } from "vitest";

import {
  createClaudeCommandArgs,
  encodeRuntimeProjectMetadata,
  readRuntimeProjectMetadataArg
} from "../shared/claude-command";

describe("createClaudeCommandArgs", () => {
  it("starts a new Claude session in structured streaming mode", () => {
    expect(createClaudeCommandArgs({ cwd: "D:\\repo", mode: "new" })).toEqual([
      "--dangerously-skip-permissions",
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose"
    ]);
  });

  it("resumes a selected Claude session by id", () => {
    expect(
      createClaudeCommandArgs({
        cwd: "D:\\repo",
        mode: "resume",
        sessionId: "session-123"
      })
    ).toEqual([
      "--dangerously-skip-permissions",
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--resume",
      "session-123"
    ]);
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
      contextPercent: 42,
      resumeSessionId: "resume-1"
    });

    expect(readRuntimeProjectMetadataArg(["electron", arg])).toEqual({
      folder: "D:\\프로젝트\\020_Source",
      projectName: "020_Source 프로젝트",
      model: "Opus 4.8",
      contextPercent: 42,
      resumeSessionId: "resume-1"
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
