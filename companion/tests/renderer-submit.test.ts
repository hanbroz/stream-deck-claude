import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { addComposerImages, createComposerState, setComposerText, submitComposer } from "../shared/composer";

it("keeps the visible draft and previews instead of sending a rejected image batch", () => {
  // Exercise the real button/Enter handler without starting the app. The
  // absence of any further UI ports also catches falling through after error.
  const source = ts.createSourceFile("index.ts", readFileSync(
    new URL("../renderer/index.ts", import.meta.url), "utf8"
  ), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(node =>
    ts.isFunctionDeclaration(node) && node.name?.text === "submitPrompt"
  );
  if (!fn) throw new Error("submitPrompt entry point not found");
  const images = Array.from({ length: 11 }, (_, index) => ({
    id: String(index), name: `${index}.png`, mimeType: "image/png", dataUrl: "data:image/png;base64,AA=="
  }));
  const showToast = vi.fn();
  const sendIntent = vi.fn();
  const renderImagePreview = vi.fn();
  const scope = vm.createContext({
    composer: addComposerImages(createComposerState(), images),
    promptInput: { value: "keep this message" },
    setComposerText, submitComposer, showToast, sendIntent, renderImagePreview
  });
  vm.runInContext(ts.transpileModule(fn.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, scope);
  scope.submitPrompt();
  expect(scope.promptInput.value).toBe("keep this message");
  expect(scope.composer.images).toEqual(images);
  expect(showToast).toHaveBeenCalledWith("이미지는 한 번에 최대 10개까지 보낼 수 있습니다.");
  expect(sendIntent).not.toHaveBeenCalled();
  expect(renderImagePreview).not.toHaveBeenCalled();
});
