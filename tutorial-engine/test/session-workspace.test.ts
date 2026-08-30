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
import { CURRENT_WORKBOOK_SESSION_FORMAT_VERSION, WORKBOOK_SESSION_FORMAT_RECORD_TYPE } from "../src/workbook/timeline.js";

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
  await write(join(root, "workspaces/refactor-line/calculator/.tmp/cache.txt"), "must not copy\n");
  await write(join(root, "workspaces/refactor-line/calculator/.tutorial/state.json"), "must not copy\n");
  await write(join(root, "workspaces/refactor-line/calculator/.git/config"), "must not copy\n");
  await write(join(root, "workspaces/refactor-line/calculator/.DS_Store"), "must not copy\n");
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

async function initializeProductRepository(root: string): Promise<void> {
  await write(join(root, ".gitignore"), ".tutorial/\n");
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.name", "Product Maintainer");
  await git(root, "config", "user.email", "maintainer@example.invalid");
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "Authored product baseline");
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

  it("materializes every declared workspace and skips generated/session/dependency/VCS state without copying authored workbook content", async () => {
    const contentRoot = await contentFixture();
    await declareWorkspaceLesson(contentRoot, "002", "tetris");
    await write(join(contentRoot, "workspaces/tetris/spec.md"), "starter spec\n");
    await write(join(contentRoot, "workspaces/unreferenced/file.txt"), "not copied\n");
    const manager = await SessionWorkspaceManager.create(contentRoot);

    const session = await manager.createSession({ id: "minimal" });

    expect((await readdir(session.sessionRoot)).sort()).toEqual(["workbook", SESSION_WORKSPACES_DIRECTORY].sort());
    expect(JSON.parse(await readFile(join(session.sessionRoot, "workbook/events.jsonl"), "utf8"))).toEqual({
      type: WORKBOOK_SESSION_FORMAT_RECORD_TYPE,
      version: CURRENT_WORKBOOK_SESSION_FORMAT_VERSION,
    });
    expect(Object.keys(session.workspaceRoots).sort()).toEqual(["refactor-line", "tetris"]);
    const refactor = workspaceRootFor(session, "refactor-line");
    await expect(readdir(join(refactor, "calculator"))).resolves.not.toEqual(expect.arrayContaining(["node_modules", ".tmp", ".tutorial", ".git", ".DS_Store"]));
    await expect(readFile(join(refactor, "calculator/src/index.ts"), "utf8")).resolves.toBe("export const value = 1;\n");
    await expect(readFile(join(refactor, "factory/refactor.md"), "utf8")).resolves.toBe("factory seed\n");
    await expect(readFile(join(workspaceRootFor(session, "tetris"), "spec.md"), "utf8")).resolves.toBe("starter spec\n");
    await expect(lstat(join(session.workspacesRoot, "unreferenced"))).rejects.toThrow();
    for (const missing of ["README.md", "workbook.md", "docs", "lessons"]) {
      await expect(lstat(join(refactor, missing))).rejects.toThrow();
    }
  });

  it("preserves directory and executable modes in copied workspace templates", async () => {
    const contentRoot = await contentFixture();
    await write(join(contentRoot, "workspaces/refactor-line/factory/run.sh"), "#!/usr/bin/env bash\n");
    await mkdir(join(contentRoot, "workspaces/refactor-line/factory/empty-mode-dir"));
    await chmod(join(contentRoot, "workspaces/refactor-line/factory/run.sh"), 0o755);
    await chmod(join(contentRoot, "workspaces/refactor-line/factory/empty-mode-dir"), 0o750);

    const session = await (await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "modes" });

    expect((await stat(join(refactorRoot(session), "factory/run.sh"))).mode & 0o111).not.toBe(0);
    expect((await stat(join(refactorRoot(session), "factory/empty-mode-dir"))).mode.toString(8).slice(-4)).toBe("0750");
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
    await declareWorkspaceLesson(contentRoot, "002", "tetris");
    await write(join(contentRoot, "workspaces/tetris/spec.md"), "template spec\n");

    const session = await (await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "git-ready" });
    const refactor = workspaceRootFor(session, "refactor-line");
    const tetrisWorkspace = workspaceRootFor(session, "tetris");

    for (const [id, root] of [["refactor-line", refactor], ["tetris", tetrisWorkspace]] as const) {
      expect(await git(root, "rev-parse", "--show-toplevel")).toBe(root);
      expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(await git(root, "log", "--oneline", "-1")).toMatch(new RegExp(`Materialize tutorial workspace ${id}`));
      expect(await git(root, "ls-files", ".gitignore")).toBe(".gitignore");
      expect(await git(root, "status", "--porcelain")).toBe("");
    }
  });

  it("ignores inherited Git identity, paths, signing, hooks, and config while materializing a repository", async () => {
    const contentRoot = await contentFixture();
    await initializeProductRepository(contentRoot);
    const productHead = await git(contentRoot, "rev-parse", "HEAD");
    const hostileConfig = join(contentRoot, ".git/host-gitconfig");
    await write(hostileConfig, [
      "[user]",
      "  name = Host User",
      "  email = host@example.invalid",
      "[commit]",
      "  gpgSign = true",
      "[core]",
      `  hooksPath = ${join(contentRoot, ".git/host-hooks")}`,
    ].join("\n"));
    const overrides: Record<string, string> = {
      GIT_DIR: join(contentRoot, ".git"),
      GIT_WORK_TREE: contentRoot,
      GIT_AUTHOR_NAME: "Injected Author",
      GIT_AUTHOR_EMAIL: "injected-author@example.invalid",
      GIT_COMMITTER_NAME: "Injected Committer",
      GIT_COMMITTER_EMAIL: "injected-committer@example.invalid",
      GIT_CONFIG_GLOBAL: hostileConfig,
      GIT_CONFIG_SYSTEM: hostileConfig,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgSign",
      GIT_CONFIG_VALUE_0: "true",
    };
    const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));

    let session;
    try {
      Object.assign(process.env, overrides);
      session = await (await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "isolated-git" });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const workspaceRoot = refactorRoot(session);
    expect(await git(workspaceRoot, "rev-parse", "--show-toplevel")).toBe(workspaceRoot);
    expect(await git(workspaceRoot, "config", "--local", "--get", "user.name")).toBe("Tutorial Factory Worker");
    expect(await git(workspaceRoot, "config", "--local", "--get", "user.email")).toBe("factory-worker@example.invalid");
    expect(await git(workspaceRoot, "config", "--local", "--get", "user.useConfigOnly")).toBe("true");
    expect(await git(workspaceRoot, "config", "--local", "--get", "commit.gpgSign")).toBe("false");
    expect(await git(workspaceRoot, "config", "--local", "--get", "tag.gpgSign")).toBe("false");
    expect(await git(workspaceRoot, "config", "--local", "--get-all", "credential.helper")).toBe("");
    expect(await git(workspaceRoot, "config", "--local", "--get", "credential.interactive")).toBe("false");
    expect(await git(workspaceRoot, "config", "--local", "--get", "core.hooksPath")).toBe("/dev/null");
    expect(await git(workspaceRoot, "config", "--local", "--get", "protocol.allow")).toBe("never");
    expect(await git(workspaceRoot, "log", "-1", "--format=%an <%ae>")).toBe("Tutorial Factory Worker <factory-worker@example.invalid>");
    expect(await git(contentRoot, "rev-parse", "HEAD")).toBe(productHead);
    expect(await git(contentRoot, "status", "--porcelain")).toBe("");
  });

  it("keeps useful worker commits in the live repository across reopen without running hooks or changing authored product history", async () => {
    const contentRoot = await contentFixture();
    await initializeProductRepository(contentRoot);
    const authoredBefore = await snapshotAuthoredFiles(contentRoot);
    const productHead = await git(contentRoot, "rev-parse", "HEAD");
    const manager = await SessionWorkspaceManager.create(contentRoot);
    const session = await manager.createSession({ id: "worker-commits" });
    const workspaceRoot = refactorRoot(session);
    const hookMarker = join(contentRoot, "worker-hook-ran");
    const hook = join(workspaceRoot, ".git/hooks/pre-commit");
    await write(hook, `#!/bin/sh\nprintf hook-ran > ${JSON.stringify(hookMarker)}\nexit 1\n`);
    await chmod(hook, 0o755);

    await write(join(workspaceRoot, "calculator/src/worker-change.ts"), "export const workerChange = true;\n");
    await git(workspaceRoot, "add", "calculator/src/worker-change.ts");
    await git(workspaceRoot, "commit", "-m", "Apply useful worker change");

    await expect(lstat(hookMarker)).rejects.toThrow();
    expect(await git(workspaceRoot, "log", "-1", "--format=%s|%an <%ae>")).toBe("Apply useful worker change|Tutorial Factory Worker <factory-worker@example.invalid>");
    await expect(run("git", ["-C", workspaceRoot, "ls-remote", `file://${workspaceRoot}`])).rejects.toThrow(/transport 'file' not allowed/);
    const commitCount = await git(workspaceRoot, "rev-list", "--count", "HEAD");
    await expect(run("git", ["-C", workspaceRoot, "commit", "-m", "No empty pass"])).rejects.toMatchObject({ code: 1 });
    expect(await git(workspaceRoot, "rev-list", "--count", "HEAD")).toBe(commitCount);

    const reopened = await manager.reopenSession("worker-commits");
    expect(await git(refactorRoot(reopened), "log", "-1", "--format=%s")).toBe("Apply useful worker change");
    expect(await snapshotAuthoredFiles(contentRoot)).toEqual(authoredBefore);
    expect(await git(contentRoot, "rev-parse", "HEAD")).toBe(productHead);
    expect(await git(contentRoot, "status", "--porcelain")).toBe("");
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

  it("skips authored workspace .git directories and rejects symlinked templates", async () => {
    const contentRoot = await contentFixture();
    await declareWorkspaceLesson(contentRoot, "git-template", "git-template");
    await write(join(contentRoot, "workspaces/git-template/.git/config"), "generated git metadata\n");
    await write(join(contentRoot, "workspaces/git-template/spec.md"), "real template\n");
    const session = await (await SessionWorkspaceManager.create(contentRoot)).createSession({ id: "git-template" });
    await expect(readFile(join(workspaceRootFor(session, "git-template"), "spec.md"), "utf8")).resolves.toBe("real template\n");
    await expect(readFile(join(workspaceRootFor(session, "git-template"), ".git/config"), "utf8")).resolves.not.toContain("generated git metadata");

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
    await declareWorkspaceLesson(contentRoot, "002", "tetris");
    await mkdir(join(contentRoot, "workspaces/tetris"), { recursive: true });
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
