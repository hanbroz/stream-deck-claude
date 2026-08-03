# Explorer drag-and-drop copy

Date: 2026-08-03

## Goal

Let a user drop files and folders from Windows Explorer onto the Companion
explorer tree to copy them into the project. The drop target is the folder the
pointer is over; large or multi-file drops are confirmed first so a mis-drag
cannot silently pull thousands of files into the project.

This extends `specs/code-start.md` acceptance criterion 22, which listed the
explorer's MVP operations as open/reveal/expand/create and named move and rename
as non-goals. Copy-in is now in scope. Move and rename remain non-goals.

## Acceptance criteria

1. Dragging files or folders from outside the app (Windows Explorer, the
   desktop) over the explorer tree shows a copy cursor and highlights the
   destination row.
2. The destination is the hovered folder row; a hovered file row targets that
   file's parent folder; the empty area below the rows targets the project root.
   Every position in the tree is a valid destination.
3. Dropping copies each source into the destination folder. Folders are copied
   with their full contents.
4. A name already taken in the destination is never overwritten. The copy is
   renamed by appending ` (n)` before the extension: `report.md` becomes
   `report (1).md`, then `report (2).md`. Directories append the suffix to the
   whole name.
5. Before copying, the sources are measured. When the drop contains 5 or more
   files, or more than 500 MB (500 × 1024 × 1024 bytes) in total, the user
   confirms in a dialog naming the file count, the total size, and the
   destination folder. Cancelling copies nothing.
6. Drops below both thresholds copy immediately with no dialog.
7. Measurement stops after 10,000 files and reports the totals as lower bounds
   ("10,000개 이상"). A drop that reaches the cap always requires confirmation.
8. The destination must resolve inside the project root, including after symlink
   resolution. Sources may be anywhere on disk — that is the point of the
   feature — but a source that would be copied into itself is rejected.
9. One failing source does not abort the rest. The result toast reports how many
   were copied and, when any failed, how many failed.
10. After a copy the destination folder is re-listed and expanded folders keep
    their expanded state.
11. Dropping a file anywhere else in the window (console, terminal, composer)
    does nothing and never navigates the renderer away from the app.
12. Dragging a row within the tree does nothing. Internal move is out of scope.
13. New user-facing strings — the confirmation dialog and the result toast — are
    Korean, matching the existing delete confirmation.

## Design

### Flow

```
Windows Explorer drag
 └→ renderer: drop on #tree
     └→ preload: api.paths.filePath(file) → absolute source paths
     └→ IPC pathCopyMeasure(sourcePaths)  → { fileCount, totalBytes, truncated }
     └→ needsCopyConfirm(...) ? window.confirm(...) : proceed
     └→ IPC pathCopyInto(destDir, sourcePaths) → { copied, failed }
     └→ refreshPath(destDir) + toast
```

Measurement and copying are two IPC calls rather than one call with a
`confirmed` flag, so neither function has a mode where it declines to do the
thing its name says.

### Crossing the context bridge

`File` objects are DOM objects and do not survive `contextBridge`. Preload
exposes `paths.filePath(file: File): string`, which calls
`webUtils.getPathForFile(file)`; the renderer maps the dropped files to path
strings itself and sends only strings over IPC. This is the pattern the Electron
`webUtils` documentation prescribes, and `webUtils` is one of the modules still
available to a sandboxed preload, so `sandbox: true` stays on.

`File.path` was removed in Electron 32 and is not an option.

### `main/paths.ts`

Existing helpers assume both ends of an operation live inside the project root.
A drop inverts that: the source is by definition outside. Two new functions:

```
measureCopySources(sourcePaths: string[]): Promise<CopyMeasurement>
copyIntoContainedDirectory(root, destPath, sourcePaths): Promise<CopyResult>
```

- `measureCopySources` walks each source with `lstat`, matching `fs.cp`'s default
  `dereference: false`. Symlinks count as themselves and are not followed, so a
  cyclic link cannot hang the walk. The walk stops at 10,000 files and sets
  `truncated`.
- `copyIntoContainedDirectory` resolves the destination through the existing
  `resolveContainedDirectory`, which already rejects paths outside the root after
  `realpath`. For each source it picks a free name via `uniqueDestinationName`
  and calls `fs.cp(source, target, { recursive: true, errorOnExist: true })`.
  Node 22 (Electron 43) provides the recursive copy, so there is no hand-written
  directory walk.
- `errorOnExist` guards the race between choosing a name and writing it.
  `fs.cp` also rejects copying a directory into its own subtree, which covers
  criterion 8's self-copy case without a separate check.
- Failures are collected per source; the loop continues.

### `renderer/index.ts`

- `dragover` on `#tree`: proceed only when `dataTransfer.types` includes
  `"Files"`, set `dropEffect = "copy"`, recompute and highlight the destination
  row. Recomputing on every `dragover` avoids tracking enter/leave pairs across
  nested row children.
- `dragleave` on `#tree` (when the pointer actually left the tree) and `drop`
  clear the highlight.
- Destination resolution reuses the context menu's existing rule:
  `closest(".tree-row")` → `nodeAt(path)` → directory ? `node.path` :
  `parentPathOf(node.path)`, falling back to `projectRoot`.
- `needsCopyConfirm(fileCount, totalBytes, truncated)` is a pure function so it
  can be unit tested without a DOM.
- Confirmation uses `window.confirm`, the same mechanism the existing delete
  confirmation uses. No new UI component.
- `document` gets `dragover`/`drop` handlers that call `preventDefault()`, so a
  file dropped outside the tree cannot make Chromium navigate to it. The
  existing `will-navigate` guard stays as the second layer.

### `renderer/styles.css`

`.tree-row.is-drop-target` — an accent outline reusing the existing
`var(--accent)`.

### Thresholds

```
CONFIRM_FILE_COUNT = 5          // confirm at 5 or more files
CONFIRM_TOTAL_BYTES = 500 MiB   // confirm above this
MEASURE_FILE_CAP = 10_000       // stop measuring here
```

The confirmation text names the destination folder as well as the size, so a
drop onto the wrong folder is caught by the same dialog.

## Files changed

| File | Change |
| --- | --- |
| `companion/shared/claude-command.ts` | two IPC channel constants |
| `companion/main/paths.ts` | `measureCopySources`, `copyIntoContainedDirectory`, `uniqueDestinationName` |
| `companion/main/ipc.ts` | `pathCopyMeasure`, `pathCopyInto` handlers |
| `companion/preload/index.ts` | `paths.filePath`, `paths.measureCopy`, `paths.copyInto` |
| `companion/renderer/index.ts` | drag handlers, destination resolution, `needsCopyConfirm`, confirm + toast |
| `companion/renderer/styles.css` | `.tree-row.is-drop-target` |

## Tests

`companion/tests/paths.test.ts`:

1. A destination outside the root is rejected.
2. An external file is copied into a project subfolder.
3. A folder is copied with its nested contents.
4. A colliding name produces `name (1).ext` and leaves the existing file
   untouched.
5. Measurement sums file count and bytes across nested folders.
6. Measurement past the cap returns `truncated: true` and stops early.
7. One unreadable source does not stop the remaining sources.

`companion/tests/renderer-labels.test.ts` (or a new small file):

8. `needsCopyConfirm` is true at 5 files, false at 4, true above 500 MiB, and
   true whenever `truncated`.

## Non-goals

- Progress or cancellation UI for a running copy. Large drops are rare and the
  confirmation already gates them; add it if a copy is reported as feeling hung.
- Internal drag to move or reorder tree entries.
- Rename.
- Copying out of the project by dragging a row to Windows Explorer.
