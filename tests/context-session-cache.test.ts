import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  contextSessionRuntimePath,
  contextSessionSnapshotPath,
  findReconnectableBindingId,
  loadCodeStartDisplayState,
  writeActiveLaunch,
  writeContextSessionRuntime
} from "../src/io/context-session-cache";

describe("context session cache", () => {
  it("finds the one running legacy binding for a moved action folder", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    await writeActiveLaunch(root, {
      schemaVersion: 2,
      actionId: "old-action-instance",
      launchId: "launch-1",
      folder: "D:\\Projects\\Moved",
      startedAt: 100,
      terminal: "powershell",
      processId: process.pid
    });

    await expect(
      findReconnectableBindingId(root, "d:\\projects\\moved")
    ).resolves.toBe("old-action-instance");
  });

  it("does not guess when a running binding is claimed or the folder is ambiguous", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    for (const actionId of ["action-1", "action-2"]) {
      await writeActiveLaunch(root, {
        schemaVersion: 2,
        actionId,
        launchId: `launch-${actionId}`,
        folder: "D:\\Projects\\Shared",
        startedAt: 100,
        terminal: "powershell",
        processId: process.pid
      });
    }

    await expect(
      findReconnectableBindingId(root, "D:\\Projects\\Shared")
    ).resolves.toBeUndefined();
    await expect(
      findReconnectableBindingId(root, "D:\\Projects\\Shared", new Set(["action-1"]))
    ).resolves.toBe("action-2");
    await expect(
      findReconnectableBindingId(
        root,
        "D:\\Projects\\Shared",
        new Set(["action-1", "action-2"])
      )
    ).resolves.toBeUndefined();
  });

  it("loads only the snapshot for the active launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    await writeActiveLaunch(root, {
      schemaVersion: 2,
      actionId: "action-1",
      launchId: "new-launch",
      folder: "D:\\Projects\\Demo",
      startedAt: 100,
      terminal: "powershell",
      processId: process.pid
    });
    const oldPath = contextSessionSnapshotPath(root, "action-1", "old-launch");
    await writeFile(
      oldPath,
      JSON.stringify({
        schemaVersion: 1,
        actionId: "action-1",
        launchId: "old-launch",
        sessionId: "old-session",
        capturedAt: 110,
        context: { usedPercentage: 99 }
      }),
      "utf8"
    );

    await expect(
      loadCodeStartDisplayState(root, "action-1", "D:\\Projects\\Demo")
    ).resolves.toEqual({
      kind: "starting",
      activity: "running"
    });
  });

  it("returns the matching session percentage and preserves null as starting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    await writeActiveLaunch(root, {
      schemaVersion: 2,
      actionId: "action-1",
      launchId: "launch-1",
      folder: "D:\\Projects\\Demo",
      startedAt: 100,
      terminal: "powershell",
      processId: process.pid
    });
    const snapshotPath = contextSessionSnapshotPath(root, "action-1", "launch-1");
    await writeFile(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        actionId: "action-1",
        launchId: "launch-1",
        sessionId: "session-1",
        capturedAt: 110,
        context: { usedPercentage: null }
      }),
      "utf8"
    );
    await expect(
      loadCodeStartDisplayState(root, "action-1", "D:\\Projects\\Demo")
    ).resolves.toEqual({
      kind: "starting",
      activity: "running"
    });

    await writeFile(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        actionId: "action-1",
        launchId: "launch-1",
        sessionId: "session-1",
        capturedAt: 120,
        context: { usedPercentage: 47.6 }
      }),
      "utf8"
    );
    await expect(
      loadCodeStartDisplayState(root, "action-1", "D:\\Projects\\Demo")
    ).resolves.toEqual({
      kind: "ready",
      percentage: 48,
      activity: "running"
    });
  });

  it("treats an unverified legacy launch marker as idle instead of sticking on starting", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    const legacyPath = contextSessionSnapshotPath(root, "action-legacy", "placeholder");
    const activePath = path.join(path.dirname(legacyPath), "active.json");
    await mkdir(path.dirname(activePath), { recursive: true });
    await writeFile(
      activePath,
      JSON.stringify({
        schemaVersion: 1,
        actionId: "action-legacy",
        launchId: "legacy-launch",
        folder: "D:\\Projects\\Demo",
        startedAt: 100
      }),
      "utf8"
    );

    await expect(
      loadCodeStartDisplayState(root, "action-legacy", "D:\\Projects\\Demo")
    ).resolves.toEqual({ kind: "idle", activity: "waiting" });
  });

  it("loads responding and ended activity for the active launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    await writeActiveLaunch(root, {
      schemaVersion: 2,
      actionId: "action-1",
      launchId: "launch-1",
      folder: "D:\\Projects\\Demo",
      startedAt: 100,
      terminal: "powershell",
      processId: process.pid
    });
    await writeContextSessionRuntime(root, {
      schemaVersion: 1,
      actionId: "action-1",
      launchId: "launch-1",
      activity: "responding",
      capturedAt: 110
    });

    await expect(
      loadCodeStartDisplayState(root, "action-1", "D:\\Projects\\Demo")
    ).resolves.toEqual({ kind: "starting", activity: "responding" });

    await writeFile(
      contextSessionSnapshotPath(root, "action-1", "launch-1"),
      JSON.stringify({
        schemaVersion: 1,
        actionId: "action-1",
        launchId: "launch-1",
        sessionId: "session-1",
        capturedAt: 120,
        context: { usedPercentage: 23 }
      }),
      "utf8"
    );
    await writeContextSessionRuntime(root, {
      schemaVersion: 1,
      actionId: "action-1",
      launchId: "launch-1",
      activity: "waiting",
      capturedAt: 130
    });

    await expect(
      loadCodeStartDisplayState(root, "action-1", "D:\\Projects\\Demo")
    ).resolves.toEqual({ kind: "closed", activity: "waiting" });
    await expect(readFile(contextSessionRuntimePath(root, "action-1", "launch-1"), "utf8"))
      .resolves.toContain('"activity": "waiting"');
  });

  it("reports Closed when the tracked terminal process is no longer running", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    await writeActiveLaunch(root, {
      schemaVersion: 2,
      actionId: "action-closed",
      launchId: "launch-closed",
      folder: "D:\\Projects\\Demo",
      startedAt: 100,
      terminal: "powershell",
      processId: 2_147_483_647
    });

    await expect(
      loadCodeStartDisplayState(root, "action-closed", "D:\\Projects\\Demo")
    ).resolves.toEqual({ kind: "closed", activity: "waiting" });
  });
});
