# Explorer Drag-and-Drop Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy files and folders dropped from Windows Explorer into the Companion explorer's tree, confirming first when the drop is large enough to be a mistake.

**Architecture:** The renderer turns dropped `File` objects into path strings through a preload helper (`webUtils.getPathForFile`), then makes two IPC calls: one to measure the sources, one to copy them. The main process seals only the *destination* inside the project root — the source is by definition outside it — and delegates recursive copying to `fs.cp`.

**Tech Stack:** Electron 43 (Node 22), TypeScript, vitest, plain DOM/CSS.

## Global Constraints

- Confirmation thresholds: 5 or more files, or more than `500 * 1024 * 1024` bytes.
- Measurement cap: 10,000 files, after which totals are lower bounds.
- Nothing is ever overwritten: colliding names get ` (n)` before the extension.
- `sandbox: true` and `contextIsolation: true` stay on; only `webUtils` may be added to the preload's Electron imports.
- New user-facing strings are Korean.
- Comments are English, matching the rest of `companion/`.
- Every task ends with `npx vitest run companion/tests` and `npx tsc --noEmit` both clean.
- Run all commands from `d:/020_PROJECT/20260716_STREAMDECK/_FIRST/claude-usage-streamdeck`.

## File Structure

| File | Responsibility |
| --- | --- |
| `companion/shared/copy-guard.ts` (new) | Thresholds and the confirm decision. Pure, no DOM, no fs — so it is testable and usable from both sides. |
| `companion/main/paths.ts` (modify) | `measureCopySources`, `uniqueDestinationName`, `copyIntoContainedDirectory`. |
| `companion/shared/claude-command.ts` (modify) | Two IPC channel names. |
| `companion/main/ipc.ts` (modify) | Two handlers with argument validation. |
| `companion/preload/index.ts` (modify) | `paths.filePath` / `measureCopy` / `copyInto`. |
| `companion/renderer/index.ts` (modify) | Drag handlers, destination resolution, confirm, toast, refresh. |
| `companion/renderer/styles.css` (modify) | `.tree-row.is-drop-target`. |

---

### Task 1: Confirm-threshold module

**Files:**
- Create: `companion/shared/copy-guard.ts`
- Test: `companion/tests/copy-guard.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type CopyMeasurement = { fileCount: number; totalBytes: number; truncated: boolean }`, `CONFIRM_FILE_COUNT: number`, `CONFIRM_TOTAL_BYTES: number`, `needsCopyConfirm(measurement: CopyMeasurement): boolean`, `formatCopySize(bytes: number): string`.

- [ ] **Step 1: Write the failing test**

Create `companion/tests/copy-guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  CONFIRM_FILE_COUNT,
  CONFIRM_TOTAL_BYTES,
  formatCopySize,
  needsCopyConfirm
} from "../shared/copy-guard";

describe("needsCopyConfirm", () => {
  it("asks at the file-count threshold but not below it", () => {
    expect(
      needsCopyConfirm({ fileCount: CONFIRM_FILE_COUNT - 1, totalBytes: 10, truncated: false })
    ).toBe(false);
    expect(
      needsCopyConfirm({ fileCount: CONFIRM_FILE_COUNT, totalBytes: 10, truncated: false })
    ).toBe(true);
  });

  it("asks above the size threshold even for a single file", () => {
    expect(
      needsCopyConfirm({ fileCount: 1, totalBytes: CONFIRM_TOTAL_BYTES, truncated: false })
    ).toBe(false);
    expect(
      needsCopyConfirm({ fileCount: 1, totalBytes: CONFIRM_TOTAL_BYTES + 1, truncated: false })
    ).toBe(true);
  });

  it("always asks when the measurement was cut short", () => {
    expect(needsCopyConfirm({ fileCount: 1, totalBytes: 1, truncated: true })).toBe(true);
  });
});

describe("formatCopySize", () => {
  it("scales to the largest unit that keeps the number small", () => {
    expect(formatCopySize(512)).toBe("512B");
    expect(formatCopySize(1536)).toBe("1.5KB");
    expect(formatCopySize(3 * 1024 * 1024)).toBe("3.0MB");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run companion/tests/copy-guard.test.ts`
Expected: FAIL — `Failed to resolve import "../shared/copy-guard"`.

- [ ] **Step 3: Write the implementation**

Create `companion/shared/copy-guard.ts`:

```ts
/**
 * A drop can pull in far more than the user meant: one folder row in Windows
 * Explorer can be a node_modules tree. Past either threshold the copy is
 * confirmed first, because a mis-drag is otherwise silent and unbounded.
 */
export const CONFIRM_FILE_COUNT = 5;
export const CONFIRM_TOTAL_BYTES = 500 * 1024 * 1024;

export type CopyMeasurement = {
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
};

/**
 * `truncated` always confirms: the walk only gives up once it is already past
 * the caps, so a cut-short measurement is by construction a large drop.
 */
export function needsCopyConfirm(measurement: CopyMeasurement): boolean {
  return (
    measurement.truncated ||
    measurement.fileCount >= CONFIRM_FILE_COUNT ||
    measurement.totalBytes > CONFIRM_TOTAL_BYTES
  );
}

/** Short enough to sit inside a one-line confirmation: "842.3MB". */
export function formatCopySize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)}${units[unit]}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run companion/tests/copy-guard.test.ts`
Expected: PASS (6 assertions across 4 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add companion/shared/copy-guard.ts companion/tests/copy-guard.test.ts
git commit -m "feat: 드롭 복사 확인 임계값 모듈 추가"
```

---

### Task 2: Measure what a drop would copy

**Files:**
- Modify: `companion/main/paths.ts` (add imports at line 1; append the function at the end of the file)
- Test: `companion/tests/paths.test.ts` (append inside the existing `describe("contained path operations")` block)

**Interfaces:**
- Consumes: `CopyMeasurement` from `../shared/copy-guard` (Task 1).
- Produces: `MEASURE_FILE_CAP: number`, `measureCopySources(sourcePaths: string[], cap?: number): Promise<CopyMeasurement>`.

- [ ] **Step 1: Write the failing test**

Append to `companion/tests/paths.test.ts` inside the `describe("contained path operations", …)` block:

```ts
  it("sums files and bytes across nested folders", async () => {
    await mkdir(path.join(root, "nested", "deep"), { recursive: true });
    await writeFile(path.join(root, "nested", "a.txt"), "12345", "utf8");
    await writeFile(path.join(root, "nested", "deep", "b.txt"), "678", "utf8");

    const measured = await measureCopySources([path.join(root, "nested")]);

    expect(measured.fileCount).toBe(2);
    expect(measured.totalBytes).toBe(8);
    expect(measured.truncated).toBe(false);
  });

  it("stops at the cap and reports the totals as lower bounds", async () => {
    const many = path.join(root, "many");
    await mkdir(many, { recursive: true });
    for (let index = 0; index < 12; index += 1) {
      await writeFile(path.join(many, `f${index}.txt`), "x", "utf8");
    }

    // The `many` directory itself consumes one of the ten capped entries.
    const measured = await measureCopySources([many], 10);

    expect(measured.truncated).toBe(true);
    expect(measured.fileCount).toBe(9);
  });

  it("caps directory-heavy trees too, not just file-heavy ones", async () => {
    // A tree of empty folders never raises fileCount, so a cap that counted
    // only files would walk it to the end — the freeze the cap exists to stop.
    let nested = path.join(root, "dirs");
    for (let index = 0; index < 8; index += 1) {
      nested = path.join(nested, `d${index}`);
    }
    await mkdir(nested, { recursive: true });

    const measured = await measureCopySources([path.join(root, "dirs")], 5);

    expect(measured.truncated).toBe(true);
    expect(measured.fileCount).toBe(0);
  });

  it("skips an unreadable source instead of failing the whole measurement", async () => {
    await writeFile(path.join(root, "real.txt"), "abc", "utf8");

    const measured = await measureCopySources([
      path.join(root, "missing.txt"),
      path.join(root, "real.txt")
    ]);

    expect(measured.fileCount).toBe(1);
    expect(measured.totalBytes).toBe(3);
  });
```

Add `measureCopySources` to the existing import block from `"../main/paths"` at the top of the file (keep the list alphabetical: it goes after `listProjectFilesRecursive`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run companion/tests/paths.test.ts`
Expected: FAIL — `measureCopySources is not a function` / no export.

- [ ] **Step 3: Write the implementation**

In `companion/main/paths.ts`, extend the first import line to pull in `cp` and `lstat`:

```ts
import { cp, lstat, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
```

Add the shared-module import below the existing `import { readModelPrefs } from "./model-prefs";`:

```ts
import type { CopyMeasurement } from "../shared/copy-guard";
```

Append at the end of the file:

```ts
export const MEASURE_FILE_CAP = 10_000;

/**
 * Count the files and bytes a drop would copy.
 *
 * `lstat`, not `stat`, because this has to describe what `fs.cp` will actually
 * do and cp defaults to `dereference: false`: a symlink is copied as a link, so
 * its target is neither counted nor walked — which also makes a link cycle
 * impossible to hang on.
 *
 * The walk gives up at `cap`. Reaching it forces confirmation on its own
 * (via `truncated`), which is why an exact total would not change the answer,
 * and measuring a huge tree exactly is the very case where the user would sit
 * in front of a frozen window waiting for the dialog that was supposed to
 * protect them.
 *
 * The cap bounds visited entries (both files and directories), not file count
 * alone, so a directory-heavy tree (thousands of near-empty nested folders)
 * cannot bypass the cap and freeze the walk.
 *
 * Unreadable entries are skipped rather than thrown: this measurement only
 * decides whether to ask, and the copy itself reports per-source failures.
 */
export async function measureCopySources(
  sourcePaths: string[],
  cap = MEASURE_FILE_CAP
): Promise<CopyMeasurement> {
  let fileCount = 0;
  let totalBytes = 0;
  let entryCount = 0;
  let truncated = false;

  async function visit(target: string): Promise<void> {
    if (entryCount >= cap) {
      truncated = true;
      return;
    }

    const info = await lstat(target).catch(() => undefined);
    if (!info) {
      return;
    }

    entryCount += 1;

    if (info.isDirectory()) {
      const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entryCount >= cap) {
          truncated = true;
          return;
        }
        await visit(path.join(target, entry.name));
      }
      return;
    }

    fileCount += 1;
    totalBytes += info.size;
  }

  for (const source of sourcePaths) {
    await visit(source);
  }

  return { fileCount, totalBytes, truncated };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run companion/tests/paths.test.ts`
Expected: PASS, all tests in the file green.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add companion/main/paths.ts companion/tests/paths.test.ts
git commit -m "feat: 드롭 대상 파일 수와 용량 측정 추가"
```

---

### Task 3: Copy sources into a contained folder

**Files:**
- Modify: `companion/main/paths.ts` (append after `measureCopySources`)
- Test: `companion/tests/paths.test.ts` (append inside the same describe block)

**Interfaces:**
- Consumes: `resolveContainedDirectory` (already in `paths.ts`), `cp`/`lstat` imports added in Task 2.
- Produces: `type CopyResult = { copied: string[]; failed: string[] }`, `uniqueDestinationName(directory: string, name: string): Promise<string>`, `copyIntoContainedDirectory(root: string, destinationPath: string, sourcePaths: string[]): Promise<CopyResult>`.

- [ ] **Step 1: Write the failing test**

Append to `companion/tests/paths.test.ts` inside the same describe block:

```ts
  it("copies an external file into a project subfolder", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "companion-drop-"));
    try {
      await writeFile(path.join(outside, "note.txt"), "hello", "utf8");
      await mkdir(path.join(root, "docs"), { recursive: true });

      const result = await copyIntoContainedDirectory(root, "docs", [
        path.join(outside, "note.txt")
      ]);

      expect(result).toEqual({ copied: ["note.txt"], failed: [] });
      expect(await readFile(path.join(root, "docs", "note.txt"), "utf8")).toBe("hello");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("copies a folder with its nested contents", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "companion-drop-"));
    try {
      await mkdir(path.join(outside, "bundle", "inner"), { recursive: true });
      await writeFile(path.join(outside, "bundle", "inner", "deep.txt"), "d", "utf8");

      const result = await copyIntoContainedDirectory(root, ".", [
        path.join(outside, "bundle")
      ]);

      expect(result.copied).toEqual(["bundle"]);
      expect(await readFile(path.join(root, "bundle", "inner", "deep.txt"), "utf8")).toBe("d");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("renames instead of overwriting a name already in the destination", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "companion-drop-"));
    try {
      await writeFile(path.join(outside, "note.txt"), "new", "utf8");
      await writeFile(path.join(root, "note.txt"), "original", "utf8");

      const result = await copyIntoContainedDirectory(root, ".", [
        path.join(outside, "note.txt")
      ]);

      expect(result.copied).toEqual(["note (1).txt"]);
      expect(await readFile(path.join(root, "note.txt"), "utf8")).toBe("original");
      expect(await readFile(path.join(root, "note (1).txt"), "utf8")).toBe("new");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a destination outside the root", async () => {
    await expect(copyIntoContainedDirectory(root, "..", [])).rejects.toThrow(
      "Path is outside the allowed root"
    );
  });

  it("keeps copying after one source fails", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "companion-drop-"));
    try {
      await writeFile(path.join(outside, "ok.txt"), "ok", "utf8");

      const result = await copyIntoContainedDirectory(root, ".", [
        path.join(outside, "missing.txt"),
        path.join(outside, "ok.txt")
      ]);

      expect(result.copied).toEqual(["ok.txt"]);
      expect(result.failed).toEqual(["missing.txt"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
```

Add `copyIntoContainedDirectory` to the import block from `"../main/paths"` (alphabetically it goes right after `claudeConversationExists`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run companion/tests/paths.test.ts`
Expected: FAIL — no export named `copyIntoContainedDirectory`.

- [ ] **Step 3: Write the implementation**

Append to `companion/main/paths.ts`:

```ts
export type CopyResult = {
  copied: string[];
  failed: string[];
};

/**
 * A free name in `directory` for `name`, suffixing " (n)" before the extension
 * the way Windows Explorer does. There is no overwrite path at all, so a
 * mis-drop can never destroy work that is already in the project.
 */
export async function uniqueDestinationName(
  directory: string,
  name: string
): Promise<string> {
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;

  for (let index = 0; index <= 1000; index += 1) {
    const candidate = index === 0 ? name : `${stem} (${index})${extension}`;
    const taken = await lstat(path.join(directory, candidate)).then(
      () => true,
      () => false
    );
    if (!taken) {
      return candidate;
    }
  }

  throw new Error(`No free name for ${name}`);
}

/**
 * Copy dropped sources into a folder inside the project.
 *
 * The containment rule inverts here. Every other helper in this file requires
 * both ends inside the root; a drop's source is by definition outside it, so
 * only the destination is sealed. `fs.cp` refuses to copy a directory into its
 * own subtree, which covers a source dragged from within the project itself.
 *
 * One bad source must not cost the user the rest of the drop, so failures are
 * collected per source and the loop continues.
 */
export async function copyIntoContainedDirectory(
  root: string,
  destinationPath: string,
  sourcePaths: string[]
): Promise<CopyResult> {
  const destination = await resolveContainedDirectory(root, destinationPath);
  const copied: string[] = [];
  const failed: string[] = [];

  for (const source of sourcePaths) {
    const sourceName = path.basename(source);
    // A drive root ("D:\") has no basename and so no name to copy it under.
    if (sourceName.length === 0) {
      failed.push(source);
      continue;
    }
    try {
      const name = await uniqueDestinationName(destination, sourceName);
      // errorOnExist guards the gap between picking the name and writing it.
      await cp(source, path.join(destination, name), {
        recursive: true,
        errorOnExist: true,
        force: false
      });
      copied.push(name);
    } catch {
      failed.push(sourceName);
    }
  }

  return { copied, failed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run companion/tests/paths.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add companion/main/paths.ts companion/tests/paths.test.ts
git commit -m "feat: 프로젝트 안으로 파일·폴더 복사 추가"
```

---

### Task 4: IPC channels, handlers, and the preload bridge

**Files:**
- Modify: `companion/shared/claude-command.ts` (the `COMPANION_IPC` object, near line 84)
- Modify: `companion/main/ipc.ts` (import block near line 14; handlers after the `pathReveal` handler near line 263)
- Modify: `companion/preload/index.ts` (Electron import line 1; `ClaudeCompanionApi["paths"]` near line 51; the `paths` implementation near line 151)
- Test: `companion/tests/ipc.test.ts` (append inside the existing describe block, after the `registerFor` helper)

**Interfaces:**
- Consumes: `measureCopySources`, `copyIntoContainedDirectory`, `CopyResult` (Tasks 2-3); `CopyMeasurement` (Task 1).
- Produces: `COMPANION_IPC.pathCopyMeasure`, `COMPANION_IPC.pathCopyInto`, and on the renderer API — `paths.filePath(file: File): string`, `paths.measureCopy(sourcePaths: string[]): Promise<CopyMeasurement>`, `paths.copyInto(destinationPath: string, sourcePaths: string[]): Promise<CopyResult>`.

- [ ] **Step 1: Write the failing test**

Append to `companion/tests/ipc.test.ts` inside the same describe block:

```ts
  it("copies dropped sources into a contained destination and rejects a bad payload", async () => {
    const ipcMain = registerFor();
    const outside = await mkdtemp(path.join(os.tmpdir(), "companion-ipc-drop-"));
    try {
      await writeFile(path.join(outside, "dropped.txt"), "hi", "utf8");

      const measured = await ipcMain.handlers.get(COMPANION_IPC.pathCopyMeasure)?.({}, [
        path.join(outside, "dropped.txt")
      ]);
      expect(measured).toEqual({ fileCount: 1, totalBytes: 2, truncated: false });

      const result = await ipcMain.handlers.get(COMPANION_IPC.pathCopyInto)?.({}, ".", [
        path.join(outside, "dropped.txt")
      ]);
      expect(result).toEqual({ copied: ["dropped.txt"], failed: [] });
      expect(await readFile(path.join(root, "dropped.txt"), "utf8")).toBe("hi");

      await expect(
        ipcMain.handlers.get(COMPANION_IPC.pathCopyInto)?.({}, ".", "not-an-array")
      ).rejects.toThrow(/sourcePaths must be an array of strings/u);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
```

Make sure `mkdtemp`, `readFile`, `rm`, `writeFile` from `node:fs/promises`, plus `os` and `path`, are imported at the top of `ipc.test.ts`; add whichever are missing.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run companion/tests/ipc.test.ts`
Expected: FAIL — `COMPANION_IPC.pathCopyMeasure` is undefined, so `handlers.get(undefined)` returns undefined and the awaited value is `undefined`.

- [ ] **Step 3: Add the channels**

In `companion/shared/claude-command.ts`, inside `COMPANION_IPC`, directly after `pathReveal: "companion:path:reveal",`:

```ts
  pathCopyMeasure: "companion:path:copy-measure",
  pathCopyInto: "companion:path:copy-into",
```

- [ ] **Step 4: Add the handlers**

In `companion/main/ipc.ts`, extend the import block from `"./paths"` with `copyIntoContainedDirectory` and `measureCopySources` (keep it alphabetical — `copyIntoContainedDirectory` goes after `createContainedFile`, `measureCopySources` after `listProjectFilesRecursive`).

Add this validator next to the existing `optionalString` helper:

```ts
function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}
```

Add the handlers immediately after the `COMPANION_IPC.pathReveal` handler:

```ts
  // Sources come from a drag out of Windows Explorer, so they are outside the
  // root by design and are not contained-checked. Only the destination is.
  //
  // `async` matters: Electron's own ipcMain.handle awaits the handler inside a
  // try/catch, so a synchronous validation throw is caught either way in
  // production — but the test fake calls the handler directly, where only an
  // async handler turns that throw into an observable rejection. Every other
  // validating handler in this file is async for the same reason.
  deps.ipcMain.handle(
    COMPANION_IPC.pathCopyMeasure,
    async (_event: SenderEvent, sourcePaths: unknown) =>
      measureCopySources(requireStringArray(sourcePaths, "sourcePaths"))
  );
  deps.ipcMain.handle(
    COMPANION_IPC.pathCopyInto,
    async (_event: SenderEvent, destinationPath: unknown, sourcePaths: unknown) =>
      copyIntoContainedDirectory(
        deps.rootPath,
        requireString(destinationPath, "destinationPath"),
        requireStringArray(sourcePaths, "sourcePaths")
      )
  );
```

- [ ] **Step 5: Expose the API through preload**

In `companion/preload/index.ts`, change line 1 to:

```ts
import { contextBridge, ipcRenderer, webUtils } from "electron";
```

Add to the type imports from `"../shared/claude-command"` nothing new, and add above the `ClaudeCompanionApi` type:

```ts
import type { CopyMeasurement } from "../shared/copy-guard";
import type { CopyResult } from "../main/paths";
```

In the `ClaudeCompanionApi` type, extend `paths`:

```ts
  paths: {
    list(path?: string): Promise<DirectoryEntry[]>;
    createDirectory(parentPath: string, name: string): Promise<string>;
    createFile(parentPath: string, name: string, content?: string): Promise<string>;
    delete(path: string): Promise<void>;
    files(): Promise<string[]>;
    open(path: string): Promise<void>;
    reveal(path: string): Promise<void>;
    filePath(file: File): string;
    measureCopy(sourcePaths: string[]): Promise<CopyMeasurement>;
    copyInto(destinationPath: string, sourcePaths: string[]): Promise<CopyResult>;
  };
```

And in the `api.paths` implementation object, after `reveal`:

```ts
    // A File is a DOM object and does not survive contextBridge, so the renderer
    // calls this per dropped file and sends only the resulting path strings.
    // File.path was removed in Electron 32; webUtils is the replacement and is
    // one of the few modules a sandboxed preload still gets.
    filePath: (file) => webUtils.getPathForFile(file),
    measureCopy: (sourcePaths) =>
      ipcRenderer.invoke(COMPANION_IPC.pathCopyMeasure, sourcePaths),
    copyInto: (destinationPath, sourcePaths) =>
      ipcRenderer.invoke(COMPANION_IPC.pathCopyInto, destinationPath, sourcePaths)
```

Remember to add a comma after the existing `reveal: …` line.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run companion/tests && npx tsc --noEmit`
Expected: PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add companion/shared/claude-command.ts companion/main/ipc.ts companion/preload/index.ts companion/tests/ipc.test.ts
git commit -m "feat: 드롭 복사 IPC 채널과 preload 브리지 추가"
```

---

### Task 5: Drag-and-drop in the explorer tree

**Files:**
- Modify: `companion/renderer/index.ts` (imports at the top; new handlers near the existing `treeElement.addEventListener("contextmenu", …)` around line 910)
- Modify: `companion/renderer/styles.css` (after the `.tree-row:hover, .tree-row.is-selected` rule around line 476)

**Interfaces:**
- Consumes: `needsCopyConfirm`, `formatCopySize`, `CopyMeasurement` (Task 1); `api.paths.filePath` / `measureCopy` / `copyInto` (Task 4); existing renderer helpers `nodeAt`, `parentPathOf`, `projectRoot`, `projectNameFromPath`, `refreshPath`, `showToast`, `treeElement`.
- Produces: nothing consumed by later tasks — this is the last one.

- [ ] **Step 1: Add the imports**

In `companion/renderer/index.ts`, add near the other `../shared/*` imports:

```ts
import {
  formatCopySize,
  needsCopyConfirm,
  type CopyMeasurement
} from "../shared/copy-guard";
```

- [ ] **Step 2: Add the drag handlers**

Insert directly after the existing `treeElement.addEventListener("contextmenu", …)` block:

```ts
// Dropping files from Windows Explorer copies them into the folder under the
// pointer. Only external drags carry "Files"; an internal drag of a row does
// not, so the tree ignores it and internal move stays out of scope.
let dropTargetRow: HTMLElement | undefined;

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function rowUnder(target: EventTarget | null): HTMLElement | undefined {
  return (target as HTMLElement | null)?.closest<HTMLElement>(".tree-row") ?? undefined;
}

function highlightDropTarget(row: HTMLElement | undefined): void {
  if (dropTargetRow === row) {
    return;
  }
  dropTargetRow?.classList.remove("is-drop-target");
  row?.classList.add("is-drop-target");
  dropTargetRow = row;
}

/**
 * A folder row takes the drop itself, a file row hands it to its parent, and
 * the empty area below the rows is the project folder — the same rule the
 * context menu already uses, so every spot in the tree is a valid destination.
 */
function dropDestination(target: EventTarget | null): string {
  const row = rowUnder(target);
  const node = row?.dataset.path ? nodeAt(row.dataset.path) : undefined;
  if (!node) {
    return projectRoot;
  }
  return node.kind === "directory" ? node.path : parentPathOf(node.path);
}

treeElement.addEventListener("dragover", (event) => {
  if (!carriesFiles(event)) {
    return;
  }
  // Without preventDefault the element is not a drop target at all.
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
  highlightDropTarget(rowUnder(event.target));
});

treeElement.addEventListener("dragleave", (event) => {
  // Moving between two rows fires dragleave on the one being left; only clear
  // the highlight when the pointer has actually left the tree.
  if (!treeElement.contains(event.relatedTarget as Node | null)) {
    highlightDropTarget(undefined);
  }
});

treeElement.addEventListener("drop", (event) => {
  if (!carriesFiles(event)) {
    return;
  }
  event.preventDefault();
  const destination = dropDestination(event.target);
  const files = Array.from(event.dataTransfer?.files ?? []);
  highlightDropTarget(undefined);
  void copyDroppedFiles(destination, files);
});

// A file dropped anywhere else would make Chromium navigate the renderer to it.
// The window's will-navigate guard also blocks that; this removes the default
// before it can fire.
document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => event.preventDefault());
```

- [ ] **Step 3: Add the copy routine**

Insert directly after the `deleteNode` function (around line 974):

```ts
/** The transcript-free summary a finished drop reports. */
function copyResultMessage(result: { copied: string[]; failed: string[] }): string {
  const head =
    result.copied.length > 0
      ? `'${result.copied[0]}'${
          result.copied.length > 1 ? ` 외 ${result.copied.length - 1}개` : ""
        }를 복사했습니다.`
      : "복사한 항목이 없습니다.";
  return result.failed.length > 0
    ? `${head} ${result.failed.length}개는 실패했습니다.`
    : head;
}

function copyConfirmMessage(measurement: CopyMeasurement, destination: string): string {
  const count = `${measurement.fileCount.toLocaleString()}개${
    measurement.truncated ? " 이상" : ""
  }`;
  const size = `${formatCopySize(measurement.totalBytes)}${
    measurement.truncated ? " 이상" : ""
  }`;
  // Naming the destination folder means a drop onto the wrong row is caught by
  // the same dialog that catches a drop that is too big.
  return `파일 ${count}(${size})를 '${projectNameFromPath(destination)}' 폴더로 복사합니다. 계속할까요?`;
}

async function copyDroppedFiles(destination: string, files: File[]): Promise<void> {
  if (!api || files.length === 0) {
    return;
  }

  const sourcePaths = files
    .map((file) => api.paths.filePath(file))
    .filter((entry) => entry.length > 0);
  if (sourcePaths.length === 0) {
    showToast("드롭한 항목의 경로를 읽지 못했습니다.");
    return;
  }

  let measurement: CopyMeasurement;
  try {
    measurement = await api.paths.measureCopy(sourcePaths);
  } catch {
    showToast("복사할 항목을 확인하지 못했습니다.");
    return;
  }

  if (needsCopyConfirm(measurement) && !window.confirm(copyConfirmMessage(measurement, destination))) {
    return;
  }

  try {
    const result = await api.paths.copyInto(destination, sourcePaths);
    await refreshPath(destination);
    showToast(copyResultMessage(result));
  } catch {
    showToast("복사하지 못했습니다.");
  }
}
```

- [ ] **Step 4: Add the drop-target style**

In `companion/renderer/styles.css`, after the `.tree-row:hover, .tree-row.is-selected` rule:

```css
/* The row a drop would land in. An outline rather than a fill, so it reads as
   a target and not as the selection the tree already paints with #2a2d2e. */
.tree-row.is-drop-target {
  outline: 1px solid var(--accent);
  outline-offset: -1px;
  background: #2f2a28;
}
```

- [ ] **Step 5: Verify the build**

Run: `npx vitest run companion/tests && npx tsc --noEmit && npm run companion:build`
Expected: tests pass, typecheck clean, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add companion/renderer/index.ts companion/renderer/styles.css
git commit -m "feat: 탐색기 폴더에 파일·폴더 드롭 복사"
```

- [ ] **Step 7: Manual verification**

Requires a Companion rebuild, which means closing the running app — **ask the user before doing this.** Then, with the app running:

1. Drag a single file from Windows Explorer onto a folder row → copies with no dialog, toast names the file, the folder re-lists.
2. Drop the same file again → a second copy appears as `name (1).ext`, the first is unchanged.
3. Drop onto a file row → the file lands in that file's folder.
4. Drop onto the empty area below the rows → the file lands in the project root.
5. Drag 5+ files at once → confirmation dialog naming the count, size, and destination folder; Cancel copies nothing.
6. Drop a folder larger than 500 MB → confirmation dialog.
7. Drop a file onto the console area → nothing happens and the window does not navigate.

---

## Self-Review

**Spec coverage:**

| Spec criterion | Task |
| --- | --- |
| 1 copy cursor + highlight | 5 |
| 2 destination rule | 5 (`dropDestination`) |
| 3 copy including folder contents | 3 |
| 4 ` (n)` rename | 3 (`uniqueDestinationName`) |
| 5 confirm thresholds | 1 + 5 |
| 6 no dialog below thresholds | 1 (`needsCopyConfirm`) + 5 |
| 7 measurement cap | 2 |
| 8 destination contained, self-copy rejected | 3 (`resolveContainedDirectory`, `fs.cp`) |
| 9 partial failure reporting | 3 + 5 (`copyResultMessage`) |
| 10 re-list keeping expanded state | 5 (`refreshPath`) |
| 11 no navigation on outside drops | 5 (document handlers) |
| 12 internal drag inert | 5 (`carriesFiles`) |
| 13 Korean strings | 5 |

No gaps.

**Type consistency:** `CopyMeasurement` is defined once in Task 1 and imported by Tasks 2, 4, 5. `CopyResult` is defined in Task 3 and imported by Task 4. `measureCopySources(sourcePaths, cap?)` and `copyIntoContainedDirectory(root, destinationPath, sourcePaths)` keep the same signatures in the handlers of Task 4 and the tests of Tasks 2-3.
