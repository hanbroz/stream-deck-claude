import { spawn } from "node:child_process";

/**
 * A MessageBox with no owner opens behind whatever has focus — usually the
 * Stream Deck window the user just pressed a key on, where they would never see
 * it. Parenting it to a TopMost form is what puts it in front.
 *
 * The text arrives through the environment rather than the script body so a
 * project path containing quotes, backslashes or Korean characters cannot break
 * PowerShell quoting. This mirrors how folder-picker.ts passes its start folder.
 */
const DIALOG_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
[System.Windows.Forms.MessageBox]::Show(
  $owner,
  $env:CLAUDE_STREAM_DECK_DIALOG_TEXT,
  'Code Start',
  [System.Windows.Forms.MessageBoxButtons]::OK,
  [System.Windows.Forms.MessageBoxIcon]::Error
) | Out-Null
$owner.Dispose()
`;

/**
 * Show a modal Windows dialog and resolve once the user dismisses it. Callers
 * await this to keep their own failure handling open for as long as the message
 * is on screen.
 */
export async function showErrorDialog(message: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", DIALOG_SCRIPT],
      {
        windowsHide: false,
        env: {
          ...process.env,
          CLAUDE_STREAM_DECK_DIALOG_TEXT: message
        },
        stdio: "ignore"
      }
    );
    // This dialog *is* the failure report. Rejecting when it cannot be shown
    // would replace the launch error the caller is reporting with a second,
    // less useful one, so every outcome resolves and the log keeps the truth.
    child.once("error", () => resolve());
    child.once("close", () => resolve());
  });
}
