import { describe, expect, it, vi } from "vitest";

import {
  launchConfiguredCodeStart,
  type CodeStartLaunchDependencies
} from "../src/actions/code-start-launch";
import { CodeStartLaunchGuard } from "../src/actions/code-start-launch-guard";

type MockAction = {
  id: string;
  setImage: ReturnType<typeof vi.fn<(image: string) => Promise<void>>>;
  showAlert: ReturnType<typeof vi.fn<() => Promise<void>>>;
  showOk: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createAction(): MockAction {
  return {
    id: "action-instance-1",
    setImage: vi.fn(async () => undefined),
    showAlert: vi.fn(async () => undefined),
    showOk: vi.fn(async () => undefined)
  };
}

function createDependencies() {
  const logger = {
    info: vi.fn(),
    error: vi.fn()
  };
  const ensureBridgeInstalled = vi.fn(async () => ({
    changed: false,
    managedCommand: "node bridge.js",
    cachePath: "D:\\Data\\usage.json"
  }));
  const validateLaunchFolder = vi.fn(async () => undefined);
  const launchClaudeCompanion = vi.fn<CodeStartLaunchDependencies["launchClaudeCompanion"]>(async () => ({
    terminal: "companion" as const,
    processId: 4321
  }));
  const readContextSessionResumePointer =
    vi.fn<CodeStartLaunchDependencies["readContextSessionResumePointer"]>(
      async () => undefined
    );
  const writeActiveLaunch = vi.fn(async () => undefined);
  const renderCodeStartKeyImage = vi.fn((projectName: string, state: { kind: string; activity: string }) =>
    `${projectName}:${state.kind}:${state.activity}`
  );
  const dependencies = {
    defaultClaudeSettingsPath: () => "D:\\Claude\\settings.json",
    defaultUsageDataDir: () => "D:\\Data\\ClaudeUsageDeck",
    ensureBridgeInstalled,
    launchClaudeCompanion,
    readContextSessionResumePointer,
    renderCodeStartKeyImage,
    validateLaunchFolder,
    writeActiveLaunch,
    createLaunchId: () => "launch-123",
    now: () => 1_700_000_000_000,
    logger
  } satisfies CodeStartLaunchDependencies;

  return {
    dependencies,
    ensureBridgeInstalled,
    validateLaunchFolder,
    launchClaudeCompanion,
    readContextSessionResumePointer,
    writeActiveLaunch,
    renderCodeStartKeyImage,
    logger
  };
}

describe("Code Start relaunch guard", () => {
  it("keeps a binding locked until its replacement terminal finishes launching", () => {
    const guard = new CodeStartLaunchGuard();

    expect(guard.begin("binding-1")).toBe(true);
    expect(guard.isLaunching("binding-1")).toBe(true);
    expect(guard.begin("binding-1")).toBe(false);

    guard.end("binding-1");

    expect(guard.isLaunching("binding-1")).toBe(false);
    expect(guard.begin("binding-1")).toBe(true);
  });

  it("writes the active launch and reports success when a configured action launches", async () => {
    const harness = createDependencies();
    const action = createAction();
    const launchGuard = new CodeStartLaunchGuard();

    await launchConfiguredCodeStart({
      action,
      settings: {
        bindingId: "binding-1",
        folder: " D:\\Projects\\Demo ",
        projectName: " Demo "
      },
      launchGuard,
      bridgeSourcePath: "D:\\Plugin\\bridge\\statusline-bridge.js",
      dependencies: harness.dependencies
    });

    expect(harness.validateLaunchFolder).toHaveBeenCalledWith("D:\\Projects\\Demo");
    expect(harness.ensureBridgeInstalled).toHaveBeenCalledWith({
      settingsPath: "D:\\Claude\\settings.json",
      dataDir: "D:\\Data\\ClaudeUsageDeck",
      bridgeSourcePath: "D:\\Plugin\\bridge\\statusline-bridge.js"
    });
    expect(harness.readContextSessionResumePointer).toHaveBeenCalledWith(
      "D:\\Data\\ClaudeUsageDeck",
      "binding-1",
      "D:\\Projects\\Demo"
    );
    expect(harness.launchClaudeCompanion).toHaveBeenCalledWith(
      "D:\\Projects\\Demo",
      "binding-1",
      "launch-123",
      undefined,
      "Demo"
    );
    expect(harness.writeActiveLaunch).toHaveBeenCalledWith(
      "D:\\Data\\ClaudeUsageDeck",
      expect.objectContaining({
        schemaVersion: 2,
        actionId: "binding-1",
        launchId: "launch-123",
        folder: "D:\\Projects\\Demo",
        startedAt: 1_700_000_000_000,
        terminal: "companion",
        processId: 4321
      })
    );
    expect(action.setImage).toHaveBeenCalledWith("Demo:starting:running");
    expect(action.showOk).toHaveBeenCalledTimes(1);
    expect(action.showAlert).not.toHaveBeenCalled();
  });

  it("keeps duplicate presses in Starting state without launching twice", async () => {
    const harness = createDependencies();
    const launch = deferred<{ terminal: "companion" | "windows-terminal" | "powershell"; processId: number }>();
    harness.launchClaudeCompanion.mockReturnValue(launch.promise);
    const action = createAction();
    const options = {
      action,
      settings: {
        bindingId: "binding-1",
        folder: "D:\\Projects\\Demo",
        projectName: "Demo"
      },
      launchGuard: new CodeStartLaunchGuard(),
      bridgeSourcePath: "D:\\Plugin\\bridge\\statusline-bridge.js",
      dependencies: harness.dependencies
    };

    const firstPress = launchConfiguredCodeStart(options);
    await vi.waitFor(() => expect(harness.launchClaudeCompanion).toHaveBeenCalledTimes(1));
    await launchConfiguredCodeStart(options);

    expect(harness.launchClaudeCompanion).toHaveBeenCalledTimes(1);
    expect(harness.writeActiveLaunch).not.toHaveBeenCalled();
    expect(action.setImage).toHaveBeenCalledWith("Demo:starting:running");

    launch.resolve({ terminal: "companion", processId: 4321 });
    await firstPress;
    expect(harness.writeActiveLaunch).toHaveBeenCalledTimes(1);
    expect(action.showOk).toHaveBeenCalledTimes(1);
  });

  it("releases the launch guard after a failed launch so the next press can relaunch", async () => {
    const harness = createDependencies();
    harness.launchClaudeCompanion
      .mockRejectedValueOnce(new Error("launch failed"))
      .mockResolvedValueOnce({ terminal: "powershell", processId: 8765 });
    const action = createAction();
    const options = {
      action,
      settings: {
        bindingId: "binding-1",
        folder: "D:\\Projects\\Demo",
        projectName: "Demo"
      },
      launchGuard: new CodeStartLaunchGuard(),
      bridgeSourcePath: "D:\\Plugin\\bridge\\statusline-bridge.js",
      dependencies: harness.dependencies
    };

    await launchConfiguredCodeStart(options);
    await launchConfiguredCodeStart(options);

    expect(harness.launchClaudeCompanion).toHaveBeenCalledTimes(2);
    expect(action.setImage).toHaveBeenCalledWith("Demo:error:idle");
    expect(action.showAlert).toHaveBeenCalledTimes(1);
    expect(harness.writeActiveLaunch).toHaveBeenCalledWith(
      "D:\\Data\\ClaudeUsageDeck",
      expect.objectContaining({
        actionId: "binding-1",
        terminal: "powershell",
        processId: 8765
      })
    );
    expect(action.showOk).toHaveBeenCalledTimes(1);
  });

  it("passes an exact resume session ID from the matching pointer into Companion", async () => {
    const harness = createDependencies();
    harness.readContextSessionResumePointer.mockResolvedValue({
      schemaVersion: 1,
      actionId: "binding-1",
      folder: "D:\\Projects\\Demo",
      sessionId: "session-resume",
      sourceLaunchId: "launch-old",
      capturedAt: 123
    });
    const action = createAction();

    await launchConfiguredCodeStart({
      action,
      settings: {
        bindingId: "binding-1",
        folder: "D:\\Projects\\Demo",
        projectName: "Demo"
      },
      launchGuard: new CodeStartLaunchGuard(),
      bridgeSourcePath: "D:\\Plugin\\bridge\\statusline-bridge.js",
      dependencies: harness.dependencies
    });

    expect(harness.launchClaudeCompanion).toHaveBeenCalledWith(
      "D:\\Projects\\Demo",
      "binding-1",
      "launch-123",
      "session-resume",
      "Demo"
    );
  });
});
