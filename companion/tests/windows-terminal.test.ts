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

describe("createWindowsTerminalFolderPlan with a command", () => {
  it("hands the command to powershell as argv instead of typed input", () => {
    expect(createWindowsTerminalFolderPlan("D:\\Projects\\A & B", "claude auth login")).toEqual({
      command: "wt.exe",
      args: [
        "-d",
        "D:\\Projects\\A & B",
        "powershell.exe",
        "-NoLogo",
        "-NoExit",
        "-Command",
        "claude auth login"
      ],
      cwd: "D:\\Projects\\A & B"
    });
  });
});
