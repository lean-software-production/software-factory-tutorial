import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionId,
  MATERIALIZED_WORKSPACE_DIRECTORIES,
  SessionWorkspaceManager,
  validateSessionId,
} from "../src/session-workspace.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function write(path: string, content: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function contentFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "session-content-")); roots.push(root);
  await write(join(root, "README.md"), "# Authored tutorial\n");
  await write(join(root, "workbook.md"), "authored workbook\n");
  await write(join(root, "docs/specs/README.md"), "authored specs\n");
  await write(join(root, "lessons/001/lesson.md"), "authored lesson\n");
  await write(join(root, "calculator/package.json"), "{\"type\":\"module\"}\n");
  await write(join(root, "calculator/src/index.ts"), "export const value = 1;\n");
  await write(join(root, "calculator/node_modules/cache.txt"), "must not copy\n");
  await write(join(root, "factory/refactor.md"), "factory seed\n");
  return root;
}

async function snapshotAuthoredFiles(root: string): Promise<Record<string, string>> {
  const files = [
    "README.md",
    "workbook.md",
    "docs/specs/README.md",
    "lessons/001/lesson.md",
    "calculator/package.json",
    "calculator/src/index.ts",
    "calculator/node_modules/cache.txt",
    "factory/refactor.md",
  ];
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(join(root, file), "utf8")])));
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", ["-C", cwd, ...args])).stdout.trim();
}

describe("session IDs", () => {
  it("generates path-safe IDs and rejects IDs that could address paths", () => {
    const id = createSessionId({ now: new Date(2026, 7, 24, 9, 5, 6), randomBytes: () => Buffer.from("a1b2c3d4", "hex") });
    expect(id).toBe("session-20260824-090506-a1b2c3d4");
    expect(validateSessionId("lesson-007")).toBe("lesson-007");

    for (const unsafe of ["", ".", "..", "../escape", "escape/session", "UPPER", "has space", "has_underscore", "has.dot", "-leading", "trailing-", "a".repeat(65)]) {
      expect(() => validateSessionId(unsafe)).toThrow(/session ID/i);
    }
  });
});

describe("SessionWorkspaceManager", () => {
  it("creates and explicitly reopens a session rooted under .tutorial/<id>/workspace", async () => {
    const contentRoot = await contentFixture();
    const manager = await SessionWorkspaceManager.create(contentRoot);

    const created = await manager.createSession({ id: "lesson-007" });
    const canonicalContentRoot = await realpath(contentRoot);
    expect(created).toEqual({
      contentRoot: canonicalContentRoot,
      sessionId: "lesson-007",
      sessionRoot: join(canonicalContentRoot, ".tutorial/lesson-007"),
      workspaceRoot: join(canonicalContentRoot, ".tutorial/lesson-007/workspace"),
    });
    await expect(manager.createSession({ id: "lesson-007" })).rejects.toThrow(/already exists/i);
    await expect(manager.reopenSession("missing-session")).rejects.toThrow(/does not exist/i);
    await expect(manager.reopenSession("../escape")).rejects.toThrow(/session ID/i);
    await expect(manager.reopenSession("lesson-007")).resolves.toEqual(created);
  });

  it("materializes only calculator and factory, and never copies node_modules or authored workbook content", async () => {
    const contentRoot = await contentFixture();
    const manager = await SessionWorkspaceManager.create(contentRoot);

    const session = await manager.createSession({ id: "minimal" });

    expect((await readdir(session.workspaceRoot)).sort()).toEqual([".git", ...MATERIALIZED_WORKSPACE_DIRECTORIES].sort());
    await expect(readdir(join(session.workspaceRoot, "calculator"))).resolves.not.toContain("node_modules");
    await expect(readFile(join(session.workspaceRoot, "calculator/src/index.ts"), "utf8")).resolves.toBe("export const value = 1;\n");
    await expect(readFile(join(session.workspaceRoot, "factory/refactor.md"), "utf8")).resolves.toBe("factory seed\n");
    for (const missing of ["README.md", "workbook.md", "docs", "lessons"]) {
      await expect(lstat(join(session.workspaceRoot, missing))).rejects.toThrow();
    }
  });

  it("keeps authored content immutable when the learner workspace changes", async () => {
    const contentRoot = await contentFixture();
    const before = await snapshotAuthoredFiles(contentRoot);
    const session = await (await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "immutable" });

    await writeFile(join(session.workspaceRoot, "calculator/src/index.ts"), "export const value = 2;\n", "utf8");
    await writeFile(join(session.workspaceRoot, "factory/refactor.md"), "learner changed this\n", "utf8");

    expect(await snapshotAuthoredFiles(contentRoot)).toEqual(before);
  });

  it("gives generated sessions independent workspaces", async () => {
    const contentRoot = await contentFixture();
    const manager = await SessionWorkspaceManager.create(contentRoot);
    const now = new Date(2026, 7, 24, 10, 30, 0);
    const first = await manager.createSession({ now, randomBytes: () => Buffer.from("01020304", "hex") });
    const second = await manager.createSession({ now, randomBytes: () => Buffer.from("05060708", "hex") });
    expect(first.sessionId).not.toBe(second.sessionId);

    await writeFile(join(first.workspaceRoot, "calculator/src/index.ts"), "export const value = 99;\n", "utf8");
    await write(join(first.workspaceRoot, "factory/new-station.sh"), "#!/usr/bin/env bash\n");

    await expect(readFile(join(second.workspaceRoot, "calculator/src/index.ts"), "utf8")).resolves.toBe("export const value = 1;\n");
    await expect(readFile(join(second.workspaceRoot, "factory/new-station.sh"), "utf8")).rejects.toThrow();
  });

  it("initializes an isolated Git repository with a clean committed baseline", async () => {
    const contentRoot = await contentFixture();
    const { workspaceRoot } = await (await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "git-ready" });

    expect(await git(workspaceRoot, "rev-parse", "--show-toplevel")).toBe(workspaceRoot);
    expect(await git(workspaceRoot, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await git(workspaceRoot, "log", "--oneline", "-1")).toMatch(/Materialize tutorial workspace/);
    expect(await git(workspaceRoot, "status", "--porcelain")).toBe("");
  });

  it("rejects missing content directories and materialized paths that leave the content root", async () => {
    const missingFactory = await contentFixture();
    await rm(join(missingFactory, "factory"), { recursive: true, force: true });
    await expect(SessionWorkspaceManager.create(missingFactory)).rejects.toThrow(/factory/);

    const root = await mkdtemp(join(tmpdir(), "session-content-symlink-")); roots.push(root);
    const outside = await mkdtemp(join(tmpdir(), "session-content-outside-")); roots.push(outside);
    await mkdir(join(root, "calculator"));
    await symlink(outside, join(root, "factory"));
    await expect(SessionWorkspaceManager.create(root)).rejects.toThrow(/inside the content root/i);

    const symlinkedFile = await contentFixture();
    await symlink(outside, join(symlinkedFile, "calculator/escape"));
    await expect((await SessionWorkspaceManager.create(symlinkedFile)).createSession({ id: "symlinked-file" })).rejects.toThrow(/symlinked content/i);
  });

  it("rejects reopened session paths that have been replaced with escaping symlinks", async () => {
    const contentRoot = await contentFixture();
    const manager = await SessionWorkspaceManager.create(contentRoot);
    const outside = await mkdtemp(join(tmpdir(), "session-outside-")); roots.push(outside);

    await mkdir(join(manager.contentRoot, ".tutorial"), { recursive: true });
    await symlink(outside, join(manager.contentRoot, ".tutorial/escaped-session"));
    await expect(manager.reopenSession("escaped-session")).rejects.toThrow(/inside/i);

    const { sessionRoot, workspaceRoot } = await manager.createSession({ id: "escaped-workspace" });
    await rm(workspaceRoot, { recursive: true, force: true });
    await symlink(outside, join(sessionRoot, "workspace"));
    await expect(manager.reopenSession("escaped-workspace")).rejects.toThrow(/inside/i);
  });
});
