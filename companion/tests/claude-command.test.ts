import { describe, expect, it } from "vitest";

import { createClaudeCommandArgs } from "../shared/claude-command";

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

