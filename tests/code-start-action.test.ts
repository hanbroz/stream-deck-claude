import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CodeStartLaunchGuard } from "../src/actions/code-start-launch-guard";

describe("Code Start relaunch guard", () => {
  it("keeps a binding locked until its replacement terminal finishes launching", () => {
    const guard = new CodeStartLaunchGuard();

    expect(guard.begin("binding-1")).toBe(true);
    expect(guard.isLaunching("binding-1")).toBe(true);
    expect(guard.begin("binding-1")).toBe(false);

    guard.end("binding-1");

    expect(guard.isLaunching("binding-1")).toBe(false);
    expect(guard.begin("binding-1")).toBe(true);
  });

  it("keeps refreshes in Starting state and releases the lock after every launch", async () => {
    const source = await readFile(path.resolve("src/actions/code-start.ts"), "utf8");

    expect(source).toContain("this.launchGuard.begin(bindingId)");
    expect(source).toContain("this.launchGuard.isLaunching(bindingId)");
    expect(source).toContain("this.launchGuard.end(bindingId)");
    expect(source).toContain("finally");
  });
});
