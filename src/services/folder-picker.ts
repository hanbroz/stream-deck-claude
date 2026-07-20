import { spawn } from "node:child_process";

const PICKER_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select the folder for Claude Code'
$dialog.ShowNewFolderButton = $true
if ($env:CLAUDE_STREAM_DECK_INITIAL_FOLDER -and (Test-Path -LiteralPath $env:CLAUDE_STREAM_DECK_INITIAL_FOLDER -PathType Container)) {
  $dialog.SelectedPath = $env:CLAUDE_STREAM_DECK_INITIAL_FOLDER
}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::Out.Write($dialog.SelectedPath)
}
`;

export async function showFolderPicker(initialFolder?: string): Promise<string | undefined> {
  return await new Promise<string | undefined>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", PICKER_SCRIPT],
      {
        windowsHide: false,
        env: {
          ...process.env,
          CLAUDE_STREAM_DECK_INITIAL_FOLDER: initialFolder ?? ""
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Folder picker failed (${code ?? "unknown"}): ${Buffer.concat(stderr).toString("utf8").trim()}`
          )
        );
        return;
      }
      const selected = Buffer.concat(stdout).toString("utf8").trim();
      resolve(selected || undefined);
    });
  });
}
