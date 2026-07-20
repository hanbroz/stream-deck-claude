# Claude Code rate limit Stream Deck display

## Scope

The plugin is private and runs only on the current Windows account.

It reads the documented Claude Code status-line payload and never reads Claude credentials.

## Acceptance criteria

### AC-1 Official usage contract

The bridge accepts `rate_limits.five_hour` and `rate_limits.seven_day` from Claude Code status-line JSON.

It writes only percentages, reset epochs, schema version, and capture time to the cache.

It must not copy the status-line payload, session transcript, prompt, credential, or token fields.

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

Visible keys re-read the local cache on an interval and when pressed.

Reset countdown is calculated from the current clock without consuming Claude usage.

### AC-8 Existing status line compatibility

Installing the bridge preserves the existing status-line command and settings.

The bridge forwards the original JSON input to the existing command and relays its stdout.

### AC-9 Safe installation

The installer makes a backup before changing `~/.claude/settings.json`.

Repeated installation is idempotent.

### AC-10 Deliverable

The plugin builds, typechecks, tests, validates against the Stream Deck schema, and packages as a `.streamDeckPlugin` file.
