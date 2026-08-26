import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const piSessions = vi.hoisted(() => [] as any[]);
const createAgentSession = vi.hoisted(() => vi.fn(async () => ({ session: piSessions.shift() })));
const resolveCliModel = vi.hoisted(() => vi.fn(() => ({ model: { api: "test-api", provider: "test", id: "block" } })));
const hasConfiguredAuth = vi.hoisted(() => vi.fn(() => true));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    DefaultResourceLoader: class { async reload() {} },
    ModelRuntime: { create: vi.fn(async () => ({ hasConfiguredAuth })) },
    SessionManager: { inMemory: vi.fn(() => ({})) },
    SettingsManager: { inMemory: vi.fn((settings) => settings) },
    createAgentSession,
    getAgentDir: vi.fn(() => "/tmp/pi-agent"),
    resolveCliModel
  };
});
import type { Attempt } from "../src/workbook/attempts.js";
import type { ActiveBlockContext } from "../src/workbook/pi-history.js";
import { FastWorkbookBlockTutor, type WorkbookBlockTutorSession, type WorkbookBlockTutorSessionFactoryRequest } from "../src/workbook/block-tutor.js";

const roots: string[] = [];
const originalBlockTutorModel = process.env.BLOCK_TUTOR_MODEL;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
  resolveCliModel.mockReturnValue({ model: { api: "test-api", provider: "test", id: "block" } });
  hasConfiguredAuth.mockReturnValue(true);
  if (originalBlockTutorModel === undefined) delete process.env.BLOCK_TUTOR_MODEL;
  else process.env.BLOCK_TUTOR_MODEL = originalBlockTutorModel;
});

function attempt(id = "attempt-1", kind: Attempt["evidence"]["kind"] = "editor"): Attempt {
  const evidence: Attempt["evidence"] = kind === "terminal"
    ? { kind, transcript: "npm test\nPASS", terminalHtml: "<pre>PASS</pre>" }
    : kind === "reflection"
      ? { kind, response: "The validator cannot run commands, so the doer must paste evidence.", conversation: [] }
      : { kind, text: "The prompt appends .tmp/evidence.txt because the validator cannot run shell commands." };
  return { id, lessonId: "lesson", blockId: "block", version: 1, evidence, status: "reviewing" };
}

function activeContext(attempts: Attempt[] = [attempt()]): ActiveBlockContext {
  return {
    lessonId: "lesson",
    blockId: "block",
    title: "Explain the boundary",
    markdown: "Explain why evidence belongs in `.tmp/evidence.txt`.",
    authorGuidance: "Accept only if the learner names the removed shell capability.",
    attempts
  };
}

class FakeSession implements WorkbookBlockTutorSession {
  readonly request: WorkbookBlockTutorSessionFactoryRequest;
  readonly prompts: string[] = [];
  disposed = false;
  response: string | ((session: FakeSession, prompt: string) => Promise<string> | string) = "  Try naming which command ability was removed.  \n";

  constructor(request: WorkbookBlockTutorSessionFactoryRequest) { this.request = request; }

  async prompt(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    if (typeof this.response === "function") return this.response(this, prompt);
    return this.response;
  }

  dispose(): void { this.disposed = true; }
}

async function workspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), "workbook-block-tutor-")); roots.push(root);
  await mkdir(join(root, "factory"));
  await writeFile(join(root, "factory/answer.md"), "# Answer\n\nEvidence stays in .tmp.\n", "utf8");
  const outside = await mkdtemp(join(tmpdir(), "workbook-block-outside-")); roots.push(outside);
  await writeFile(join(outside, "outside.txt"), "secret", "utf8");
  return root;
}

describe("FastWorkbookBlockTutor", () => {
  it("retries a terminal provider error through the configured fast block-tutor model before returning a hint", async () => {
    const workspace = await workspaceFixture();
    process.env.BLOCK_TUTOR_MODEL = "test/block";
    vi.useFakeTimers();
    const listeners = new Set<(event: any) => void>();
    let firstPrompt!: () => void;
    const prompted = new Promise<void>((resolve) => { firstPrompt = resolve; });
    const outcomes = [
      { type: "message_end", message: { role: "assistant", content: [], errorMessage: "transport failed" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Name the removed shell capability." }] } }
    ];
    piSessions.push({
      state: { model: { provider: "test", id: "block" } },
      subscribe(listener: (event: any) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async prompt() { firstPrompt(); listeners.forEach((listener) => listener(outcomes.shift())); },
      dispose() {}
    });
    const tutor = new FastWorkbookBlockTutor({ workspace, log: { info() {}, error() {} } });

    try {
      const hint = tutor.hint({ context: activeContext() });
      await prompted;
      await vi.advanceTimersByTimeAsync(250);
      await expect(hint).resolves.toBe("Name the removed shell capability.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates a fresh read-only block session for each hint with private author guidance and active evidence", async () => {
    const workspace = await workspaceFixture();
    const sessions: FakeSession[] = [];
    const tutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
      const session = new FakeSession(request);
      sessions.push(session);
      return session;
    } });
    const context = activeContext();

    await expect(tutor.hint({ context })).resolves.toBe("Try naming which command ability was removed.");
    await expect(tutor.hint({ context })).resolves.toBe("Try naming which command ability was removed.");

    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.disposed).toBe(true);
    expect(sessions[1]!.disposed).toBe(true);
    expect(sessions[0]!.request.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(sessions[0]!.request.customTools.map((tool: any) => tool.name).sort()).toEqual(["find", "grep", "ls", "read"]);
    expect(sessions[0]!.request.systemPrompt).toContain("author guidance");
    expect(sessions[0]!.request.systemPrompt).not.toContain("private briefing");
    expect(sessions[0]!.prompts[0]).toContain("\"authorGuidance\": \"Accept only if the learner names the removed shell capability.\"");
    expect(sessions[0]!.prompts[0]).toContain("\"attempts\"");
  });

  it("rejects a blank hint", async () => {
    const workspace = await workspaceFixture();
    const tutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
      const session = new FakeSession(request);
      session.response = "   \n";
      return session;
    } });

    await expect(tutor.hint({ context: activeContext() })).rejects.toThrow(/empty block tutor hint/i);
  });

  it("rejects hints that quote private author guidance", async () => {
    const workspace = await workspaceFixture();
    const context = activeContext();
    const authorLeakTutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
      const session = new FakeSession(request);
      session.response = `Internal rubric says: ${context.authorGuidance}`;
      return session;
    } });
    await expect(authorLeakTutor.hint({ context })).rejects.toThrow(/private/i);
  });

  it("rejects exact private guidance text even when it is short", async () => {
    const workspace = await workspaceFixture();
    const shortContext = { ...activeContext(), authorGuidance: "K9" };
    const shortGuidanceTutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
      const session = new FakeSession(request);
      session.response = "Try K9 next.";
      return session;
    } });
    await expect(shortGuidanceTutor.hint({ context: shortContext })).rejects.toThrow(/private/i);
  });

  it("exposes only safe read-only workspace tools inside the workspace", async () => {
    const workspace = await workspaceFixture();
    const requests: WorkbookBlockTutorSessionFactoryRequest[] = [];
    const tutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
      requests.push(request);
      return new FakeSession(request);
    } });

    await tutor.hint({ context: activeContext() });

    const tools = new Map(requests[0]!.customTools.map((tool: any) => [tool.name, tool]));
    expect([...tools.keys()].sort()).toEqual(["find", "grep", "ls", "read"]);
    expect(tools.has("write")).toBe(false);
    expect(tools.has("edit")).toBe(false);
    expect(tools.has("move")).toBe(false);
    expect(tools.has("bash")).toBe(false);
    await expect((tools.get("read") as any).execute("read-ok", { path: "factory/answer.md" }, undefined, undefined, undefined))
      .resolves.toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Evidence stays") }] });
    await expect((tools.get("read") as any).execute("read-outside", { path: "../outside.txt" }, undefined, undefined, undefined)).rejects.toThrow(/outside/);
  });

  it("can read authored content and learner workspace through the same read-only tool boundary", async () => {
    const contentRoot = await mkdtemp(join(tmpdir(), "workbook-block-content-")); roots.push(contentRoot);
    const workspace = await workspaceFixture();
    await mkdir(join(contentRoot, "lessons/001/blocks"), { recursive: true });
    await writeFile(join(contentRoot, "lessons/001/blocks/step.md"), "authored lesson text\n", "utf8");
    await mkdir(join(contentRoot, "factory"), { recursive: true });
    await writeFile(join(contentRoot, "factory/answer.md"), "authored stale answer\n", "utf8");
    await writeFile(join(contentRoot, "factory/authored-stale.md"), "authored stale factory-only file\n", "utf8");
    await writeFile(join(workspace, "factory/learner-only.md"), "learner current factory-only file\n", "utf8");
    const outside = await mkdtemp(join(tmpdir(), "workbook-block-outside-factory-")); roots.push(outside);
    await mkdir(join(outside, "factory"));
    await writeFile(join(outside, "factory/answer.md"), "outside factory secret\n", "utf8");
    await symlink(join(outside, "factory/answer.md"), join(contentRoot, "lessons/001/blocks/leak.md"));
    const requests: WorkbookBlockTutorSessionFactoryRequest[] = [];
    const tutor = new FastWorkbookBlockTutor({ workspace, contentRoot, sessionFactory: async (request) => {
      requests.push(request);
      return new FakeSession(request);
    } });

    await tutor.hint({ context: activeContext() });

    const tools = new Map(requests[0]!.customTools.map((tool: any) => [tool.name, tool]));
    await expect((tools.get("read") as any).execute("read-authored", { path: "lessons/001/blocks/step.md" }, undefined, undefined, undefined))
      .resolves.toMatchObject({ content: [{ type: "text", text: expect.stringContaining("authored lesson text") }] });
    await expect((tools.get("read") as any).execute("read-learner", { path: "factory/answer.md" }, undefined, undefined, undefined))
      .resolves.toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Evidence stays") }] });
    const findFactory = await (tools.get("find") as any).execute("find-factory", { path: "factory" }, undefined, undefined, undefined);
    expect(findFactory.content[0].text).toContain("factory/learner-only.md");
    expect(findFactory.content[0].text).not.toContain("authored-stale.md");
    const findRoot = await (tools.get("find") as any).execute("find-root", {}, undefined, undefined, undefined);
    expect(findRoot.content[0].text).toContain("factory/learner-only.md");
    expect(findRoot.content[0].text).not.toContain("authored-stale.md");
    await expect((tools.get("read") as any).execute("read-outside-absolute", { path: join(outside, "factory/answer.md") }, undefined, undefined, undefined)).rejects.toThrow(/outside/);
    await expect((tools.get("find") as any).execute("find-outside-absolute", { path: join(outside, "factory") }, undefined, undefined, undefined)).rejects.toThrow(/outside/);
    await expect((tools.get("read") as any).execute("read-authored-symlink", { path: "lessons/001/blocks/leak.md" }, undefined, undefined, undefined)).rejects.toThrow(/outside/);
    expect(tools.has("write")).toBe(false);
  });

  it("does not expose private .tutorial session state when the workspace lives under the content root", async () => {
    const contentRoot = await mkdtemp(join(tmpdir(), "workbook-block-session-content-")); roots.push(contentRoot);
    const workspace = join(contentRoot, ".tutorial/current-session/workspace");
    await mkdir(join(contentRoot, "lessons/001/blocks"), { recursive: true });
    await writeFile(join(contentRoot, "lessons/001/blocks/step.md"), "authored public lesson text\n", "utf8");
    await mkdir(join(contentRoot, "factory"), { recursive: true });
    await writeFile(join(contentRoot, "factory/answer.md"), "authored stale answer\n", "utf8");
    await mkdir(join(workspace, "factory"), { recursive: true });
    await writeFile(join(workspace, "factory/answer.md"), "learner visible answer\n", "utf8");
    await mkdir(join(contentRoot, ".tutorial/current-session/workbook/attempts/lesson/block"), { recursive: true });
    await writeFile(join(contentRoot, ".tutorial/current-session/workbook/events.jsonl"), "PRIVATE_EVENT_SECRET\n", "utf8");
    await writeFile(join(contentRoot, ".tutorial/current-session/workbook/attempts/lesson/block/current.json"), "PRIVATE_ATTEMPT_SECRET\n", "utf8");
    await mkdir(join(contentRoot, ".tutorial/other-session/workbook"), { recursive: true });
    await writeFile(join(contentRoot, ".tutorial/other-session/workbook/events.jsonl"), "OTHER_SESSION_SECRET\n", "utf8");
    const requests: WorkbookBlockTutorSessionFactoryRequest[] = [];
    const tutor = new FastWorkbookBlockTutor({ workspace, contentRoot, sessionFactory: async (request) => {
      requests.push(request);
      return new FakeSession(request);
    } });

    await tutor.hint({ context: activeContext() });

    const tools = new Map(requests[0]!.customTools.map((tool: any) => [tool.name, tool]));
    await expect((tools.get("read") as any).execute("read-learner", { path: "factory/answer.md" }, undefined, undefined, undefined))
      .resolves.toMatchObject({ content: [{ type: "text", text: expect.stringContaining("learner visible answer") }] });
    for (const privatePath of [
      ".tutorial/current-session/workbook/events.jsonl",
      ".tutorial/current-session/workbook/attempts/lesson/block/current.json",
      ".tutorial/other-session/workbook/events.jsonl",
    ]) {
      await expect((tools.get("read") as any).execute(`read-${privatePath}`, { path: privatePath }, undefined, undefined, undefined), privatePath).rejects.toThrow(/private/i);
    }
    await expect((tools.get("ls") as any).execute("ls-private", { path: ".tutorial" }, undefined, undefined, undefined)).rejects.toThrow(/private/i);
    await expect((tools.get("find") as any).execute("find-private", { path: ".tutorial" }, undefined, undefined, undefined)).rejects.toThrow(/private/i);
    await expect((tools.get("grep") as any).execute("grep-private", { pattern: "PRIVATE", path: ".tutorial" }, undefined, undefined, undefined)).rejects.toThrow(/private/i);
    const lsRoot = await (tools.get("ls") as any).execute("ls-root", { path: "." }, undefined, undefined, undefined);
    expect(lsRoot.content[0].text).not.toContain(".tutorial");
    const findRoot = await (tools.get("find") as any).execute("find-root-session", {}, undefined, undefined, undefined);
    expect(findRoot.content[0].text).toContain("factory/answer.md");
    expect(findRoot.content[0].text).not.toContain(".tutorial");
    expect(findRoot.content[0].text).not.toContain("PRIVATE_EVENT_SECRET");
    const grepRoot = await (tools.get("grep") as any).execute("grep-root-session", { pattern: "PRIVATE", path: "." }, undefined, undefined, undefined);
    expect(grepRoot.content[0].text).toBe("No matches found");
    expect(grepRoot.content[0].text).not.toContain("PRIVATE_ATTEMPT_SECRET");
    expect(grepRoot.content[0].text).not.toContain("OTHER_SESSION_SECRET");
  });

  it("disables the Pi-backed fast coach instead of falling back when BLOCK_TUTOR_MODEL is unset", async () => {
    const workspace = await workspaceFixture();
    delete process.env.BLOCK_TUTOR_MODEL;
    const tutor = new FastWorkbookBlockTutor({ workspace, log: { info() {}, error() {} } });

    await expect(tutor.assessTerminal!({ context: activeContext([attempt("terminal-unset", "terminal")]), attempt: attempt("terminal-unset", "terminal") })).rejects.toThrow(/BLOCK_TUTOR_MODEL.*set/i);

    expect(createAgentSession).not.toHaveBeenCalled();
    expect(resolveCliModel).not.toHaveBeenCalled();
  });

  it("disables the Pi-backed fast coach instead of falling back when BLOCK_TUTOR_MODEL has no configured auth", async () => {
    const workspace = await workspaceFixture();
    process.env.BLOCK_TUTOR_MODEL = "test/block";
    hasConfiguredAuth.mockReturnValue(false);
    const tutor = new FastWorkbookBlockTutor({ workspace, log: { info() {}, error() {} } });

    await expect(tutor.assessTerminal!({ context: activeContext([attempt("terminal-unauth", "terminal")]), attempt: attempt("terminal-unauth", "terminal") })).rejects.toThrow(/no configured auth/i);

    expect(resolveCliModel).toHaveBeenCalledWith({ cliModel: "test/block", modelRuntime: expect.anything() });
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("reports terminal quick-coach correction without readiness or acceptance tools", async () => {
    const workspace = await workspaceFixture();
    const requests: WorkbookBlockTutorSessionFactoryRequest[] = [];
    const terminalAttempt = attempt("terminal-wrong", "terminal");
    const tutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
      requests.push(request);
      const session = new FakeSession(request);
      session.response = async () => {
        const quickCoach = request.customTools.find((tool: any) => tool.name === "report_terminal_attempt") as any;
        await quickCoach.execute("terminal-tool", { outcome: "feedback", message: "Use the command from the block, then run it again." }, undefined, undefined, undefined);
        return "";
      };
      return session;
    } });

    await expect(tutor.assessTerminal!({ context: activeContext([terminalAttempt]), attempt: terminalAttempt })).resolves.toEqual({ outcome: "feedback", text: "Use the command from the block, then run it again." });

    expect(requests[0]!.tools).toEqual(["read", "grep", "find", "ls", "report_terminal_attempt"]);
    expect(requests[0]!.customTools.map((tool: any) => tool.name).sort()).toEqual(["find", "grep", "ls", "read", "report_terminal_attempt"]);
    expect(requests[0]!.customTools.map((tool: any) => tool.name)).not.toContain("accept_current_attempt");
    expect(requests[0]!.customTools.map((tool: any) => tool.name)).not.toContain("mark_attempt_still_working");
  });

  it("reports attempt readiness only through report_attempt_readiness", async () => {
    const workspace = await workspaceFixture();
    const requests: WorkbookBlockTutorSessionFactoryRequest[] = [];
    const tutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
      requests.push(request);
      const session = new FakeSession(request);
      session.response = async () => {
        const readiness = request.customTools.find((tool: any) => tool.name === "report_attempt_readiness") as any;
        await readiness.execute("ready-tool", { readiness: "likely_ready", rationale: "The attempt names the missing shell capability." }, undefined, undefined, undefined);
        return "  This likely covers the block.  ";
      };
      return session;
    } });

    await expect(tutor.assess({ context: activeContext(), attempt: attempt("attempt-ready") })).resolves.toEqual({
      readiness: "likely_ready",
      text: "This likely covers the block."
    });

    expect(requests[0]!.tools).toEqual(["read", "grep", "find", "ls", "report_attempt_readiness"]);
    expect(requests[0]!.customTools.map((tool: any) => tool.name).sort()).toEqual(["find", "grep", "ls", "read", "report_attempt_readiness"]);
    expect(requests[0]!.customTools.map((tool: any) => tool.name)).not.toContain("accept_current_attempt");
    expect(requests[0]!.customTools.map((tool: any) => tool.name)).not.toContain("mark_attempt_still_working");
  });

  it("rejects readiness values outside the block-tutor signal vocabulary", async () => {
    const workspace = await workspaceFixture();
    const tutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
      const session = new FakeSession(request);
      session.response = async () => {
        const readiness = request.customTools.find((tool: any) => tool.name === "report_attempt_readiness") as any;
        await readiness.execute("ready-tool", { readiness: "accepted", rationale: "Looks done." }, undefined, undefined, undefined);
        return "Looks done.";
      };
      return session;
    } });

    await expect(tutor.assess({ context: activeContext(), attempt: attempt("attempt-invalid") })).rejects.toThrow(/readiness/i);
  });

  it("rejects readiness output that claims the attempt is accepted, passing, rejected, or failed", async () => {
    const workspace = await workspaceFixture();
    for (const claim of ["accepted", "passing", "reject", "rejected", "fail", "failed"]) {
      const tutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
        const session = new FakeSession(request);
        session.response = async () => {
          const readiness = request.customTools.find((tool: any) => tool.name === "report_attempt_readiness") as any;
          await readiness.execute("ready-tool", { readiness: "likely_ready", rationale: `This is ${claim}.` }, undefined, undefined, undefined);
          return "Likely ready.";
        };
        return session;
      } });

      await expect(tutor.assess({ context: activeContext(), attempt: attempt(`attempt-${claim}`) }), claim).rejects.toThrow(/acceptance/i);
    }

    const responseClaimTutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
      const session = new FakeSession(request);
      session.response = async () => {
        const readiness = request.customTools.find((tool: any) => tool.name === "report_attempt_readiness") as any;
        await readiness.execute("ready-tool", { readiness: "still_working", rationale: "Names the capability but needs more detail." }, undefined, undefined, undefined);
        return "This passed; send it on.";
      };
      return session;
    } });

    await expect(responseClaimTutor.assess({ context: activeContext(), attempt: attempt("attempt-passed") })).rejects.toThrow(/acceptance/i);
  });
});
