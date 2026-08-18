import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_FILE_BYTES,
  MAX_HITS_PER_FILE,
  searchProjectText
} from "../main/project-search";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "companion-search-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(relativePath: string, content: string | Buffer): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

describe("searchProjectText", () => {
  it("finds a string and reports the file, line and column", async () => {
    await write("src/app.ts", "const a = 1;\nconst needle = 2;\n");

    const result = await searchProjectText(root, "needle");

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.relativePath).toBe("src/app.ts");
    expect(result.files[0]?.hits).toEqual([
      { line: 2, column: 6, text: "const needle = 2;" }
    ]);
    expect(result.truncated).toBe(false);
  });

  it("matches case-insensitively", async () => {
    await write("readme.md", "The NEEDLE is here.\n");

    const result = await searchProjectText(root, "needle");

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.hits[0]?.line).toBe(1);
  });

  it("strips indentation and reports the column inside the trimmed text", async () => {
    await write("src/deep.ts", "      return needle;\n");

    const hit = (await searchProjectText(root, "needle")).files[0]?.hits[0];

    expect(hit?.text).toBe("return needle;");
    expect(hit?.text.slice(hit.column, hit.column + "needle".length)).toBe("needle");
  });

  it("handles CRLF line endings without trailing carriage returns", async () => {
    await write("src/crlf.ts", "one\r\nneedle\r\nthree\r\n");

    const hit = (await searchProjectText(root, "needle")).files[0]?.hits[0];

    expect(hit).toEqual({ line: 2, column: 0, text: "needle" });
  });

  it("skips binary files even when the bytes spell the query", async () => {
    await write("assets/blob.bin", Buffer.concat([
      Buffer.from("needle"),
      Buffer.from([0x00]),
      Buffer.from("needle")
    ]));
    await write("src/app.ts", "needle\n");

    const result = await searchProjectText(root, "needle");

    expect(result.files.map((file) => file.relativePath)).toEqual(["src/app.ts"]);
  });

  it("skips files larger than the size cap", async () => {
    await write("big.txt", `${"x".repeat(MAX_FILE_BYTES)}needle`);

    const result = await searchProjectText(root, "needle");

    expect(result.files).toHaveLength(0);
  });

  it("does not visit ignored directories", async () => {
    await write("node_modules/pkg/index.js", "needle\n");
    await write(".git/COMMIT_EDITMSG", "needle\n");
    await write("dist/bundle.js", "needle\n");
    await write("src/app.ts", "needle\n");

    const result = await searchProjectText(root, "needle");

    expect(result.files.map((file) => file.relativePath)).toEqual(["src/app.ts"]);
  });

  it("caps hits per file and marks that file truncated", async () => {
    await write("many.txt", `${"needle\n".repeat(MAX_HITS_PER_FILE + 5)}`);

    const result = await searchProjectText(root, "needle");

    expect(result.files[0]?.hits).toHaveLength(MAX_HITS_PER_FILE);
    expect(result.files[0]?.truncated).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it("clips a long line to a window around the match", async () => {
    await write("long.txt", `${"a".repeat(4000)}needle${"b".repeat(4000)}\n`);

    const hit = (await searchProjectText(root, "needle")).files[0]?.hits[0];

    expect(hit?.text.length).toBeLessThanOrEqual(200);
    expect(hit?.text.slice(hit.column, hit.column + "needle".length)).toBe("needle");
  });

  it("returns nothing for a query under the minimum length", async () => {
    await write("src/app.ts", "a needle\n");

    expect((await searchProjectText(root, "n")).files).toHaveLength(0);
    expect((await searchProjectText(root, "  ")).files).toHaveLength(0);
    expect((await searchProjectText(root, "")).scanned).toBe(0);
  });

  it("ignores a file that contains no match", async () => {
    await write("src/app.ts", "nothing here\n");

    const result = await searchProjectText(root, "needle");

    expect(result.files).toHaveLength(0);
    expect(result.scanned).toBe(1);
  });
});

describe("searchProjectText cancellation", () => {
  it("returns an empty result without scanning when already aborted", async () => {
    await write("src/app.ts", "const needle = 2;\n");
    const controller = new AbortController();
    controller.abort();

    const result = await searchProjectText(root, "needle", controller.signal);

    expect(result.files).toEqual([]);
    expect(result.scanned).toBe(0);
    expect(result.cancelled).toBe(true);
  });

  it("leaves a genuine empty result unmarked, so the two stay distinguishable", async () => {
    await write("src/app.ts", "nothing here");

    const result = await searchProjectText(root, "needle");

    expect(result.files).toEqual([]);
    expect(result.cancelled).toBeUndefined();
  });

  it("stops inside the scan loop, after the directory walk has finished", async () => {
    // Flat on purpose: with no subdirectory the walk calls visit() exactly once,
    // so the reads of `aborted` before the scan loop are a fixed three — the
    // entry guard, that one visit, and the post-walk guard. The fourth read is
    // the loop's own, which is what this test is here to exercise. If a guard is
    // ever added or moved, this count changes and the test says so.
    for (let index = 0; index < 200; index += 1) {
      await write(`file-${index}.ts`, "const needle = 1;\n");
    }
    const READS_BEFORE_LOOP = 3;
    let reads = 0;
    const signal = {
      get aborted(): boolean {
        reads += 1;
        return reads > READS_BEFORE_LOOP;
      }
    };

    const result = await searchProjectText(root, "needle", signal);

    expect(reads).toBe(READS_BEFORE_LOOP + 1);
    expect(result.scanned).toBe(200); // the walk ran to completion
    expect(result.files).toEqual([]); // and not one file was read
    expect(result.cancelled).toBe(true);
  });

  it("still searches normally when no signal is given", async () => {
    await write("src/app.ts", "const needle = 2;\n");

    const result = await searchProjectText(root, "needle");

    expect(result.files).toHaveLength(1);
  });
});
