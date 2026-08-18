import { describe, expect, it } from "vitest";

import { createActivityTracker } from "../main/activity-tracker";

describe("key activity tracker", () => {
  it("stays running while background agents work past end_turn", () => {
    const track = createActivityTracker();

    expect(track([{ kind: "phase", phase: "requesting" }])).toBe("running");
    expect(track([
      { kind: "agent", op: "start", toolUseId: "a1", agentType: "inspector", description: "" },
      { kind: "agent", op: "start", toolUseId: "a2", agentType: "inspector", description: "" }
    ])).toBe("running");
    // Claude hands the floor back while both agents keep running: the key must
    // not blink for input yet.
    expect(track([{ kind: "phase", phase: "waiting" }])).toBe("running");
    expect(track([{ kind: "agent", op: "end", toolUseId: "a1", outcome: "ok" }])).toBe("running");
    expect(track([{ kind: "agent", op: "end", toolUseId: "a2", outcome: "unknown" }])).toBe("waiting");
  });

  it("reports waiting on end_turn, errors and login with no agents live", () => {
    const track = createActivityTracker();

    expect(track([{ kind: "phase", phase: "responding" }])).toBe("running");
    expect(track([{ kind: "phase", phase: "waiting" }])).toBe("waiting");
    expect(track([{ kind: "phase", phase: "requesting" }])).toBe("running");
    expect(track([{ kind: "error", message: "boom", missingConversation: false }])).toBe("waiting");
    expect(track([{ kind: "phase", phase: "thinking" }])).toBe("running");
    expect(track([{ kind: "login", message: "Please run /login" }])).toBe("waiting");
  });
});
