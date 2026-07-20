import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builtBridge = path.join(
  projectRoot,
  "com.hanbroz.claude-usage.sdPlugin",
  "bridge",
  "statusline-bridge.js"
);

function runBridge(scriptPath, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-usage-deck-verify-"));
try {
  const bridgePath = path.join(tempRoot, "statusline-bridge.js");
  const forwarderPath = path.join(tempRoot, "forwarder.cjs");
  await copyFile(builtBridge, bridgePath);
  await writeFile(
    forwarderPath,
    "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('HUD_FORWARD_OK'));\n",
    "utf8"
  );
  await writeFile(
    path.join(tempRoot, "bridge-config.json"),
    `${JSON.stringify({ originalCommand: `"${process.execPath}" "${forwarderPath}"` }, null, 2)}\n`,
    "utf8"
  );

  const firstInput = {
    session_id: "session-code-start",
    workspace: { project_dir: "D:\\Projects\\Demo" },
    context_window: {
      used_percentage: 41.7,
      total_input_tokens: 12_345,
      context_window_size: 200_000
    },
    prompt: "must-not-be-cached",
    rate_limits: {
      five_hour: { used_percentage: 31.2, resets_at: 1_900_000_000 },
      seven_day: { used_percentage: 64.8, resets_at: 1_900_500_000 }
    }
  };
  const firstRun = await runBridge(bridgePath, firstInput, {
    CLAUDE_STREAM_DECK_BINDING_ID: "binding-1",
    CLAUDE_STREAM_DECK_LAUNCH_ID: "launch-1"
  });
  assert.equal(firstRun.code, 0);
  assert.equal(firstRun.stdout, "HUD_FORWARD_OK");
  assert.equal(firstRun.stderr, "");

  const firstCache = JSON.parse(await readFile(path.join(tempRoot, "usage.json"), "utf8"));
  assert.deepEqual(Object.keys(firstCache).sort(), ["capturedAt", "rateLimits", "schemaVersion"]);
  assert.deepEqual(Object.keys(firstCache.rateLimits).sort(), ["fiveHour", "sevenDay"]);
  assert.equal(JSON.stringify(firstCache).includes("must-not-be-cached"), false);
  assert.equal(JSON.stringify(firstCache).includes("session-code-start"), false);

  const hash = (value) => createHash("sha256").update(value, "utf8").digest("hex");
  const contextPath = path.join(
    tempRoot,
    "context-sessions",
    hash("binding-1"),
    `${hash("launch-1")}.json`
  );
  const contextCache = JSON.parse(await readFile(contextPath, "utf8"));
  assert.deepEqual(Object.keys(contextCache).sort(), [
    "actionId",
    "capturedAt",
    "context",
    "launchId",
    "projectDir",
    "schemaVersion",
    "sessionId"
  ]);
  assert.equal(contextCache.context.usedPercentage, 41.7);
  assert.equal(contextCache.actionId, "binding-1");
  assert.equal(contextCache.sessionId, "session-code-start");
  assert.equal(JSON.stringify(contextCache).includes("must-not-be-cached"), false);

  const runtimePath = path.join(
    tempRoot,
    "context-sessions",
    hash("binding-1"),
    `${hash("launch-1")}.state.json`
  );
  const runningState = JSON.parse(await readFile(runtimePath, "utf8"));
  assert.deepEqual(Object.keys(runningState).sort(), [
    "actionId",
    "activity",
    "capturedAt",
    "launchId",
    "schemaVersion"
  ]);
  assert.equal(runningState.activity, "running");

  const respondingRun = await runBridge(
    bridgePath,
    {
      session_id: "session-code-start",
      hook_event_name: "UserPromptSubmit",
      prompt: "must-not-be-cached"
    },
    {
      CLAUDE_STREAM_DECK_ACTION_ID: "action-1",
      CLAUDE_STREAM_DECK_BINDING_ID: "binding-1",
      CLAUDE_STREAM_DECK_LAUNCH_ID: "launch-1"
    }
  );
  assert.equal(respondingRun.code, 0);
  assert.equal(respondingRun.stdout, "");
  assert.equal(respondingRun.stderr, "");
  const respondingState = JSON.parse(await readFile(runtimePath, "utf8"));
  assert.equal(respondingState.activity, "responding");
  assert.equal(JSON.stringify(respondingState).includes("must-not-be-cached"), false);

  const stoppedRun = await runBridge(
    bridgePath,
    {
      session_id: "session-code-start",
      hook_event_name: "Stop",
      last_assistant_message: "must-not-be-cached"
    },
    {
      CLAUDE_STREAM_DECK_ACTION_ID: "action-1",
      CLAUDE_STREAM_DECK_BINDING_ID: "binding-1",
      CLAUDE_STREAM_DECK_LAUNCH_ID: "launch-1"
    }
  );
  assert.equal(stoppedRun.code, 0);
  assert.equal(stoppedRun.stdout, "");
  const stoppedState = JSON.parse(await readFile(runtimePath, "utf8"));
  assert.equal(stoppedState.activity, "running");
  assert.equal(JSON.stringify(stoppedState).includes("must-not-be-cached"), false);

  const secondRun = await runBridge(bridgePath, {
    rate_limits: {
      five_hour: { used_percentage: 32.5, resets_at: 1_900_000_000 },
      seven_day: { used_percentage: 65.1, resets_at: 1_900_500_000 }
    }
  });
  assert.equal(secondRun.code, 0);
  const secondCache = JSON.parse(await readFile(path.join(tempRoot, "usage.json"), "utf8"));
  assert.equal(secondCache.rateLimits.fiveHour.usedPercentage, 32.5);

  process.stdout.write(
    "Bridge verification successful: safe usage/context/activity caches, hook isolation, session isolation, overwrite, and HUD forwarding.\n"
  );
} finally {
  const normalizedTemp = path.resolve(tempRoot);
  const normalizedBase = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (!normalizedTemp.startsWith(normalizedBase) || !path.basename(normalizedTemp).startsWith("claude-usage-deck-verify-")) {
    throw new Error(`Refusing to remove unexpected verification directory: ${normalizedTemp}`);
  }
  await rm(normalizedTemp, { recursive: true, force: true });
}
