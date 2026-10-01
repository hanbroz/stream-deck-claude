import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/**
 * Whether VS Code has a window open on a folder, for keys in VS Code mode.
 *
 * VS Code's extension owns that Claude process, so there is no pid or heartbeat
 * of ours to watch — the window title is the only signal. Its default title ends
 * "<root folder name> - Visual Studio Code", which is what this matches.
 *
 * ponytail: matches the folder NAME (case-insensitively, as Windows does), so two
 * open folders with the same name both light the key, as does an open editor
 * whose file is named exactly like the folder, and a custom `window.title` hides
 * the folder entirely. Read the workspace path from VS Code's storage if needed.
 */
export function titleShowsFolder(title: string, folder: string): boolean {
  const segments = title.split(" - ");
  const name = path.win32.basename(folder).toLowerCase();
  return (
    name.length > 0 &&
    segments.length >= 2 &&
    (segments.at(-1) ?? "").startsWith("Visual Studio Code") &&
    segments.slice(0, -1).some((segment) => segment.toLowerCase() === name)
  );
}

// EnumWindows, because every VS Code window belongs to one Code.exe process and
// Get-Process only reports a single MainWindowTitle per process. A plain
// -Command like focusCompanionWindow, not -EncodedCommand: base64 PowerShell
// calling user32 on a timer is exactly what endpoint protection flags.
const WINDOW_TITLES_TYPE = [
  "using System; using System.Collections.Generic; using System.Diagnostics; using System.Runtime.InteropServices; using System.Text;",
  "public static class CodeDeckVsCodeWindows {",
  "delegate bool EnumProc(IntPtr h, IntPtr l);",
  "[DllImport(\"user32.dll\")] static extern bool EnumWindows(EnumProc cb, IntPtr l);",
  "[DllImport(\"user32.dll\")] static extern bool IsWindowVisible(IntPtr h);",
  "[DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);",
  "[DllImport(\"user32.dll\")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);",
  "public static string[] Titles() {",
  "var ids = new HashSet<uint>();",
  "foreach (var p in Process.GetProcessesByName(\"Code\")) { ids.Add((uint)p.Id); p.Dispose(); }",
  "var titles = new List<string>();",
  "EnumWindows((h, l) => { uint pid; if (!IsWindowVisible(h)) return true; GetWindowThreadProcessId(h, out pid); if (!ids.Contains(pid)) return true; var text = new StringBuilder(512); if (GetWindowText(h, text, text.Capacity) > 0) titles.Add(text.ToString()); return true; }, IntPtr.Zero);",
  "return titles.ToArray(); } }"
].join(" ");
const LIST_TITLES_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  `Add-Type -TypeDefinition '${WINDOW_TITLES_TYPE}'`,
  // Writing to a closed pipe throws once the plugin is gone, ending the loop.
  "while ($true) { [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @([CodeDeckVsCodeWindows]::Titles()))); Start-Sleep -Seconds 3 }"
].join("; ");
/** The watcher stops once no key has asked for this long. */
const IDLE_STOP_MS = 10_000;
/** A watcher silent this long is wedged; it is killed so a fresh one can start. */
const SILENT_KILL_MS = 15_000;
/** A watcher that died is not restarted sooner than this, so a broken one cannot respawn every refresh. */
const RESTART_BACKOFF_MS = 30_000;
/** A just-pressed folder reads as open this long, covering the first listing and a cold start. */
const OPENED_GRACE_MS = 15_000;

let watcher: ChildProcess | undefined;
let titles: string[] = [];
let lastAskedAt = 0;
let lastStartedAt = Number.NEGATIVE_INFINITY;
let lastHeardAt = 0;
const openedAt = new Map<string, number>();

function folderKey(folder: string): string {
  return path.win32.resolve(folder).toLowerCase();
}

function startWatcher(now: number): void {
  // One process for every key: compiling the Add-Type above costs about a second
  // of CPU, too much to repeat on the 500ms key refresh.
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", LIST_TITLES_SCRIPT],
    { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
  );
  watcher = child;
  lastStartedAt = now;
  lastHeardAt = now;
  let buffered = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    lastHeardAt = Date.now();
    buffered += chunk;
    const lines = buffered.split(/\r?\n/u);
    buffered = lines.pop() ?? "";
    const latest = lines.at(-1);
    if (latest) {
      try {
        const parsed: unknown = JSON.parse(latest);
        titles = Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
      } catch {
        // A torn line; the next one arrives in 3s.
      }
    }
    if (Date.now() - lastAskedAt > IDLE_STOP_MS && watcher === child) {
      stopWatcher();
      // Stopped for being idle, not for failing: the next key may start one at once.
      lastStartedAt = Number.NEGATIVE_INFINITY;
    }
  });
  const forget = (): void => {
    if (watcher === child) {
      watcher = undefined;
      titles = [];
    }
  };
  // `on`, not `once`: a second error event with no listener would crash the plugin.
  child.on("error", forget);
  child.once("exit", forget);
}

function stopWatcher(): void {
  const child = watcher;
  watcher = undefined;
  titles = [];
  child?.kill();
}

/** Called right after a VS Code launch, so the key does not drop to closed before the first listing. */
export function noteVsCodeOpened(folder: string): void {
  openedAt.set(folderKey(folder), Date.now());
}

/**
 * The answer as of the last listing (at most ~3s old). The first call after a
 * quiet spell starts the watcher and answers false until its first listing.
 */
export function vsCodeHasFolderOpen(folder: string): boolean {
  const now = Date.now();
  lastAskedAt = now;
  if (watcher && now - lastHeardAt > SILENT_KILL_MS) {
    stopWatcher();
  }
  if (!watcher && now - lastStartedAt >= RESTART_BACKOFF_MS) {
    startWatcher(now);
  }
  const pressedAt = openedAt.get(folderKey(folder));
  if (pressedAt !== undefined && now - pressedAt < OPENED_GRACE_MS) {
    return true;
  }
  return titles.some((title) => titleShowsFolder(title, folder));
}
