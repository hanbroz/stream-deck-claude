import { describe, expect, it } from "vitest";

import { titleShowsFolder } from "../src/services/vscode-windows";

describe("titleShowsFolder", () => {
  const folder = "D:\\Projects\\Demo";

  it("matches VS Code's default title with and without an open editor", () => {
    expect(titleShowsFolder("Demo - Visual Studio Code", folder)).toBe(true);
    expect(titleShowsFolder("index.ts - Demo - Visual Studio Code", folder)).toBe(true);
    expect(titleShowsFolder("● index.ts - Demo - Visual Studio Code", folder)).toBe(true);
    expect(titleShowsFolder("Demo - Visual Studio Code [Administrator]", folder)).toBe(true);
    expect(titleShowsFolder("한글 - Visual Studio Code", "C:\\작업\\한글\\")).toBe(true);
    // Windows folder names are case-insensitive; a hand-typed path may differ.
    expect(titleShowsFolder("demo - Visual Studio Code", folder)).toBe(true);
  });

  it("does not match another folder, a longer name, or another app", () => {
    expect(titleShowsFolder("Other - Visual Studio Code", folder)).toBe(false);
    expect(titleShowsFolder("Demo2 - Visual Studio Code", folder)).toBe(false);
    expect(titleShowsFolder("Demo - Notepad", folder)).toBe(false);
    expect(titleShowsFolder("Visual Studio Code", folder)).toBe(false);
  });
});
