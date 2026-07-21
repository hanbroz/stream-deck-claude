import { spawn, type ChildProcess } from "node:child_process";

export type WindowsTerminalPlan = {
  command: "wt.exe";
  args: string[];
  cwd: string;
};

export function createWindowsTerminalFolderPlan(folder: string): WindowsTerminalPlan {
  return {
    command: "wt.exe",
    args: ["-d", folder],
    cwd: folder
  };
}

export function openWindowsTerminalFolder(folder: string): ChildProcess {
  const plan = createWindowsTerminalFolderPlan(folder);
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    detached: true,
    windowsHide: false,
    stdio: "ignore"
  });
  child.once("spawn", () => child.unref());
  return child;
}

