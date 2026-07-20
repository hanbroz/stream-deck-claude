import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { JsonObject, JsonValue } from "@elgato/utils";
import {
  action,
  DidReceiveSettingsEvent,
  KeyAction,
  KeyDownEvent,
  SendToPluginEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
  streamDeck
} from "@elgato/streamdeck";

import { ensureBridgeInstalled } from "../bridge/installer";
import { defaultClaudeSettingsPath, defaultUsageDataDir } from "../bridge/paths";
import {
  findReconnectableBindingId,
  loadCodeStartDisplayState,
  writeActiveLaunch
} from "../io/context-session-cache";
import { showFolderPicker } from "../services/folder-picker";
import { launchClaudeTerminal, validateLaunchFolder } from "../services/terminal-launcher";
import { renderCodeStartKeyImage } from "../ui/code-start-renderer";

const REFRESH_INTERVAL_MS = 1_000;
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeSourcePath = path.join(pluginRoot, "bridge", "statusline-bridge.js");

type CodeStartSettings = JsonObject & {
  bindingId?: string;
  folder?: string;
  projectName?: string;
};

type PropertyInspectorMessage = JsonObject & {
  event?: JsonValue;
  projectName?: JsonValue;
};

function configuredFolder(settings: CodeStartSettings): string | undefined {
  return typeof settings.folder === "string" && settings.folder.trim().length > 0
    ? settings.folder.trim()
    : undefined;
}

function configuredProjectName(settings: CodeStartSettings): string {
  return typeof settings.projectName === "string" && settings.projectName.trim().length > 0
    ? settings.projectName.trim()
    : "PROJECT";
}

function configuredBindingId(settings: CodeStartSettings): string | undefined {
  return typeof settings.bindingId === "string" && settings.bindingId.trim().length > 0
    ? settings.bindingId.trim()
    : undefined;
}

@action({ UUID: "com.hanbroz.claude-usage.code-start" })
export class CodeStartAction extends SingletonAction<CodeStartSettings> {
  private readonly visibleActions = new Map<string, KeyAction<CodeStartSettings>>();
  private readonly bindingIdsByAction = new Map<string, string>();
  private bindingInitialization: Promise<void> = Promise.resolve();
  private refreshTimer?: NodeJS.Timeout;

  override async onWillAppear(ev: WillAppearEvent<CodeStartSettings>): Promise<void> {
    if (!ev.action.isKey()) {
      return;
    }
    this.visibleActions.set(ev.action.id, ev.action);
    this.ensureRefreshTimer();
    const settings = await this.ensureBindingId(ev.action, ev.payload.settings);
    await this.refreshAction(ev.action, settings);
  }

  override onWillDisappear(ev: WillDisappearEvent<CodeStartSettings>): void {
    this.visibleActions.delete(ev.action.id);
    this.bindingIdsByAction.delete(ev.action.id);
    if (this.visibleActions.size === 0 && this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<CodeStartSettings>
  ): Promise<void> {
    if (ev.action.isKey()) {
      const settings = await this.ensureBindingId(ev.action, ev.payload.settings);
      await this.refreshAction(ev.action, settings);
    }
  }

  override async onKeyDown(ev: KeyDownEvent<CodeStartSettings>): Promise<void> {
    const settings = await this.ensureBindingId(ev.action, ev.payload.settings);
    const bindingId = configuredBindingId(settings);
    const folder = configuredFolder(settings);
    const projectName = configuredProjectName(settings);
    if (!bindingId) {
      await ev.action.showAlert();
      return;
    }
    if (!folder) {
      await ev.action.setImage(
        renderCodeStartKeyImage(projectName, { kind: "setup", activity: "idle" })
      );
      await ev.action.showAlert();
      return;
    }

    await ev.action.setImage(
      renderCodeStartKeyImage(projectName, { kind: "starting", activity: "running" })
    );
    try {
      await validateLaunchFolder(folder);
      await ensureBridgeInstalled({
        settingsPath: defaultClaudeSettingsPath(),
        dataDir: defaultUsageDataDir(),
        bridgeSourcePath
      });

      const launchId = randomUUID();
      const launch = await launchClaudeTerminal(folder, bindingId, launchId);
      await writeActiveLaunch(defaultUsageDataDir(), {
        schemaVersion: 2,
        actionId: bindingId,
        launchId,
        folder,
        startedAt: Date.now(),
        terminal: launch.terminal,
        processId: launch.processId
      });
      streamDeck.logger.info(
        `Code Start launched using ${launch.terminal}, pid=${launch.processId}.`
      );
      await ev.action.setImage(
        renderCodeStartKeyImage(projectName, { kind: "starting", activity: "running" })
      );
      await ev.action.showOk();
    } catch (error) {
      streamDeck.logger.error("Code Start launch failed.", error);
      await ev.action.setImage(
        renderCodeStartKeyImage(projectName, { kind: "error", activity: "idle" })
      );
      await ev.action.showAlert();
    }
  }

  override async onSendToPlugin(
    ev: SendToPluginEvent<JsonValue, CodeStartSettings>
  ): Promise<void> {
    const payload = ev.payload as PropertyInspectorMessage;
    if (payload.event !== "browseFolder") {
      return;
    }

    try {
      const current = await ev.action.getSettings<CodeStartSettings>();
      const folder = await showFolderPicker(configuredFolder(current));
      if (!folder) {
        return;
      }
      const projectName =
        typeof payload.projectName === "string"
          ? payload.projectName.trim()
          : typeof current.projectName === "string"
            ? current.projectName
            : "";
      const settings: CodeStartSettings = { ...current, projectName, folder };
      await ev.action.setSettings(settings);
      await streamDeck.ui.sendToPropertyInspector({ folder, projectName });
    } catch (error) {
      streamDeck.logger.error("Code Start folder picker failed.", error);
      await ev.action.showAlert();
      await streamDeck.ui.sendToPropertyInspector({ error: "Folder selection failed." });
    }
  }

  private ensureRefreshTimer(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setInterval(() => void this.refreshAll(), REFRESH_INTERVAL_MS);
    this.refreshTimer.unref();
  }

  private async ensureBindingId(
    actionInstance: KeyAction<CodeStartSettings>,
    settings: CodeStartSettings
  ): Promise<CodeStartSettings> {
    const persistedBindingId = configuredBindingId(settings);
    if (persistedBindingId) {
      this.bindingIdsByAction.set(actionInstance.id, persistedBindingId);
      return settings;
    }

    const knownBindingId = this.bindingIdsByAction.get(actionInstance.id);
    if (knownBindingId) {
      const repairedSettings: CodeStartSettings = { ...settings, bindingId: knownBindingId };
      await actionInstance.setSettings(repairedSettings);
      return repairedSettings;
    }

    const initialization = this.bindingInitialization.then(async () => {
      const latestSettings = await actionInstance.getSettings<CodeStartSettings>();
      const latestBindingId =
        configuredBindingId(latestSettings) ?? this.bindingIdsByAction.get(actionInstance.id);
      if (latestBindingId) {
        this.bindingIdsByAction.set(actionInstance.id, latestBindingId);
        return { ...latestSettings, bindingId: latestBindingId };
      }

      const folder = configuredFolder(latestSettings);
      const unavailableBindingIds = new Set(this.bindingIdsByAction.values());
      const reconnectedBindingId = folder
        ? await findReconnectableBindingId(
            defaultUsageDataDir(),
            folder,
            unavailableBindingIds
          )
        : undefined;
      const bindingId = reconnectedBindingId ?? randomUUID();
      const nextSettings: CodeStartSettings = { ...latestSettings, bindingId };
      this.bindingIdsByAction.set(actionInstance.id, bindingId);
      try {
        await actionInstance.setSettings(nextSettings);
      } catch (error) {
        if (this.bindingIdsByAction.get(actionInstance.id) === bindingId) {
          this.bindingIdsByAction.delete(actionInstance.id);
        }
        throw error;
      }
      if (reconnectedBindingId) {
        streamDeck.logger.info("Code Start reconnected a moved action to its running session.");
      }
      return nextSettings;
    });
    this.bindingInitialization = initialization.then(
      () => undefined,
      () => undefined
    );
    return await initialization;
  }

  private async refreshAll(): Promise<void> {
    await Promise.all(
      [...this.visibleActions.values()].map(async (actionInstance) => {
        const settings = await this.ensureBindingId(
          actionInstance,
          await actionInstance.getSettings<CodeStartSettings>()
        );
        await this.refreshAction(actionInstance, settings);
      })
    );
  }

  private async refreshAction(
    actionInstance: KeyAction<CodeStartSettings>,
    settings: CodeStartSettings
  ): Promise<void> {
    const folder = configuredFolder(settings);
    const bindingId = configuredBindingId(settings);
    const projectName = configuredProjectName(settings);
    if (!folder || !bindingId) {
      await actionInstance.setImage(
        renderCodeStartKeyImage(projectName, { kind: "setup", activity: "idle" })
      );
      return;
    }
    const state = await loadCodeStartDisplayState(
      defaultUsageDataDir(),
      bindingId,
      folder
    );
    await actionInstance.setImage(renderCodeStartKeyImage(projectName, state));
  }
}
