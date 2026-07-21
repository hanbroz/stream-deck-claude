# Code Start MVP

## Goal

Add a private Stream Deck action named `Code Start` that launches Claude Code through Claude Deck Companion in a configured folder and displays the current model and context-window usage for the exact session launched by that action instance.

## Acceptance criteria

1. The manifest contains a third, uniquely identified key action named `Code Start` with its own icon, key image, and property inspector.
2. Each placed action stores its own `folder` and `projectName` settings. With no folder configured, pressing it does not launch a process.
3. Pressing a configured action validates that the folder exists, installs/updates the existing Claude status-line bridge, opens Claude Deck Companion, and launches the exact command `claude --dangerously-skip-permissions` with the folder passed as the process working directory rather than interpolated into shell text.
4. Claude Deck Companion is resolved from `CLAUDE_DECK_COMPANION_PATH`, then the linked plugin's `companion\win-unpacked\Claude Deck Companion.exe`, then the repository `dist\companion\win-unpacked\Claude Deck Companion.exe`, then `%LOCALAPPDATA%\Programs\Claude Deck Companion\Claude Deck Companion.exe`. The legacy terminal launcher is available only when `CLAUDE_DECK_ALLOW_TERMINAL_FALLBACK=1` is set for development. This lets a linked development plugin use a freshly built unpacked Companion without reinstalling the per-user release.
5. Every placed action persists a binding ID independent of Stream Deck's transient action-instance ID, and every launch has that binding ID plus a new random launch ID in its inherited environment. Multiple buttons, repeated launches, and older still-running sessions cannot overwrite the active session selected for another launch.
6. The status-line bridge caches only the session ID, launch ID, project directory, current model display name, context percentage, token totals, and capture time. It never caches effort, prompts, transcripts, credentials, or the complete status-line payload.
7. The key displays exactly three content elements and no status labels: the configured project name, the current model (for example `Opus 4.8`), and a context-usage progress bar. Context-capacity decorations such as `(1M context)` are omitted, and the project name remains larger than the model line.
8. Before a matching context snapshot arrives, the key displays the project name, `MODEL --`, and an empty progress bar. Once a matching snapshot arrives, it displays the model while the matching bar fill continues to represent the rounded context percentage.
9. Context percentages are clamped to 0-100. A `null` context percentage remains in the waiting state rather than showing a false zero.
10. The property inspector supports project-name entry, direct path entry, saving both values, and a native Windows folder picker. Settings changes update the key without replacing the action.
11. Existing 5-hour and weekly actions, their UUIDs, the prior HUD forwarding behavior, and the safe rate-limit cache remain unchanged.
12. Unit tests, bridge integration verification, type checking, build, Stream Deck manifest validation, and packaging all pass without launching a real Claude session during automated verification.
13. The model text keeps the existing activity colors: red while no Claude Code session is active, green while Claude Code is running at its prompt, and blue from prompt submission until the answer finishes.
14. Activity transitions use Claude Code lifecycle hooks: `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, and `SessionEnd`. Existing user hooks are preserved and the managed hooks are installed idempotently.
15. Hook payloads, including submitted prompts and assistant responses, are never cached or forwarded to an existing status-line command. Only action ID, launch ID, activity, and capture time are persisted.
16. A project name typed before opening the folder picker is included in the picker request and saved together with the selected folder, so the first entry is not overwritten.
17. When the launched Claude session ends or its tracked terminal process exits, the key shows only the project name and `Closed`; it does not show the model or context bar.
18. Both Windows Terminal and the PowerShell fallback report the persistent PowerShell host PID, allowing terminal closure to be detected instead of tracking a short-lived launcher process.
19. Moving a running Code Start action to another key preserves its binding ID and continues displaying the same session. Existing installations without a binding ID reconnect only when exactly one unclaimed running launch matches the configured folder; ambiguous matches are never guessed.
20. The Windows Terminal launch-plan regression test decodes the encoded PowerShell payload back to the exact Claude launch command and verifies that no raw semicolon remains in the `wt.exe` argument vector.
21. Reopening the same Code Start binding and canonical folder passes the latest observed same-binding session ID to Companion as an exact resume request. If resume fails, Companion shows the failure and does not silently start a new unrelated session.
22. Companion provides a project explorer scoped to the configured root. MVP operations are open/reveal, lazy folder expansion, and non-overwriting file/folder creation; destructive operations, rename, move, and arbitrary shell commands are non-goals.
23. Companion's terminal-open action runs exactly `wt.exe -d <configured-folder>` and does not start Claude.
24. The Windows installer requires Windows Terminal. It detects `wt.exe`, otherwise runs `winget install --id Microsoft.WindowsTerminal -e --source winget --silent --accept-package-agreements --accept-source-agreements`, rechecks `wt.exe`, and aborts with Korean manual-install guidance if Windows Terminal is still unavailable.
25. Windows release packaging builds the Companion installer, packages the Stream Deck plugin, stages `Install.cmd`, `INSTALL_WINDOWS_KO.html`, and `SHA256SUMS.txt`, and the Companion NSIS installer opens the bundled `.streamDeckPlugin` after Companion files are installed.
