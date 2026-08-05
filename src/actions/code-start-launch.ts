import { randomUUID } from "node:crypto";

import type { ensureBridgeInstalled } from "../bridge/installer";
import { defaultClaudeSettingsPath, defaultUsageDataDir } from "../bridge/paths";
import type {
  claudeConversationExists,
  clearContextSessionResumePointer,
  findRunningCompanionLaunch,
  readContextSessionResumePointer,
  writeActiveLaunch
} from "../io/context-session-cache";
import type {
  focusCompanionWindow,
  launchClaudeCompanion
} from "../services/companion-launcher";
import type { showErrorDialog } from "../services/error-dialog";
import type {
  launchClaudeTerminal,
  validateLaunchFolder
} from "../services/terminal-launcher";
import type { renderCodeStartKeyImage } from "../ui/code-start-renderer";
import type { CodeStartLaunchGuard } from "./code-start-launch-guard";
import { describeLaunchFailure } from "./launch-failure-message";

/**
 * Where a press opens Claude Code. "companion" is the assumed value when the
 * setting is absent, so keys configured before this choice existed keep the
 * behaviour they were set up with.
 */
export type CodeStartLaunchMode = "companion" | "terminal";

export const DEFAULT_LAUNCH_MODE: CodeStartLaunchMode = "companion";

export type CodeStartLaunchSettings = {
  bindingId?: string;
  folder?: string;
  projectName?: string;
  launchMode?: string;
};

type CodeStartLaunchAction = {
  setImage(image: string): Promise<void>;
  showAlert(): Promise<void>;
  showOk(): Promise<void>;
};

type CodeStartLaunchLogger = {
  info(message: string): void;
  error(message: string, error: unknown): void;
};

export type CodeStartLaunchDependencies = {
  defaultClaudeSettingsPath: typeof defaultClaudeSettingsPath;
  defaultUsageDataDir: typeof defaultUsageDataDir;
  ensureBridgeInstalled: typeof ensureBridgeInstalled;
  launchClaudeCompanion: typeof launchClaudeCompanion;
  launchClaudeTerminal: typeof launchClaudeTerminal;
  findRunningCompanionLaunch: typeof findRunningCompanionLaunch;
  focusCompanionWindow: typeof focusCompanionWindow;
  claudeConversationExists: typeof claudeConversationExists;
  clearContextSessionResumePointer: typeof clearContextSessionResumePointer;
  readContextSessionResumePointer: typeof readContextSessionResumePointer;
  renderCodeStartKeyImage: typeof renderCodeStartKeyImage;
  showErrorDialog: typeof showErrorDialog;
  validateLaunchFolder: typeof validateLaunchFolder;
  writeActiveLaunch: typeof writeActiveLaunch;
  /** Where the failure dialog points the user for the full stack trace. */
  pluginLogDirectory: string;
  createLaunchId: () => string;
  now: () => number;
  logger: CodeStartLaunchLogger;
};

export type CodeStartLaunchOptions = {
  action: CodeStartLaunchAction;
  settings: CodeStartLaunchSettings;
  launchGuard: CodeStartLaunchGuard;
  bridgeSourcePath: string;
  dependencies: CodeStartLaunchDependencies;
};

export function configuredFolder(settings: CodeStartLaunchSettings): string | undefined {
  return typeof settings.folder === "string" && settings.folder.trim().length > 0
    ? settings.folder.trim()
    : undefined;
}

export function configuredProjectName(settings: CodeStartLaunchSettings): string {
  return typeof settings.projectName === "string" && settings.projectName.trim().length > 0
    ? settings.projectName.trim()
    : "PROJECT";
}

/**
 * Only an explicit "terminal" switches away from the app. Anything else — the
 * setting missing on a key from before this option, or a value a hand-edited
 * profile got wrong — stays on the Companion, which is the mode with the fuller
 * feature set.
 */
export function configuredLaunchMode(settings: CodeStartLaunchSettings): CodeStartLaunchMode {
  return settings.launchMode === "terminal" ? "terminal" : DEFAULT_LAUNCH_MODE;
}

export function configuredBindingId(settings: CodeStartLaunchSettings): string | undefined {
  return typeof settings.bindingId === "string" && settings.bindingId.trim().length > 0
    ? settings.bindingId.trim()
    : undefined;
}

export function defaultCodeStartLaunchDependencies(
  overrides: Pick<
    CodeStartLaunchDependencies,
    "ensureBridgeInstalled" | "launchClaudeCompanion" | "launchClaudeTerminal" |
      "findRunningCompanionLaunch" |
      "focusCompanionWindow" | "claudeConversationExists" |
      "clearContextSessionResumePointer" | "readContextSessionResumePointer" |
      "renderCodeStartKeyImage" | "showErrorDialog" | "validateLaunchFolder" |
      "writeActiveLaunch" | "pluginLogDirectory" | "logger"
  >
): CodeStartLaunchDependencies {
  return {
    defaultClaudeSettingsPath,
    defaultUsageDataDir,
    createLaunchId: randomUUID,
    now: Date.now,
    ...overrides
  };
}

export async function launchConfiguredCodeStart(options: CodeStartLaunchOptions): Promise<void> {
  const {
    action,
    settings,
    launchGuard,
    bridgeSourcePath,
    dependencies
  } = options;
  const bindingId = configuredBindingId(settings);
  const folder = configuredFolder(settings);
  const projectName = configuredProjectName(settings);
  const launchMode = configuredLaunchMode(settings);
  if (!bindingId) {
    await action.showAlert();
    return;
  }
  if (!folder) {
    await action.setImage(
      dependencies.renderCodeStartKeyImage(projectName, { kind: "setup", activity: "idle" })
    );
    await action.showAlert();
    return;
  }

  if (!launchGuard.begin(bindingId)) {
    await action.setImage(
      dependencies.renderCodeStartKeyImage(projectName, { kind: "starting", activity: "running" })
    );
    return;
  }

  try {
    // Companion only: focusing is a window operation on the app's own process.
    // Skipped in terminal mode so a key switched to terminal cannot focus a
    // Companion left over from the previous mode instead of opening a terminal.
    if (launchMode === "companion") {
      // A second press for the same folder focuses the app that is already
      // open instead of spawning a twin, which would also rotate the launch id
      // and orphan the key's snapshot stream.
      const running = await dependencies.findRunningCompanionLaunch(
        dependencies.defaultUsageDataDir(),
        bindingId,
        folder
      );
      if (running) {
        const focused = await dependencies.focusCompanionWindow(running.processId);
        if (focused) {
          dependencies.logger.info(
            `Code Start already running for this folder (pid=${running.processId}); focused existing window.`
          );
          await action.showOk();
          return;
        }
        // The recorded pid exists but is not a focusable Companion (Windows
        // reused the pid, or the window is gone). Treat the record as stale
        // and fall through to a normal launch — this also rewrites
        // active.json with the real new pid, correcting the key state.
        dependencies.logger.info(
          `Stale active launch for this folder (pid=${running.processId} not a Companion window); launching fresh.`
        );
      }
    }

    await action.setImage(
      dependencies.renderCodeStartKeyImage(projectName, { kind: "starting", activity: "running" })
    );
    await dependencies.validateLaunchFolder(folder);
    await dependencies.ensureBridgeInstalled({
      settingsPath: dependencies.defaultClaudeSettingsPath(),
      dataDir: dependencies.defaultUsageDataDir(),
      bridgeSourcePath
    });

    const launchId = dependencies.createLaunchId();
    const resumePointer = await dependencies.readContextSessionResumePointer(
      dependencies.defaultUsageDataDir(),
      bindingId,
      folder
    );
    let resumeSessionId: string | undefined;
    if (resumePointer) {
      if (await dependencies.claudeConversationExists(folder, resumePointer.sessionId)) {
        resumeSessionId = resumePointer.sessionId;
      } else {
        await dependencies.clearContextSessionResumePointer(
          dependencies.defaultUsageDataDir(),
          bindingId,
          folder
        );
        dependencies.logger.info(
          "Ignored a stale Code Start resume pointer because its Claude conversation is absent."
        );
      }
    }
    // The terminal runs the CLI directly, so it has no way to be handed a
    // conversation to continue — a press there always starts a new one. The
    // resume pointer above is still read and pruned so switching back to the
    // app does not resume a conversation that has since been deleted.
    const launch = launchMode === "terminal"
      ? await dependencies.launchClaudeTerminal(folder, bindingId, launchId)
      : await dependencies.launchClaudeCompanion(
        folder,
        bindingId,
        launchId,
        resumeSessionId,
        projectName
      );
    await dependencies.writeActiveLaunch(dependencies.defaultUsageDataDir(), {
      schemaVersion: 2,
      actionId: bindingId,
      launchId,
      folder,
      startedAt: dependencies.now(),
      terminal: launch.terminal,
      processId: launch.processId
    });
    dependencies.logger.info(
      `Code Start launched using ${launch.terminal}, pid=${launch.processId}.`
    );
    await action.setImage(
      dependencies.renderCodeStartKeyImage(projectName, { kind: "starting", activity: "running" })
    );
    await action.showOk();
  } catch (error) {
    dependencies.logger.error("Code Start launch failed.", error);
    await action.setImage(
      dependencies.renderCodeStartKeyImage(projectName, { kind: "error", activity: "idle" })
    );
    await action.showAlert();
    // Awaited here, before `finally` releases the guard, so pressing the key
    // again while the dialog is open cannot stack a second copy of it.
    await dependencies.showErrorDialog(
      describeLaunchFailure(error, folder, dependencies.pluginLogDirectory)
    );
  } finally {
    launchGuard.end(bindingId);
  }
}
