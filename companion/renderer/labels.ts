export type HeaderContextStatus = {
  contextPercentage?: number | null;
  context?: { usedPercentage?: number | null } | number | null;
};

export function projectNameFromPath(sourcePath: string): string {
  const normalized = sourcePath.replace(/[\\/]+$/, "");
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return (slash >= 0 ? normalized.slice(slash + 1) : normalized) || "project";
}

export function formatModelName(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    return "Claude Code";
  }
  return normalized.replace(/\s*\([^)]*context[^)]*\)\s*$/iu, "").trim() || normalized;
}

export function formatHeaderContext(status: HeaderContextStatus): string {
  const raw = typeof status.context === "number"
    ? status.context
    : status.context?.usedPercentage ?? status.contextPercentage;
  return typeof raw === "number" ? `CTX ${Math.round(Math.max(0, Math.min(100, raw)))}%` : "CTX --";
}
