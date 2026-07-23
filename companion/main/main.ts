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
import { ConversationHistoryReader } from "./transcript-history";
import { readCompanionSessionStatus } from "./session-status";
import { diag, setDiagSink } from "../shared/diag";
import { companionBuildVersion } from "../shared/build-version";

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
  const iconPath = path.join(__dirname, "..", "assets", "icon.png");
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
  await createCompanionWindow({
    BrowserWindow,
    preloadPath,
    runtimeMetadata: runtimeEnv.metadata,
    indexPath,
    iconPath,
    beforeLoad: (createdWindow) => {
      registerCompanionIpc({
        ipcMain,
        window: createdWindow,
        rootPath: runtimeEnv.rootPath,
        ptyManager: new ClaudePtyManager({
          command: runtimeEnv.claudePath,
          onContext: (info) => {
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
