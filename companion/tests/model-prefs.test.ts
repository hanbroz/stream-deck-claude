import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readModelPrefs, writeModelPrefs } from "../main/model-prefs";

let dataDir: string;
const ROOT = "D:\\projects\\demo";

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "companion-prefs-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function prefsFile(rootPath: string): string {
  const digest = createHash("sha256").update(rootPath, "utf8").digest("hex");
  return path.join(dataDir, "model-prefs", `${digest}.json`);
}

describe("model-prefs", () => {
  it("returns empty prefs when nothing is saved", async () => {
    expect(await readModelPrefs(dataDir, ROOT)).toEqual({});
  });

  it("round-trips the applied model and effort", async () => {
    await writeModelPrefs(dataDir, ROOT, { model: "sonnet", effort: "xhigh" });
    expect(await readModelPrefs(dataDir, ROOT)).toEqual({ model: "sonnet", effort: "xhigh" });
  });

  it("keeps prefs separate per folder", async () => {
    await writeModelPrefs(dataDir, ROOT, { model: "haiku", effort: "low" });
    await writeModelPrefs(dataDir, "D:\\projects\\other", { model: "opus", effort: "max" });
    expect(await readModelPrefs(dataDir, ROOT)).toEqual({ model: "haiku", effort: "low" });
    expect(await readModelPrefs(dataDir, "D:\\projects\\other")).toEqual({ model: "opus", effort: "max" });
  });

  it("drops values outside the known model/effort sets", async () => {
    const target = prefsFile(ROOT);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify({ model: "gpt", effort: "turbo" }), "utf8");
    expect(await readModelPrefs(dataDir, ROOT)).toEqual({ model: undefined, effort: undefined });
  });

  it("returns empty prefs when the file is corrupt", async () => {
    const target = prefsFile(ROOT);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "{ not json", "utf8");
    expect(await readModelPrefs(dataDir, ROOT)).toEqual({});
  });
});
