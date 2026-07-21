import { describe, expect, it } from "vitest";

import { createWindowsTerminalFolderPlan } from "../main/windows-terminal";

describe("createWindowsTerminalFolderPlan", () => {
  it("uses wt.exe -d with the folder as a separate argument", () => {
    expect(createWindowsTerminalFolderPlan("D:\\Projects\\A & B")).toEqual({
      command: "wt.exe",
      args: ["-d", "D:\\Projects\\A & B"],
      cwd: "D:\\Projects\\A & B"
    });
  });
});

