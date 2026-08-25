import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MODEL_PREFS_VERSION, readModelPrefs, writeModelPrefs } from "../main/model-prefs";

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
    await writeFile(
      target,
      JSON.stringify({ v: MODEL_PREFS_VERSION, model: "gpt", effort: "turbo" }),
      "utf8"
    );
    expect(await readModelPrefs(dataDir, ROOT)).toEqual({ model: undefined, effort: undefined });
  });

  it("ignores a pref an older build seeded rather than the user choosing it", async () => {
    // A saved pref outranks the default, so an unversioned file — every one of
    // which holds the opus/high-or-higher value the old build wrote on first
    // launch — would make changing the default a no-op forever.
    const target = prefsFile(ROOT);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify({ model: "opus", effort: "xhigh" }), "utf8");
    expect(await readModelPrefs(dataDir, ROOT)).toEqual({});

    // A deliberate pick made now is versioned, and survives from then on.
    await writeModelPrefs(dataDir, ROOT, { model: "opus", effort: "xhigh" });
    expect(await readModelPrefs(dataDir, ROOT)).toEqual({ model: "opus", effort: "xhigh" });
  });

  it("returns empty prefs when the file is corrupt", async () => {
    const target = prefsFile(ROOT);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "{ not json", "utf8");
    expect(await readModelPrefs(dataDir, ROOT)).toEqual({});
  });
});
