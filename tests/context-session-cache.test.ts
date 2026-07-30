import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  claudeConversationExists,
  clearContextSessionResumePointer,
  contextSessionRuntimePath,
  contextSessionSnapshotPath,
  findReconnectableBindingId,
  findRunningCompanionLaunch,
  loadCodeStartDisplayState,
  readContextSessionResumePointer,
  refreshResumePointerFromIdentity,
  refreshResumePointerFromSnapshot,
  writeActiveLaunch,
  writeContextSessionResumePointer,
  writeContextSessionRuntime
} from "../src/io/context-session-cache";

// The fixtures below stamp records at epoch 100-140ms. Pinning "now" just past
// them keeps every activity record inside the freshness window, so these tests
// stay about launch/snapshot matching rather than the staleness cutoff.
const FRESH_NOW = 1_000;

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
      // These fixtures stamp startedAt at epoch 100ms, so "now" is pinned to the
      // same era — reconnect now applies the same freshness rule as the display.
      findReconnectableBindingId(root, "d:\\projects\\moved", new Set<string>(), FRESH_NOW)
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
      findReconnectableBindingId(root, "D:\\Projects\\Shared", new Set<string>(), FRESH_NOW)
    ).resolves.toBeUndefined();
    await expect(
      findReconnectableBindingId(root, "D:\\Projects\\Shared", new Set(["action-1"]), FRESH_NOW)
    ).resolves.toBe("action-2");
    await expect(
      findReconnectableBindingId(
        root,
        "D:\\Projects\\Shared",
        new Set(["action-1", "action-2"]),
        FRESH_NOW
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
      loadCodeStartDisplayState(root, "action-1", "D:\\Projects\\Demo", FRESH_NOW)
    ).resolves.toEqual({
      // No activity record for this launch yet, so it is not claimed to be running.
      kind: "starting",
      activity: "idle"
    });
  });

  it("accepts a Companion active launch as the tracked process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    await writeActiveLaunch(root, {
      schemaVersion: 2,
      actionId: "action-companion",
      launchId: "launch-companion",
      folder: "D:\\Projects\\Demo",
      startedAt: 100,
      terminal: "companion",
      processId: process.pid
    });

    await expect(
      loadCodeStartDisplayState(root, "action-companion", "D:\\Projects\\Demo", FRESH_NOW)
    ).resolves.toEqual({ kind: "starting", activity: "idle" });
  });

  it("reports closed — never a live session — when no app is running for the folder", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    const folder = "D:\\Projects\\Demo";

    // Field incident: these cases used to return `idle`, which the renderer drew
    // exactly like a live session — project name, `MODEL --` and a context bar —
    // so a project with no app open looked open.

    // No launch on record at all.
    await expect(
      loadCodeStartDisplayState(root, "action-never-run", folder, FRESH_NOW)
    ).resolves.toEqual({ kind: "closed", activity: "ended" });

    // The key was re-pointed at another folder, so its launch is not for this one.
    await writeActiveLaunch(root, {
      schemaVersion: 2,
      actionId: "action-moved",
      launchId: "launch-elsewhere",
      folder: "D:\\Projects\\Other",
      startedAt: FRESH_NOW,
      terminal: "companion",
      processId: process.pid
    });
    await expect(
      loadCodeStartDisplayState(root, "action-moved", folder, FRESH_NOW)
    ).resolves.toEqual({ kind: "closed", activity: "ended" });
  });

  it("rejects an activity record stamped in the future instead of trusting it forever", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    // A clock that ran ahead (dual boot, restored VM snapshot) leaves a record dated
    // later than "now". A lower-bound-only freshness check makes the difference
    // negative, switching the rule off and bringing the PID-reuse bug back.
    await writeActiveLaunch(root, {
      schemaVersion: 2,
      actionId: "action-future",
      launchId: "launch-future",
      folder: "D:\\Projects\\Demo",
      startedAt: FRESH_NOW,
      terminal: "companion",
      processId: process.pid
    });
    await writeContextSessionRuntime(root, {
      schemaVersion: 2,
      actionId: "action-future",
      launchId: "launch-future",
      activity: "waiting",
      capturedAt: FRESH_NOW + 10 * 60 * 1000
    });

    await expect(
      loadCodeStartDisplayState(root, "action-future", "D:\\Projects\\Demo", FRESH_NOW)
    ).resolves.toEqual({ kind: "closed", activity: "ended" });
  });

  it("agrees between the display and the press path about a stale launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    const folder = "D:\\Projects\\Demo";
    // process.pid stands in for a reused PID that now belongs to another Companion,
    // which passes a process-name check. When only the display path applied the
    // freshness rule, the key read "Closed" while pressing it focused that stranger's
    // window and skipped the launch — so the key had no way back.
    await writeActiveLaunch(root, {
      schemaVersion: 2,
      actionId: "action-split",
      launchId: "launch-split",
      folder,
      startedAt: FRESH_NOW,
      terminal: "companion",
      processId: process.pid
    });
    await writeContextSessionRuntime(root, {
      schemaVersion: 2,
      actionId: "action-split",
      launchId: "launch-split",
      activity: "waiting",
      capturedAt: FRESH_NOW
    });

    const stale = FRESH_NOW + 120_000;
    await expect(
      loadCodeStartDisplayState(root, "action-split", folder, stale)
    ).resolves.toEqual({ kind: "closed", activity: "ended" });
    // The press path must reach the same verdict, so the press launches afresh.
    await expect(
      findRunningCompanionLaunch(root, "action-split", folder, () => true, stale)
    ).resolves.toBeUndefined();

    // While the record is fresh, both agree it is live.
    await expect(
      findRunningCompanionLaunch(root, "action-split", folder, () => true, FRESH_NOW + 1_000)
    ).resolves.toMatchObject({ launchId: "launch-split" });
  });

  it("closes a key whose PID is alive but whose activity record went stale", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    // Field incident: Windows reused this launch's PID two hours after its app
    // died, handing it to another Companion that was still running. The PID check
    // passed, so the key kept blinking on a hours-old "waiting" record for a
    // project that was closed. process.pid stands in for that live stranger.
    await writeActiveLaunch(root, {
      schemaVersion: 2,
      actionId: "action-stale",
      launchId: "launch-stale",
      folder: "D:\\Projects\\Demo",
      startedAt: FRESH_NOW,
      terminal: "companion",
      processId: process.pid
    });
    await writeContextSessionRuntime(root, {
      schemaVersion: 2,
      actionId: "action-stale",
      launchId: "launch-stale",
      activity: "waiting",
      capturedAt: FRESH_NOW
    });

    // A refreshed record is trusted: the app is genuinely open and waiting.
    await expect(
      loadCodeStartDisplayState(root, "action-stale", "D:\\Projects\\Demo", FRESH_NOW + 1_000)
    ).resolves.toMatchObject({ activity: "waiting" });

    // The heartbeat stopped: gone, whoever holds the PID now.
    await expect(
      loadCodeStartDisplayState(root, "action-stale", "D:\\Projects\\Demo", FRESH_NOW + 120_000)
    ).resolves.toEqual({ kind: "closed", activity: "ended" });
  });

  it("closes a launch that never wrote an activity record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    await writeActiveLaunch(root, {
      schemaVersion: 2,
      actionId: "action-silent",
      launchId: "launch-silent",
      folder: "D:\\Projects\\Demo",
      startedAt: FRESH_NOW,
      terminal: "companion",
      processId: process.pid
    });

    // Just launched: no record yet is normal, so the key shows it starting.
    await expect(
      loadCodeStartDisplayState(root, "action-silent", "D:\\Projects\\Demo", FRESH_NOW + 1_000)
    ).resolves.toEqual({ kind: "starting", activity: "idle" });

    // Still nothing much later: the app never came up, so stop reporting it.
    await expect(
      loadCodeStartDisplayState(root, "action-silent", "D:\\Projects\\Demo", FRESH_NOW + 120_000)
    ).resolves.toEqual({ kind: "closed", activity: "ended" });
  });

  it("writes and reads a canonical-folder resume pointer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    const folder = await mkdtemp(path.join(os.tmpdir(), "claude-project-"));

    await expect(
      writeContextSessionResumePointer(root, {
        actionId: "action-1",
        folder,
        sessionId: "session-1",
        sourceLaunchId: "launch-1",
        capturedAt: 123
      })
    ).resolves.toMatchObject({
      schemaVersion: 1,
      actionId: "action-1",
      sessionId: "session-1",
      sourceLaunchId: "launch-1",
      capturedAt: 123
    });

    await expect(
      readContextSessionResumePointer(root, "action-1", folder)
    ).resolves.toMatchObject({
      actionId: "action-1",
      sessionId: "session-1",
      sourceLaunchId: "launch-1"
    });
    await expect(
      readContextSessionResumePointer(root, "other-action", folder)
    ).resolves.toBeUndefined();
  });

  it("recognizes Claude JSONL conversations and rejects missing transcripts", async () => {
    const projectsDir = await mkdtemp(path.join(os.tmpdir(), "claude-projects-"));
    const folder = await mkdtemp(path.join(os.tmpdir(), "claude-project-"));
    const encodedFolder = folder.replace(/[^a-zA-Z0-9]/g, "-");
    const sessionId = "session-1";
    await mkdir(path.join(projectsDir, encodedFolder), { recursive: true });
    await writeFile(
      path.join(projectsDir, encodedFolder, `${sessionId}.jsonl`),
      "{}\n",
      "utf8"
    );

    await expect(
      claudeConversationExists(folder, sessionId, projectsDir)
    ).resolves.toBe(true);
    await expect(
      claudeConversationExists(folder, "missing-session", projectsDir)
    ).resolves.toBe(false);
  });

  it("clears a stale resume pointer without failing when the folder is unavailable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    const folder = await mkdtemp(path.join(os.tmpdir(), "claude-project-"));
    await writeContextSessionResumePointer(root, {
      actionId: "action-1",
      folder,
      sessionId: "session-1",
      sourceLaunchId: "launch-1",
      capturedAt: 123
    });

    await expect(
      clearContextSessionResumePointer(root, "action-1", folder)
    ).resolves.toBeUndefined();
    await expect(
      readContextSessionResumePointer(root, "action-1", folder)
    ).resolves.toBeUndefined();
  });

  it("ignores resume pointers with mismatched folder authority", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    const folder = await mkdtemp(path.join(os.tmpdir(), "claude-project-"));
    const otherFolder = await mkdtemp(path.join(os.tmpdir(), "claude-project-"));
    await writeContextSessionResumePointer(root, {
      actionId: "action-1",
      folder,
      sessionId: "session-1",
      sourceLaunchId: "launch-1",
      capturedAt: 123
    });

    await expect(
      readContextSessionResumePointer(root, "action-1", otherFolder)
    ).resolves.toBeUndefined();
  });

  it("refreshes the pointer from matching status-line snapshots only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    const folder = await mkdtemp(path.join(os.tmpdir(), "claude-project-"));
    const otherFolder = await mkdtemp(path.join(os.tmpdir(), "claude-project-"));

    await expect(
      refreshResumePointerFromSnapshot(
        root,
        {
          schemaVersion: 2,
          actionId: "action-1",
          launchId: "launch-1",
          sessionId: "session-1",
          projectDir: otherFolder,
          capturedAt: 123,
          context: { usedPercentage: 1 }
        },
        folder
      )
    ).resolves.toBeUndefined();
    await expect(
      refreshResumePointerFromSnapshot(
        root,
        {
          schemaVersion: 2,
          actionId: "action-1",
          launchId: "launch-1",
          sessionId: "session-1",
          projectDir: folder,
          capturedAt: 123,
          context: { usedPercentage: 1 }
        },
        folder
      )
    ).resolves.toMatchObject({ sessionId: "session-1" });
  });

  it("refreshes the pointer from hook identity only for the active launch and folder", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    const folder = await mkdtemp(path.join(os.tmpdir(), "claude-project-"));
    const otherFolder = await mkdtemp(path.join(os.tmpdir(), "claude-project-"));
    await writeActiveLaunch(root, {
      schemaVersion: 2,
      actionId: "action-1",
      launchId: "launch-1",
      folder,
      startedAt: 100,
      terminal: "companion",
      processId: process.pid
    });

    await expect(
      refreshResumePointerFromIdentity(
        root,
        {
          schemaVersion: 1,
          actionId: "action-1",
          launchId: "other-launch",
          sessionId: "session-1",
          capturedAt: 123
        },
        folder
      )
    ).resolves.toBeUndefined();
    await expect(
      refreshResumePointerFromIdentity(
        root,
        {
          schemaVersion: 1,
          actionId: "action-1",
          launchId: "launch-1",
          sessionId: "session-1",
          capturedAt: 123
        },
        otherFolder
      )
    ).resolves.toBeUndefined();
    await expect(
      refreshResumePointerFromIdentity(
        root,
        {
          schemaVersion: 1,
          actionId: "action-1",
          launchId: "launch-1",
          sessionId: "session-1",
          capturedAt: 123
        },
        folder
      )
    ).resolves.toMatchObject({ sessionId: "session-1" });
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
        schemaVersion: 2,
        actionId: "action-1",
        launchId: "launch-1",
        sessionId: "session-1",
        capturedAt: 110,
        model: { displayName: "Opus 4.8", effortLevel: "xhigh" },
        context: { usedPercentage: null }
      }),
      "utf8"
    );
    await expect(
      loadCodeStartDisplayState(root, "action-1", "D:\\Projects\\Demo", FRESH_NOW)
    ).resolves.toEqual({
      kind: "starting",
      activity: "idle",
      model: { displayName: "Opus 4.8" }
    });

    await writeFile(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 2,
        actionId: "action-1",
        launchId: "launch-1",
        sessionId: "session-1",
        capturedAt: 120,
        model: { displayName: "Opus 4.8", effortLevel: "xhigh" },
        context: { usedPercentage: 47.6 }
      }),
      "utf8"
    );
    await expect(
      loadCodeStartDisplayState(root, "action-1", "D:\\Projects\\Demo", FRESH_NOW)
    ).resolves.toEqual({
      kind: "ready",
      percentage: 48,
      activity: "idle",
      model: { displayName: "Opus 4.8" }
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
      loadCodeStartDisplayState(root, "action-legacy", "D:\\Projects\\Demo", FRESH_NOW)
    ).resolves.toEqual({ kind: "closed", activity: "ended" });
  });

  it("keeps idle and user-input waits open, and closes only an ended session", async () => {
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
      schemaVersion: 2,
      actionId: "action-1",
      launchId: "launch-1",
      activity: "waiting",
      capturedAt: 110
    });

    await expect(
      loadCodeStartDisplayState(root, "action-1", "D:\\Projects\\Demo", FRESH_NOW)
    ).resolves.toEqual({ kind: "starting", activity: "waiting" });

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
      schemaVersion: 2,
      actionId: "action-1",
      launchId: "launch-1",
      activity: "idle",
      capturedAt: 130
    });

    await expect(
      loadCodeStartDisplayState(root, "action-1", "D:\\Projects\\Demo", FRESH_NOW)
    ).resolves.toEqual({ kind: "ready", percentage: 23, activity: "idle" });
    await writeContextSessionRuntime(root, {
      schemaVersion: 2,
      actionId: "action-1",
      launchId: "launch-1",
      activity: "ended",
      capturedAt: 140
    });
    await expect(
      loadCodeStartDisplayState(root, "action-1", "D:\\Projects\\Demo", FRESH_NOW)
    ).resolves.toEqual({ kind: "closed", activity: "ended" });
    await expect(readFile(contextSessionRuntimePath(root, "action-1", "launch-1"), "utf8"))
      .resolves.toContain('"activity": "ended"');
  });

  it("migrates legacy runtime meanings without leaving an idle session green", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-code-start-"));
    await writeActiveLaunch(root, {
      schemaVersion: 2,
      actionId: "action-legacy-runtime",
      launchId: "launch-legacy-runtime",
      folder: "D:\\Projects\\Demo",
      startedAt: 100,
      terminal: "powershell",
      processId: process.pid
    });
    const runtimePath = contextSessionRuntimePath(
      root,
      "action-legacy-runtime",
      "launch-legacy-runtime"
    );
    await writeFile(
      runtimePath,
      JSON.stringify({
        schemaVersion: 1,
        actionId: "action-legacy-runtime",
        launchId: "launch-legacy-runtime",
        activity: "running",
        capturedAt: 110
      }),
      "utf8"
    );

    await expect(
      loadCodeStartDisplayState(root, "action-legacy-runtime", "D:\\Projects\\Demo", FRESH_NOW)
    ).resolves.toEqual({ kind: "starting", activity: "idle" });

    await writeFile(
      runtimePath,
      JSON.stringify({
        schemaVersion: 1,
        actionId: "action-legacy-runtime",
        launchId: "launch-legacy-runtime",
        activity: "responding",
        capturedAt: 120
      }),
      "utf8"
    );
    await expect(
      loadCodeStartDisplayState(root, "action-legacy-runtime", "D:\\Projects\\Demo", FRESH_NOW)
    ).resolves.toEqual({ kind: "starting", activity: "running" });
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
      loadCodeStartDisplayState(root, "action-closed", "D:\\Projects\\Demo", FRESH_NOW)
    ).resolves.toEqual({ kind: "closed", activity: "ended" });
  });
});
