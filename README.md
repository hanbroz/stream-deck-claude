# Claude for Stream Deck

Personal Windows Stream Deck plugin for Claude controls and status displays. It shows Claude Code subscription limits, launches configured projects, and tracks the context usage of each launched session.

> [!WARNING]
> `Code Start` intentionally launches `claude --dangerously-skip-permissions`. Use it only for folders and repositories you trust.

## Actions

- `5-Hour Usage`: used percentage and reset countdown for the five-hour window.
- `Weekly Usage`: used percentage and reset countdown for the seven-day window.
- `Code Start`: launches Claude Code in a configured project folder and displays that session's context usage and activity.

The actions have separate UUIDs and can be placed on separate keys. Each Code Start placement persists a session binding so moving a running button to another key keeps the same context display.

## Data source

Claude Code documents `rate_limits.five_hour` and `rate_limits.seven_day` in its status-line JSON. The included bridge saves only those fields to `%LOCALAPPDATA%\ClaudeUsageDeck\usage.json` and forwards the original input to the pre-existing status-line command.

The plugin never reads `.claude/.credentials.json`.

## Install and use

1. Download `com.hanbroz.claude-usage.streamDeckPlugin` from the repository's latest GitHub release and double-click it. For local development, link the development folder with `npm exec -- streamdeck link com.hanbroz.claude-usage.sdPlugin`.
2. In Stream Deck, drag the desired usage actions or `Code Start` onto keys. Configure a project name and folder for each Code Start key.
3. Press a Code Start key or either usage key once. The plugin backs up `~/.claude/settings.json`, installs the status-line bridge and lifecycle hooks, and preserves the existing status-line command and hooks.
4. Send one Claude Code message. Usage keys display the current percentages and reset countdowns, while Code Start displays the launched session's context usage.

Visible keys refresh from the local cache every 30 seconds. Countdown refreshes do not send Claude requests or consume usage. If a reset time passes before Claude supplies fresh data, the key displays `REFRESH` instead of a stale percentage.

## Local development

```powershell
npm install
npm test
npm run typecheck
npm run build
npm run validate
npm run verify:bridge
npm run pack
npm run release:windows
```

`npm run preview` writes actual-account SVG previews to `dist/previews` after a successful build.

`npm run release:windows` runs the complete verification pipeline and creates a versioned Windows recovery ZIP containing the `.streamDeckPlugin` installer, Korean installation guide, launcher, and SHA-256 checksum.

## Privacy and local data

- The plugin does not read Claude credentials.
- Prompts and assistant responses are never persisted by the bridge.
- Usage and context caches are stored locally under `%LOCALAPPDATA%\ClaudeUsageDeck`.
- Project folders and button settings remain in the local Stream Deck profile.
