import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkbookCli } from "../src/workbook/cli.js";
import type { WorkbookServerOptions } from "../src/workbook/server.js";
import { SessionWorkspaceManager, type TutorialSessionPaths } from "../src/session-workspace.js";
import { WorkbookTimeline } from "../src/workbook/timeline.js";

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function write(path: string, content: string): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function contentFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workbook-cli-content-"));
  roots.push(root);
  await write(join(root, "workbook.md"), ["---", "parts:", "  - id: validation-loop", "    lessons:", "      - 001-run-an-agent-headlessly", "      - 007-compose-and-branch", "      - 008-missing-seed", "---", "# CLI fixture", "", "Welcome."].join("\n"));
  await write(join(root, "parts/validation-loop.md"), "---\n---\n# Validation loop\n\nPart preamble.\n");
  for (const id of ["001-run-an-agent-headlessly", "007-compose-and-branch", "008-missing-seed"]) {
    await write(join(root, `lessons/${id}/lesson.md`), "---\ndurationMinutes: 1\nblocks:\n  - read\n---\n# Lesson\n\nLesson dek.\n");
    await write(join(root, `lessons/${id}/blocks/read.md`), "---\ntype: narrative\n---\n## Read\n\nRead this.\n");
  }
  await write(join(root, "README.md"), "# CLI fixture\n");
  await write(join(root, "calculator/package.json"), "{\"type\":\"module\"}\n");
  await write(join(root, "calculator/src/index.ts"), "export const value = 1;\n");
  await write(join(root, "factory/refactor.md"), "factory seed\n");
  await write(join(root, "docs/seeds/lesson-jump/007-compose-and-branch/factory/refactor.md"), "lesson 007 seed\n");
  return root;
}

function sessionFixture(id: string): TutorialSessionPaths {
  return {
    contentRoot: "/content",
    sessionId: id,
    sessionRoot: `/content/.tutorial/${id}`,
    workspaceRoot: `/content/.tutorial/${id}/workspace`,
  };
}

describe("workbook CLI", () => {
  it("starts the normal launch path with the embedded terminal enabled", async () => {
    const close = vi.fn(async () => {});
    const startServer = vi.fn(async (_options: WorkbookServerOptions) => ({ url: "http://127.0.0.1:4310", port: 4310, host: "127.0.0.1", close }));

    const resolveSession = vi.fn(async () => sessionFixture("session-20260824-120000-a1b2c3d4"));
    const lines: string[] = [];

    const server = await runWorkbookCli(["/tmp/workbook", "--no-open"], {
      startServer,
      resolveSession,
      installSignalHandlers: false,
      packageDirectory: "/pkg",
      logger: { info: vi.fn(), error: vi.fn() },
      writeLine: (line) => lines.push(line),
    });

    expect(server).toBeDefined();
    expect(startServer).toHaveBeenCalledOnce();
    expect(resolveSession).toHaveBeenCalledWith("/tmp/workbook", undefined);
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      target: "/content",
      session: sessionFixture("session-20260824-120000-a1b2c3d4"),
      webRoot: resolve("/pkg", "dist/web-workbook"),
      embeddedTerminal: true,
      watchContent: false,
    }));
    expect(lines).toEqual([
      "Created tutorial session: session-20260824-120000-a1b2c3d4",
      "Session state: /content/.tutorial/session-20260824-120000-a1b2c3d4",
      "Learner workspace: /content/.tutorial/session-20260824-120000-a1b2c3d4/workspace",
      "Reopen with: npm run tutorial:workbook -- --session session-20260824-120000-a1b2c3d4",
    ]);
    expect(startServer.mock.calls[0]![0]).not.toHaveProperty("terminalPtyFactory");
    expect(startServer.mock.calls[0]![0]).not.toHaveProperty("terminalObserver");
  });

  it("trusts an injected runtime provision profile at the launch boundary", async () => {
    const runtimeSource = await mkdtemp(join(tmpdir(), "workbook-cli-runtime-source-")); roots.push(runtimeSource);
    const startServer = vi.fn(async (_options: WorkbookServerOptions) => ({ url: "http://127.0.0.1:4310", port: 4310, host: "127.0.0.1", close: vi.fn(async () => {}) }));
    const resolveSession = vi.fn(async (_target: string, _sessionId: string | undefined, runtimeProvision: any) => ({
      ...sessionFixture("session-20260824-120000-a1b2c3d4"),
      runtimeProvision,
    }));

    await runWorkbookCli(["/tmp/workbook", "--no-open"], {
      startServer,
      resolveSession,
      runtimeProvision: { mounts: [{ source: runtimeSource, target: "runtime-tools", readonly: true }] },
      installSignalHandlers: false,
      packageDirectory: "/pkg",
      logger: { info: vi.fn(), error: vi.fn() },
      writeLine: () => undefined,
    });

    expect(resolveSession).toHaveBeenCalledWith("/tmp/workbook", undefined, expect.objectContaining({ workspaceMountTargets: ["runtime-tools"] }));
    expect(startServer.mock.calls[0]![0].session?.runtimeProvision?.mounts).toEqual([
      expect.objectContaining({ hostSource: expect.stringContaining("workbook-cli-runtime-source-"), workspaceTarget: "runtime-tools", readonly: true }),
    ]);
  });

  it("passes --watch through to the workbook server without changing session reopening", async () => {
    const startServer = vi.fn(async (_options: WorkbookServerOptions) => ({ url: "http://127.0.0.1:4310", port: 4310, host: "127.0.0.1", close: vi.fn(async () => {}) }));
    const resolveSession = vi.fn(async () => sessionFixture("lesson-007"));

    await runWorkbookCli(["/tmp/workbook", "--session", "lesson-007", "--port", "4310", "--watch", "--no-open"], {
      startServer,
      resolveSession,
      installSignalHandlers: false,
      packageDirectory: "/pkg",
      logger: { info: vi.fn(), error: vi.fn() },
      writeLine: () => undefined,
    });

    expect(resolveSession).toHaveBeenCalledWith("/tmp/workbook", "lesson-007");
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ port: 4310, watchContent: true }));
  });

  it("creates a distinct test-only session for --lesson rather than reopening one", async () => {
    const startServer = vi.fn(async (_options: WorkbookServerOptions) => ({ url: "http://127.0.0.1:4310", port: 4310, host: "127.0.0.1", close: vi.fn(async () => {}) }));
    const createLessonJumpSession = vi.fn(async () => sessionFixture("jump-007"));
    const resolveSession = vi.fn(async () => sessionFixture("must-not-reopen"));
    const lines: string[] = [];

    await runWorkbookCli(["/tmp/workbook", "--lesson=007", "--no-open"], {
      startServer, createLessonJumpSession, resolveSession, installSignalHandlers: false,
      packageDirectory: "/pkg", logger: { info: vi.fn(), error: vi.fn() }, writeLine: (line) => lines.push(line),
    });

    expect(createLessonJumpSession).toHaveBeenCalledWith("/tmp/workbook", "007");
    expect(resolveSession).not.toHaveBeenCalled();
    expect(lines).toContain("Test-only lesson jump: 007 (previous blocks are skipped; exact 'move on' may skip this lesson's evaluated blocks).");
  });

  it.each(["001", "001-run-an-agent-headlessly"])("starts --lesson %s from the normal materialized workspace", async (lesson) => {
    const contentRoot = await contentFixture();
    const startServer = vi.fn(async (_options: WorkbookServerOptions) => ({ url: "http://127.0.0.1:4310", port: 4310, host: "127.0.0.1", close: vi.fn(async () => {}) }));

    await runWorkbookCli([contentRoot, "--lesson", lesson, "--no-open"], {
      startServer, installSignalHandlers: false, packageDirectory: "/pkg", logger: { info: vi.fn(), error: vi.fn() }, writeLine: () => undefined,
    });

    const session = startServer.mock.calls[0]![0].session as TutorialSessionPaths;
    await expect(readFile(resolve(session.workspaceRoot, "factory/refactor.md"), "utf8")).resolves.toBe("factory seed\n");
    await expect(readFile(resolve(session.workspaceRoot, "calculator/src/index.ts"), "utf8")).resolves.toBe("export const value = 1;\n");
    await expect(new WorkbookTimeline({ stateRoot: session.sessionRoot }).read()).resolves.toEqual([
      expect.objectContaining({ type: "lesson_jump_started", lessonId: "001-run-an-agent-headlessly", testOnly: true }),
      expect.objectContaining({ type: "block_skipped", reason: "lesson-jump-prerequisite" }),
      expect.objectContaining({ type: "block_skipped", reason: "lesson-jump-prerequisite" }),
    ]);
  });

  it("uses a later lesson's explicit seed and clearly rejects a missing later seed", async () => {
    const contentRoot = await contentFixture();
    const startServer = vi.fn(async (_options: WorkbookServerOptions) => ({ url: "http://127.0.0.1:4310", port: 4310, host: "127.0.0.1", close: vi.fn(async () => {}) }));

    await runWorkbookCli([contentRoot, "--lesson", "007", "--no-open"], {
      startServer, installSignalHandlers: false, packageDirectory: "/pkg", logger: { info: vi.fn(), error: vi.fn() }, writeLine: () => undefined,
    });
    const session = startServer.mock.calls[0]![0].session as TutorialSessionPaths;
    await expect(readFile(resolve(session.workspaceRoot, "factory/refactor.md"), "utf8")).resolves.toBe("lesson 007 seed\n");

    await expect(runWorkbookCli([contentRoot, "--lesson", "008", "--no-open"], {
      startServer, installSignalHandlers: false, packageDirectory: "/pkg", logger: { info: vi.fn(), error: vi.fn() }, writeLine: () => undefined,
    })).rejects.toThrow(/Lesson jump seed for '008-missing-seed'/);
  });

  it("passes an explicit --session ID through to reopening and prints the reopened workspace", async () => {
    const startServer = vi.fn(async (_options: WorkbookServerOptions) => ({ url: "http://127.0.0.1:4310", port: 4310, host: "127.0.0.1", close: vi.fn(async () => {}) }));
    const resolveSession = vi.fn(async () => sessionFixture("lesson-007"));
    const lines: string[] = [];

    await runWorkbookCli(["/tmp/workbook", "--session", "lesson-007", "--no-open"], {
      startServer,
      resolveSession,
      installSignalHandlers: false,
      packageDirectory: "/pkg",
      logger: { info: vi.fn(), error: vi.fn() },
      writeLine: (line) => lines.push(line),
    });

    expect(resolveSession).toHaveBeenCalledWith("/tmp/workbook", "lesson-007");
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({
      target: "/content",
      session: sessionFixture("lesson-007"),
    }));
    expect(lines[0]).toBe("Reopened tutorial session: lesson-007");
    expect(lines).toContain("Learner workspace: /content/.tutorial/lesson-007/workspace");
  });

  it("reopens an explicit materialized session instead of creating another one", async () => {
    const contentRoot = await contentFixture();
    const manager = await SessionWorkspaceManager.create(contentRoot);
    const existing = await manager.createSession({ id: "resume-me" });
    await write(resolve(existing.workspaceRoot, "factory/resume-note.md"), "keep this session-local file\n");
    const startServer = vi.fn(async (_options: WorkbookServerOptions) => ({ url: "http://127.0.0.1:4310", port: 4310, host: "127.0.0.1", close: vi.fn(async () => {}) }));
    const lines: string[] = [];

    await runWorkbookCli([contentRoot, "--session", "resume-me", "--no-open"], {
      startServer,
      installSignalHandlers: false,
      packageDirectory: "/pkg",
      logger: { info: vi.fn(), error: vi.fn() },
      writeLine: (line) => lines.push(line),
    });

    const options = startServer.mock.calls[0]![0];
    expect(options.session).toEqual(existing);
    await expect(readFile(resolve(existing.workspaceRoot, "factory/resume-note.md"), "utf8")).resolves.toBe("keep this session-local file\n");
    expect(lines[0]).toBe("Reopened tutorial session: resume-me");
    expect(lines).toContain(`Learner workspace: ${existing.workspaceRoot}`);
  });

  it("materializes a fresh default session and ignores legacy .tutorial/.tmp state", async () => {
    const contentRoot = await contentFixture();
    await write(join(contentRoot, ".tutorial/.tmp/workbook/events.jsonl"), "legacy state stays put\n");
    const startServer = vi.fn(async (_options: WorkbookServerOptions) => ({ url: "http://127.0.0.1:4310", port: 4310, host: "127.0.0.1", close: vi.fn(async () => {}) }));
    const lines: string[] = [];

    await runWorkbookCli([contentRoot, "--no-open"], {
      startServer,
      installSignalHandlers: false,
      packageDirectory: "/pkg",
      logger: { info: vi.fn(), error: vi.fn() },
      writeLine: (line) => lines.push(line),
    });

    const options = startServer.mock.calls[0]![0];
    // The CLI passes the resolved TutorialSessionPaths; WorkbookServerOptions declares only the
    // runtime fields the server itself needs, which do not include the session id the CLI reports.
    const session = options.session as TutorialSessionPaths;
    const canonicalContentRoot = await realpath(contentRoot);
    expect(options.target).toBe(canonicalContentRoot);
    expect(options.session?.contentRoot).toBe(canonicalContentRoot);
    expect(session.sessionId).toMatch(/^session-\d{8}-\d{6}-[a-f0-9]{8}$/);
    expect(options.session?.workspaceRoot).toBe(resolve(canonicalContentRoot, ".tutorial", session.sessionId, "workspace"));
    await expect(readFile(resolve(session.workspaceRoot, "factory/refactor.md"), "utf8")).resolves.toBe("factory seed\n");
    await expect(readFile(resolve(session.workspaceRoot, "calculator/src/index.ts"), "utf8")).resolves.toBe("export const value = 1;\n");
    await expect(stat(resolve(session.workspaceRoot, ".git"))).resolves.toBeDefined();
    await expect(readFile(resolve(contentRoot, ".tutorial/.tmp/workbook/events.jsonl"), "utf8")).resolves.toBe("legacy state stays put\n");
    expect(lines[0]).toBe(`Created tutorial session: ${session.sessionId}`);
    expect(lines).toContain(`Learner workspace: ${session.workspaceRoot}`);
  });
});
