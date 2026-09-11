import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WatchListener = (eventType: "rename" | "change", filename: string | null) => void;

class FakeWatcher extends EventEmitter {
  readonly close = vi.fn();

  constructor(readonly directory: string, readonly listener: WatchListener) {
    super();
  }
}

const watchCalls: FakeWatcher[] = [];
let watchFailure: Error | undefined;
const rootPath = path.resolve("watch-test");
const srcPath = path.join(rootPath, "src");
const appPath = path.join(srcPath, "app");
const docsPath = path.join(rootPath, "docs");
const dotCachePath = path.join(rootPath, "..cache");
const nestedDotCachePath = path.join(dotCachePath, "nested");

vi.mock("node:fs", () => ({
  watch: vi.fn((directory: string, _options: { persistent: boolean }, listener: WatchListener) => {
    if (watchFailure) {
      throw watchFailure;
    }
    const watcher = new FakeWatcher(directory, listener);
    watchCalls.push(watcher);
    return watcher;
  })
}));

describe("ExplorerWatcher", () => {
  let ExplorerWatcher: typeof import("../main/explorer-watcher").ExplorerWatcher;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    watchCalls.length = 0;
    watchFailure = undefined;
    ({ ExplorerWatcher } = await import("../main/explorer-watcher"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it("ignores content saves and notifies once for a structural burst", () => {
    const onChange = vi.fn();
    const watcher = new ExplorerWatcher(onChange);
    watcher.observe(rootPath);

    watchCalls[0].listener("change", "index.ts");
    vi.advanceTimersByTime(1000);
    expect(onChange).not.toHaveBeenCalled();

    watchCalls[0].listener("rename", "new.ts");
    vi.advanceTimersByTime(600);
    watchCalls[0].listener("rename", "other.ts");
    vi.advanceTimersByTime(699);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("flushes a continuous stream at the max wait", () => {
    const onChange = vi.fn();
    const watcher = new ExplorerWatcher(onChange);
    watcher.observe(rootPath);

    for (let elapsed = 0; elapsed < 2400; elapsed += 600) {
      watchCalls[0].listener("rename", null);
      vi.advanceTimersByTime(600);
    }

    watchCalls[0].listener("rename", null);
    vi.advanceTimersByTime(599);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("watches multiple listed directories idempotently", () => {
    const watcher = new ExplorerWatcher(vi.fn());
    watcher.observe(rootPath);
    watcher.observe(rootPath);
    watcher.observe(srcPath);

    expect(watchCalls.map((call) => call.directory)).toEqual([
      rootPath,
      srcPath
    ]);
  });

  it("prunes watched descendants when their direct listed child disappears", () => {
    const watcher = new ExplorerWatcher(vi.fn());
    watcher.observe(rootPath);
    watcher.observe(srcPath);
    watcher.observe(appPath);
    watcher.observe(docsPath);

    watcher.reconcile(rootPath, [docsPath]);

    expect(watchCalls[0].close).not.toHaveBeenCalled();
    expect(watchCalls[1].close).toHaveBeenCalledTimes(1);
    expect(watchCalls[2].close).toHaveBeenCalledTimes(1);
    expect(watchCalls[3].close).not.toHaveBeenCalled();

    watcher.observe(srcPath);
    expect(watchCalls.at(-1)?.directory).toBe(srcPath);
  });

  it("keeps descendant directories whose names start with dot-dot text", () => {
    const watcher = new ExplorerWatcher(vi.fn());
    watcher.observe(rootPath);
    watcher.observe(dotCachePath);
    watcher.observe(nestedDotCachePath);
    watcher.observe(srcPath);

    watcher.reconcile(rootPath, [dotCachePath]);

    expect(watchCalls[0].close).not.toHaveBeenCalled();
    expect(watchCalls[1].close).not.toHaveBeenCalled();
    expect(watchCalls[2].close).not.toHaveBeenCalled();
    expect(watchCalls[3].close).toHaveBeenCalledTimes(1);
  });

  it("detaches watched child directories on parent rename so replacements re-observe", () => {
    const onChange = vi.fn();
    const watcher = new ExplorerWatcher(onChange);
    watcher.observe(rootPath);
    watcher.observe(srcPath);
    watcher.observe(appPath);
    watcher.observe(docsPath);

    watchCalls[0].listener("rename", path.basename(srcPath));

    expect(watchCalls[0].close).not.toHaveBeenCalled();
    expect(watchCalls[1].close).toHaveBeenCalledTimes(1);
    expect(watchCalls[2].close).toHaveBeenCalledTimes(1);
    expect(watchCalls[3].close).not.toHaveBeenCalled();

    watcher.reconcile(rootPath, [srcPath, docsPath]);
    watcher.observe(srcPath);
    expect(watchCalls.at(-1)?.directory).toBe(srcPath);

    vi.advanceTimersByTime(700);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("reports synchronous watch failures and recovers on a future observe", () => {
    const onError = vi.fn();
    const watcher = new ExplorerWatcher(vi.fn(), onError);
    watchFailure = new Error("missing");

    watcher.observe(path.join(rootPath, "gone"));
    expect(onError).toHaveBeenCalledWith(watchFailure);
    expect(watchCalls).toHaveLength(0);

    watchFailure = undefined;
    watcher.observe(path.join(rootPath, "gone"));
    expect(watchCalls).toHaveLength(1);
  });

  it("drops failed runtime watchers, reports, and schedules reconciliation", () => {
    const onChange = vi.fn();
    const onError = vi.fn();
    const watcher = new ExplorerWatcher(onChange, onError);
    watcher.observe(rootPath);
    const runtimeError = new Error("watch failed");

    watchCalls[0].emit("error", runtimeError);
    expect(watchCalls[0].close).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(runtimeError);

    vi.advanceTimersByTime(700);
    expect(onChange).toHaveBeenCalledTimes(1);

    watcher.observe(rootPath);
    expect(watchCalls).toHaveLength(2);
  });

  it("close removes watchers, cancels timers, and makes later observe a no-op", () => {
    const onChange = vi.fn();
    const watcher = new ExplorerWatcher(onChange);
    watcher.observe(rootPath);
    watchCalls[0].listener("rename", "new.ts");

    watcher.close();
    vi.advanceTimersByTime(3000);
    watcher.observe(srcPath);

    expect(watchCalls[0].close).toHaveBeenCalledTimes(1);
    expect(watchCalls).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("ExplorerWatcher with the real filesystem", () => {
  let root: string;

  beforeEach(async () => {
    vi.useRealTimers();
    vi.resetModules();
    vi.doUnmock("node:fs");
    root = await mkdtemp(path.join(os.tmpdir(), "companion-explorer-watcher-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it("notifies once for create, rename, and delete activity in an observed directory", async () => {
    const { ExplorerWatcher } = await import("../main/explorer-watcher");
    const onChange = vi.fn();
    const watcher = new ExplorerWatcher(onChange);
    try {
      watcher.observe(root);

      await writeFile(path.join(root, "created.txt"), "hello", "utf8");
      await rename(path.join(root, "created.txt"), path.join(root, "renamed.txt"));
      await mkdir(path.join(root, "folder"));
      await rm(path.join(root, "renamed.txt"));

      await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1), {
        timeout: 2500,
        interval: 50
      });
    } finally {
      watcher.close();
    }
  });
});
