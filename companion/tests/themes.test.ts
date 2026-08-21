import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_THEME,
  normalizeThemeId,
  terminalPalette,
  THEMES,
  type ThemeId
} from "../renderer/themes";

const styles = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "renderer", "styles.css"),
  "utf8"
);

function blockFor(selector: string): string {
  return styles.slice(styles.indexOf(selector)).split("}")[0];
}

function blockForTheme(id: ThemeId): string {
  return id === DEFAULT_THEME ? blockFor(":root {") : blockFor(`:root[data-theme="${id}"]`);
}

function paletteOf(id: ThemeId): Record<string, string> {
  const palette: Record<string, string> = {};
  for (const [, token, value] of blockForTheme(id).matchAll(/^\s+--([a-z0-9-]+): (#[0-9a-f]{6});/gm)) {
    palette[token] = value;
  }
  return palette;
}

function relativeLuminance(colour: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(colour.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

describe("colour themes", () => {
  // The failure this guards: a theme listed in the picker with no matching CSS
  // block leaves every token at its initial value, i.e. an unstyled window.
  it("has a stylesheet block for every theme in the picker", () => {
    const missing = THEMES.filter((theme) => theme.id !== DEFAULT_THEME).filter(
      (theme) => !styles.includes(`:root[data-theme="${theme.id}"]`)
    );

    expect(missing.map((theme) => theme.id)).toEqual([]);
  });

  // Each block must restate the whole palette; a token left out would fall back
  // to the default theme's value and show up as one stray Claude-orange control.
  it("declares the same palette tokens in every theme block", () => {
    const tokensOf = (block: string): string[] =>
      [...block.matchAll(/^\s+(--[a-z0-9-]+):/gm)].map((match) => match[1]).sort();

    // The default palette ends where the derived tokens begin.
    const expected = tokensOf(blockFor(":root {").split("/* ── Derived")[0]);
    expect(expected.length).toBeGreaterThan(15);

    for (const theme of THEMES) {
      if (theme.id === DEFAULT_THEME) {
        continue;
      }
      expect(tokensOf(blockForTheme(theme.id)), theme.id).toEqual(expected);
    }
  });

  // Chromium paints <select> and the other native controls itself; without this
  // a light theme keeps a black dropdown sitting in a white composer.
  it("flips color-scheme in every light theme block", () => {
    for (const theme of THEMES.filter((choice) => choice.group === "light")) {
      expect(blockForTheme(theme.id), theme.id).toContain("color-scheme: light");
    }
  });

  /*
   * Light palettes are the ones that need watching: the upstream themes pick
   * these colours for syntax inside a code pane, and several are far too pale
   * once they carry a UI label on the window ground. The values in the
   * stylesheet were darkened until they cleared AA, and this pins that.
   *
   * The dark palettes are checked at the looser 3.6:1 because their --muted is
   * the theme's own comment grey, drawn dimmer than AA on purpose — but four of
   * them started below even that and were lifted, since --muted labels rows and
   * counts here rather than commented-out code.
   */
  it.each([
    ["light", 4.5],
    ["dark", 3.6]
  ])("keeps %s theme text readable on its own ground", (group, floor) => {
    const failures: string[] = [];

    for (const theme of THEMES.filter((choice) => choice.group === group)) {
      const palette = paletteOf(theme.id);
      const grounds = [palette.bg, palette.sunken];
      for (const token of [
        "text",
        "text-soft",
        "text-hi",
        "muted",
        "accent",
        "yellow",
        "green",
        "red",
        "blue",
        "cyan",
        "magenta"
      ]) {
        // --sunken carries the terminal and the code blocks, --bg the rest.
        const ratio = Math.min(...grounds.map((ground) => contrast(palette[token], ground)));
        if (ratio < floor) {
          failures.push(`${theme.id} --${token} ${ratio.toFixed(2)}:1`);
        }
      }

      // Ink sitting on a filled accent or destructive button.
      for (const [ink, fill] of [
        ["accent-fg", "accent"],
        ["danger-fg", "danger"]
      ]) {
        const inkValue = palette[ink] ?? paletteOf(DEFAULT_THEME)[ink] ?? "#ffffff";
        const ratio = contrast(inkValue, palette[fill]);
        if (ratio < 4.5) {
          failures.push(`${theme.id} --${ink} on --${fill} ${ratio.toFixed(2)}:1`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  /*
   * The bug this pins: xterm's stock ANSI palette is built for a dark
   * background, so on a light theme the yellow a shell prints for its progress
   * lines came out invisible. Every slot a program can pick as a foreground has
   * to survive on that theme's terminal ground.
   */
  it("keeps every ANSI colour legible on the terminal ground", () => {
    const failures: string[] = [];

    for (const theme of THEMES) {
      const palette = paletteOf(theme.id);
      const colours = terminalPalette((name) => palette[name.slice(2)], theme.group);
      const floor = theme.group === "light" ? 4.5 : 3.6;

      const ground = colours.background as string;
      for (const [slot, colour] of Object.entries(colours) as [string, string][]) {
        // ANSI black is a background slot — every dark terminal, this one and
        // every other, draws it invisible against its own ground on purpose.
        if (slot === "background" || slot === "selectionBackground" || slot === "black") {
          continue;
        }
        const ratio = contrast(colour, ground);
        if (ratio < floor) {
          failures.push(`${theme.id} ${slot} ${ratio.toFixed(2)}:1`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("falls back to the default for an unknown or missing stored value", () => {
    expect(normalizeThemeId(null)).toBe(DEFAULT_THEME);
    expect(normalizeThemeId("solarized")).toBe(DEFAULT_THEME);
    expect(normalizeThemeId(42)).toBe(DEFAULT_THEME);
    expect(normalizeThemeId("nord")).toBe("nord");
  });
});
