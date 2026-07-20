import { describe, expect, it } from "vitest";

import { renderUsageKey, renderUsageKeyImage } from "../src/ui/key-renderer";

describe("renderUsageKey", () => {
  it("renders the five-hour percentage and reset countdown", () => {
    const svg = renderUsageKey("fiveHour", {
      kind: "ready",
      percentage: 24,
      remaining: "2h 14m"
    });

    expect(svg).toContain("5 HOURS");
    expect(svg).toContain("24%");
    expect(svg).toContain("RESET 2h 14m");
    expect(svg).toContain("<svg");
  });

  it("renders weekly usage independently", () => {
    const svg = renderUsageKey("sevenDay", {
      kind: "ready",
      percentage: 81,
      remaining: "4d 8h"
    });

    expect(svg).toContain("WEEKLY");
    expect(svg).toContain("81%");
    expect(svg).toContain("RESET 4d 8h");
  });

  it("renders setup, waiting, and expired states without a false percentage", () => {
    expect(renderUsageKey("fiveHour", { kind: "setup" })).toContain("PRESS TO SETUP");
    expect(renderUsageKey("fiveHour", { kind: "waiting" })).toContain("RUN CLAUDE");
    const expired = renderUsageKey("fiveHour", { kind: "expired", remaining: "REFRESH" });
    expect(expired).toContain("REFRESH");
    expect(expired).not.toMatch(/\d+%/);
  });

  it("encodes the SVG as the image data URI required by Stream Deck", () => {
    const image = renderUsageKeyImage("fiveHour", {
      kind: "ready",
      percentage: 42,
      remaining: "1h 20m"
    });

    expect(image).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(image.split(",", 2)[1])).toContain("42%");
  });
});
