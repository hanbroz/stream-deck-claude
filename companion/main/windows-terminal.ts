import { spawn, type ChildProcess } from "node:child_process";

export type WindowsTerminalPlan = {
  command: "wt.exe";
  args: string[];
  cwd: string;
};

/**
 * `wt.exe` arguments for a folder, optionally running one command inside it.
 *
 * The command travels as argv, never as keystrokes typed after the shell opens.
 * Typing races the shell's startup — the pty resolves when PowerShell is spawned,
 * not when it starts reading stdin, so an immediately written line is swallowed —
 * and argv has no such window. `-NoExit` leaves the outcome on screen afterwards.
 */
export function createWindowsTerminalFolderPlan(
  folder: string,
  command?: string
): WindowsTerminalPlan {
  return {
    command: "wt.exe",
    args: command === undefined
      ? ["-d", folder]
      : ["-d", folder, "powershell.exe", "-NoLogo", "-NoExit", "-Command", command],
    cwd: folder
  };
}

export function openWindowsTerminalFolder(folder: string, command?: string): ChildProcess {
  const plan = createWindowsTerminalFolderPlan(folder, command);
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    detached: true,
    windowsHide: false,
    stdio: "ignore"
  });
  child.once("spawn", () => child.unref());
  return child;
}

