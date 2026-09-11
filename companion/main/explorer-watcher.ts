import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

const DEBOUNCE_MS = 700;
const MAX_WAIT_MS = 3000;

export class ExplorerWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private maxWaitTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly onChange: () => void,
    private readonly onError?: (error: unknown) => void
  ) {}

  observe(directory: string): void {
    if (this.closed) {
      return;
    }

    const watchedPath = normalizePath(directory);
    if (this.watchers.has(watchedPath)) {
      return;
    }

    try {
      const watcher = watch(watchedPath, { persistent: false }, (eventType, filename) => {
        if (eventType === "rename") {
          this.detachChangedChild(watchedPath, filename);
          this.scheduleChange();
        }
      });
      watcher.on("error", (error) => {
        this.handleWatcherError(watchedPath, watcher, error);
      });
      this.watchers.set(watchedPath, watcher);
    } catch (error) {
      this.onError?.(error);
    }
  }

  reconcile(directory: string, childDirectories: string[]): void {
    if (this.closed) {
      return;
    }

    const parent = normalizePath(directory);
    const extantChildren = new Set(childDirectories.map((child) => normalizePath(child)));

    for (const watchedPath of [...this.watchers.keys()]) {
      if (watchedPath === parent || !isDescendant(parent, watchedPath)) {
        continue;
      }

      const directChild = directChildUnder(parent, watchedPath);
      if (directChild !== undefined && !extantChildren.has(directChild)) {
        this.closeWatcher(watchedPath);
      }
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.clearTimers();
    for (const watchedPath of [...this.watchers.keys()]) {
      this.closeWatcher(watchedPath);
    }
  }

  private handleWatcherError(watchedPath: string, watcher: FSWatcher, error: unknown): void {
    if (this.closed) {
      return;
    }

    if (this.watchers.get(watchedPath) === watcher) {
      this.watchers.delete(watchedPath);
    }
    try {
      watcher.close();
    } catch {
      // A failing watcher may already be closed by Node.
    }
    this.onError?.(error);
    this.scheduleChange();
  }

  private detachChangedChild(parent: string, filename: string | Buffer | null): void {
    if (!filename) {
      return;
    }

    const changedName = filename.toString();
    if (!changedName) {
      return;
    }

    const changedPath = normalizePath(path.join(parent, changedName));
    for (const watchedPath of [...this.watchers.keys()]) {
      if (watchedPath === changedPath || isDescendant(changedPath, watchedPath)) {
        this.closeWatcher(watchedPath);
      }
    }
  }

  private scheduleChange(): void {
    if (this.closed) {
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => this.flushChange(), DEBOUNCE_MS);

    this.maxWaitTimer ??= setTimeout(() => this.flushChange(), MAX_WAIT_MS);
  }

  private flushChange(): void {
    if (this.closed) {
      return;
    }

    this.clearTimers();
    this.onChange();
  }

  private clearTimers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.maxWaitTimer) {
      clearTimeout(this.maxWaitTimer);
      this.maxWaitTimer = undefined;
    }
  }

  private closeWatcher(watchedPath: string): void {
    const watcher = this.watchers.get(watchedPath);
    if (!watcher) {
      return;
    }

    this.watchers.delete(watchedPath);
    try {
      watcher.close();
    } catch (error) {
      this.onError?.(error);
    }
  }
}

function normalizePath(value: string): string {
  return path.resolve(value);
}

function isDescendant(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !isOutsideRelativePath(relative);
}

function directChildUnder(parent: string, descendant: string): string | undefined {
  const relative = path.relative(parent, descendant);
  if (relative === "" || isOutsideRelativePath(relative)) {
    return undefined;
  }

  const [firstSegment] = relative.split(/[\\/]/u);
  return firstSegment ? path.join(parent, firstSegment) : undefined;
}

function isOutsideRelativePath(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}
