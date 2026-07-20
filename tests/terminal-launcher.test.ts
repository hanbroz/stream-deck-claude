import { describe, expect, it } from "vitest";

import { createTerminalLaunchPlan } from "../src/services/terminal-launcher";

describe("createTerminalLaunchPlan", () => {
  it("uses Windows Terminal with the folder as cwd and a separate argument", () => {
    const plan = createTerminalLaunchPlan(
      "D:\\Projects\\Folder & Name",
      "action-1",
      "launch-1",
      true
    );

    expect(plan.command).toBe("wt.exe");
    expect(plan.cwd).toBe("D:\\Projects\\Folder & Name");
    expect(plan.args).toEqual([
      "-d",
      "D:\\Projects\\Folder & Name",
      "powershell.exe",
      "-NoExit",
      "-Command",
      "$PID | Set-Content -LiteralPath $env:CLAUDE_STREAM_DECK_PID_FILE -NoNewline; & $env:CLAUDE_STREAM_DECK_CLAUDE_PATH --dangerously-skip-permissions"
    ]);
    expect(plan.env.CLAUDE_STREAM_DECK_BINDING_ID).toBe("action-1");
    expect(plan.env.CLAUDE_STREAM_DECK_ACTION_ID).toBe("action-1");
    expect(plan.env.CLAUDE_STREAM_DECK_LAUNCH_ID).toBe("launch-1");
    expect(plan.env.CLAUDE_STREAM_DECK_CLAUDE_PATH).toBe("claude.exe");
    expect(plan.env.CLAUDE_STREAM_DECK_PID_FILE).toMatch(/\.pid$/u);
  });

  it("uses cmd start to create a separate visible PowerShell window and report its PID", () => {
    const plan = createTerminalLaunchPlan("D:\\Projects\\Demo", "action", "launch", false);

    expect(plan.command).toBe("cmd.exe");
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(plan.args[3]).toContain('start "Claude Code" powershell.exe');
    expect(plan.args[3]).toContain("CLAUDE_STREAM_DECK_PID_FILE");
    expect(plan.args[3]).toContain("--dangerously-skip-permissions");
    expect(plan.cwd).toBe("D:\\Projects\\Demo");
    expect(plan.env.CLAUDE_STREAM_DECK_FOLDER).toBe("D:\\Projects\\Demo");
    expect(plan.env.CLAUDE_STREAM_DECK_BINDING_ID).toBe("action");
    expect(plan.env.CLAUDE_STREAM_DECK_PID_FILE).toMatch(/\.pid$/u);
  });
});
