import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionId,
  SESSION_WORKSPACES_DIRECTORY,
  SessionWorkspaceManager,
  validateSessionId,
  workspaceRootFor,
} from "../src/session-workspace.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function write(path: string, content: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function declareWorkspaceLesson(root: string, lessonId: string, workspaceId: string): Promise<void> {
  await write(join(root, `lessons/${lessonId}/lesson.md`), [
    "---",
    "durationMinutes: 5",
    `workspace: ${workspaceId}`,
    "blocks:",
    "  - only",
    "---",
    `# ${lessonId}`,
    "",
    "Lesson dek.",
  ].join("\n"));
  await write(join(root, `lessons/${lessonId}/blocks/only.md`), ["---", "type: narrative", "---", "## Only", "", "Read."].join("\n"));
}

async function contentFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "session-content-")); roots.push(root);
  await write(join(root, "README.md"), "# Authored tutorial\n");
  await write(join(root, "workbook.md"), "---\n---\n# Authored workbook\n\nWelcome.\n");
  await write(join(root, "docs/specs/README.md"), "authored specs\n");
  await declareWorkspaceLesson(root, "001", "refactor-line");
  await write(join(root, "workspaces/refactor-line/calculator/package.json"), "{\"type\":\"module\"}\n");
  await write(join(root, "workspaces/refactor-line/calculator/src/index.ts"), "export const value = 1;\n");
  await write(join(root, "workspaces/refactor-line/calculator/node_modules/cache.txt"), "must not copy\n");
  await write(join(root, "workspaces/refactor-line/factory/refactor.md"), "factory seed\n");
  return root;
}

function refactorRoot(session: { workspaceRoots: Record<string, string> }): string {
  return session.workspaceRoots["refactor-line"]!;
}

async function snapshotAuthoredFiles(root: string): Promise<Record<string, string>> {
  const files = [
    "README.md",
    "workbook.md",
    "docs/specs/README.md",
    "lessons/001/lesson.md",
    "workspaces/refactor-line/calculator/package.json",
    "workspaces/refactor-line/calculator/src/index.ts",
    "workspaces/refactor-line/calculator/node_modules/cache.txt",
    "workspaces/refactor-line/factory/refactor.md",
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
  it("creates and explicitly reopens a session rooted under .tutorial/<id>/workspaces", async () => {
    const contentRoot = await contentFixture();
    const manager = await SessionWorkspaceManager.create(contentRoot);

    const created = await manager.createSession({ id: "lesson-007" });
    const canonicalContentRoot = await realpath(contentRoot);
    expect(created).toEqual({
      contentRoot: canonicalContentRoot,
      sessionId: "lesson-007",
      sessionRoot: join(canonicalContentRoot, ".tutorial/lesson-007"),
      workspacesRoot: join(canonicalContentRoot, `.tutorial/lesson-007/${SESSION_WORKSPACES_DIRECTORY}`),
      workspaceRoots: { "refactor-line": join(canonicalContentRoot, ".tutorial/lesson-007/workspaces/refactor-line") },
    });
    await expect(manager.createSession({ id: "lesson-007" })).rejects.toThrow(/already exists/i);
    await expect(manager.reopenSession("missing-session")).rejects.toThrow(/does not exist/i);
    await expect(manager.reopenSession("../escape")).rejects.toThrow(/session ID/i);
    await expect(manager.reopenSession("lesson-007")).resolves.toEqual(created);
  });

  it("materializes every declared workspace and never copies node_modules or authored workbook content", async () => {
    const contentRoot = await contentFixture();
    await declareWorkspaceLesson(contentRoot, "002", "your-first-factory");
    await write(join(contentRoot, "workspaces/your-first-factory/spec.md"), "starter spec\n");
    await write(join(contentRoot, "workspaces/unreferenced/file.txt"), "not copied\n");
    const manager = await SessionWorkspaceManager.create(contentRoot);

    const session = await manager.createSession({ id: "minimal" });

    expect((await readdir(session.sessionRoot)).sort()).toEqual([SESSION_WORKSPACES_DIRECTORY].sort());
    expect(Object.keys(session.workspaceRoots).sort()).toEqual(["refactor-line", "your-first-factory"]);
    const refactor = workspaceRootFor(session, "refactor-line");
    await expect(readdir(join(refactor, "calculator"))).resolves.not.toContain("node_modules");
    await expect(readFile(join(refactor, "calculator/src/index.ts"), "utf8")).resolves.toBe("export const value = 1;\n");
    await expect(readFile(join(refactor, "factory/refactor.md"), "utf8")).resolves.toBe("factory seed\n");
    await expect(readFile(join(workspaceRootFor(session, "your-first-factory"), "spec.md"), "utf8")).resolves.toBe("starter spec\n");
    await expect(lstat(join(session.workspacesRoot, "unreferenced"))).rejects.toThrow();
    for (const missing of ["README.md", "workbook.md", "docs", "lessons"]) {
      await expect(lstat(join(refactor, missing))).rejects.toThrow();
    }
  });

  it("preserves executable modes in copied workspace templates", async () => {
    const contentRoot = await contentFixture();
    await write(join(contentRoot, "workspaces/refactor-line/factory/run.sh"), "#!/usr/bin/env bash\n");
    await chmod(join(contentRoot, "workspaces/refactor-line/factory/run.sh"), 0o755);

    const session = await (await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "modes" });

    expect((await stat(join(refactorRoot(session), "factory/run.sh"))).mode & 0o111).not.toBe(0);
  });

  it("keeps authored content immutable when a live workspace changes", async () => {
    const contentRoot = await contentFixture();
    const before = await snapshotAuthoredFiles(contentRoot);
    const session = await (await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "immutable" });

    await writeFile(join(refactorRoot(session), "calculator/src/index.ts"), "export const value = 2;\n", "utf8");
    await writeFile(join(refactorRoot(session), "factory/refactor.md"), "learner changed this\n", "utf8");

    expect(await snapshotAuthoredFiles(contentRoot)).toEqual(before);
  });

  it("gives generated sessions independent workspace repos", async () => {
    const contentRoot = await contentFixture();
    const manager = await SessionWorkspaceManager.create(contentRoot);
    const now = new Date(2026, 7, 24, 10, 30, 0);
    const first = await manager.createSession({ now, randomBytes: () => Buffer.from("01020304", "hex") });
    const second = await manager.createSession({ now, randomBytes: () => Buffer.from("05060708", "hex") });
    expect(first.sessionId).not.toBe(second.sessionId);

    await writeFile(join(refactorRoot(first), "calculator/src/index.ts"), "export const value = 99;\n", "utf8");
    await write(join(refactorRoot(first), "factory/new-station.sh"), "#!/usr/bin/env bash\n");

    await expect(readFile(join(refactorRoot(second), "calculator/src/index.ts"), "utf8")).resolves.toBe("export const value = 1;\n");
    await expect(readFile(join(refactorRoot(second), "factory/new-station.sh"), "utf8")).rejects.toThrow();
  });

  it("uses one live workspace and one Git history for lessons sharing an id", async () => {
    const contentRoot = await contentFixture();
    await declareWorkspaceLesson(contentRoot, "002", "refactor-line");
    const session = await (await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "shared" });

    expect(Object.keys(session.workspaceRoots)).toEqual(["refactor-line"]);
    await write(join(refactorRoot(session), "factory/lesson-001.txt"), "kept\n");
    const reopened = await (await SessionWorkspaceManager.create(contentRoot)).reopenSession("shared");
    await expect(readFile(join(refactorRoot(reopened), "factory/lesson-001.txt"), "utf8")).resolves.toBe("kept\n");
  });

  it("materializes declared workspace templates as independent clean Git repositories", async () => {
    const contentRoot = await contentFixture();
    await declareWorkspaceLesson(contentRoot, "002", "your-first-factory");
    await write(join(contentRoot, "workspaces/your-first-factory/spec.md"), "template spec\n");

    const session = await (await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "git-ready" });
    const refactor = workspaceRootFor(session, "refactor-line");
    const firstFactory = workspaceRootFor(session, "your-first-factory");

    for (const [id, root] of [["refactor-line", refactor], ["your-first-factory", firstFactory]] as const) {
      expect(await git(root, "rev-parse", "--show-toplevel")).toBe(root);
      expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(await git(root, "log", "--oneline", "-1")).toMatch(new RegExp(`Materialize tutorial workspace ${id}`));
      expect(await git(root, "ls-files", ".gitignore")).toBe(".gitignore");
      expect(await git(root, "status", "--porcelain")).toBe("");
    }
  });

  it("rejects declared workspaces with no authored template", async () => {
    const contentRoot = await contentFixture();
    await declareWorkspaceLesson(contentRoot, "missing", "missing-template");

    await expect((await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "missing-template" })).rejects.toThrow(/missing-template/);
  });

  it("rejects malformed declared workspace ids during materialization", async () => {
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

  it("rejects authored workspace .git directories and symlinked templates", async () => {
    const contentRoot = await contentFixture();
    await declareWorkspaceLesson(contentRoot, "git-template", "git-template");
    await mkdir(join(contentRoot, "workspaces/git-template/.git"), { recursive: true });
    await expect((await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "git-template" })).rejects.toThrow(/\.git/);

    const symlinked = await contentFixture();
    await declareWorkspaceLesson(symlinked, "symlinked-template", "symlinked-template");
    await write(join(symlinked, "workspaces/real-template/spec.md"), "real template\n");
    await symlink(join(symlinked, "workspaces/real-template"), join(symlinked, "workspaces/symlinked-template"));
    await expect((await SessionWorkspaceManager.create(symlinked)).createSession({ id: "symlinked-template" })).rejects.toThrow(/real directory|symlink/i);
  });

  it("rejects nested symlinks inside authored workspace templates", async () => {
    const contentRoot = await contentFixture();
    await declareWorkspaceLesson(contentRoot, "nested-symlink", "nested-symlink");
    await write(join(contentRoot, "workspaces/shared/spec.md"), "shared spec\n");
    await mkdir(join(contentRoot, "workspaces/nested-symlink"), { recursive: true });
    await symlink(join(contentRoot, "workspaces/shared/spec.md"), join(contentRoot, "workspaces/nested-symlink/spec.md"));

    await expect((await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "nested-symlink" })).rejects.toThrow(/symlinked content/i);
  });

  it("ignores regenerated factory .tmp evidence in each live workspace repository", async () => {
    const contentRoot = await contentFixture();
    const session = await (await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "gitignore-ready" });
    const workspaceRoot = refactorRoot(session);

    await write(join(workspaceRoot, "factory/refactor/.tmp/evidence.txt"), "regenerated evidence\n");

    expect(await readFile(join(workspaceRoot, ".gitignore"), "utf8")).toBe("factory/**/.tmp/\n");
    expect(await git(workspaceRoot, "check-ignore", "factory/refactor/.tmp/evidence.txt")).toBe("factory/refactor/.tmp/evidence.txt");
    expect(await git(workspaceRoot, "status", "--porcelain")).toBe("");
  });

  it("materializes trusted runtime provision mount targets as empty ignored directories in each live workspace", async () => {
    const contentRoot = await contentFixture();
    await declareWorkspaceLesson(contentRoot, "002", "your-first-factory");
    await mkdir(join(contentRoot, "workspaces/your-first-factory"), { recursive: true });
    const runtimeSource = await mkdtemp(join(tmpdir(), "session-runtime-source-")); roots.push(runtimeSource);
    await write(join(runtimeSource, "tool.txt"), "host runtime source\n");

    const session = await (await SessionWorkspaceManager.create(contentRoot)).createSession({
      id: "runtime-ready",
      runtimeProvision: { mounts: [{ source: runtimeSource, target: "runtime-tools", readonly: true }] },
    });

    expect(session.runtimeProvision?.workspaceMountTargets).toEqual(["runtime-tools"]);
    for (const workspaceRoot of Object.values(session.workspaceRoots)) {
      expect(await readdir(join(workspaceRoot, "runtime-tools"))).toEqual([]);
      expect(await readFile(join(workspaceRoot, ".gitignore"), "utf8")).toBe("factory/**/.tmp/\nruntime-tools/\n");
      expect(await git(workspaceRoot, "check-ignore", "runtime-tools/generated.txt")).toBe("runtime-tools/generated.txt");
      expect(await git(workspaceRoot, "status", "--porcelain")).toBe("");
    }
  });

  it("rejects runtime provision targets that collide with materialized workspace content", async () => {
    const contentRoot = await contentFixture();
    const runtimeSource = await mkdtemp(join(tmpdir(), "session-runtime-source-")); roots.push(runtimeSource);

    await expect((await SessionWorkspaceManager.create(contentRoot)).createSession({
      id: "runtime-collides",
      runtimeProvision: { mounts: [{ source: runtimeSource, target: "calculator/src", readonly: true }] },
    })).rejects.toThrow(/must be empty|must be a directory/i);
  });

  it("rejects nested template paths that leave the content root", async () => {
    const contentRoot = await contentFixture();
    const outside = await mkdtemp(join(tmpdir(), "session-content-outside-")); roots.push(outside);
    await symlink(outside, join(contentRoot, "workspaces/refactor-line/calculator/escape"));

    await expect((await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "symlinked-file" })).rejects.toThrow(/symlinked content/i);
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

    const { sessionRoot, workspacesRoot } = await manager.createSession({ id: "escaped-workspace" });
    await rm(workspacesRoot, { recursive: true, force: true });
    await symlink(outside, join(sessionRoot, "workspaces"));
    await expect(manager.reopenSession("escaped-workspace")).rejects.toThrow(/inside/i);
  });
});
