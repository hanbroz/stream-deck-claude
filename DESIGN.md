# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-08-25
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

- Token cost is a design constraint, not an afterthought. A message spawns its own `claude --print --resume` run, so the CLI reloads the transcript from disk and lays out its `cache_control` breakpoints afresh; they land off the boundaries the previous run wrote, and the whole prefix is re-billed at cache-*creation* price instead of being read at a twelfth of it. Measured across five sessions: 162,869 mean creation tokens on the request right after a respawn against 6,394 within one, with 77-91% of all creation concentrated in those first requests, and re-writes of 300k+ observed 26 seconds apart while the cache was still warm. Four defaults exist to bound that cost and should not be loosened without re-measuring, and one deliberately does not:
  - the model/effort default is `sonnet`/`medium`, because a per-message default is paid every turn rather than once; opus is a dropdown away and is remembered per folder
  - `AUTO_COMPACT_AT_PERCENT` was 45, not 70: on a 1M-window model 70% first fires at ~700k tokens, 1.55x the ~450k break-even the same measurements produced, so the mark sat above the point it existed to protect. Compaction is itself a paid turn that reads the whole prefix, which is exactly why it has to fire near break-even. Overridden to 85 by explicit user instruction on 2026-09-01, to match the CLI's own auto-compact window rather than the measured break-even — this reopens the same cost regression 70 was replaced for, now worse (850k vs. 700k), and should be revisited if compaction cost creeps back up
  - the turn-boundary handler releases queued sends and considers compaction on `waiting` only. `ready` is synthesised solely by `clear()` and `interrupt()`, so acting on it fired a queued message, or a whole-context `/compact`, at the moment the user pressed Esc to stop spending. `interrupt()` therefore releases the queue itself rather than leaving it to fire at a boundary the user stopped expecting
  - `model-prefs` files carry a schema version, because a saved pref outranks the default and every file written before this change holds the opus/high-or-higher value the old build seeded on first launch. Without the version, changing the default is a no-op for everyone who already ran the app — the fix would ship and change nothing
  - `--max-turns 100` is a backstop, not a throttle. `--dangerously-skip-permissions` removes the human gate on every tool, so one Enter can loop without bound; measured over 138 real messages the loop ran a median of 6 requests, p95 27, and never past 44
  - a paste is capped at 200k characters and five attachments, and images at ten per message and 30 MB total. An attachment is not a one-off: `--resume` carries it in the prefix of every later turn until a compaction drops it
  - opening the app starts a NEW conversation and OFFERS the folder's last one behind a button, priced with its own last recorded usage. Continuing on open read as a convenience and billed like a subscription: because a message respawns the CLI, the inherited prefix was re-bought every turn rather than paid once. Measured over five sessions, 53% of all spend was prefix carried in at launch — 0% in the one session never relaunched, 88% in the one relaunched ten times, whose conversation grew from 97k to 535k tokens because nothing ever ended it. The context is worth that when the work really does continue, which is why this is an offer and not a removal
- Two knobs here must NOT be tightened for cost, and both look tempting:
  - the agent idle timeout stays at 10 minutes. It measures silence, and a subagent's only heartbeat is one `activity` event per tool it starts, so an agent sitting inside a single Bash call is silent for that call's whole duration — up to the 600s the CLI allows. Any cap at or under that kills work in progress, and a killed agent's tokens are spent either way
  - `AUTO_COMPACT_AT_PERCENT` cannot go far below 45 either. A conversation cannot compact below its preamble, and the re-arm latch only re-arms once usage falls back under the mark, so a mark at or under the floor fires once and then never again. 45% of a 1M window is 450k against a preamble measured at ~22k; on a 200k-window model the same 45% is 90k, which is the case to re-measure before lowering it further
- Still open, in order of measured size:
  - the respawn itself, worth 1.13-1.58x. The reason for it — a turn taking ~2 minutes to finalise — is already handled by `finaliseGraceMs` and the `sawEndTurn` path, so a long-lived process fed over stdin is worth revisiting
  - compaction only runs at a turn boundary, so a single turn can still grow from 44% to 69% of the window with nothing to intervene. The CLI's own `--autocompact <auto|tokens>` is the only lever that works mid-turn; it is deliberately not wired up yet because the value is a token count and a fixed one would silently disable itself on a smaller-window model
- The window has two surfaces and the key setting picks between them. Chat mode drives Claude through `claude --print` and renders the conversation; terminal mode hosts the interactive CLI in the window's own PTY and renders nothing of its own. Explorer, title bar, themes, splitters and the Stream Deck key are identical either way — only what fills the right-hand side differs, which is why terminal mode is a layout branch (`.is-terminal-mode`) rather than a second window. Terminal is the cheaper surface per turn: one long-lived process keeps the prompt cache warm, and measured at turn starts still inside the 5-minute cache TTL, `--print` re-wrote a median 76k-123k tokens against the terminal's 12.5k. Model and effort are deliberately not passed to it — inside an interactive session those belong to `/model`, and a flag would override the user's last choice on every launch.
- A parent Claude session's `CLAUDE_CODE_CHILD_SESSION` marker is stripped from the environment at startup, before anything spawns. The CLI treats that marker as "you are nested" and turns transcript saving OFF, announcing it in the banner. That is not cosmetic here: `--resume` stops finding the session, and terminal mode reads the transcript for its context percentage, so the meter and the key would sit at `--` forever with nothing explaining why. The marker arrives whenever anything up the launch chain was itself started from a Claude session — restarting Stream Deck from one is enough — and then flows through the plugin, this app and the PTY into the CLI. Stripping beats forcing persistence back on, because the session this app opens really is top-level and the marker is simply false about it. `CLAUDE_CODE_SKIP_PROMPT_HISTORY` is left alone: the CLI reports that one separately and a user who set it meant it.
- Terminal mode's context percentage comes from the transcript, not the stream. The CLI reports nothing to the app, and the status-line route only works when the plugin's bridge owns that slot — which it will not do when another tool already has it. The main process therefore polls the folder's newest transcript with the same bounded 256KB tail read that prices the resume offer, and feeds the result to the key AND to the window's own meter through the path a streamed context event takes. A local file on a timer: no Claude request, no tokens.
- Companion startup launches Claude in structured streaming mode in the configured project root; only conversation text is rendered in the read-only Claude Console, while prompts and images are sent from the bottom composer.
- The top `TERMINAL` tab opens an embedded PowerShell PTY rooted at the configured project and accepts normal commands as a separate optional split.
- The explorer terminal action still opens an external Windows Terminal window with `wt.exe -d <project-root>`.
- The Claude console is intentionally selectable/read-only; prompts are entered only in the bottom composer.
- The header reads the project name from Code Start metadata and polls the current model/context snapshot without taking over another status-line owner.
- Subagents get a board pinned between the transcript and the status strip, from the first agent onward: one row each carrying agent type, description, the tool it is on and elapsed time. It is pinned rather than inline because a fan-out runs for minutes while the console keeps scrolling, and it is capped so it never squeezes the transcript or the strip. The board is handed to the console as the run's record when the turn ends, never at the moment an agent finishes — a background agent settles mid-way through the *next* turn, and moving it then cuts that reply in half.
- The theme is applied to `<html>` before the xterm `Terminal` is constructed, because xterm reads its colours once at construction and cannot see CSS variables afterwards. `terminalPalette()` therefore copies them out of the stylesheet on every theme change — and reads only literal palette tokens, since a derived `color-mix()` one comes back as the unresolved expression.
- xterm gets all sixteen ANSI slots, not just the ground. Its defaults assume a dark background, so a light theme alone left the yellows a shell prints for progress lines invisible on the page. Bright variants are pushed *away* from the ground — lighter on a dark theme, darker on a light one — which is the opposite of what "bright" literally means and the only way the emphasis reads. ANSI `black` is left invisible against its own dark ground on purpose: it is a background slot, and lifting it would break programs that fill with it.
- The status strip is the one signal saying whether the session accepts input, so every ending has to reach it. `end_turn` in the stream is not enough on its own: the CLI keeps printing afterwards and a late tool_result puts the strip back on `requesting`, and a run can end on another stop_reason or die outright. The run's exit therefore emits an idle phase too — but only when nothing else speaks for that ending, because `error` and `login` free the strip themselves and also release the messages queued mid-turn.
