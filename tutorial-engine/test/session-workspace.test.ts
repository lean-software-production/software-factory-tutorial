import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionId,
  LESSON_WORKSPACES_DIRECTORY,
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

    expect((await readdir(session.workspaceRoot)).sort()).toEqual([".git", ".gitignore", LESSON_WORKSPACES_DIRECTORY, ...MATERIALIZED_WORKSPACE_DIRECTORIES].sort());
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

  it("materializes declared lesson workspaces, copying an optional authored template", async () => {
    const contentRoot = await contentFixture();
    await write(join(contentRoot, "lessons/scoped-lesson/lesson.md"), [
      "---",
      "durationMinutes: 5",
      "workspace: workspaces/scoped-lesson",
      "blocks:",
      "  - only",
      "---",
      "# Scoped lesson",
      "",
      "Scoped dek.",
    ].join("\n"));
    await write(join(contentRoot, "workspaces/scoped-lesson/spec.md"), "template spec\n");
    await write(join(contentRoot, "workspaces/scoped-lesson/.gitkeep"), "\n");
    await write(join(contentRoot, "workspaces/unreferenced/file.txt"), "not copied\n");

    const { workspaceRoot } = await (await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "scoped" });

    await expect(readFile(join(workspaceRoot, "workspaces/scoped-lesson/spec.md"), "utf8")).resolves.toBe("template spec\n");
    await expect(readFile(join(workspaceRoot, "workspaces/scoped-lesson/.gitkeep"), "utf8")).resolves.toBe("\n");
    await expect(lstat(join(workspaceRoot, "workspaces/unreferenced"))).rejects.toThrow();
    expect(await git(workspaceRoot, "ls-files", "workspaces/scoped-lesson/spec.md")).toBe("workspaces/scoped-lesson/spec.md");
    expect(await git(workspaceRoot, "ls-files", "workspaces/scoped-lesson/.gitkeep")).toBe("workspaces/scoped-lesson/.gitkeep");
    expect(await git(workspaceRoot, "status", "--porcelain")).toBe("");
  });

  it("tracks .gitkeep for otherwise empty authored lesson workspace templates", async () => {
    const contentRoot = await contentFixture();
    await write(join(contentRoot, "lessons/empty-template/lesson.md"), [
      "---",
      "durationMinutes: 5",
      "workspace: workspaces/empty-template",
      "blocks:",
      "  - only",
      "---",
      "# Empty template",
      "",
      "Empty template dek.",
    ].join("\n"));
    await mkdir(join(contentRoot, "workspaces/empty-template"), { recursive: true });

    const { workspaceRoot } = await (await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "empty-template" });

    await expect(readFile(join(workspaceRoot, "workspaces/empty-template/.gitkeep"), "utf8")).resolves.toBe("");
    expect(await git(workspaceRoot, "ls-files", "workspaces/empty-template/.gitkeep")).toBe("workspaces/empty-template/.gitkeep");
    expect(await git(workspaceRoot, "status", "--porcelain")).toBe("");
  });

  it("tracks .gitkeep for declared lesson workspaces with no authored template", async () => {
    const contentRoot = await contentFixture();
    await write(join(contentRoot, "lessons/empty-scoped/lesson.md"), [
      "---",
      "durationMinutes: 5",
      "workspace: workspaces/empty-scoped",
      "blocks:",
      "  - only",
      "---",
      "# Empty scoped lesson",
      "",
      "Empty scoped dek.",
    ].join("\n"));

    const { workspaceRoot } = await (await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "empty-scoped" });

    await expect(stat(join(workspaceRoot, "workspaces/empty-scoped"))).resolves.toMatchObject({});
    await expect(readFile(join(workspaceRoot, "workspaces/empty-scoped/.gitkeep"), "utf8")).resolves.toBe("");
    expect(await git(workspaceRoot, "ls-files", "workspaces/empty-scoped/.gitkeep")).toBe("workspaces/empty-scoped/.gitkeep");
    expect(await git(workspaceRoot, "status", "--porcelain")).toBe("");
  });

  it("rejects malformed declared lesson workspace paths during materialization", async () => {
    const contentRoot = await contentFixture();
    await write(join(contentRoot, "lessons/bad-scoped/lesson.md"), [
      "---",
      "durationMinutes: 5",
      "workspace: ../escape",
      "blocks:",
      "  - only",
      "---",
      "# Bad scoped lesson",
      "",
      "Bad scoped dek.",
    ].join("\n"));

    await expect((await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "bad-scoped" })).rejects.toThrow(/workspace/);
  });

  it("rejects symlinked lesson workspace templates even when they point inside the content root", async () => {
    const contentRoot = await contentFixture();
    await write(join(contentRoot, "lessons/symlinked-template/lesson.md"), [
      "---",
      "durationMinutes: 5",
      "workspace: workspaces/symlinked-template",
      "blocks:",
      "  - only",
      "---",
      "# Symlinked template",
      "",
      "Symlinked template dek.",
    ].join("\n"));
    await write(join(contentRoot, "workspaces/real-template/spec.md"), "real template\n");
    await symlink(join(contentRoot, "workspaces/real-template"), join(contentRoot, "workspaces/symlinked-template"));

    await expect((await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "symlinked-template" })).rejects.toThrow(/symlinked content/i);
  });

  it("rejects nested symlinks inside authored lesson workspace templates", async () => {
    const contentRoot = await contentFixture();
    await write(join(contentRoot, "lessons/nested-symlink/lesson.md"), [
      "---",
      "durationMinutes: 5",
      "workspace: workspaces/nested-symlink",
      "blocks:",
      "  - only",
      "---",
      "# Nested symlink",
      "",
      "Nested symlink dek.",
    ].join("\n"));
    await write(join(contentRoot, "workspaces/shared/spec.md"), "shared spec\n");
    await mkdir(join(contentRoot, "workspaces/nested-symlink"), { recursive: true });
    await symlink(join(contentRoot, "workspaces/shared/spec.md"), join(contentRoot, "workspaces/nested-symlink/spec.md"));

    await expect((await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "nested-symlink" })).rejects.toThrow(/symlinked content/i);
  });

  it("initializes an isolated Git repository with a clean committed baseline", async () => {
    const contentRoot = await contentFixture();
    const { workspaceRoot } = await (await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "git-ready" });

    expect(await git(workspaceRoot, "rev-parse", "--show-toplevel")).toBe(workspaceRoot);
    expect(await git(workspaceRoot, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await git(workspaceRoot, "log", "--oneline", "-1")).toMatch(/Materialize tutorial workspace/);
    expect(await git(workspaceRoot, "ls-files", ".gitignore")).toBe(".gitignore");
    expect(await git(workspaceRoot, "status", "--porcelain")).toBe("");
  });

  it("ignores regenerated factory .tmp evidence in the session-local Git repository", async () => {
    const contentRoot = await contentFixture();
    const { workspaceRoot } = await (await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "gitignore-ready" });

    await write(join(workspaceRoot, "factory/refactor/.tmp/evidence.txt"), "regenerated evidence\n");

    expect(await readFile(join(workspaceRoot, ".gitignore"), "utf8")).toBe("factory/**/.tmp/\n");
    expect(await git(workspaceRoot, "check-ignore", "factory/refactor/.tmp/evidence.txt")).toBe("factory/refactor/.tmp/evidence.txt");
    expect(await git(workspaceRoot, "status", "--porcelain")).toBe("");
  });

  it("materializes trusted runtime provision mount targets as empty ignored directories", async () => {
    const contentRoot = await contentFixture();
    const runtimeSource = await mkdtemp(join(tmpdir(), "session-runtime-source-")); roots.push(runtimeSource);
    await write(join(runtimeSource, "tool.txt"), "host runtime source\n");

    const session = await (await SessionWorkspaceManager.create(contentRoot)).createSession({
      id: "runtime-ready",
      runtimeProvision: { mounts: [{ source: runtimeSource, target: "runtime-tools", readonly: true }] },
    });

    expect(session.runtimeProvision?.workspaceMountTargets).toEqual(["runtime-tools"]);
    expect(await readdir(join(session.workspaceRoot, "runtime-tools"))).toEqual([]);
    expect(await readFile(join(session.workspaceRoot, ".gitignore"), "utf8")).toBe("factory/**/.tmp/\nruntime-tools/\n");
    expect(await git(session.workspaceRoot, "check-ignore", "runtime-tools/generated.txt")).toBe("runtime-tools/generated.txt");
    expect(await git(session.workspaceRoot, "status", "--porcelain")).toBe("");
  });

  it("rejects runtime provision targets that collide with materialized workspace content", async () => {
    const contentRoot = await contentFixture();
    const runtimeSource = await mkdtemp(join(tmpdir(), "session-runtime-source-")); roots.push(runtimeSource);

    await expect((await SessionWorkspaceManager.create(contentRoot)).createSession({
      id: "runtime-collides",
      runtimeProvision: { mounts: [{ source: runtimeSource, target: "calculator/src", readonly: true }] },
    })).rejects.toThrow(/must be empty|must be a directory/i);
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

  it("rejects a pre-existing .tutorial symlink before creating a session", async () => {
    const contentRoot = await contentFixture();
    const manager = await SessionWorkspaceManager.create(contentRoot);
    const outside = await mkdtemp(join(tmpdir(), "session-state-outside-")); roots.push(outside);

    await symlink(outside, join(manager.contentRoot, ".tutorial"));

    await expect(manager.createSession({ id: "escaped-create" })).rejects.toThrow(/state directory.*symlink/i);
    await expect(lstat(join(outside, "escaped-create"))).rejects.toThrow();
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
