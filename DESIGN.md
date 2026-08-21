# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-08-21
- Primary product surfaces: Claude Deck Companion desktop workspace
- Evidence reviewed: `companion/ClaudeCodeApp.dc.html`, `companion/renderer/index.html`, `companion/renderer/styles.css`, `companion/renderer/themes.ts`, `README.md`, and the supplied `Stream Deck Terminal Electron App-handoff.zip`

## Brand

- Personality: focused, calm, precise, developer-first
- Trust signals: visible project root, explicit session state, safe file boundaries, predictable terminal controls
- Avoid: generic dashboard cards, bright gradients, hidden destructive actions, and unrelated decorative chrome

## Product goals

- Goals: make Claude Code comfortable for Korean text entry, image paste, text copy, session resume, and project-file navigation while matching the supplied Visual Studio-style screen
- Non-goals: replacing Claude Code's terminal semantics, destructive file operations, or taking over another status-line owner
- Success signals: the live renderer preserves the reference's title bar, explorer, session tabs, console, optional terminal split, context menu, and composer proportions

## Personas and jobs

- Primary personas: Windows developers using Claude Code from Stream Deck
- User jobs: open a project, resume the last Claude session, inspect files, create a file or folder, send Korean prompts, and paste screenshots
- Key contexts of use: keyboard-heavy desktop work with a project window beside Windows Terminal

## Information architecture

- Primary navigation: title bar -> project explorer -> session workspace -> composer
- Core routes/screens: one project-scoped Companion workspace; optional PowerShell split
- Content hierarchy: project identity, file tree, Claude session output, terminal split, prompt composer

## Design principles

- Reference fidelity first: use the imported dc.html dimensions, colors, typography, and interaction states as the visual contract
- Function in place: keep PTY, file operations, resume, copy, and image paste behind the same visual surfaces
- Quiet chrome: controls remain discoverable through the title bar, explorer context menu, session tab, and composer without adding dashboard panels

## Visual language

- Color: the reference palette — `#1f1f1f` shell, `#252526` panels, `#1e1e1e` workspace, `#d97757` orange accent, `#3fb950` running state, `#569cd6` informational state — ships as the `Claude Dark` theme and remains the default. Eleven further themes restate the same 23 palette tokens; no rule in the stylesheet names a colour directly.
- Themes: seven dark (Claude Dark, Catppuccin Mocha, Tokyo Night, Nord, Dracula, One Dark Pro, Gruvbox Dark) and five light (Catppuccin Latte, Solarized Light, GitHub Light, One Light, Gruvbox Light), chosen from the title-bar settings popover and remembered in `localStorage`
- Typography: Segoe UI Variable for chrome and Cascadia Code for console/terminal content
- Spacing/layout rhythm: 40px title bar, 36px session tabs, 260px explorer default, 23px tree rows, 34% bottom composer dock (180px minimum)
- Shape/radius/elevation: 5-12px restrained radii, 2px draggable split rules, dark 8-28px context/toast shadows
- Motion: caret blink and short toast fade only
- Imagery/iconography: compact local SVG icons; the explorer uses VS Code-like `›`/`⌄` chevrons and a vendored Material Icon Theme subset for files/folders, with no emoji-dependent navigation

## Components

- Existing components to reuse: `ClaudePtyManager`, secure path IPC, composer state, tree state, xterm terminal
- New/changed components: reference-faithful title bar, resizable explorer, session tab strip, independently resizable console/terminal split, resizable chat composer dock, context menu, toast, pinned agent board, title-bar settings popover
- Variants and states: explorer collapsed, terminal split open/closed, session idle/running/waiting/closed, focused composer, context menu open, agent board live/settled/absent, settings popover open with the active theme checked
- Token/component ownership: `companion/renderer/styles.css` owns the palettes and every derived tone; `companion/renderer/themes.ts` owns the picker list and the xterm palette derived from those tokens; `companion/renderer/index.ts` owns interaction state

## Accessibility

- Target standard: keyboard-operable desktop controls with semantic labels
- Keyboard/focus behavior: Enter sends, Shift+Enter inserts a newline, Escape cancels inline creation/context menus, splitter handles expose keyboard arrows/Home/End, focus returns to the composer after session start
- Contrast/readability: every palette is pinned by `companion/tests/themes.test.ts` — light themes clear WCAG AA (4.5:1) and dark themes 3.6:1 for text, accents and all sixteen ANSI slots, measured against both grounds a colour can land on (`--bg` and the darker `--sunken`). Several upstream palettes needed darkening for this: their values are picked for syntax inside a code pane, not for UI labels on window chrome. Ink on a filled accent or destructive button is checked separately at 4.5:1.
- Screen-reader semantics: buttons, nav/section labels, live toast, and image preview alt text
- Reduced motion and sensory considerations: no motion beyond caret/toast; each theme sets `color-scheme` to match its own polarity, so Chromium paints the native `<select>` and form chrome — which no token reaches — the right way round

## Responsive behavior

- Supported breakpoints/devices: desktop Electron window, minimum 960x640
- Layout adaptations: explorer collapses to a 40px rail; explorer, console/terminal, and composer splitters respect minimum sizes; terminal split uses the remaining workspace; composer wraps image chips
- Touch/hover differences: hover states remain supplemental; all actions have click/keyboard paths

## Interaction states

- Loading: tree rows retain their location while folders load
- Empty: console and terminal show quiet reference-style placeholder lines
- Error: toast and console message identify session/file failures without losing the workspace
- Success: toast confirms file creation, refresh, resume, copy, and external launches
- Disabled: the Claude console is output-only; prompt submission uses Enter and Shift+Enter keeps a newline
- Offline/slow network, if applicable: Claude remains a local PTY; no network-only UI state is introduced

## Content voice

- Tone: concise, technical, friendly Korean-first UI with familiar English developer labels where the reference uses them
- Terminology: Companion, Claude Code, PowerShell, Explorer, Resume, New File, New Folder, Refresh
- Microcopy rules: short labels, no status-line jargon in the main workspace, errors state the next actionable step

## Implementation constraints

- Framework/styling system: Electron + TypeScript + plain DOM/CSS + xterm
- Design-token constraints: preserve the dc.html measurements, and keep its palette as the default `Claude Dark` theme. Additional themes are palette-only: a theme is one `:root[data-theme="…"]` block restating the 23 literal tokens plus `color-scheme`, and nothing else. Everything downstream — hovers, selections, borders, washes — is derived in `:root` by mixing toward `--text`, which is what lets one set of rules serve both polarities. Never reintroduce a literal colour into a rule.
- Performance constraints: lazy-load file children and keep terminal rendering in xterm
- Compatibility constraints: Windows 10+, Electron 43, Windows Terminal `wt.exe`, secure preload IPC
- Explorer icon constraints: resolve icons locally from `companion/renderer/assets/material-icons`; keep the upstream MIT notice with the vendored SVGs and never require a runtime CDN
- Test/screenshot expectations: run Companion tests, typecheck, build, and inspect the built renderer HTML/CSS before release

## Runtime notes

- Companion startup launches Claude in structured streaming mode in the configured project root; only conversation text is rendered in the read-only Claude Console, while prompts and images are sent from the bottom composer.
- The top `TERMINAL` tab opens an embedded PowerShell PTY rooted at the configured project and accepts normal commands as a separate optional split.
- The explorer terminal action still opens an external Windows Terminal window with `wt.exe -d <project-root>`.
- The Claude console is intentionally selectable/read-only; prompts are entered only in the bottom composer.
- The header reads the project name from Code Start metadata and polls the current model/context snapshot without taking over another status-line owner.
- Subagents get a board pinned between the transcript and the status strip, from the first agent onward: one row each carrying agent type, description, the tool it is on and elapsed time. It is pinned rather than inline because a fan-out runs for minutes while the console keeps scrolling, and it is capped so it never squeezes the transcript or the strip. The board is handed to the console as the run's record when the turn ends, never at the moment an agent finishes — a background agent settles mid-way through the *next* turn, and moving it then cuts that reply in half.
- The theme is applied to `<html>` before the xterm `Terminal` is constructed, because xterm reads its colours once at construction and cannot see CSS variables afterwards. `terminalPalette()` therefore copies them out of the stylesheet on every theme change — and reads only literal palette tokens, since a derived `color-mix()` one comes back as the unresolved expression.
- xterm gets all sixteen ANSI slots, not just the ground. Its defaults assume a dark background, so a light theme alone left the yellows a shell prints for progress lines invisible on the page. Bright variants are pushed *away* from the ground — lighter on a dark theme, darker on a light one — which is the opposite of what "bright" literally means and the only way the emphasis reads. ANSI `black` is left invisible against its own dark ground on purpose: it is a background slot, and lifting it would break programs that fill with it.
- The status strip is the one signal saying whether the session accepts input, so every ending has to reach it. `end_turn` in the stream is not enough on its own: the CLI keeps printing afterwards and a late tool_result puts the strip back on `requesting`, and a run can end on another stop_reason or die outright. The run's exit therefore emits an idle phase too — but only when nothing else speaks for that ending, because `error` and `login` free the strip themselves and also release the messages queued mid-turn.
