import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Attempt } from "../src/workbook/attempts.js";
import type { ActiveBlockContext } from "../src/workbook/pi-history.js";
import { FastWorkbookBlockTutor, type WorkbookBlockTutorSession, type WorkbookBlockTutorSessionFactoryRequest } from "../src/workbook/block-tutor.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

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
  it("creates a fresh read-only block session for each hint with private briefing and active evidence", async () => {
    const workspace = await workspaceFixture();
    const sessions: FakeSession[] = [];
    const tutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
      const session = new FakeSession(request);
      sessions.push(session);
      return session;
    } });
    const context = activeContext();

    await expect(tutor.hint({ context, briefing: "Watch for the learner naming shell execution as removed." })).resolves.toBe("Try naming which command ability was removed.");
    await expect(tutor.hint({ context, briefing: "Second private briefing." })).resolves.toBe("Try naming which command ability was removed.");

    expect(sessions).toHaveLength(2);
    expect(sessions[0].disposed).toBe(true);
    expect(sessions[1].disposed).toBe(true);
    expect(sessions[0].request.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(sessions[0].request.customTools.map((tool: any) => tool.name).sort()).toEqual(["find", "grep", "ls", "read"]);
    expect(sessions[0].request.systemPrompt).toContain("private briefing");
    expect(sessions[0].prompts[0]).toContain("Watch for the learner naming shell execution as removed.");
    expect(sessions[0].prompts[0]).toContain("\"authorGuidance\": \"Accept only if the learner names the removed shell capability.\"");
    expect(sessions[0].prompts[0]).toContain("\"attempts\"");
  });

  it("rejects a blank hint", async () => {
    const workspace = await workspaceFixture();
    const tutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
      const session = new FakeSession(request);
      session.response = "   \n";
      return session;
    } });

    await expect(tutor.hint({ context: activeContext(), briefing: "Private guidance." })).rejects.toThrow(/empty block tutor hint/i);
  });

  it("rejects hints that quote private briefing or author guidance", async () => {
    const workspace = await workspaceFixture();
    const briefing = "Watch for the learner naming shell execution as removed.";
    const context = activeContext();
    const tutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
      const session = new FakeSession(request);
      session.response = `Tell the learner: ${briefing}`;
      return session;
    } });

    await expect(tutor.hint({ context, briefing })).rejects.toThrow(/private/i);

    const authorLeakTutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
      const session = new FakeSession(request);
      session.response = `Internal rubric says: ${context.authorGuidance}`;
      return session;
    } });
    await expect(authorLeakTutor.hint({ context, briefing: "Private briefing." })).rejects.toThrow(/private/i);
  });

  it("rejects exact private briefing or guidance text even when it is short", async () => {
    const workspace = await workspaceFixture();
    const shortContext = { ...activeContext(), authorGuidance: "K9" };
    const shortGuidanceTutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
      const session = new FakeSession(request);
      session.response = "Try K9 next.";
      return session;
    } });
    await expect(shortGuidanceTutor.hint({ context: shortContext, briefing: "Z7" })).rejects.toThrow(/private/i);

    const shortBriefingTutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
      const session = new FakeSession(request);
      session.response = "Look for z7 in your answer.";
      return session;
    } });
    await expect(shortBriefingTutor.hint({ context: shortContext, briefing: "Z7" })).rejects.toThrow(/private/i);
  });

  it("exposes only safe read-only workspace tools inside the workspace", async () => {
    const workspace = await workspaceFixture();
    const requests: WorkbookBlockTutorSessionFactoryRequest[] = [];
    const tutor = new FastWorkbookBlockTutor({ workspace, sessionFactory: async (request) => {
      requests.push(request);
      return new FakeSession(request);
    } });

    await tutor.hint({ context: activeContext(), briefing: "Private guidance." });

    const tools = new Map(requests[0].customTools.map((tool: any) => [tool.name, tool]));
    expect([...tools.keys()].sort()).toEqual(["find", "grep", "ls", "read"]);
    expect(tools.has("write")).toBe(false);
    expect(tools.has("edit")).toBe(false);
    expect(tools.has("move")).toBe(false);
    expect(tools.has("bash")).toBe(false);
    await expect((tools.get("read") as any).execute("read-ok", { path: "factory/answer.md" }, undefined, undefined, undefined))
      .resolves.toMatchObject({ content: [{ type: "text", text: expect.stringContaining("Evidence stays") }] });
    await expect((tools.get("read") as any).execute("read-outside", { path: "../outside.txt" }, undefined, undefined, undefined)).rejects.toThrow(/outside/);
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

    expect(requests[0].tools).toEqual(["read", "grep", "find", "ls", "report_attempt_readiness"]);
    expect(requests[0].customTools.map((tool: any) => tool.name).sort()).toEqual(["find", "grep", "ls", "read", "report_attempt_readiness"]);
    expect(requests[0].customTools.map((tool: any) => tool.name)).not.toContain("accept_current_attempt");
    expect(requests[0].customTools.map((tool: any) => tool.name)).not.toContain("mark_attempt_still_working");
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
