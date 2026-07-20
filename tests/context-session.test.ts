import { describe, expect, it } from "vitest";

import {
  extractContextSessionRuntime,
  extractContextSessionSnapshot
} from "../src/domain/context-session";

describe("extractContextSessionSnapshot", () => {
  it("extracts only safe session and context fields", () => {
    const snapshot = extractContextSessionSnapshot(
      {
        session_id: "session-abc",
        workspace: { project_dir: "D:\\work\\demo" },
        context_window: {
          used_percentage: 42.4,
          total_input_tokens: 21_000,
          context_window_size: 200_000
        },
        transcript_path: "must-not-be-cached",
        prompt: "must-not-be-cached"
      },
      "action-1",
      "launch-1",
      1_700_000_000_000
    );

    expect(snapshot).toEqual({
      schemaVersion: 1,
      actionId: "action-1",
      launchId: "launch-1",
      sessionId: "session-abc",
      projectDir: "D:\\work\\demo",
      capturedAt: 1_700_000_000_000,
      context: {
        usedPercentage: 42.4,
        totalInputTokens: 21_000,
        contextWindowSize: 200_000
      }
    });
    expect(JSON.stringify(snapshot)).not.toContain("must-not-be-cached");
  });

  it("keeps a null percentage while the first response is pending", () => {
    expect(
      extractContextSessionSnapshot(
        {
          session_id: "session-abc",
          workspace: { project_dir: "D:\\work\\demo" },
          context_window: { used_percentage: null }
        },
        "action-1",
        "launch-1",
        100
      )
    ).toMatchObject({ context: { usedPercentage: null } });
  });

  it("clamps percentages and rejects payloads without a session", () => {
    expect(
      extractContextSessionSnapshot(
        { session_id: "session", context_window: { used_percentage: 120 } },
        "action",
        "launch",
        100
      )
    ).toMatchObject({ context: { usedPercentage: 100 } });
    expect(
      extractContextSessionSnapshot(
        { context_window: { used_percentage: 10 } },
        "action",
        "launch",
        100
      )
    ).toBeUndefined();
    expect(
      extractContextSessionSnapshot(
        { session_id: "session", context_window: { used_percentage: 10 } },
        "",
        "launch",
        100
      )
    ).toBeUndefined();
  });
});

describe("extractContextSessionRuntime", () => {
  it.each([
    [undefined, "running"],
    ["SessionStart", "running"],
    ["UserPromptSubmit", "responding"],
    ["Stop", "running"],
    ["StopFailure", "running"],
    ["SessionEnd", "waiting"]
  ] as const)("maps %s to %s without caching payload content", (hookEventName, activity) => {
    const runtime = extractContextSessionRuntime(
      {
        session_id: "session-abc",
        ...(hookEventName === undefined ? {} : { hook_event_name: hookEventName }),
        prompt: "must-not-be-cached",
        last_assistant_message: "must-not-be-cached"
      },
      "action-1",
      "launch-1",
      123
    );

    expect(runtime).toEqual({
      schemaVersion: 1,
      actionId: "action-1",
      launchId: "launch-1",
      activity,
      capturedAt: 123
    });
    expect(JSON.stringify(runtime)).not.toContain("must-not-be-cached");
  });

  it("ignores unrelated hooks and payloads outside a managed launch", () => {
    expect(
      extractContextSessionRuntime(
        { session_id: "session", hook_event_name: "PreToolUse" },
        "action",
        "launch"
      )
    ).toBeUndefined();
    expect(
      extractContextSessionRuntime(
        { session_id: "session", hook_event_name: "Stop" },
        undefined,
        "launch"
      )
    ).toBeUndefined();
  });
});
