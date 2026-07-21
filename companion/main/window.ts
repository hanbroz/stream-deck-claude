import type { BrowserWindowConstructorOptions } from "electron";

export type BrowserWindowLike = {
  loadFile(filePath: string): Promise<void>;
  loadURL(url: string): Promise<void>;
  show(): void;
  webContents: {
    send(channel: string, ...args: unknown[]): void;
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
    on(event: "will-navigate", handler: (event: { preventDefault(): void }) => void): void;
  };
};

export type BrowserWindowFactory = new (
  options: BrowserWindowConstructorOptions
) => BrowserWindowLike;

export type CompanionWindowOptions = {
  BrowserWindow: BrowserWindowFactory;
  preloadPath: string;
  indexPath?: string;
  devServerUrl?: string;
  beforeLoad?: (window: BrowserWindowLike) => void | Promise<void>;
};

export function companionWindowOptions(
  preloadPath: string
): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 860,
    minWidth: 920,
    minHeight: 640,
    show: false,
    backgroundColor: "#101418",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  };
}

export async function createCompanionWindow(
  options: CompanionWindowOptions
): Promise<BrowserWindowLike> {
  const window = new options.BrowserWindow(
    companionWindowOptions(options.preloadPath)
  );

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });

  await options.beforeLoad?.(window);

  if (options.devServerUrl) {
    await window.loadURL(options.devServerUrl);
  } else if (options.indexPath) {
    await window.loadFile(options.indexPath);
  } else {
    await window.loadURL("about:blank");
  }
  window.show();

  return window;
}
