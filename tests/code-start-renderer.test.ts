import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { renderCodeStartKey, renderCodeStartKeyImage } from "../src/ui/code-start-renderer";

describe("renderCodeStartKey", () => {
  it("renders only the project name, current model, and usage bar", () => {
    const ready = renderCodeStartKey("Project A", {
      kind: "ready",
      percentage: 42,
      activity: "running",
      model: { displayName: "Opus 4.8" }
    });

    expect(ready).toContain('font-size="25" font-weight="800"');
    expect(ready).toContain(">Project A</text>");
    expect(ready).toContain('font-size="17" font-weight="800">Opus 4.8</text>');
    expect(ready).not.toContain('textLength="108" lengthAdjust="spacingAndGlyphs">Opus 4.8</text>');
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

  // Only states that mean "an app is open" may draw the model line and context
  // bar. `idle` used to be in this list, which is how a project with no app
  // running still rendered as a live session.
  it.each(["setup", "starting", "error"] as const)(
    "keeps the same three-element layout for the %s state",
    (kind) => {
      const svg = renderCodeStartKey("Project A", { kind, activity: "idle" });

      expect(svg).toContain("Project A");
      expect(svg).toContain("MODEL --");
      expect(svg.match(/<text\b/g)).toHaveLength(2);
      expect(svg).toContain('data-role="context-track"');
      expect(svg).toContain('data-role="context-fill"');
      expect(svg).toContain('data-role="context-fill" x="18" y="101" width="0"');
    }
  );

  it("escapes and truncates long project names", () => {
    const svg = renderCodeStartKey("Alpha & <Long Project>", {
      kind: "starting",
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
      activity: "running",
      model: { displayName: "Opus 4.8" }
    });
    expect(image).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(image.split(",", 2)[1])).toContain("Opus 4.8");
  });

  it("escapes model text before rendering it into SVG", () => {
    const svg = renderCodeStartKey("Project A", {
      kind: "ready",
      percentage: 42,
      activity: "running",
      model: { displayName: "Opus & <Beta>" }
    });

    expect(svg).toContain("Opus &amp; &lt;Beta&gt;");
    expect(svg).not.toContain("Opus & <Beta>");
  });

  it.each([
    ["running", "#60d3a3"],
    ["idle", "#ff6b74"],
    ["waiting", "#70c7ff"]
  ] as const)("renders %s model text as %s", (activity, color) => {
    // Frame 1 is the dark phase of the waiting blink — the key's normal look.
    const svg = renderCodeStartKey("Project A", {
      kind: "ready",
      percentage: 42,
      activity,
      model: { displayName: "Opus 4.8" }
    }, 1);

    expect(svg).toContain(`data-role="model-text"`);
    expect(svg).toContain(`data-role="model-text" x="72" y="84" text-anchor="middle" fill="${color}"`);
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
    expect(svg).not.toContain('data-role="model-text"');
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
    expect(svg).toContain("MODEL --");
    expect(svg).toContain('data-role="model-text" x="72" y="84" text-anchor="middle" fill="#ff6b74"');
    expect(svg).toContain('data-role="context-track"');
    expect(svg).not.toContain("CODE START");
    expect(svg).not.toContain("SET FOLDER");
  });
});

describe("running sweep animation", () => {
  const base = {
    kind: "ready" as const,
    percentage: 40,
    model: { displayName: "Opus 5" }
  };

  it("draws a sweep segment only while the session is running", () => {
    const running = renderCodeStartKey("DEMO", { ...base, activity: "running" }, 0);
    expect(running).toContain('data-role="context-sweep"');
    const waiting = renderCodeStartKey("DEMO", { ...base, activity: "waiting" }, 0);
    expect(waiting).not.toContain("context-sweep");
  });

  it("moves the sweep as the frame advances and wraps around", () => {
    const xAt = (frame: number): string =>
      /data-role="context-sweep" x="(\d+)"/.exec(
        renderCodeStartKey("DEMO", { ...base, activity: "running" }, frame)
      )?.[1] ?? "";
    expect(xAt(0)).toBe("18");
    expect(xAt(1)).not.toBe(xAt(0));
    expect(xAt(6)).toBe(xAt(0)); // 6-step cycle
  });
});

describe("waiting blink", () => {
  const base = {
    kind: "ready" as const,
    percentage: 40,
    model: { displayName: "Opus 5" }
  };

  const backgroundOf = (svg: string): string =>
    /data-role="key-bg"[^>]*fill="([^"]+)"/.exec(svg)?.[1] ?? "";
  const modelColorOf = (svg: string): string =>
    /data-role="model-text"[^>]*fill="([^"]+)"/.exec(svg)?.[1] ?? "";

  it("flashes the whole key body to pastel blue while waiting", () => {
    const on = renderCodeStartKey("DEMO", { ...base, activity: "waiting" }, 0);
    expect(backgroundOf(on)).toBe("#aacfe6");
    expect(modelColorOf(on)).toBe("#175d84"); // dark text stays readable on pastel
    const off = renderCodeStartKey("DEMO", { ...base, activity: "waiting" }, 1);
    expect(backgroundOf(off)).toBe("#17130f");
    expect(modelColorOf(off)).toBe("#70c7ff"); // normal waiting look
    // 1s-on/1s-off: the two-frame cycle repeats.
    expect(backgroundOf(renderCodeStartKey("DEMO", { ...base, activity: "waiting" }, 2))).toBe("#aacfe6");
    // The border never blinks — the bezel crops it at shallow angles.
    expect(on).toContain('stroke="#40342b"');
  });

  it("keeps the background static for running and idle sessions", () => {
    for (const activity of ["running", "idle"] as const) {
      for (const frame of [0, 1]) {
        expect(backgroundOf(renderCodeStartKey("DEMO", { ...base, activity }, frame))).toBe("#17130f");
      }
    }
  });
});
