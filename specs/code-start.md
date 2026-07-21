# Code Start MVP

## Goal

Add a private Stream Deck action named `Code Start` that launches Claude Code in a configured folder and displays the context-window usage for the exact session launched by that action instance.

## Acceptance criteria

1. The manifest contains a third, uniquely identified key action named `Code Start` with its own icon, key image, and property inspector.
2. Each placed action stores its own `folder` and `projectName` settings. With no folder configured, pressing it does not launch a process.
3. Pressing a configured action validates that the folder exists, installs/updates the existing Claude status-line bridge, and launches the exact command `claude --dangerously-skip-permissions` with the folder passed as the process working directory rather than interpolated into shell text.
4. Windows Terminal is preferred when `wt.exe` is available. Its PowerShell payload is passed as UTF-16LE Base64 through `-EncodedCommand`, so statement separators such as `;` are not interpreted as additional Windows Terminal commands. A visible PowerShell window is used as the fallback when `wt.exe` is not available.
5. Every placed action persists a binding ID independent of Stream Deck's transient action-instance ID, and every launch has that binding ID plus a new random launch ID in its inherited environment. Multiple buttons, repeated launches, and older still-running sessions cannot overwrite the active session selected for another launch.
6. The status-line bridge caches only the session ID, launch ID, project directory, context percentage, token totals, and capture time. It never caches prompts, transcripts, credentials, or the complete status-line payload.
7. The key displays exactly three content elements and no status labels: the configured project name, `CTX n%`, and a context-usage progress bar. The project name uses the former `CTX n%` size, while `CTX n%` is smaller.
8. Before a matching context snapshot arrives, the key displays the project name, `CTX --%`, and an empty progress bar. Once a matching snapshot arrives, it displays the rounded percentage and matching bar fill.
9. Context percentages are clamped to 0-100. A `null` context percentage remains in the waiting state rather than showing a false zero.
10. The property inspector supports project-name entry, direct path entry, saving both values, and a native Windows folder picker. Settings changes update the key without replacing the action.
11. Existing 5-hour and weekly actions, their UUIDs, the prior HUD forwarding behavior, and the safe rate-limit cache remain unchanged.
12. Unit tests, bridge integration verification, type checking, build, Stream Deck manifest validation, and packaging all pass without launching a real Claude session during automated verification.
13. The `CTX` text is red while no Claude Code session is active, green while Claude Code is running at its prompt, and blue from prompt submission until the answer finishes.
14. Activity transitions use Claude Code lifecycle hooks: `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, and `SessionEnd`. Existing user hooks are preserved and the managed hooks are installed idempotently.
15. Hook payloads, including submitted prompts and assistant responses, are never cached or forwarded to an existing status-line command. Only action ID, launch ID, activity, and capture time are persisted.
16. A project name typed before opening the folder picker is included in the picker request and saved together with the selected folder, so the first entry is not overwritten.
17. When the launched Claude session ends or its tracked terminal process exits, the key shows only the project name and `Closed`; it does not show `CTX`, a percentage, or the context bar.
18. Both Windows Terminal and the PowerShell fallback report the persistent PowerShell host PID, allowing terminal closure to be detected instead of tracking a short-lived launcher process.
19. Moving a running Code Start action to another key preserves its binding ID and continues displaying the same session. Existing installations without a binding ID reconnect only when exactly one unclaimed running launch matches the configured folder; ambiguous matches are never guessed.
20. The Windows Terminal launch-plan regression test decodes the encoded PowerShell payload back to the exact Claude launch command and verifies that no raw semicolon remains in the `wt.exe` argument vector.
