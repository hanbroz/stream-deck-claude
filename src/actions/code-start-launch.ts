import { randomUUID } from "node:crypto";

import type { ensureBridgeInstalled } from "../bridge/installer";
import { defaultClaudeSettingsPath, defaultUsageDataDir } from "../bridge/paths";
import type {
  readContextSessionResumePointer,
  writeActiveLaunch
} from "../io/context-session-cache";
import type {
  launchClaudeCompanion
} from "../services/companion-launcher";
import type {
  validateLaunchFolder
} from "../services/terminal-launcher";
import type { renderCodeStartKeyImage } from "../ui/code-start-renderer";
import type { CodeStartLaunchGuard } from "./code-start-launch-guard";

export type CodeStartLaunchSettings = {
  bindingId?: string;
  folder?: string;
  projectName?: string;
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
  readContextSessionResumePointer: typeof readContextSessionResumePointer;
  renderCodeStartKeyImage: typeof renderCodeStartKeyImage;
  validateLaunchFolder: typeof validateLaunchFolder;
  writeActiveLaunch: typeof writeActiveLaunch;
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

export function configuredBindingId(settings: CodeStartLaunchSettings): string | undefined {
  return typeof settings.bindingId === "string" && settings.bindingId.trim().length > 0
    ? settings.bindingId.trim()
    : undefined;
}

export function defaultCodeStartLaunchDependencies(
  overrides: Pick<
    CodeStartLaunchDependencies,
    "ensureBridgeInstalled" | "launchClaudeCompanion" | "readContextSessionResumePointer" |
      "renderCodeStartKeyImage" | "validateLaunchFolder" | "writeActiveLaunch" | "logger"
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
    const launch = await dependencies.launchClaudeCompanion(
      folder,
      bindingId,
      launchId,
      resumePointer?.sessionId
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
  } finally {
    launchGuard.end(bindingId);
  }
}
