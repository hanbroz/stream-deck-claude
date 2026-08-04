import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readGitBranch } from "../main/git-branch";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "companion-git-branch-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("readGitBranch", () => {
  it("reads the branch name, keeping slashes inside it", async () => {
    const root = await makeTemporaryDirectory();
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/feat/drop-copy\n", "utf8");

    await expect(readGitBranch(root)).resolves.toEqual({
      tracked: true,
      branch: "feat/drop-copy"
    });
  });

  it("walks up from a subdirectory to the repository root", async () => {
    const root = await makeTemporaryDirectory();
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    const nested = path.join(root, "companion", "renderer");
    await mkdir(nested, { recursive: true });

    await expect(readGitBranch(nested)).resolves.toEqual({ tracked: true, branch: "main" });
  });

  it("follows the gitdir pointer a linked worktree leaves behind", async () => {
    const root = await makeTemporaryDirectory();
    const worktreeGitDir = path.join(root, "main-repo", ".git", "worktrees", "wt");
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/wt-branch\n", "utf8");
    const worktree = path.join(root, "wt");
    await mkdir(worktree, { recursive: true });
    await writeFile(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf8");

    await expect(readGitBranch(worktree)).resolves.toEqual({
      tracked: true,
      branch: "wt-branch"
    });
  });

  it("reports a detached HEAD with the short commit id", async () => {
    const root = await makeTemporaryDirectory();
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, ".git", "HEAD"), "845a1df".padEnd(40, "0") + "\n", "utf8");

    await expect(readGitBranch(root)).resolves.toEqual({
      tracked: true,
      branch: "845a1df",
      detached: true
    });
  });

  it("reports an untracked folder when there is no .git anywhere above", async () => {
    const root = await makeTemporaryDirectory();

    await expect(readGitBranch(root)).resolves.toEqual({ tracked: false });
  });

  it("resolves a relative gitdir pointer the way a submodule writes it", async () => {
    const root = await makeTemporaryDirectory();
    const moduleGitDir = path.join(root, ".git", "modules", "sub");
    await mkdir(moduleGitDir, { recursive: true });
    await writeFile(path.join(moduleGitDir, "HEAD"), "ref: refs/heads/sub-main\n", "utf8");
    const sub = path.join(root, "sub");
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, ".git"), "gitdir: ../.git/modules/sub\n", "utf8");

    await expect(readGitBranch(sub)).resolves.toEqual({ tracked: true, branch: "sub-main" });
  });

  it("stays 'tracked' when the work tree is found but HEAD cannot be read", async () => {
    // A checkout swapping HEAD under us, or a permission error. Reporting
    // "not a repository" here would assert the opposite of what we know.
    const root = await makeTemporaryDirectory();
    await mkdir(path.join(root, ".git"), { recursive: true });

    await expect(readGitBranch(root)).resolves.toEqual({ tracked: true });
  });

  it("does not fall through to an enclosing repository when .git is unreadable", async () => {
    // The parent is a real repo; the child holds a .git that is neither a
    // directory nor a gitdir pointer. Walking up would report "outer" as the
    // child's own branch — a wrong answer is worse than an unknown one.
    const root = await makeTemporaryDirectory();
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/outer\n", "utf8");
    const child = path.join(root, "child");
    await mkdir(child, { recursive: true });
    await writeFile(path.join(child, ".git"), "this is not a gitdir pointer\n", "utf8");

    await expect(readGitBranch(child)).resolves.toEqual({ tracked: true });
  });
});
