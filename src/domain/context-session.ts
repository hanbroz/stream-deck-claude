export type ContextSessionSnapshot = {
  schemaVersion: 1;
  actionId: string;
  launchId: string;
  sessionId: string;
  projectDir?: string;
  capturedAt: number;
  context: {
    usedPercentage: number | null;
    totalInputTokens?: number;
    contextWindowSize?: number;
  };
};

export type ActiveCodeLaunch = {
  schemaVersion: 2;
  actionId: string;
  launchId: string;
  folder: string;
  startedAt: number;
  terminal: "windows-terminal" | "powershell";
  processId: number;
};

export type CodeSessionActivity = "idle" | "running" | "waiting" | "ended";

export type ContextSessionRuntime = {
  schemaVersion: 2;
  actionId: string;
  launchId: string;
  activity: CodeSessionActivity;
  capturedAt: number;
};

export type CodeStartDisplayState =
  | { kind: "setup"; activity: CodeSessionActivity }
  | { kind: "idle"; activity: CodeSessionActivity }
  | { kind: "starting"; activity: CodeSessionActivity }
  | { kind: "ready"; percentage: number; activity: CodeSessionActivity }
  | { kind: "closed"; activity: "ended" }
  | { kind: "error"; activity: CodeSessionActivity };

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function extractContextSessionSnapshot(
  statusLinePayload: unknown,
  actionId: string | undefined,
  launchId: string | undefined,
  capturedAt = Date.now()
): ContextSessionSnapshot | undefined {
  if (!actionId || !launchId) {
    return undefined;
  }

  const root = asRecord(statusLinePayload);
  const contextWindow = asRecord(root?.context_window);
  const workspace = asRecord(root?.workspace);
  const sessionId = root?.session_id;
  if (!contextWindow || typeof sessionId !== "string" || sessionId.length === 0) {
    return undefined;
  }

  const rawPercentage = contextWindow.used_percentage;
  if (rawPercentage !== null && (typeof rawPercentage !== "number" || !Number.isFinite(rawPercentage))) {
    return undefined;
  }

  const projectDir = workspace?.project_dir;
  const totalInputTokens = finiteNonNegative(contextWindow.total_input_tokens);
  const contextWindowSize = finiteNonNegative(contextWindow.context_window_size);

  return {
    schemaVersion: 1,
    actionId,
    launchId,
    sessionId,
    ...(typeof projectDir === "string" && projectDir.length > 0 ? { projectDir } : {}),
    capturedAt,
    context: {
      usedPercentage:
        rawPercentage === null ? null : Math.min(100, Math.max(0, rawPercentage)),
      ...(totalInputTokens === undefined ? {} : { totalInputTokens }),
      ...(contextWindowSize === undefined ? {} : { contextWindowSize })
    }
  };
}

export function extractContextSessionRuntime(
  payload: unknown,
  actionId: string | undefined,
  launchId: string | undefined,
  capturedAt = Date.now()
): ContextSessionRuntime | undefined {
  if (!actionId || !launchId) {
    return undefined;
  }

  const root = asRecord(payload);
  if (typeof root?.session_id !== "string" || root.session_id.length === 0) {
    return undefined;
  }

  const hookEventName = root.hook_event_name;
  let activity: CodeSessionActivity;
  if (hookEventName === "SessionStart") {
    activity = "idle";
  } else if (hookEventName === "UserPromptSubmit") {
    activity = "running";
  } else if (hookEventName === "Stop" || hookEventName === "StopFailure") {
    activity = "idle";
  } else if (hookEventName === "Notification") {
    const notificationType = root.notification_type;
    if (
      notificationType === "permission_prompt" ||
      notificationType === "elicitation_dialog" ||
      notificationType === "agent_needs_input"
    ) {
      activity = "waiting";
    } else if (notificationType === "idle_prompt" || notificationType === "agent_completed") {
      activity = "idle";
    } else if (
      notificationType === "elicitation_complete" ||
      notificationType === "elicitation_response"
    ) {
      activity = "running";
    } else {
      return undefined;
    }
  } else if (hookEventName === "SessionEnd") {
    activity = "ended";
  } else {
    return undefined;
  }

  return {
    schemaVersion: 2,
    actionId,
    launchId,
    activity,
    capturedAt
  };
}
