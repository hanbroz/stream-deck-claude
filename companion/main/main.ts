import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerCompanionIpc } from "./ipc";
import { resolveCompanionRuntimeEnv } from "./paths";
import { createCompanionWindow } from "./window";
import os from "node:os";

import { ClaudePtyManager } from "./claude-session";
import { writeContextSnapshot } from "./context-snapshot";
import { writeModelPrefs } from "./model-prefs";
import { listSlashCommands } from "./slash-commands";
import { CLAUDE_MODELS, type ClaudeModel } from "../shared/claude-command";
import { ConversationHistoryReader } from "./transcript-history";
import { readCompanionSessionStatus } from "./session-status";
import { diag, setDiagSink } from "../shared/diag";
import { companionBuildVersion } from "../shared/build-version";
import { REPRESENTATIVE_MODEL_ID } from "../shared/model-name";
import { contextWindowForModel } from "../shared/claude-stream";

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
    hasResumeSessionId: runtimeEnv.resumeSessionId !== undefined
  });
  // The Stream Deck key should show model + context the moment the app opens,
  // not only after the first message: seed the snapshot from the saved model
  // prefs and the resumed conversation's last recorded usage.
  if (runtimeEnv.bindingId && runtimeEnv.launchId) {
    const bindingId = runtimeEnv.bindingId;
    const launchId = runtimeEnv.launchId;
    void (async () => {
      const family: ClaudeModel = CLAUDE_MODELS.includes(runtimeEnv.metadata.model as ClaudeModel)
        ? (runtimeEnv.metadata.model as ClaudeModel)
        : "opus";
      const representativeId = REPRESENTATIVE_MODEL_ID[family];
      const usage = runtimeEnv.resumeSessionId
        ? await historyReader.lastContextUsage(runtimeEnv.resumeSessionId)
        : undefined;
      await writeContextSnapshot({
        dataDir: runtimeEnv.usageDataDir,
        bindingId,
        launchId,
        // The launch id stands in when the folder has no conversation yet; a
        // resume-pointer promotion discards it via the existence check.
        sessionId: runtimeEnv.resumeSessionId ?? launchId,
        projectDir: runtimeEnv.rootPath,
        model: representativeId,
        usedTokens: usage?.usedTokens ?? null,
        windowTokens: contextWindowForModel(representativeId),
        capturedAt: Date.now()
      });
      diag("main.snapshot.initial", {
        model: family,
        hasUsage: usage !== undefined,
        resumed: runtimeEnv.resumeSessionId !== undefined
      });
    })().catch(() => {
      // The key simply waits for the first message's snapshot.
    });
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
      registerCompanionIpc({
        ipcMain,
        window: createdWindow,
        rootPath: runtimeEnv.rootPath,
        ptyManager: new ClaudePtyManager({
          command: runtimeEnv.claudePath,
          onContext: (info) => {
            if (info.claudeSessionId.length > 0) {
              lastContext = {
                claudeSessionId: info.claudeSessionId,
                usedTokens: info.usedTokens,
                windowTokens: info.windowTokens
              };
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
          }
        }),
        sessionStatus: () => readCompanionSessionStatus({
          dataDir: runtimeEnv.usageDataDir,
          bindingId: runtimeEnv.bindingId,
          launchId: runtimeEnv.launchId,
          fallback: {
            model: runtimeEnv.metadata.model,
            contextPercentage: runtimeEnv.metadata.contextPercent
          }
        }),
        applyModelPrefs: async ({ model, effort }) => {
          await writeModelPrefs(runtimeEnv.usageDataDir, runtimeEnv.rootPath, { model, effort });
          if (!runtimeEnv.bindingId || !runtimeEnv.launchId) {
            return;
          }
          // Before the first message there is no live conversation id, so fall
          // back to the folder's resume id so the key still updates immediately.
          const sessionId = lastContext?.claudeSessionId ?? runtimeEnv.resumeSessionId;
          if (!sessionId) {
            return;
          }
          const representativeId = REPRESENTATIVE_MODEL_ID[model];
          await writeContextSnapshot({
            dataDir: runtimeEnv.usageDataDir,
            bindingId: runtimeEnv.bindingId,
            launchId: runtimeEnv.launchId,
            sessionId,
            projectDir: runtimeEnv.rootPath,
            model: representativeId,
            usedTokens: lastContext?.usedTokens ?? 0,
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
  console.error("Claude Deck Companion failed to start:", error);
  app.quit();
});
