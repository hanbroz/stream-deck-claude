import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerCompanionIpc } from "./ipc";
import { resolveCompanionRuntimeEnv } from "./paths";
import { createCompanionWindow } from "./window";
import { ClaudePtyManager } from "./claude-session";

const require = createRequire(import.meta.url);
const { app, BrowserWindow, clipboard, ipcMain, nativeImage, shell } = require("electron");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function start(): Promise<void> {
  await app.whenReady();
  const preloadPath = path.join(__dirname, "..", "preload", "index.cjs");
  const indexPath = path.join(__dirname, "..", "renderer", "index.html");
  const runtimeEnv = await resolveCompanionRuntimeEnv(process.env);
  await createCompanionWindow({
    BrowserWindow,
    preloadPath,
    indexPath,
    beforeLoad: (createdWindow) => {
      registerCompanionIpc({
        ipcMain,
        window: createdWindow,
        rootPath: runtimeEnv.rootPath,
        ptyManager: new ClaudePtyManager({ command: runtimeEnv.claudePath }),
        clipboard,
        nativeImage,
        shell
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
