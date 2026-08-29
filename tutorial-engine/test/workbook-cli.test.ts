import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkbookCli } from "../src/workbook/cli.js";
import { startWorkbookServer, type WorkbookServerOptions } from "../src/workbook/server.js";
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

type WorkbookCliTestDependencies = NonNullable<Parameters<typeof runWorkbookCli>[1]>;

function runCli(argv: readonly string[], dependencies: WorkbookCliTestDependencies = {}) {
  return runWorkbookCli(argv, { preflightModels: async () => undefined, ...dependencies });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("workbook CLI", () => {
  it("does not preflight models for --help", async () => {
    const preflightModels = vi.fn(async () => undefined);
    const startServer = vi.fn();
    const lines: string[] = [];

    await runWorkbookCli(["--help"], {
      preflightModels,
      startServer,
      writeLine: (line) => lines.push(line),
    });

    expect(preflightModels).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("Usage:");
  });

  it("waits for model preflight before starting the server or browser", async () => {
    const preflight = deferred();
    const startServer = vi.fn(async (_options: WorkbookServerOptions) => ({ url: "http://127.0.0.1:4310", port: 4310, host: "127.0.0.1", close: vi.fn(async () => {}) }));
    const resolveSession = vi.fn(async () => sessionFixture("session-preflight"));
    const spawnBrowser = vi.fn(() => ({ once: vi.fn(), unref: vi.fn() }) as any);
    const log = { info: vi.fn(), error: vi.fn() };
    const preflightModels = vi.fn(() => preflight.promise);

    const launch = runWorkbookCli(["/tmp/workbook"], {
      startServer,
      resolveSession,
      preflightModels,
      browserCommand: () => ({ command: "open", args: ["url"] }),
      spawnBrowser,
      installSignalHandlers: false,
      packageDirectory: "/pkg",
      logger: log,
      writeLine: () => undefined,
    });
    await Promise.resolve();

    expect(resolveSession).toHaveBeenCalledWith("/tmp/workbook", undefined);
    expect(preflightModels).toHaveBeenCalledWith({ contentRoot: "/content", workspaceRoot: "/content/.tutorial/session-preflight/workspace", logger: log });
    expect(startServer).not.toHaveBeenCalled();
    expect(spawnBrowser).not.toHaveBeenCalled();

    preflight.resolve();
    await expect(launch).resolves.toBeDefined();
    expect(startServer).toHaveBeenCalledOnce();
    expect(spawnBrowser).toHaveBeenCalledOnce();
  });

  it("does not print launch lines, start the server, or open the browser when preflight fails", async () => {
    const startServer = vi.fn();
    const spawnBrowser = vi.fn();
    const lines: string[] = [];

    await expect(runWorkbookCli(["/tmp/workbook"], {
      startServer,
      resolveSession: vi.fn(async () => sessionFixture("session-fails")),
      preflightModels: vi.fn(async () => { throw new Error("Main Tutor model preflight failed: usage limit"); }),
      browserCommand: () => ({ command: "open", args: [] }),
      spawnBrowser: spawnBrowser as any,
      installSignalHandlers: false,
      packageDirectory: "/pkg",
      logger: { info: vi.fn(), error: vi.fn() },
      writeLine: (line) => lines.push(line),
    })).rejects.toThrow("usage limit");

    expect(startServer).not.toHaveBeenCalled();
    expect(spawnBrowser).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it("starts the server before spawning the browser after successful preflight", async () => {
    const order: string[] = [];
    const startServer = vi.fn(async (_options: WorkbookServerOptions) => {
      order.push("server");
      return { url: "http://127.0.0.1:4310", port: 4310, host: "127.0.0.1", close: vi.fn(async () => {}) };
    });
    const browserCommand = vi.fn((url: string) => {
      order.push(`browser-command:${url}`);
      return { command: "open", args: [url] };
    });
    const spawnBrowser = vi.fn(() => {
      order.push("spawn-browser");
      return { once: vi.fn(), unref: vi.fn() } as any;
    });

    await runWorkbookCli(["/tmp/workbook"], {
      startServer,
      resolveSession: vi.fn(async () => sessionFixture("session-opens")),
      preflightModels: vi.fn(async () => { order.push("preflight"); }),
      browserCommand,
      spawnBrowser,
      installSignalHandlers: false,
      packageDirectory: "/pkg",
      logger: { info: vi.fn(), error: vi.fn() },
      writeLine: () => undefined,
    });

    expect(order).toEqual(["preflight", "server", "browser-command:http://127.0.0.1:4310", "spawn-browser"]);
  });

  it("starts the normal launch path with the embedded terminal enabled", async () => {
    const close = vi.fn(async () => {});
    const startServer = vi.fn(async (_options: WorkbookServerOptions) => ({ url: "http://127.0.0.1:4310", port: 4310, host: "127.0.0.1", close }));

    const resolveSession = vi.fn(async () => sessionFixture("session-20260824-120000-a1b2c3d4"));
    const lines: string[] = [];

    const server = await runCli(["/tmp/workbook", "--no-open"], {
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

    await runCli(["/tmp/workbook", "--no-open"], {
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

    await runCli(["/tmp/workbook", "--session", "lesson-007", "--port", "4310", "--watch", "--no-open"], {
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

  it("creates a distinct fresh session for --lesson rather than reopening one", async () => {
    const startServer = vi.fn(async (_options: WorkbookServerOptions) => ({ url: "http://127.0.0.1:4310", port: 4310, host: "127.0.0.1", close: vi.fn(async () => {}) }));
    const createLessonJumpSession = vi.fn(async () => sessionFixture("jump-007"));
    const resolveSession = vi.fn(async () => sessionFixture("must-not-reopen"));
    const lines: string[] = [];

    await runCli(["/tmp/workbook", "--lesson=007", "--no-open"], {
      startServer, createLessonJumpSession, resolveSession, installSignalHandlers: false,
      packageDirectory: "/pkg", logger: { info: vi.fn(), error: vi.fn() }, writeLine: (line) => lines.push(line),
    });

    expect(createLessonJumpSession).toHaveBeenCalledWith("/tmp/workbook", "007");
    expect(resolveSession).not.toHaveBeenCalled();
    expect(lines).toContain("Lesson jump: 007 (prior blocks are marked completed).");
  });

  it.each(["001", "001-run-an-agent-headlessly", "007", "007-compose-and-branch"])("starts --lesson %s from the normal materialized workspace at its target", async (lesson) => {
    const contentRoot = await contentFixture();
    await write(join(contentRoot, "web/index.html"), "<!doctype html><div id=\"root\"></div>");
    const mainTutor = { restore: async () => {}, reply: async () => "Continue with the active block.", review: async () => ({ outcome: "feedback" as const, message: "Try again." }), summarizeBlock: async () => "", summarizeLesson: async () => "", dispose: () => {} };
    const startServer = vi.fn(async (options: WorkbookServerOptions) => await startWorkbookServer({ ...options, webRoot: resolve(contentRoot, "web"), embeddedTerminal: false, mainTutor, practiceCoach: { assess: async () => ({ outcome: "ready" as const, text: "" }) } }));

    const server = await runCli([contentRoot, "--lesson", lesson, "--no-open"], {
      startServer, installSignalHandlers: false, packageDirectory: "/pkg", logger: { info: vi.fn(), error: vi.fn() }, writeLine: () => undefined,
    });

    try {
      const session = startServer.mock.calls[0]![0].session as TutorialSessionPaths;
      await expect(readFile(resolve(session.workspaceRoot, "factory/refactor.md"), "utf8")).resolves.toBe("factory seed\n");
      await expect(readFile(resolve(session.workspaceRoot, "calculator/src/index.ts"), "utf8")).resolves.toBe("export const value = 1;\n");
      const records = await new WorkbookTimeline({ stateRoot: session.sessionRoot }).read();
      const target = lesson.startsWith("001") ? "001-run-an-agent-headlessly" : "007-compose-and-branch";
      expect(records[0]).toMatchObject({ type: "lesson_jump_started", lessonId: target });
      expect(records.filter((record) => record.type === "block_completed").length).toBeGreaterThanOrEqual(target.startsWith("001") ? 2 : 4);
      expect(records.some((record) => record.type === "block_completed" && record.blockId === `lesson--${target}`)).toBe(false);
      const state = await fetch(`${server!.url}/api/workbook/state`).then((response) => response.json() as any);
      expect(state.progress.activeBlockId).toBe(`lesson--${target}`);
    } finally { await server?.close(); }
  });

  it("passes an explicit --session ID through to reopening and prints the reopened workspace", async () => {
    const startServer = vi.fn(async (_options: WorkbookServerOptions) => ({ url: "http://127.0.0.1:4310", port: 4310, host: "127.0.0.1", close: vi.fn(async () => {}) }));
    const resolveSession = vi.fn(async () => sessionFixture("lesson-007"));
    const preflightModels = vi.fn(async () => undefined);
    const lines: string[] = [];

    await runCli(["/tmp/workbook", "--session", "lesson-007", "--no-open"], {
      startServer,
      resolveSession,
      preflightModels,
      installSignalHandlers: false,
      packageDirectory: "/pkg",
      logger: { info: vi.fn(), error: vi.fn() },
      writeLine: (line) => lines.push(line),
    });

    expect(resolveSession).toHaveBeenCalledWith("/tmp/workbook", "lesson-007");
    expect(preflightModels).toHaveBeenCalledWith(expect.objectContaining({ contentRoot: "/content", workspaceRoot: "/content/.tutorial/lesson-007/workspace" }));
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

    await runCli([contentRoot, "--session", "resume-me", "--no-open"], {
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

    await runCli([contentRoot, "--no-open"], {
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
