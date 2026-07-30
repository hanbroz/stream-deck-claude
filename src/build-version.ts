import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Identify the running plugin build in its first log line.
 *
 * A rebuilt bundle only takes effect once Stream Deck restarts the plugin, and
 * nothing in the log used to say which build was live — so a plugin still
 * running yesterday's code looked identical to a freshly restarted one. The
 * bundle's own mtime is its build time and the manifest sits beside it, so no
 * build step has to inject anything.
 *
 * Mirrors the `ver. yyyy.MM.dd.HH.mm` shape the Companion shows in its title bar
 * (companion/shared/build-version.ts), minus the `ver. ` prefix.
 */
export function formatBuildStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    String(date.getFullYear()),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes())
  ].join(".");
}

/**
 * `0.7.1.0 (build 2026.07.30.17.36)` for the bundle at `bundlePath`, whose
 * manifest is expected one directory up (the bundle lives in `bin/`).
 */
export function pluginBuildLabel(bundlePath: string): string {
  let version = "unknown";
  try {
    const manifestPath = path.join(path.dirname(bundlePath), "..", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { Version?: unknown };
    if (typeof manifest.Version === "string" && manifest.Version.length > 0) {
      version = manifest.Version;
    }
  } catch {
    // An unreadable manifest must never stop the plugin from starting.
  }

  try {
    return `${version} (build ${formatBuildStamp(statSync(bundlePath).mtime)})`;
  } catch {
    return `${version} (build unknown)`;
  }
}
