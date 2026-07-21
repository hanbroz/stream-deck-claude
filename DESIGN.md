# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-07-21
- Primary product surfaces: Claude Deck Companion desktop workspace
- Evidence reviewed: `companion/ClaudeCodeApp.dc.html`, `companion/renderer/index.html`, `companion/renderer/styles.css`, `README.md`, and the supplied `Stream Deck Terminal Electron App-handoff.zip`

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

- Color: `#1f1f1f` shell, `#252526` panels, `#1e1e1e` workspace, `#d97757` orange accent, `#3fb950` running state, `#569cd6` informational state
- Typography: Segoe UI Variable for chrome and Cascadia Code for console/terminal content
- Spacing/layout rhythm: 40px title bar, 36px session tabs, 260px explorer default, 23px tree rows, 150px composer dock
- Shape/radius/elevation: 5-12px restrained radii, 1px separators, dark 8-28px context/toast shadows
- Motion: caret blink and short toast fade only
- Imagery/iconography: compact inline SVG/icons; no emoji-dependent navigation

## Components

- Existing components to reuse: `ClaudePtyManager`, secure path IPC, composer state, tree state, xterm terminal
- New/changed components: reference-faithful title bar, resizable explorer, session tab strip, console/terminal split, dock composer, context menu, toast
- Variants and states: explorer collapsed, terminal split open/closed, session idle/running/waiting/closed, focused composer, context menu open
- Token/component ownership: `companion/renderer/styles.css` owns visual tokens; `companion/renderer/index.ts` owns interaction state

## Accessibility

- Target standard: keyboard-operable desktop controls with semantic labels
- Keyboard/focus behavior: Enter sends, Shift+Enter inserts a newline, Escape cancels inline creation/context menus, focus returns to the composer after session start
- Contrast/readability: preserve the dark reference palette with readable muted text and visible orange focus borders
- Screen-reader semantics: buttons, nav/section labels, live toast, and image preview alt text
- Reduced motion and sensory considerations: no motion beyond caret/toast; system color scheme remains dark

## Responsive behavior

- Supported breakpoints/devices: desktop Electron window, minimum 960x640
- Layout adaptations: explorer collapses to a 40px rail; terminal split uses the remaining workspace; composer wraps image chips
- Touch/hover differences: hover states remain supplemental; all actions have click/keyboard paths

## Interaction states

- Loading: tree rows retain their location while folders load
- Empty: console and terminal show quiet reference-style placeholder lines
- Error: toast and console message identify session/file failures without losing the workspace
- Success: toast confirms file creation, refresh, resume, copy, and external launches
- Disabled: copy is disabled until a terminal selection exists; send remains available for an empty-session start
- Offline/slow network, if applicable: Claude remains a local PTY; no network-only UI state is introduced

## Content voice

- Tone: concise, technical, friendly Korean-first UI with familiar English developer labels where the reference uses them
- Terminology: Companion, Claude Code, PowerShell, Explorer, Resume, New File, New Folder, Refresh
- Microcopy rules: short labels, no status-line jargon in the main workspace, errors state the next actionable step

## Implementation constraints

- Framework/styling system: Electron + TypeScript + plain DOM/CSS + xterm
- Design-token constraints: preserve the dc.html palette and measurements; do not add a second visual theme
- Performance constraints: lazy-load file children and keep terminal rendering in xterm
- Compatibility constraints: Windows 10+, Electron 43, Windows Terminal `wt.exe`, secure preload IPC
- Test/screenshot expectations: run Companion tests, typecheck, build, and inspect the built renderer HTML/CSS before release

## Open questions

- [ ] Should the optional PowerShell split eventually embed a second PTY, or remain an external `wt.exe` launch affordance? / owner: product / impact: terminal panel content
