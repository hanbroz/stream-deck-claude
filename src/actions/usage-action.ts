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

import {
  ensureBridgeInstalled,
  isBridgeInstalled,
  isStatusLineConflict
} from "../bridge/installer";
import {
  defaultClaudeSettingsPath,
  defaultOmcUsageCachePath,
  defaultUsageDataDir
} from "../bridge/paths";
import type { RateLimitKind } from "../domain/rate-limits";
import {
  loadUsageDisplayState,
  withLastGoodHold,
  type LastGoodUsage
} from "../services/display-loader";
import { renderUsageKeyImage } from "../ui/key-renderer";
import { UsageImageCache } from "./usage-image-cache";

const REFRESH_INTERVAL_MS = 1_000;
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeSourcePath = path.join(pluginRoot, "bridge", "statusline-bridge.js");

export abstract class UsageAction extends SingletonAction {
  private readonly visibleActions = new Map<string, KeyAction>();
  private readonly renderedImages = new UsageImageCache();
  private refreshTimer?: NodeJS.Timeout;
  private refreshInFlight?: Promise<void>;
  private refreshQueued = false;
  private lastGood?: LastGoodUsage;

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
      await this.refreshCoalesced();
    } catch (error) {
      streamDeck.logger.error(`Initial usage refresh failed: ${this.kind}.`, error);
      await ev.action.setImage(renderUsageKeyImage(this.kind, { kind: "error" }));
    }
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.visibleActions.delete(ev.action.id);
    this.renderedImages.forget(ev.action.id);
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
      await this.refreshCoalesced();
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
      void this.refreshCoalesced().catch((error: unknown) => {
        streamDeck.logger.error(`Usage refresh failed: ${this.kind}.`, error);
      });
    }, REFRESH_INTERVAL_MS);
    this.refreshTimer.unref();
  }

  private async refreshAll(): Promise<void> {
    const settingsPath = defaultClaudeSettingsPath();
    const dataDir = defaultUsageDataDir();
    const loaded = await loadUsageDisplayState(this.kind, {
      cachePath: path.join(dataDir, "usage.json"),
      bridgeInstalled: await isBridgeInstalled(settingsPath, dataDir),
      statusLineConflict: await isStatusLineConflict(settingsPath, dataDir),
      externalUsageCachePath: defaultOmcUsageCachePath()
    });
    const held = withLastGoodHold(loaded, this.lastGood);
    this.lastGood = held.lastGood;
    const state = held.state;
    const image = renderUsageKeyImage(this.kind, state);
    await Promise.all(
      [...this.visibleActions.values()].map(async (action) => {
        if (this.renderedImages.isCurrent(action.id, image)) {
          return;
        }
        await action.setImage(image);
        if (this.visibleActions.get(action.id) === action) {
          this.renderedImages.remember(action.id, image);
        }
      })
    );
    streamDeck.logger.debug(`Usage image updated: ${this.kind}, state=${state.kind}.`);
  }

  private async refreshCoalesced(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }
    const operation = this.drainRefreshQueue();
    this.refreshInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.refreshInFlight === operation) {
        this.refreshInFlight = undefined;
      }
    }
  }

  private async drainRefreshQueue(): Promise<void> {
    do {
      this.refreshQueued = false;
      await this.refreshAll();
    } while (this.refreshQueued);
  }
}
