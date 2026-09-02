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
  isStatusLineConflict,
  NODE_MISSING_MESSAGE
} from "../bridge/installer";
import {
  defaultClaudeSettingsPath,
  defaultOmcStdinCacheRoots,
  defaultOmcUsageCachePath,
  defaultUsageDataDir
} from "../bridge/paths";
import type { RateLimitKind } from "../domain/rate-limits";
import { readUsageCache } from "../io/usage-cache";
import {
  loadUsageDisplayState,
  withLastGoodHold,
  type LastGoodUsage
} from "../services/display-loader";
import { showErrorDialog } from "../services/error-dialog";
import { OmcStdinSync } from "../services/omc-stdin-sync";
import { maybeRefreshUsageViaApi } from "../services/usage-refresher";
import { renderUsageKeyImage } from "../ui/key-renderer";
import { UsageImageCache } from "./usage-image-cache";

const REFRESH_INTERVAL_MS = 1_000;
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeSourcePath = path.join(pluginRoot, "bridge", "statusline-bridge.js");
// Shared across the five-hour and weekly actions: one copy serves both.
const omcStdinSync = new OmcStdinSync(defaultOmcStdinCacheRoots());
// A prerequisite dialog is shown once per plugin lifetime, not on every press.
let prerequisiteDialogShown = false;

export abstract class UsageAction extends SingletonAction {
  private readonly visibleActions = new Map<string, KeyAction>();
  private readonly renderedImages = new UsageImageCache();
  private refreshTimer?: NodeJS.Timeout;
  private refreshInFlight?: Promise<void>;
  private refreshQueued = false;
  private lastGood?: LastGoodUsage;
  private lastSyncFailure?: string;

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
      const installed = await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });
      const problems = [
        ...(installed.nodeMissing ? [NODE_MISSING_MESSAGE] : []),
        ...installed.warnings.map((warning) => `Bridge install: ${warning}`)
      ];
      for (const problem of problems) {
        streamDeck.logger.warn(problem);
      }
      await this.refreshCoalesced();
      if (problems.length > 0 && !prerequisiteDialogShown) {
        // The key alone cannot explain a missing prerequisite.
        prerequisiteDialogShown = true;
        await ev.action.showAlert();
        void showErrorDialog(problems.join("\n\n"));
        return;
      }
      await ev.action.showOk();
    } catch (error) {
      streamDeck.logger.error(`Usage action press failed: ${this.kind}.`, error);
      await ev.action.setImage(renderUsageKeyImage(this.kind, { kind: "error" }));
      await ev.action.showAlert();
    }
  }

  /** The sync runs every second; log a failure once per distinct message. */
  private logSyncFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (message === this.lastSyncFailure) {
      return;
    }
    this.lastSyncFailure = message;
    streamDeck.logger.error(`OMC status-line snapshot sync failed: ${this.kind}.`, error);
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
    const bridgeInstalled = await isBridgeInstalled(settingsPath, dataDir);
    const statusLineConflict = await isStatusLineConflict(settingsPath, dataDir);
    // OMC persists the status-line payload Claude Code hands it (the same
    // rate_limits OMC HUD displays) after every render. Mirroring that into
    // usage.json is what keeps the keys live while OMC owns the status-line
    // slot and the usage API is unreachable. Only while another command
    // actually owns the slot: otherwise a lingering snapshot would hide the
    // SETUP prompt from a user who still needs the bridge installed.
    const synced = statusLineConflict
      ? await omcStdinSync.sync(dataDir).catch((error: unknown) => {
          this.logSyncFailure(error);
          return undefined;
        })
      : undefined;
    const loaded = await loadUsageDisplayState(this.kind, {
      cachePath: path.join(dataDir, "usage.json"),
      bridgeInstalled,
      statusLineConflict,
      externalUsageCachePath: defaultOmcUsageCachePath()
    });
    // Fallback for when no status line has rendered recently: ask the usage
    // API directly. It is throttled hard (and lately answers 403), so the
    // refresher stays quiet while the status-line snapshot is fresh and backs
    // off for a long time after a failure.
    const localCapturedAt =
      synced?.localCapturedAt ??
      (await readUsageCache(path.join(dataDir, "usage.json")).catch(() => undefined))?.capturedAt;
    void maybeRefreshUsageViaApi(dataDir, Date.now(), { localCapturedAt }).catch((error: unknown) => {
      streamDeck.logger.error(`Usage API refresh failed: ${this.kind}.`, error);
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
