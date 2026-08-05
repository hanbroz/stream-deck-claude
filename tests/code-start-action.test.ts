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
  const launchClaudeTerminal = vi.fn<CodeStartLaunchDependencies["launchClaudeTerminal"]>(async () => ({
    terminal: "windows-terminal" as const,
    processId: 8765
  }));
  const readContextSessionResumePointer =
    vi.fn<CodeStartLaunchDependencies["readContextSessionResumePointer"]>(
      async () => undefined
    );
  const claudeConversationExists =
    vi.fn<CodeStartLaunchDependencies["claudeConversationExists"]>(async () => false);
  const clearContextSessionResumePointer =
    vi.fn<CodeStartLaunchDependencies["clearContextSessionResumePointer"]>(
      async () => undefined
    );
  const writeActiveLaunch = vi.fn(async () => undefined);
  const findRunningCompanionLaunch =
    vi.fn<CodeStartLaunchDependencies["findRunningCompanionLaunch"]>(async () => undefined);
  const focusCompanionWindow =
    vi.fn<CodeStartLaunchDependencies["focusCompanionWindow"]>(async () => true);
  const renderCodeStartKeyImage = vi.fn((projectName: string, state: { kind: string; activity: string }) =>
    `${projectName}:${state.kind}:${state.activity}`
  );
  const dependencies = {
    defaultClaudeSettingsPath: () => "D:\\Claude\\settings.json",
    defaultUsageDataDir: () => "D:\\Data\\ClaudeUsageDeck",
    ensureBridgeInstalled,
    launchClaudeCompanion,
    launchClaudeTerminal,
    findRunningCompanionLaunch,
    focusCompanionWindow,
    claudeConversationExists,
    clearContextSessionResumePointer,
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
    launchClaudeTerminal,
    findRunningCompanionLaunch,
    focusCompanionWindow,
    claudeConversationExists,
    clearContextSessionResumePointer,
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

  it("focuses the existing Companion instead of launching a twin for the same folder", async () => {
    const harness = createDependencies();
    harness.findRunningCompanionLaunch.mockResolvedValue({
      schemaVersion: 2,
      actionId: "binding-1",
      launchId: "launch-old",
      folder: "D:\\Projects\\Demo",
      startedAt: 1,
      terminal: "companion",
      processId: 7777
    });
    const action = createAction();

    await launchConfiguredCodeStart({
      action,
      settings: { bindingId: "binding-1", folder: "D:\\Projects\\Demo", projectName: "Demo" },
      launchGuard: new CodeStartLaunchGuard(),
      bridgeSourcePath: "D:\\Plugin\\bridge\\statusline-bridge.js",
      dependencies: harness.dependencies
    });

    expect(harness.focusCompanionWindow).toHaveBeenCalledWith(7777);
    // No second spawn, and the old launch id must survive untouched.
    expect(harness.launchClaudeCompanion).not.toHaveBeenCalled();
    expect(harness.writeActiveLaunch).not.toHaveBeenCalled();
    expect(action.showOk).toHaveBeenCalled();
    expect(action.showAlert).not.toHaveBeenCalled();
  });

  it("launches fresh when the recorded pid is not a focusable Companion (pid reuse)", async () => {
    const harness = createDependencies();
    harness.findRunningCompanionLaunch.mockResolvedValue({
      schemaVersion: 2,
      actionId: "binding-1",
      launchId: "launch-old",
      folder: "D:\\Projects\\Demo",
      startedAt: 1,
      terminal: "companion",
      processId: 7777
    });
    // Windows reused pid 7777 for a foreign process — focusing must fail…
    harness.focusCompanionWindow.mockResolvedValue(false);
    const action = createAction();

    await launchConfiguredCodeStart({
      action,
      settings: { bindingId: "binding-1", folder: "D:\\Projects\\Demo", projectName: "Demo" },
      launchGuard: new CodeStartLaunchGuard(),
      bridgeSourcePath: "D:\\Plugin\\bridge\\statusline-bridge.js",
      dependencies: harness.dependencies
    });

    // …and the press falls through to a real launch that rewrites the state.
    expect(harness.launchClaudeCompanion).toHaveBeenCalled();
    expect(harness.writeActiveLaunch).toHaveBeenCalled();
    expect(action.showOk).toHaveBeenCalled();
    expect(action.showAlert).not.toHaveBeenCalled();
  });

  /**
   * Keys configured before the launch mode existed carry no `launchMode`, and
   * they were all set up against the Companion. Reading a missing value as the
   * app is what stops this option from silently moving every existing key to a
   * terminal that cannot resume their conversations.
   */
  it("opens the app when no launch mode is stored", async () => {
    const harness = createDependencies();
    const action = createAction();

    await launchConfiguredCodeStart({
      action,
      settings: { bindingId: "binding-1", folder: "D:\\Projects\\Demo", projectName: "Demo" },
      launchGuard: new CodeStartLaunchGuard(),
      bridgeSourcePath: "D:\\Plugin\\bridge\\statusline-bridge.js",
      dependencies: harness.dependencies
    });

    expect(harness.launchClaudeCompanion).toHaveBeenCalled();
    expect(harness.launchClaudeTerminal).not.toHaveBeenCalled();
  });

  it("opens a terminal, and records which one, when the launch mode says terminal", async () => {
    const harness = createDependencies();
    const action = createAction();

    await launchConfiguredCodeStart({
      action,
      settings: {
        bindingId: "binding-1",
        folder: "D:\\Projects\\Demo",
        projectName: "Demo",
        launchMode: "terminal"
      },
      launchGuard: new CodeStartLaunchGuard(),
      bridgeSourcePath: "D:\\Plugin\\bridge\\statusline-bridge.js",
      dependencies: harness.dependencies
    });

    expect(harness.launchClaudeTerminal).toHaveBeenCalledWith(
      "D:\\Projects\\Demo",
      "binding-1",
      "launch-123"
    );
    expect(harness.launchClaudeCompanion).not.toHaveBeenCalled();
    // The key reads liveness from this record, so the terminal it actually
    // opened has to be what gets stored — not the Companion's own value.
    expect(harness.writeActiveLaunch).toHaveBeenCalledWith(
      "D:\\Data\\ClaudeUsageDeck",
      expect.objectContaining({ terminal: "windows-terminal", processId: 8765 })
    );
    expect(action.showOk).toHaveBeenCalled();
  });

  /**
   * The bridge is what feeds the key its state, and in terminal mode it is the
   * ONLY source — the Companion's stream reader is not in play. Installing it
   * must therefore still happen on this path.
   */
  it("still installs the bridge when launching a terminal", async () => {
    const harness = createDependencies();

    await launchConfiguredCodeStart({
      action: createAction(),
      settings: {
        bindingId: "binding-1",
        folder: "D:\\Projects\\Demo",
        projectName: "Demo",
        launchMode: "terminal"
      },
      launchGuard: new CodeStartLaunchGuard(),
      bridgeSourcePath: "D:\\Plugin\\bridge\\statusline-bridge.js",
      dependencies: harness.dependencies
    });

    expect(harness.ensureBridgeInstalled).toHaveBeenCalled();
  });

  /**
   * A key switched from app to terminal can still have a live Companion on
   * record for its folder. Focusing that window would swallow the press and
   * never open the terminal the key is now configured for.
   */
  it("ignores a running Companion when the key is set to terminal", async () => {
    const harness = createDependencies();
    harness.findRunningCompanionLaunch.mockResolvedValue({
      schemaVersion: 2,
      actionId: "binding-1",
      launchId: "launch-old",
      folder: "D:\\Projects\\Demo",
      startedAt: 1,
      terminal: "companion",
      processId: 7777
    });
    const action = createAction();

    await launchConfiguredCodeStart({
      action,
      settings: {
        bindingId: "binding-1",
        folder: "D:\\Projects\\Demo",
        projectName: "Demo",
        launchMode: "terminal"
      },
      launchGuard: new CodeStartLaunchGuard(),
      bridgeSourcePath: "D:\\Plugin\\bridge\\statusline-bridge.js",
      dependencies: harness.dependencies
    });

    expect(harness.focusCompanionWindow).not.toHaveBeenCalled();
    expect(harness.launchClaudeTerminal).toHaveBeenCalled();
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
    harness.claudeConversationExists.mockResolvedValue(true);
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

  it("starts a new conversation without warning when the saved pointer is stale", async () => {
    const harness = createDependencies();
    harness.readContextSessionResumePointer.mockResolvedValue({
      schemaVersion: 1,
      actionId: "binding-1",
      folder: "D:\\Projects\\Demo",
      sessionId: "missing-session",
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

    expect(harness.claudeConversationExists).toHaveBeenCalledWith(
      "D:\\Projects\\Demo",
      "missing-session"
    );
    expect(harness.clearContextSessionResumePointer).toHaveBeenCalledWith(
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
    expect(action.showAlert).not.toHaveBeenCalled();
  });
});
