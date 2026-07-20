import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { renderCodeStartKey, renderCodeStartKeyImage } from "../src/ui/code-start-renderer";

describe("renderCodeStartKey", () => {
  it("renders only the project name, smaller CTX value, and usage bar", () => {
    const ready = renderCodeStartKey("Project A", {
      kind: "ready",
      percentage: 42,
      activity: "running"
    });

    expect(ready).toContain('font-size="25" font-weight="800"');
    expect(ready).toContain(">Project A</text>");
    expect(ready).toContain('font-size="17" font-weight="800">CTX 42%</text>');
    expect(ready.match(/<text\b/g)).toHaveLength(2);
    expect(ready).toContain('data-role="context-track"');
    expect(ready).toContain('data-role="context-fill"');
    for (const disallowed of [
      "CODE START",
      "PRESS START",
      "STARTING",
      "ERROR",
      "SET FOLDER",
      "OPEN SETTINGS"
    ]) {
      expect(ready).not.toContain(disallowed);
    }
  });

  it.each(["setup", "idle", "starting", "error"] as const)(
    "keeps the same three-element layout for the %s state",
    (kind) => {
      const svg = renderCodeStartKey("Project A", { kind, activity: "idle" });

      expect(svg).toContain("Project A");
      expect(svg).toContain("CTX --%");
      expect(svg.match(/<text\b/g)).toHaveLength(2);
      expect(svg).toContain('data-role="context-track"');
      expect(svg).toContain('data-role="context-fill"');
      expect(svg).toContain('data-role="context-fill" x="18" y="101" width="0"');
    }
  );

  it("escapes and truncates long project names", () => {
    const svg = renderCodeStartKey("Alpha & <Long Project>", {
      kind: "idle",
      activity: "waiting"
    });

    expect(svg).toContain("Alpha &amp; &lt;");
    expect(svg).toContain("…");
    expect(svg).not.toContain("<Long Project>");
  });

  it("fits a wide 25px project name inside the key", () => {
    const svg = renderCodeStartKey("MY PROJECT", {
      kind: "ready",
      percentage: 42,
      activity: "running"
    });

    expect(svg).toContain('font-size="25" font-weight="800" textLength="108"');
    expect(svg).toContain('lengthAdjust="spacingAndGlyphs">MY PROJECT</text>');
  });

  it("returns an encoded Stream Deck image", () => {
    const image = renderCodeStartKeyImage("Project A", {
      kind: "ready",
      percentage: 67,
      activity: "running"
    });
    expect(image).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(image.split(",", 2)[1])).toContain("CTX 67%");
  });

  it.each([
    ["running", "#60d3a3"],
    ["idle", "#ff6b74"],
    ["waiting", "#70c7ff"]
  ] as const)("renders %s CTX text as %s", (activity, color) => {
    const svg = renderCodeStartKey("Project A", {
      kind: "ready",
      percentage: 42,
      activity
    });

    expect(svg).toContain(`data-role="context-text"`);
    expect(svg).toContain(`data-role="context-text" x="72" y="84" text-anchor="middle" fill="${color}"`);
    expect(svg).toContain('data-role="context-fill" x="18" y="101" width="45"');
  });

  it("replaces all context content with Closed after the launched session ends", () => {
    const svg = renderCodeStartKey("Project A", {
      kind: "closed",
      activity: "ended"
    });

    expect(svg).toContain(">Project A</text>");
    expect(svg).toContain(">Closed</text>");
    expect(svg.match(/<text\b/g)).toHaveLength(2);
    expect(svg).not.toContain("CTX");
    expect(svg).not.toContain('data-role="context-track"');
    expect(svg).not.toContain('data-role="context-fill"');
  });

  it("uses the same three-element contract for the manifest fallback image", async () => {
    const svg = await readFile(
      path.resolve("com.hanbroz.claude-usage.sdPlugin/imgs/actions/code-start/key.svg"),
      "utf8"
    );

    expect(svg.match(/<text\b/g)).toHaveLength(2);
    expect(svg).toContain("PROJECT");
    expect(svg).toContain("CTX --%");
    expect(svg).toContain('data-role="context-text" x="72" y="84" text-anchor="middle" fill="#ff6b74"');
    expect(svg).toContain('data-role="context-track"');
    expect(svg).not.toContain("CODE START");
    expect(svg).not.toContain("SET FOLDER");
  });
});
