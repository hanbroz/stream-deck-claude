import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("Code Start property inspector", () => {
  it("saves a project name together with the launch folder", async () => {
    const html = await readFile(
      path.resolve("com.hanbroz.claude-usage.sdPlugin/ui/code-start.html"),
      "utf8"
    );

    expect(html).toContain('id="projectName"');
    expect(html).toContain("projectName.value =");
    expect(html).toContain("projectName: projectName.value.trim()");
    expect(html).toContain("folder: folder.value.trim()");
    expect(html).toContain("const collectSettings = () => ({");
    expect(html).toContain("settings = collectSettings();");
    expect(html).toContain('payload: { event: "browseFolder", projectName: settings.projectName }');
  });

  it("persists the draft project name returned with a folder selection", async () => {
    const source = await readFile(path.resolve("src/actions/code-start.ts"), "utf8");

    expect(source).toContain("projectName?: JsonValue;");
    expect(source).toContain('typeof payload.projectName === "string"');
    expect(source).toContain("{ ...current, projectName, folder }");
    expect(source).toContain("sendToPropertyInspector({ folder, projectName })");
  });

  it("persists a session binding independently from the transient action instance", async () => {
    const source = await readFile(path.resolve("src/actions/code-start.ts"), "utf8");

    expect(source).toContain("bindingId?: string;");
    expect(source).toContain("findReconnectableBindingId");
    expect(source).toContain("bindingIdsByAction");
    expect(source).toContain("launchClaudeCompanion");
    expect(source).toContain("loadCodeStartDisplayState");
  });
});
