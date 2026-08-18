# Project text search

Date: 2026-08-12

## Goal

Find every file in the project that contains a given string, without leaving
Companion. Today the explorer can only browse — there is no way to ask "which
files mention `resolveContainedPath`?" — so the user has to leave the app for an
editor or a shell.

The model is IntelliJ's Find in Files: a keystroke opens a search field over the
window, typing searches file *contents*, and the results are grouped by file with
the matching lines shown. Binary files are excluded.

Companion has no editor, so a result opens in the explorer tree (or in the OS
default app), not in an internal viewer. That is the deliberate boundary of this
feature.

## Acceptance criteria

1. Pressing `Shift` twice within 300 ms, with no other key in between, opens the
   search overlay. Pressing `Ctrl+Shift+F` opens it too — the keyboard shortcut
   exists because double-`Shift` is easy to trigger by accident and easy to miss.
2. Both shortcuts work wherever focus is, including inside the embedded xterm
   terminal, and `Ctrl+Shift+F` is never forwarded to the terminal's PTY.
3. Double-`Shift` does not fire while a modifier is held (`Ctrl`, `Alt`, `Meta`),
   while a key is auto-repeating, or during IME composition. `Alt+Shift` — the
   Windows keyboard-layout switch — therefore never opens the overlay.
4. The overlay shows a single text field. Typing searches after a 250 ms pause;
   queries shorter than 2 characters search nothing and show no results.
5. Matching is a case-insensitive substring match. There is no regex, no
   whole-word option, and no file-name mask.
6. Results are grouped by file: a file row showing the project-relative path and
   its hit count, followed by one row per matching line showing the line number
   and the line's text with the matched substring highlighted.
7. Binary files never appear in results. A file counts as binary when a NUL byte
   occurs in its first 8 KB, which is how git decides the same question.
8. Files larger than 1 MB are skipped, as are the directories the `@` mention
   picker already ignores (`.git`, `node_modules`, `dist`, `build`, `out`,
   `.next`, `.venv`, `__pycache__`, `.omc`).
9. The scan is capped: 20,000 files visited, 12 directory levels deep, 200 files
   reported, 20 hits per file. Whenever a cap truncates the answer the overlay
   says so, so a partial result is never mistaken for a complete one.
10. `ArrowUp` / `ArrowDown` move the selection across all rows, file rows and hit
    rows alike. The selection stays visible as it moves.
11. `Enter` on either kind of row reveals that file in the explorer tree: every
    ancestor folder expands, loading from disk as needed, the file's row is
    selected and scrolled into view, and the overlay closes.
12. `Ctrl+Enter` opens the file in the OS default application and closes the
    overlay.
13. `Esc` closes the overlay. While the overlay is open, `Esc` does not also
    interrupt the message Claude is generating.
14. A search that is superseded by newer typing never overwrites the newer
    result, however late it arrives.
15. A file that was deleted between the scan and the reveal fails quietly — the
    overlay closes and the tree is left as it was.
16. The search runs entirely in the main process against paths sealed inside the
    project root, exactly as every other `paths.*` channel is.
17. New user-facing strings are Korean, matching the existing toasts.

## Design

### Flow

```
Shift Shift  /  Ctrl+Shift+F
        │  (document keydown, capture phase — ahead of xterm)
        ▼
   search overlay ── 250 ms debounce ──▶ api.paths.search(query)
        │                                      │ IPC companion:path:search
        │                                      ▼
        │                            main/project-search.ts
        │                              listProjectFilesRecursive(root, 20000, 12)
        │                              → stat  (>1 MB? skip)
        │                              → read  (NUL in first 8 KB? skip)
        │                              → scan lines, cap hits
        │                                      │
        ◀─────── ProjectSearchResult ──────────┘
        │
   Enter ──▶ expand ancestors via api.paths.list, select row
   Ctrl+Enter ──▶ api.paths.open
```

### Modules

**`companion/main/project-search.ts`** (new) — the whole search. It takes the
root and the query and returns the result; it holds no state and touches no
Electron API, so it is unit-testable on its own.

```ts
export type SearchHit = { line: number; column: number; text: string };
export type SearchFileResult = { path: string; relativePath: string; hits: SearchHit[]; truncated: boolean };
export type ProjectSearchResult = { files: SearchFileResult[]; truncated: boolean; scanned: number };

export function searchProjectText(root: string, query: string): Promise<ProjectSearchResult>;
```

`text` is the matching line, trimmed to at most 200 characters around the first
match, and `column` is the match's offset *within that trimmed text* — so the
renderer highlights by slicing, with no second search and no off-by-one against
the original line.

The file list comes from the existing `listProjectFilesRecursive`, called with
wider caps than the `@` picker uses. Its ignore-list and depth limiting are
already what this feature needs; a second directory walker would be a second
thing to keep in sync.

**`companion/shared/claude-command.ts`** — one entry, `pathSearch:
"companion:path:search"`.

**`companion/main/ipc.ts`** — one handler, validating the query as a string and
delegating to `searchProjectText`. The root is `deps.rootPath`, never a
caller-supplied path, so the channel cannot be aimed outside the project.

**`companion/preload/index.ts`** — `paths.search(query)`.

**`companion/renderer/`** — the overlay markup in `index.html`, its styles in
`styles.css`, and in `index.ts`: the shortcut handler, the debounced search, the
result list, and `revealInTree`.

### Why the capture phase

xterm reads keystrokes from its own helper `<textarea>` and forwards them to the
PTY. A listener registered on `document` with `capture: true` runs before the
event reaches that textarea, so the shortcut is seen first; `stopPropagation()`
there also ends the event's journey entirely, which is what keeps `Ctrl+Shift+F`
out of the terminal and keeps `Esc` from reaching the existing bubble-phase
handler that interrupts Claude.

### Superseded searches

The renderer holds a counter that increments on every search it starts. A result
is rendered only when its counter still matches the current one.

That counter alone was not enough. It stops a stale *reply* from rendering, but
the scan behind it kept running to the end in the main process — the same thread
that forwards PTY output to the renderer — and one ran per debounced keystroke,
so they stacked. The caps bound each scan, not the number of them in flight.

So the main process cancels too. Each `path:search` aborts the previous scan
before starting its own, and `path:search-cancel` aborts the last one when no
newer search follows: closing the overlay, and backspacing the query below the
minimum length. Both are checked at three points — before the walk starts,
inside the directory walk, and once per batch of the scan loop — so an abandoned
search stops within a batch rather than at the end of the project.

An aborted scan resolves; it never rejects, because the renderer shows a
rejection as a failed search and being superseded is not a failure. It carries
`cancelled: true` so an empty `files` says "stopped looking" rather than "nothing
matches" to anyone reading the result on its own.

### Revealing in the tree

The reveal walks the relative path segment by segment, matching each against the
current node's children by name, expanding and listing as it goes with the
existing `setNodeChildren` / `setNodeExpanded` helpers. Matching by name rather
than by reconstructed path string keeps the walk free of separator and
drive-letter-case assumptions. A segment with no matching child means the file
moved or was deleted after the scan: the walk stops and the tree is untouched.

## Non-goals

- Regex, whole-word, and file-mask filters.
- Search-and-replace.
- An in-app file viewer or editor, and therefore jumping to the matched line.
- Search history and saved searches.
- Honouring `.gitignore`. The fixed ignore list is what the `@` picker uses and
  is enough for the projects this app opens.

## Tests

`companion/tests/project-search.test.ts` (vitest), against a temporary
directory: case-insensitive matching, binary files skipped via the NUL probe,
oversized files skipped, ignored directories not visited, the per-file hit cap
and the file cap both reported through `truncated`, and a query under 2
characters returning nothing.

Cancellation is covered at each layer it acts on. `project-search.test.ts` drives
the scan loop's own guard with a signal that reports aborted only after the walk
has finished, so the guard is exercised rather than skipped, and checks that a
genuine empty result stays unmarked. `paths.test.ts` covers the walk stopping.
`ipc.test.ts` overlaps two `path:search` invocations without awaiting between
them and asserts the first comes back cancelled — awaiting would let it finish
and prove nothing.

`shared/search-query.ts` holds the length policy both processes apply, with its
own test. It lives in `shared/` because the renderer bundles for the browser: a
value imported out of `main/` drags `node:fs` into a bundle that cannot resolve
it, and neither the typechecker nor the tests see that — only the build does.
