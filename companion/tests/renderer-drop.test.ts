import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { copyResultMessage, needsCopyConfirm } from "../shared/copy-guard";

// Exercise the renderer's real drop orchestration with filesystem/UI ports
// mocked, without booting Electron, xterm, or copying user files.
const source = ts.createSourceFile(
  "index.ts",
  readFileSync(new URL("../renderer/index.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true
);
const fn = source.statements.find((node) =>
  ts.isFunctionDeclaration(node) && node.name?.text === "copyDroppedFiles"
);
if (!fn) throw new Error("copyDroppedFiles entry point not found");
const script = ts.transpileModule(fn.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText;

function fixture(refreshFails = false) {
  const copyInto = vi.fn(async () => ({ copied: ["good.txt"], failed: ["unreadable.txt"] }));
  const showToast = vi.fn();
  const scope = {
    api: { paths: {
      filePath: (file: { name: string }) => {
        if (file.name === "virtual") throw new Error("No filesystem path");
        return file.name === "empty" ? "" : file.name;
      },
      measureCopy: vi.fn(async () => ({ fileCount: 2, totalBytes: 1, truncated: false })),
      copyInto
    } },
    showToast, copyResultMessage, needsCopyConfirm,
    refreshTree: vi.fn(async () => { if (refreshFails) throw new Error("Refresh failed"); })
  };
  const context = vm.createContext(scope);
  vm.runInContext(script, context);
  const run = (context.copyDroppedFiles as (destination: string, files: { name: string }[]) => Promise<void>);
  return { run, copyInto, showToast };
}

describe("external drop result", () => {
  it.each([false, true])("reports path and copy failures even when refresh fails=%s", async (refreshFails) => {
    const { run, copyInto, showToast } = fixture(refreshFails);
    await run("project", ["good.txt", "virtual", "empty", "unreadable.txt"].map(name => ({ name })));
    expect(copyInto).toHaveBeenCalledWith("project", ["good.txt", "unreadable.txt"]);
    expect(showToast.mock.calls.at(-1)?.[0]).toContain("3개는 실패했습니다.");
  });

  it("does not attempt a copy when every path is unavailable", async () => {
    const { run, copyInto, showToast } = fixture();
    await run("project", [{ name: "virtual" }, { name: "empty" }]);
    expect(copyInto).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith("드롭한 항목의 경로를 읽지 못했습니다.");
  });
});
