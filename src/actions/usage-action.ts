import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  KeyDownEvent,
  KeyAction,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
  streamDeck
} from "@elgato/streamdeck";

import { ensureBridgeInstalled, isBridgeInstalled } from "../bridge/installer";
import { defaultClaudeSettingsPath, defaultUsageDataDir } from "../bridge/paths";
import type { RateLimitKind } from "../domain/rate-limits";
import { loadUsageDisplayState } from "../services/display-loader";
import { renderUsageKeyImage } from "../ui/key-renderer";

const REFRESH_INTERVAL_MS = 30_000;
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeSourcePath = path.join(pluginRoot, "bridge", "statusline-bridge.js");

export abstract class UsageAction extends SingletonAction {
  private readonly visibleActions = new Map<string, KeyAction>();
  private refreshTimer?: NodeJS.Timeout;

  protected constructor(private readonly kind: RateLimitKind) {
    super();
  }

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!ev.action.isKey()) {
      return;
    }
    this.visibleActions.set(ev.action.id, ev.action);
    this.ensureRefreshTimer();
    streamDeck.logger.info(`Usage action appeared: ${this.kind}.`);
    try {
      await this.refreshAction(ev.action);
    } catch (error) {
      streamDeck.logger.error(`Initial usage refresh failed: ${this.kind}.`, error);
      await ev.action.setImage(renderUsageKeyImage(this.kind, { kind: "error" }));
    }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.visibleActions.delete(ev.action.id);
    if (this.visibleActions.size === 0 && this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    try {
      streamDeck.logger.info(`Usage action pressed: ${this.kind}.`);
      const settingsPath = defaultClaudeSettingsPath();
      const dataDir = defaultUsageDataDir();
      await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });
      await this.refreshAll();
      await ev.action.showOk();
    } catch (error) {
      streamDeck.logger.error(`Usage action press failed: ${this.kind}.`, error);
      await ev.action.setImage(renderUsageKeyImage(this.kind, { kind: "error" }));
      await ev.action.showAlert();
    }
  }

  private ensureRefreshTimer(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = setInterval(() => {
      void this.refreshAll();
    }, REFRESH_INTERVAL_MS);
    this.refreshTimer.unref();
  }

  private async refreshAll(): Promise<void> {
    await Promise.all([...this.visibleActions.values()].map((action) => this.refreshAction(action)));
  }

  private async refreshAction(action: KeyAction): Promise<void> {
    const settingsPath = defaultClaudeSettingsPath();
    const dataDir = defaultUsageDataDir();
    const state = await loadUsageDisplayState(this.kind, {
      cachePath: path.join(dataDir, "usage.json"),
      bridgeInstalled: await isBridgeInstalled(settingsPath, dataDir)
    });
    await action.setImage(renderUsageKeyImage(this.kind, state));
    streamDeck.logger.debug(`Usage image updated: ${this.kind}, state=${state.kind}.`);
  }
}
