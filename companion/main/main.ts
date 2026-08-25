import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerCompanionIpc } from "./ipc";
import { resolveCompanionRuntimeEnv } from "./paths";
import { createCompanionWindow } from "./window";
import os from "node:os";

import { createActivityTracker } from "./activity-tracker";
import { ClaudePtyManager } from "./claude-session";
import {
  snapshotSessionId,
  writeContextSnapshot,
  writeRuntimeActivity,
  writeRuntimeActivitySync,
  type CompanionActivity
} from "./context-snapshot";
import { writeModelPrefs } from "./model-prefs";
import { listSlashCommands } from "./slash-commands";
import { CLAUDE_MODELS, type ClaudeModel } from "../shared/claude-command";
import { ConversationHistoryReader } from "./transcript-history";
import { readCompanionSessionStatus } from "./session-status";
import { diag, setDiagSink } from "../shared/diag";
import { companionBuildVersion } from "../shared/build-version";
import { REPRESENTATIVE_MODEL_ID } from "../shared/model-name";
import { contextWindowForModel } from "../shared/claude-stream";

/** How often the live activity record is re-stamped so the key can trust its age. */
const ACTIVITY_HEARTBEAT_MS = 30_000;

const require = createRequire(import.meta.url);
const { app, BrowserWindow, clipboard, ipcMain, nativeImage, shell } = require("electron");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Code Start launches the Companion with stdio "ignore", so console output is
 * discarded. Always mirror diagnostics into a file so a real Stream Deck launch
 * stays observable. The log is truncated per launch to keep the most recent
 * Code Start easy to read.
 */
function installDiagFileSink(): string {
  const localAppData =
    process.env.LOCALAPPDATA?.trim() ||
    path.join(process.env.USERPROFILE ?? process.cwd(), "AppData", "Local");
  const diagFile =
    process.env.CLAUDE_DECK_DIAG_FILE?.trim() ||
    path.join(localAppData, "ClaudeUsageDeck", "companion-diag.log");

  try {
    mkdirSync(path.dirname(diagFile), { recursive: true });
    writeFileSync(diagFile, `${new Date().toISOString()} [diag] launch ${companionBuildVersion()}\n`, "utf8");
  } catch {
    // Fall through to console-only diagnostics when the path is unwritable.
  }

  setDiagSink((line) => {
    try {
      appendFileSync(diagFile, `${new Date().toISOString()} ${line}\n`, "utf8");
    } catch {
      // Diagnostics must never break the session they are observing.
    }
    console.log(line);
  });
  return diagFile;
}

async function start(): Promise<void> {
  await app.whenReady();
  const diagFile = installDiagFileSink();
  const preloadPath = path.join(__dirname, "..", "preload", "index.cjs");
  const indexPath = path.join(__dirname, "..", "renderer", "index.html");
  // Load the window icon as a NativeImage rather than passing the path string:
  // the asset lives inside app.asar and Windows' native icon loader cannot read
  // an asar path, which made the window fall back to the default Electron icon.
  // nativeImage.createFromPath reads through Electron's asar-aware fs.
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "icon.png"));
  const windowIcon = icon.isEmpty() ? undefined : icon;
  // On Windows the taskbar button icon comes from the Start Menu shortcut whose
  // AppUserModelID matches the window's. Sharing the installed app's id
  // (com.hanbroz.claudedeck.companion) makes the button show that shortcut's
  // icon, which is stale when Code Start runs the freshly built binary instead
  // of the installer. Deriving the id from this executable's path means no
  // shortcut matches, so Windows uses the window's own (correct) icon. The hash
  // keeps the id space-free and within the 128-char AppUserModelID limit.
  if (process.platform === "win32") {
    const exeHash = createHash("sha1").update(app.getPath("exe")).digest("hex").slice(0, 16);
    app.setAppUserModelId(`com.hanbroz.claudedeck.companion.${exeHash}`);
  }
  const runtimeEnv = await resolveCompanionRuntimeEnv(process.env);
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(
    process.env.USERPROFILE?.trim() || os.homedir(),
    ".claude"
  );
  const historyReader = new ConversationHistoryReader({
    configDir,
    folder: runtimeEnv.rootPath
  });
  diag("main.runtime", {
    buildVersion: companionBuildVersion(),
    diagFile,
    rootPath: runtimeEnv.rootPath,
    claudePath: runtimeEnv.claudePath,
    projectName: runtimeEnv.metadata.projectName,
    hasResumeCandidate: runtimeEnv.resumeCandidateId !== undefined
  });
  // The Stream Deck key should show the model the moment the app opens. It must
  // NOT show the candidate's context: nothing was resumed, so that number
  // describes a conversation this window is not in.
  const startupFamily: ClaudeModel = CLAUDE_MODELS.includes(runtimeEnv.metadata.model as ClaudeModel)
    ? (runtimeEnv.metadata.model as ClaudeModel)
    : "sonnet";
  const startupModelId = REPRESENTATIVE_MODEL_ID[startupFamily];
  if (runtimeEnv.bindingId && runtimeEnv.launchId) {
    const bindingId = runtimeEnv.bindingId;
    const launchId = runtimeEnv.launchId;
    void (async () => {
      const family = startupFamily;
      const representativeId = startupModelId;
      await writeContextSnapshot({
        dataDir: runtimeEnv.usageDataDir,
        bindingId,
        launchId,
        // Always the launch id: the window opens on a new conversation, and
        // the real session id replaces this with the first reply's snapshot.
        sessionId: launchId,
        projectDir: runtimeEnv.rootPath,
        model: representativeId,
        usedTokens: null,
        windowTokens: contextWindowForModel(representativeId),
        capturedAt: Date.now()
      });
      diag("main.snapshot.initial", {
        model: family,
        resumed: false
      });
    })().catch(() => {
      // The key simply waits for the first message's snapshot.
    });
  }
  // Price the offer with the candidate's OWN last recorded usage. Estimating
  // from the transcript's byte size was the alternative and it is not honest
  // here: the ratio ranged 8.1 to 21.2 bytes per token across real sessions,
  // so a size-derived figure can be off by more than double.
  if (runtimeEnv.resumeCandidateId) {
    const candidate = await historyReader.lastContextUsage(runtimeEnv.resumeCandidateId);
    runtimeEnv.metadata.resumeCandidateTokens = candidate?.usedTokens;
  }
  await createCompanionWindow({
    BrowserWindow,
    preloadPath,
    runtimeMetadata: runtimeEnv.metadata,
    indexPath,
    icon: windowIcon,
    beforeLoad: (createdWindow) => {
      // The most recent context the stream reported, so applying a model can
      // refresh the key with the real usage instead of resetting it to 0%.
      let lastContext: { claudeSessionId: string; usedTokens: number; windowTokens: number } | undefined;
      // The model choice outlives the conversation — ending one keeps it — so a
      // reset snapshot can still name the model instead of blanking that half of
      // the key too.
      let currentModelId = startupModelId;
      /**
       * Put the key back to "--" because the conversation changed size without
       * being measured. The stream reports usage only at the start of a reply,
       * so both callers here — ending the conversation and compacting it — leave
       * no number behind; the recorded one now describes a conversation that no
       * longer exists, and showing it reads as if nothing happened.
       *
       * `keepConversation` separates the two: a compaction continues the same
       * conversation, and the key's resume pointer is derived from this id, so
       * it has to survive. An ended one has no id left to name.
       */
      const forgetContextUsage = (keepConversation: boolean): void => {
        const continuedSessionId = keepConversation ? lastContext?.claudeSessionId : undefined;
        lastContext = undefined;
        if (!runtimeEnv.bindingId || !runtimeEnv.launchId) {
          return;
        }
        void writeContextSnapshot({
          dataDir: runtimeEnv.usageDataDir,
          bindingId: runtimeEnv.bindingId,
          launchId: runtimeEnv.launchId,
          // The launch id stands in exactly as it does for the opening snapshot.
          sessionId: continuedSessionId ?? runtimeEnv.launchId,
          projectDir: runtimeEnv.rootPath,
          model: currentModelId,
          usedTokens: null,
          windowTokens: contextWindowForModel(currentModelId),
          capturedAt: Date.now()
        }).catch(() => {
          // Leaves the stale percentage up until the next reply — the same
          // outcome as before this reset existed.
        });
      };
      const ptyManager = new ClaudePtyManager({
          command: runtimeEnv.claudePath,
          onContext: (info) => {
            if (info.claudeSessionId.length > 0) {
              lastContext = {
                claudeSessionId: info.claudeSessionId,
                usedTokens: info.usedTokens,
                windowTokens: info.windowTokens
              };
            }
            if (info.model) {
              currentModelId = info.model;
            }
            // Feed the Stream Deck Code Start key, which cannot read a --print
            // session's usage on its own. Requires the launch identifiers.
            if (!runtimeEnv.bindingId || !runtimeEnv.launchId || info.claudeSessionId.length === 0) {
              return;
            }
            void writeContextSnapshot({
              dataDir: runtimeEnv.usageDataDir,
              bindingId: runtimeEnv.bindingId,
              launchId: runtimeEnv.launchId,
              sessionId: info.claudeSessionId,
              projectDir: runtimeEnv.rootPath,
              model: info.model,
              usedTokens: info.usedTokens,
              windowTokens: info.windowTokens,
              capturedAt: Date.now()
            }).catch(() => {
              // The key simply keeps its last value if the snapshot write fails.
            });
          },
          onCleared: () => forgetContextUsage(false)
      });

      // Mirror the conversation phase onto the key's activity dot: without
      // this record the plugin assumes "running" for the whole app lifetime,
      // so an idle app kept the green running indicator.
      let lastActivity: CompanionActivity | undefined;
      const publishActivity = (activity: CompanionActivity): void => {
        if (!runtimeEnv.bindingId || !runtimeEnv.launchId) {
          return;
        }
        void writeRuntimeActivity({
          dataDir: runtimeEnv.usageDataDir,
          bindingId: runtimeEnv.bindingId,
          launchId: runtimeEnv.launchId,
          activity,
          capturedAt: Date.now()
        }).catch(() => {
          // lastActivity is deliberately kept. Clearing it made the next heartbeat
          // publish "waiting" through the `?? "waiting"` fallback for a session that
          // was still running, and dedup then held that wrong value until the next
          // phase change. The heartbeat re-publishes the correct value in 30s.
        });
      };
      const recordActivity = (activity: CompanionActivity): void => {
        if (activity === lastActivity) {
          return;
        }
        lastActivity = activity;
        publishActivity(activity);
      };

      /**
       * Re-stamp the activity record while the window lives.
       *
       * The key cannot tell a quiet app from a closed one by PID alone: Windows
       * reuses PIDs, so a launch whose app died can point at a stranger's live
       * process, and the key kept blinking for a project closed hours earlier.
       * A record that stops being refreshed is the reliable "app is gone" signal,
       * and it covers crashes and force-kills that no teardown hook would catch.
       *
       * ponytail: paired with ACTIVITY_STALE_MS in src/io/context-session-cache.ts,
       * which allows three missed beats. Change both together.
       */
      const heartbeat = setInterval(
        () => publishActivity(lastActivity ?? "waiting"),
        ACTIVITY_HEARTBEAT_MS
      );
      app.on("before-quit", () => {
        clearInterval(heartbeat);
        // A run held open for its background agents would otherwise outlive the
        // app: the idle timer that reclaims it lives in this process and dies with
        // it, stranding a `claude --print` subtree that runs with
        // --dangerously-skip-permissions and has nobody left to supervise it.
        ptyManager.killAll();
        if (!runtimeEnv.bindingId || !runtimeEnv.launchId) {
          return;
        }
        try {
          // A normal quit reports itself immediately instead of waiting out the
          // staleness window.
          writeRuntimeActivitySync({
            dataDir: runtimeEnv.usageDataDir,
            bindingId: runtimeEnv.bindingId,
            launchId: runtimeEnv.launchId,
            activity: "ended",
            capturedAt: Date.now()
          });
        } catch {
          // Shutting down anyway; the staleness window still retires the record.
        }
      });
      const trackActivity = createActivityTracker();
      ptyManager.on("data", (_sessionId, events) => {
        recordActivity(trackActivity(events));
      });
      recordActivity("waiting"); // the app opens idle, waiting for input

      registerCompanionIpc({
        ipcMain,
        window: createdWindow,
        rootPath: runtimeEnv.rootPath,
        claudePath: runtimeEnv.claudePath,
        ptyManager,
        sessionStatus: () => readCompanionSessionStatus({
          dataDir: runtimeEnv.usageDataDir,
          bindingId: runtimeEnv.bindingId,
          launchId: runtimeEnv.launchId,
          fallback: {
            model: runtimeEnv.metadata.model,
            contextPercentage: runtimeEnv.metadata.contextPercent
          }
        }),
        onContextReset: () => forgetContextUsage(true),
        applyModelPrefs: async ({ model, effort }) => {
          await writeModelPrefs(runtimeEnv.usageDataDir, runtimeEnv.rootPath, { model, effort });
          if (!runtimeEnv.bindingId || !runtimeEnv.launchId) {
            return;
          }
          const sessionId = snapshotSessionId({
            liveSessionId: lastContext?.claudeSessionId,
            launchId: runtimeEnv.launchId
          });
          const representativeId = REPRESENTATIVE_MODEL_ID[model];
          currentModelId = representativeId;
          await writeContextSnapshot({
            dataDir: runtimeEnv.usageDataDir,
            bindingId: runtimeEnv.bindingId,
            launchId: runtimeEnv.launchId,
            sessionId,
            projectDir: runtimeEnv.rootPath,
            model: representativeId,
            // null, not 0: with no usage reported yet the key must keep showing
            // "--". A 0 here invented a percentage, and after the conversation
            // was ended it overwrote the "--" this switch is supposed to preserve.
            usedTokens: lastContext?.usedTokens ?? null,
            windowTokens: contextWindowForModel(representativeId),
            capturedAt: Date.now()
          }).catch(() => {
            // The key keeps its last value if the snapshot write fails.
          });
        },
        slashCommands: () => listSlashCommands({ configDir, projectRoot: runtimeEnv.rootPath }),
        clipboard,
        nativeImage,
        shell,
        historyReader
      });
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

void start().catch((error: unknown) => {
  console.error("Code Deck Companion failed to start:", error);
  app.quit();
});
