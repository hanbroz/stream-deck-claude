import type { ClaudePhase } from "../shared/claude-stream";

export type ClaudeStatusLabel = {
  text: string;
  detail: string;
  busy: boolean;
};

const READY_TEXT = "메시지를 입력하세요";

const PHASE_LABELS: Record<ClaudePhase, { text: string; busy: boolean }> = {
  booting: { text: READY_TEXT, busy: true },
  ready: { text: READY_TEXT, busy: false },
  requesting: { text: "요청 중…", busy: true },
  thinking: { text: "생각 중…", busy: true },
  responding: { text: "응답 작성 중…", busy: true },
  tool: { text: "작업 진행 중", busy: true },
  waiting: { text: READY_TEXT, busy: false }
};

/**
 * Turn a stream phase into the one-line status shown above the Console. The
 * detail carries hook progress or the running tool so a multi-second wait shows
 * what is actually happening.
 *
 * Startup never blocks input: Claude buffers stdin from the moment it spawns,
 * and `system/init` only arrives once the first message is sent. One
 * SessionStart hook is also asynchronous (asyncTimeout 180s), so the hook count
 * legitimately never balances. Booting therefore invites input and reports hook
 * progress as secondary detail rather than telling the user to wait.
 */
export function formatClaudePhase(phase: ClaudePhase, detail?: string): ClaudeStatusLabel {
  const label = PHASE_LABELS[phase];
  if (phase === "booting") {
    return { text: READY_TEXT, detail: detail ? `준비 중 ${detail}` : "준비 중", busy: true };
  }
  return { text: label.text, detail: detail ?? "", busy: label.busy };
}

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

/** The context usage as a 0-100 number, or null when it is not known yet. */
export function contextPercentValue(status: HeaderContextStatus): number | null {
  const raw = typeof status.context === "number"
    ? status.context
    : status.context?.usedPercentage ?? status.contextPercentage;
  return typeof raw === "number" ? Math.round(Math.max(0, Math.min(100, raw))) : null;
}
