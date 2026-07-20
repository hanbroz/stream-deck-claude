import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { defaultUsageDataDir } from "../src/bridge/paths";
import type { RateLimitKind } from "../src/domain/rate-limits";
import { loadUsageDisplayState } from "../src/services/display-loader";
import { renderUsageKey } from "../src/ui/key-renderer";
import { renderCodeStartKey } from "../src/ui/code-start-renderer";

const outputDir = path.resolve(process.argv[2] ?? "dist/previews");
const cachePath = path.join(defaultUsageDataDir(), "usage.json");
const previews: Array<{ kind: RateLimitKind; filename: string }> = [
  { kind: "fiveHour", filename: "five-hour.svg" },
  { kind: "sevenDay", filename: "weekly.svg" }
];

await mkdir(outputDir, { recursive: true });
for (const preview of previews) {
  const state = await loadUsageDisplayState(preview.kind, {
    cachePath,
    bridgeInstalled: true
  });
  await writeFile(
    path.join(outputDir, preview.filename),
    `${renderUsageKey(preview.kind, state)}\n`,
    "utf8"
  );
  process.stdout.write(`${preview.filename}: ${JSON.stringify(state)}\n`);
}

const codeStartPreviews = [
  { filename: "code-start.svg", activity: "running" },
  { filename: "code-start-waiting.svg", activity: "waiting" },
  { filename: "code-start-responding.svg", activity: "responding" }
] as const;
for (const preview of codeStartPreviews) {
  const state = {
    kind: "ready",
    percentage: 42,
    activity: preview.activity
  } as const;
  await writeFile(
    path.join(outputDir, preview.filename),
    `${renderCodeStartKey("MY PROJECT", state)}\n`,
    "utf8"
  );
  process.stdout.write(`${preview.filename}: ${JSON.stringify(state)}\n`);
}

const closedState = { kind: "closed", activity: "waiting" } as const;
await writeFile(
  path.join(outputDir, "code-start-closed.svg"),
  `${renderCodeStartKey("MY PROJECT", closedState)}\n`,
  "utf8"
);
process.stdout.write(`code-start-closed.svg: ${JSON.stringify(closedState)}\n`);
