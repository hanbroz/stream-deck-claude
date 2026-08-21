import type { ITheme } from "@xterm/xterm";

/**
 * The colour themes offered in the settings popover.
 *
 * Each id matches a `:root[data-theme="…"]` block in renderer/styles.css —
 * that block is the palette, this table is only what the picker needs to draw
 * a row. The four swatch colours are ground / accent / string / function from
 * the theme's own palette, which is enough to tell twelve themes apart at a
 * glance.
 */
export type ThemeId =
  | "claude"
  | "catppuccin"
  | "tokyo-night"
  | "nord"
  | "dracula"
  | "one-dark"
  | "gruvbox"
  | "latte"
  | "solarized-light"
  | "github-light"
  | "one-light"
  | "gruvbox-light";

export type ThemeChoice = {
  id: ThemeId;
  label: string;
  /** Drives the group heading in the picker; the palette itself lives in CSS. */
  group: "dark" | "light";
  swatch: [string, string, string, string];
};

export const DEFAULT_THEME: ThemeId = "claude";

export const THEMES: readonly ThemeChoice[] = [
  { id: "claude", label: "Claude Dark", group: "dark", swatch: ["#1f1f1f", "#d97757", "#3fb950", "#569cd6"] },
  { id: "catppuccin", label: "Catppuccin Mocha", group: "dark", swatch: ["#1e1e2e", "#cba6f7", "#a6e3a1", "#89b4fa"] },
  { id: "tokyo-night", label: "Tokyo Night", group: "dark", swatch: ["#1a1b26", "#bb9af7", "#9ece6a", "#7aa2f7"] },
  { id: "nord", label: "Nord", group: "dark", swatch: ["#2e3440", "#81a1c1", "#a3be8c", "#88c0d0"] },
  { id: "dracula", label: "Dracula", group: "dark", swatch: ["#282a36", "#ff79c6", "#f1fa8c", "#50fa7b"] },
  { id: "one-dark", label: "One Dark Pro", group: "dark", swatch: ["#282c34", "#c678dd", "#98c379", "#61afef"] },
  { id: "gruvbox", label: "Gruvbox Dark", group: "dark", swatch: ["#282828", "#fb4934", "#b8bb26", "#fabd2f"] },
  { id: "latte", label: "Catppuccin Latte", group: "light", swatch: ["#eff1f5", "#8839ef", "#40a02b", "#1e66f5"] },
  { id: "solarized-light", label: "Solarized Light", group: "light", swatch: ["#fdf6e3", "#d33682", "#2aa198", "#268bd2"] },
  { id: "github-light", label: "GitHub Light", group: "light", swatch: ["#ffffff", "#cf222e", "#0a3069", "#8250df"] },
  { id: "one-light", label: "One Light", group: "light", swatch: ["#fafafa", "#a626a4", "#50a14f", "#4078f2"] },
  { id: "gruvbox-light", label: "Gruvbox Light", group: "light", swatch: ["#fbf1c7", "#9d0006", "#79740e", "#b57614"] }
];

export const GROUP_LABELS: Record<ThemeChoice["group"], string> = {
  dark: "다크",
  light: "라이트"
};

/** Nudge a colour toward white (amount > 0) or black (amount < 0). */
function shade(colour: string, amount: number): string {
  const target = amount > 0 ? 255 : 0;
  const weight = Math.abs(amount);
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(colour.slice(offset, offset + 2), 16);
    return Math.round(value + (target - value) * weight);
  });

  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}
/**
 * The colours xterm paints with. It cannot read CSS variables, so the palette
 * is copied out of the stylesheet — and only literal tokens are read, because a
 * derived color-mix() one comes back unresolved.
 *
 * All sixteen ANSI slots are set, not just the ground: xterm's defaults assume
 * a dark background, so on a light theme the yellows and oranges a shell prints
 * for progress lines vanish into the page. Bright variants are pushed AWAY from
 * the ground — lighter on a dark theme, darker on a light one — which is the
 * opposite of what "bright" literally means but the only way the emphasis reads.
 */
export function terminalPalette(
  token: (name: string) => string,
  group: ThemeChoice["group"]
): ITheme {
  const light = group === "light";
  const emphasise = (colour: string): string => shade(colour, light ? -0.22 : 0.22);
  const base = {
    red: token("--red"),
    green: token("--green"),
    yellow: token("--yellow"),
    blue: token("--blue"),
    magenta: token("--magenta"),
    cyan: token("--cyan")
  };

  return {
    background: token("--sunken"),
    foreground: token("--text"),
    cursor: token("--text-soft"),
    // 8-digit hex: the selection stays translucent so the text under it reads.
    selectionBackground: `${token("--accent")}55`,
    // "black" and "white" are both foreground slots in practice, so on a light
    // theme both have to stay dark enough to read.
    black: light ? token("--text-hi") : token("--line-strong"),
    brightBlack: token("--muted"),
    white: token("--text-soft"),
    brightWhite: token("--text-hi"),
    ...base,
    brightRed: emphasise(base.red),
    brightGreen: emphasise(base.green),
    brightYellow: emphasise(base.yellow),
    brightBlue: emphasise(base.blue),
    brightMagenta: emphasise(base.magenta),
    brightCyan: emphasise(base.cyan)
  };
}

/**
 * Anything that is not a known id falls back to the default, so a stale or
 * hand-edited localStorage value cannot leave the app on an undefined palette
 * (which would render every token as its initial value — i.e. unstyled).
 */
export function normalizeThemeId(value: unknown): ThemeId {
  return THEMES.some((theme) => theme.id === value) ? (value as ThemeId) : DEFAULT_THEME;
}
