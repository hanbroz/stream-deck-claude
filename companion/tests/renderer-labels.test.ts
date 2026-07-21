import { describe, expect, it } from "vitest";

import { formatHeaderContext, formatModelName, projectNameFromPath } from "../renderer/labels";

describe("renderer labels", () => {
  it("derives the project label from the configured project root path", () => {
    expect(projectNameFromPath("D:\\work\\my-project")).toBe("my-project");
    expect(projectNameFromPath("/Users/me/demo/")).toBe("demo");
    expect(projectNameFromPath("")).toBe("project");
  });

  it("formats header context percentages and preserves unknown state", () => {
    expect(formatHeaderContext({ context: { usedPercentage: 47.6 } })).toBe("CTX 48%");
    expect(formatHeaderContext({ contextPercentage: 120 })).toBe("CTX 100%");
    expect(formatHeaderContext({ context: null })).toBe("CTX --");
  });

  it("shows only the model family and version", () => {
    expect(formatModelName("Opus 4.8 (1M context)")).toBe("Opus 4.8");
    expect(formatModelName(undefined)).toBe("Claude Code");
  });
});
