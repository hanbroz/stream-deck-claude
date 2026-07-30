import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { formatBuildStamp, pluginBuildLabel } from "../src/build-version";

/** Lay out a bundle the way the packaged plugin does: bin/plugin.js + manifest.json. */
async function fakePlugin(manifest: string | undefined, builtAt: Date): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-plugin-build-"));
  await mkdir(path.join(root, "bin"), { recursive: true });
  const bundlePath = path.join(root, "bin", "plugin.js");
  await writeFile(bundlePath, "// bundle\n", "utf8");
  await utimes(bundlePath, builtAt, builtAt);
  if (manifest !== undefined) {
    await writeFile(path.join(root, "manifest.json"), manifest, "utf8");
  }
  return bundlePath;
}

describe("plugin build label", () => {
  it("formats a build stamp with zero padding", () => {
    expect(formatBuildStamp(new Date(2026, 6, 30, 17, 36))).toBe("2026.07.30.17.36");
    expect(formatBuildStamp(new Date(2026, 0, 5, 9, 4))).toBe("2026.01.05.09.04");
  });

  it("reports the manifest version and the bundle's own build time", async () => {
    const builtAt = new Date(2026, 6, 30, 17, 36);
    const bundlePath = await fakePlugin(JSON.stringify({ Version: "0.7.1.0" }), builtAt);

    expect(pluginBuildLabel(bundlePath)).toBe("0.7.1.0 (build 2026.07.30.17.36)");
    await rm(path.dirname(path.dirname(bundlePath)), { recursive: true, force: true });
  });

  it("still starts when the manifest is missing or unreadable", async () => {
    const builtAt = new Date(2026, 6, 30, 17, 36);
    const noManifest = await fakePlugin(undefined, builtAt);
    expect(pluginBuildLabel(noManifest)).toBe("unknown (build 2026.07.30.17.36)");

    const brokenManifest = await fakePlugin("{ not json", builtAt);
    expect(pluginBuildLabel(brokenManifest)).toBe("unknown (build 2026.07.30.17.36)");

    // A bundle path that does not exist must not throw either.
    expect(pluginBuildLabel(path.join(os.tmpdir(), "no-such-bundle", "bin", "plugin.js")))
      .toBe("unknown (build unknown)");

    await rm(path.dirname(path.dirname(noManifest)), { recursive: true, force: true });
    await rm(path.dirname(path.dirname(brokenManifest)), { recursive: true, force: true });
  });
});
