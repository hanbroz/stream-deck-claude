import { describe, expect, it } from "vitest";

import {
  createClaudeCommandArgs,
  encodeRuntimeProjectMetadata,
  readRuntimeProjectMetadataArg
} from "../shared/claude-command";

describe("createClaudeCommandArgs", () => {
  it("starts a new Claude session with skip-permissions only", () => {
    expect(createClaudeCommandArgs({ cwd: "D:\\repo", mode: "new" })).toEqual([
      "--dangerously-skip-permissions"
    ]);
  });

  it("resumes a selected Claude session by id", () => {
    expect(
      createClaudeCommandArgs({
        cwd: "D:\\repo",
        mode: "resume",
        sessionId: "session-123"
      })
    ).toEqual(["--dangerously-skip-permissions", "--resume", "session-123"]);
  });

  it("rejects invalid resume requests", () => {
    expect(() => createClaudeCommandArgs({ cwd: "D:\\repo", mode: "resume" })).toThrow(
      "sessionId is required"
    );
  });
});

describe("runtime metadata args", () => {
  it("round-trips sanitized project metadata for preload", () => {
    const arg = encodeRuntimeProjectMetadata({
      folder: "D:\\repo",
      projectName: "Repo",
      model: "Opus 4.8",
      contextPercent: 42,
      resumeSessionId: "resume-1"
    });

    expect(readRuntimeProjectMetadataArg(["electron", arg])).toEqual({
      folder: "D:\\repo",
      projectName: "Repo",
      model: "Opus 4.8",
      contextPercent: 42,
      resumeSessionId: "resume-1"
    });
  });
});
