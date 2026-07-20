import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Code Start manifest action", () => {
  it("registers a unique action with a property inspector", async () => {
    const manifest = JSON.parse(
      await readFile("com.hanbroz.claude-usage.sdPlugin/manifest.json", "utf8")
    ) as { Actions: Array<Record<string, unknown>> };
    const action = manifest.Actions.find((item) => item.Name === "Code Start");

    expect(action).toMatchObject({
      UUID: "com.hanbroz.claude-usage.code-start",
      PropertyInspectorPath: "ui/code-start.html"
    });
    expect(new Set(manifest.Actions.map((item) => item.UUID)).size).toBe(manifest.Actions.length);
  });
});
