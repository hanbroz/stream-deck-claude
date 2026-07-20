import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractUsageCache } from "../domain/rate-limits";
import {
  extractContextSessionRuntime,
  extractContextSessionSnapshot
} from "../domain/context-session";
import {
  writeContextSessionRuntime,
  writeContextSessionSnapshot
} from "../io/context-session-cache";

type BridgeConfig = {
  originalCommand?: string | null;
};

function sessionBindingId(): string | undefined {
  return (
    process.env.CLAUDE_STREAM_DECK_BINDING_ID ??
    process.env.CLAUDE_STREAM_DECK_ACTION_ID
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function writeUsageCache(dataDir: string, payload: unknown): Promise<void> {
  const cache = extractUsageCache(payload);
  if (!cache) {
    return;
  }

  const cachePath = path.join(dataDir, "usage.json");
  const temporaryPath = `${cachePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  await rename(temporaryPath, cachePath);
}

async function writeContextCache(dataDir: string, payload: unknown): Promise<void> {
  const snapshot = extractContextSessionSnapshot(
    payload,
    sessionBindingId(),
    process.env.CLAUDE_STREAM_DECK_LAUNCH_ID
  );
  if (snapshot) {
    await writeContextSessionSnapshot(dataDir, snapshot);
  }
}

async function writeRuntimeCache(dataDir: string, payload: unknown): Promise<void> {
  const runtime = extractContextSessionRuntime(
    payload,
    sessionBindingId(),
    process.env.CLAUDE_STREAM_DECK_LAUNCH_ID
  );
  if (runtime) {
    await writeContextSessionRuntime(dataDir, runtime);
  }
}

async function writeStatusLineCaches(dataDir: string, payload: unknown): Promise<void> {
  await Promise.all([
    writeUsageCache(dataDir, payload),
    writeContextCache(dataDir, payload),
    writeRuntimeCache(dataDir, payload)
  ]);
}

async function forwardToOriginal(
  originalCommand: string | null | undefined,
  input: string
): Promise<number> {
  if (!originalCommand || process.env.CLAUDE_USAGE_DECK_FORWARDING === "1") {
    return 0;
  }

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(originalCommand, {
      shell: true,
      windowsHide: true,
      env: {
        ...process.env,
        CLAUDE_USAGE_DECK_FORWARDING: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.on("error", reject);
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.stdin.end(input);
    child.on("close", (code) => resolve(code ?? 0));
  });
}

async function main(): Promise<void> {
  const dataDir = path.dirname(fileURLToPath(import.meta.url));
  const input = await readStdin();
  let payload: unknown;
  try {
    payload = JSON.parse(input) as unknown;
  } catch (error) {
    process.stderr.write(`Claude Usage Deck input error: ${(error as Error).message}\n`);
  }

  const payloadRecord =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  const isHook = typeof payloadRecord?.hook_event_name === "string";
  if (payload !== undefined) {
    try {
      if (isHook) {
        await writeRuntimeCache(dataDir, payload);
      } else {
        await writeStatusLineCaches(dataDir, payload);
      }
    } catch (error) {
      process.stderr.write(`Claude Usage Deck cache error: ${(error as Error).message}\n`);
    }
  }

  if (isHook) {
    return;
  }

  let config: BridgeConfig = {};
  try {
    config = JSON.parse(await readFile(path.join(dataDir, "bridge-config.json"), "utf8")) as BridgeConfig;
  } catch (error) {
    process.stderr.write(`Claude Usage Deck config error: ${(error as Error).message}\n`);
  }

  process.exitCode = await forwardToOriginal(config.originalCommand, input);
}

void main().catch((error: unknown) => {
  process.stderr.write(`Claude Usage Deck bridge error: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
