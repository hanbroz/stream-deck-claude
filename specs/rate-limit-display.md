# Claude Code rate limit Stream Deck display

## Scope

The plugin is private and runs only on the current Windows account.

It reads the documented Claude Code status-line payload and never reads Claude credentials.

## Acceptance criteria

### AC-1 Official usage contract

The bridge accepts `rate_limits.five_hour` and `rate_limits.seven_day` from Claude Code status-line JSON.

It writes only percentages, reset epochs, schema version, and capture time to the cache.

It must not copy the status-line payload, session transcript, prompt, credential, or token fields.

Within the same reset epoch, a lower percentage from another stale Claude session must not overwrite a higher observed percentage, including when bridge processes write concurrently. A later reset epoch starts a new window and may accept a lower percentage.

### AC-2 Independent actions

The manifest exposes a five-hour action and a weekly action with distinct UUIDs.

Each action can be placed on a separate Stream Deck key.

### AC-3 Five-hour display

The five-hour key shows `5 HOURS`, a rounded used percentage, and time remaining until reset.

### AC-4 Weekly display

The weekly key shows `WEEKLY`, a rounded used percentage, and time remaining until reset.

### AC-5 Remaining time

Durations below one day render as hours and minutes.

Durations of one day or more render as days and hours.

An elapsed reset time renders `REFRESH` rather than claiming a current percentage.

### AC-6 Missing data

A missing cache renders setup guidance if the bridge is not installed.

A missing cache renders `RUN CLAUDE` if the bridge is already installed.

### AC-7 Refresh

When no other status-line command is configured, the installer sets Claude Code status-line `refreshInterval` to the supported minimum of one second.

Existing status-line commands and other settings remain preserved in Claude settings because Claude Code exposes a single status-line command slot.

When an external status-line command owns that slot (for example OMC HUD), usage keys show `STATUSLINE BUSY` and do not claim the rate-limit cache is live. Code Start lifecycle hooks still operate, but rate-limit refresh requires the Usage Deck bridge to own the slot.

Visible keys re-read the local cache every second and when pressed. Unchanged images are not sent to Stream Deck again.

Reset countdown is calculated from the current clock without consuming Claude usage.

The display remains bounded by Claude Code's documented `rate_limits` payload; it does not scrape the web dashboard or read Claude credentials.

### AC-8 Existing status line compatibility

Installing the bridge preserves the existing status-line command and settings in Claude settings.

When the Usage Deck bridge owns the status-line slot, it forwards the original JSON input to the
recorded command and relays its stdout. If another command already owns the slot (for example OMC
HUD), the installer does not replace or wrap that command; the usage keys show `STATUSLINE BUSY`
and no rate-limit forwarding is attempted.

If an older install left the managed bridge command in Claude settings, reinstalling restores the recorded original command instead of forwarding to itself.

### AC-9 Safe installation

The installer makes a backup before changing `~/.claude/settings.json`.

Repeated installation is idempotent.

### AC-10 Deliverable

The plugin builds, typechecks, tests, validates against the Stream Deck schema, and packages as a `.streamDeckPlugin` file.
