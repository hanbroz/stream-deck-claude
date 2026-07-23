/**
 * Build stamp injected by scripts/build-companion.mjs via esbuild `define`.
 * It makes the running build identifiable from the window title, so a stale
 * Companion binary can be spotted without inspecting the process tree.
 */
declare const __COMPANION_BUILD_VERSION__: string;

export const UNKNOWN_BUILD_VERSION = "ver. dev";

export function companionBuildVersion(): string {
  return typeof __COMPANION_BUILD_VERSION__ === "string"
    ? __COMPANION_BUILD_VERSION__
    : UNKNOWN_BUILD_VERSION;
}

/** Format a build time as `ver. yyyy.MM.dd.HH.mm` in the builder's local zone. */
export function formatBuildVersion(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    `ver. ${date.getFullYear()}`,
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes())
  ].join(".");
}
