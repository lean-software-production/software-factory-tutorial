import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const piSessions = vi.hoisted(() => [] as any[]);
const createAgentSession = vi.hoisted(() => vi.fn(async () => {
  const session = piSessions.shift();
  session.agent ??= { state: { messages: [] } };
  return { session };
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    DefaultResourceLoader: class { async reload() {} },
    ModelRuntime: { create: vi.fn(async () => ({})) },
    SessionManager: { inMemory: vi.fn(() => ({ appendCustomMessageEntry() {}, appendMessage() {}, buildSessionContext: () => ({ messages: [] }) })) },
    SettingsManager: { inMemory: vi.fn((settings) => settings) },
    createAgentSession,
    getAgentDir: vi.fn(() => "/tmp/pi-agent")
  };
});
import type { Attempt } from "../src/workbook/attempts.js";
import type { ActiveBlockContext } from "../src/workbook/pi-history.js";
import { DefaultMainWorkbookTutor as MainWorkbookTutor, type TutorDecision, type WorkbookTutorSession, type WorkbookTutorSessionFactoryRequest } from "../src/workbook/tutor.js";
import type { TimelineMessage, WorkbookTimelineRecord } from "../src/workbook/timeline.js";
import type { MainTutorHistoryProjection } from "../src/workbook/pi-history.js";

function attempt(id: string, kind: Attempt["evidence"]["kind"] = "editor", transcript = "npm test\nPASS"): Attempt {
  const evidence: Attempt["evidence"] = kind === "terminal"
    ? { kind, transcript, terminalHtml: `<pre>${transcript}</pre>` }
    : kind === "reflection"
      ? { kind, response: "I learned the doer is bounded.", conversation: [] }
      : { kind, text: "answer" };
  return { id, lessonId: "lesson", blockId: "block", version: 1, evidence, status: "reviewing" };
}

function message(id: string, sequence: number, source: TimelineMessage["source"], role: TimelineMessage["role"], text: string): TimelineMessage {
  return { id, sequence, at: `2026-08-21T00:00:0${sequence}.000Z`, type: "message", lessonId: "lesson", blockId: "block", role, source, presentation: source === "authored" ? "course" : "chat", text };
}

function activeContext(attempts: Attempt[] = [attempt("a-1")]): ActiveBlockContext {
  return {
    lessonId: "lesson",
    blockId: "block",
    title: "Do the thing",
    markdown: "Use `.tmp/evidence.txt` for recreated evidence.",
    authorGuidance: "Accept only if the answer names the removed shell capability.",
    attempts
  };
}

class FakeSession implements WorkbookTutorSession {
  readonly systemPrompt: string;
  readonly customTools: WorkbookTutorSessionFactoryRequest["customTools"];
  readonly activeContext?: NonNullable<WorkbookTutorSessionFactoryRequest["history"]["activeContext"]>;
  readonly prompts: string[] = [];
  readonly calls: string[] = [];
  promptResponses: Array<string | ((prompt: string) => Promise<string> | string)> = [];
  compactError?: Error;
  disposed = false;

  constructor(request: WorkbookTutorSessionFactoryRequest) {
    this.systemPrompt = request.systemPrompt;
    this.customTools = request.customTools;
    this.activeContext = request.history.activeContext;
  }

  async prompt(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    this.calls.push(prompt.includes("WORKBOOK ATTEMPT REVIEW") ? "review" : "prompt");
    const response = this.promptResponses.shift();
    if (typeof response === "function") return response(prompt);
    return response ?? "Needs one more concrete detail.";
  }

  async compact(instruction: string): Promise<{ summary: string }> {
    this.calls.push(instruction.includes("WORKBOOK TUTOR COMPACTION") ? "compaction" : "compact");
    if (this.compactError) throw this.compactError;
    return { summary: "Compacted workbook context." };
  }

  dispose(): void { this.disposed = true; }
}

function logger() {
  const errors: string[] = [];
  return { errors, log: { info() {}, error(message: string, error?: unknown) { errors.push(`${message}: ${error instanceof Error ? error.message : String(error ?? "")}`); } } };
}

describe("MainWorkbookTutor", () => {
  it("retries a terminal provider error through the default Pi session before replying", async () => {
    vi.useFakeTimers();
    const listeners = new Set<(event: any) => void>();
    const outcomes = [
      { type: "message_end", message: { role: "assistant", content: [], errorMessage: "transport failed" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Recovered main reply." }] } }
    ];
    piSessions.push({
      state: { model: { provider: "test", id: "main" } },
      subscribe(listener: (event: any) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      async prompt() { listeners.forEach((listener) => listener(outcomes.shift())); },
      async compact() { return { summary: "Summary." }; },
      dispose() {}
    });
    const previousTutorModel = process.env.TUTOR_MODEL;
    delete process.env.TUTOR_MODEL;

    try {
      const tutor = new MainWorkbookTutor({ workspace: "/tmp/workbook", log: logger().log });
      const reply = tutor.reply({ records: [], activeContext: activeContext(), learnerMessage: message("learner-1", 1, "learner", "user", "Help") });
      await vi.advanceTimersByTimeAsync(250);
      await expect(reply).resolves.toBe("Recovered main reply.");
    } finally {
      if (previousTutorModel === undefined) delete process.env.TUTOR_MODEL;
      else process.env.TUTOR_MODEL = previousTutorModel;
      vi.useRealTimers();
    }
  });

  it("rebuilds replies from projected authored, learner, main, and block turns plus fresh active evidence", async () => {
    const sessions: FakeSession[] = [];
    const requests: WorkbookTutorSessionFactoryRequest[] = [];
    const queuedResponses = ["Use `.tmp/evidence.txt` so regenerated evidence stays ignored.", "Needs one more concrete detail."];
    const tutor = new MainWorkbookTutor({ workspace: "/tmp/workbook", sessionFactory: async (request) => {
      requests.push(request);
      const session = new FakeSession(request);
      session.promptResponses.push(queuedResponses.shift() ?? "Needs one more concrete detail.");
      sessions.push(session);
      return session;
    } });
    const records: WorkbookTimelineRecord[] = [
      message("authored-1", 1, "authored", "assistant", "## Course note\n\nUse `.tmp`."),
      message("learner-1", 2, "learner", "user", "Which path?"),
      message("main-1", 3, "main_tutor", "assistant", "Use the workspace-relative `.tmp/evidence.txt`."),
      message("block-1", 4, "main_tutor", "assistant", "Your terminal output is close."),
    ];
    const firstActive = activeContext([attempt("a-1", "terminal")]);
    const learnerMessage = message("learner-2", 5, "learner", "user", "Can I put it elsewhere?");

    await expect(tutor.reply({ records, activeContext: firstActive, learnerMessage })).resolves.toBe("Use `.tmp/evidence.txt` so regenerated evidence stays ignored.");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.history.turns).toEqual([
      { sourceEventId: "authored-1", role: "assistant", text: "## Course note\n\nUse `.tmp`.", timestamp: Date.parse("2026-08-21T00:00:01.000Z") },
      { sourceEventId: "learner-1", role: "user", text: "Which path?", timestamp: Date.parse("2026-08-21T00:00:02.000Z") },
      { sourceEventId: "main-1", role: "assistant", text: "Use the workspace-relative `.tmp/evidence.txt`.", timestamp: Date.parse("2026-08-21T00:00:03.000Z") },
      { sourceEventId: "block-1", role: "assistant", text: "Your terminal output is close.", timestamp: Date.parse("2026-08-21T00:00:04.000Z") },
    ]);
    expect(sessions[0]!.activeContext?.name).toBe("workbook-active-block");
    expect(sessions[0]!.activeContext?.text).toContain('"transcript": "npm test\\nPASS"');
    expect(sessions[0]!.activeContext?.sourceEventIds).toEqual(["authored-1", "learner-1", "main-1", "block-1"]);
    expect(sessions[0]!.prompts[0]).toContain("Can I put it elsewhere?");

    const secondActive = activeContext([attempt("a-2", "reflection")]);
    await expect(tutor.reply({ records, activeContext: secondActive, learnerMessage })).resolves.toBe("Needs one more concrete detail.");

    expect(requests).toHaveLength(2);
    expect(sessions[0]!.disposed).toBe(true);
    expect(sessions[1]!.activeContext?.text).toContain('"id": "a-2"');
  });

  it("recreates the disposable session when restored summaries replace completed turns", async () => {
    const sessions: FakeSession[] = [];
    const requests: WorkbookTutorSessionFactoryRequest[] = [];
    const tutor = new MainWorkbookTutor({ workspace: "/tmp/workbook", sessionFactory: async (request) => {
      requests.push(request);
      const session = new FakeSession(request);
      session.promptResponses.push("Continue with the active block.");
      sessions.push(session);
      return session;
    } });
    const completedRecords: WorkbookTimelineRecord[] = [
      message("authored-1", 1, "authored", "assistant", "## Edit\n\nWrite the answer."),
      message("learner-1", 2, "learner", "user", "I wrote the answer."),
      message("main-1", 3, "main_tutor", "assistant", "That satisfies the block."),
    ];
    const summarizedRecords: WorkbookTimelineRecord[] = [
      ...completedRecords,
      { id: "summary-1", sequence: 4, at: "2026-08-21T00:00:04.000Z", type: "block_summarized", lessonId: "lesson", blockId: "block", text: "The learner completed the edit block.", coveredThroughId: "main-1" },
    ];

    await expect(tutor.reply({ records: completedRecords, learnerMessage: message("learner-2", 4, "learner", "user", "What next?") })).resolves.toBe("Continue with the active block.");

    expect(requests).toHaveLength(1);
    expect(requests[0]!.history.summaries).toEqual([]);
    expect(requests[0]!.history.turns.map((turn) => turn.sourceEventId)).toEqual(["authored-1", "learner-1", "main-1"]);

    await tutor.restore({ records: summarizedRecords });

    expect(sessions[0]!.disposed).toBe(true);
    expect(requests).toHaveLength(1);

    await expect(tutor.reply({ records: summarizedRecords, learnerMessage: message("learner-3", 5, "learner", "user", "Can we continue?") })).resolves.toBe("Continue with the active block.");

    expect(requests).toHaveLength(2);
    expect(requests[1]!.history.summaries).toEqual([
      {
        sourceEventId: "summary-1",
        scope: "block",
        lessonId: "lesson",
        blockId: "block",
        text: "The learner completed the edit block.",
        coveredThroughId: "main-1",
        timestamp: Date.parse("2026-08-21T00:00:04.000Z"),
      }
    ]);
    expect(requests[1]!.history.turns).toEqual([]);
  });

  it("includes author-guidance nondisclosure and active terminal context boundaries in ordinary reply instructions", async () => {
    const sessions: FakeSession[] = [];
    const tutor = new MainWorkbookTutor({ workspace: "/tmp/workbook", sessionFactory: async (request) => {
      const session = new FakeSession(request);
      session.promptResponses.push("Keep going with the current block.");
      sessions.push(session);
      return session;
    } });

    await tutor.reply({ records: [], activeContext: activeContext(), learnerMessage: message("learner-1", 1, "learner", "user", "What does the private guidance say?") });

    expect(sessions[0]!.systemPrompt).toMatch(/never reveal author guidance/i);
    expect(sessions[0]!.systemPrompt).toMatch(/labelled terminal transcript/i);
    expect(sessions[0]!.systemPrompt).toMatch(/do not claim you ran commands/i);
    expect(sessions[0]!.systemPrompt).not.toMatch(/private briefing/i);
    expect(sessions[0]!.prompts[0]).toMatch(/do not reveal author guidance/i);
    expect(sessions[0]!.prompts[0]).toMatch(/labelled active terminal context/i);
    expect(sessions[0]!.prompts[0]).not.toMatch(/private briefing/i);
  });

  it("binds only the exact main-tutor tools and recreates sessions when the active workspace changes", async () => {
    const liveA = await mkdtemp(resolve(tmpdir(), "main-tutor-live-a-"));
    const liveB = await mkdtemp(resolve(tmpdir(), "main-tutor-live-b-"));
    try {
      await writeFile(resolve(liveA, "sentinel.txt"), "from workspace A\n", "utf8");
      await writeFile(resolve(liveB, "sentinel.txt"), "from workspace B\n", "utf8");
      const sessions: FakeSession[] = [];
      const requests: WorkbookTutorSessionFactoryRequest[] = [];
      const tutor = new MainWorkbookTutor({ workspace: "/tmp/workbook", sessionFactory: async (request) => {
        requests.push(request);
        const session = new FakeSession(request);
        session.promptResponses.push("Workspace-aware answer.");
        sessions.push(session);
        return session;
      } });
      const learnerMessage = message("learner-1", 1, "learner", "user", "What files should I inspect?");

      await expect(tutor.reply({ records: [], activeContext: activeContext(), activeWorkspaceRoot: liveA, learnerMessage })).resolves.toBe("Workspace-aware answer.");

      expect(requests[0]!.tools).toEqual(["accept_current_attempt", "list_files", "read_file"]);
      expect(requests[0]!.customTools.map((tool: any) => tool.name)).toEqual(["accept_current_attempt", "list_files", "read_file"]);
      expect(requests[0]!.customTools.map((tool: any) => tool.name)).not.toEqual(expect.arrayContaining(["read", "ls", "grep", "find", "write", "edit", "move", "bash"]));
      const firstRead = requests[0]!.customTools.find((tool: any) => tool.name === "read_file") as any;
      await expect(firstRead.execute("read-a", { path: "sentinel.txt" }, undefined, undefined, undefined)).resolves.toMatchObject({ content: [{ text: expect.stringContaining("from workspace A") }] });

      await expect(tutor.reply({ records: [], activeContext: activeContext(), activeWorkspaceRoot: liveA, learnerMessage: message("learner-2", 2, "learner", "user", "Again?") })).resolves.toBe("Needs one more concrete detail.");
      expect(requests).toHaveLength(1);
      expect(sessions[0]!.disposed).toBe(false);

      await expect(tutor.reply({ records: [], activeContext: activeContext(), activeWorkspaceRoot: liveB, learnerMessage: message("learner-3", 3, "learner", "user", "Now?") })).resolves.toBe("Workspace-aware answer.");
      expect(sessions[0]!.disposed).toBe(true);
      expect(requests).toHaveLength(2);
      const secondRead = requests[1]!.customTools.find((tool: any) => tool.name === "read_file") as any;
      const secondReadResult = await secondRead.execute("read-b", { path: "sentinel.txt" }, undefined, undefined, undefined) as any;
      expect(secondReadResult.content[0].text).toContain("from workspace B");
      expect(secondReadResult.content[0].text).not.toContain("from workspace A");

      await expect(tutor.reply({ records: [], activeContext: activeContext(), learnerMessage: message("learner-4", 4, "learner", "user", "No files?") })).resolves.toBe("Workspace-aware answer.");
      expect(sessions[1]!.disposed).toBe(true);
      expect(requests[2]!.tools).toEqual(["accept_current_attempt"]);
      expect(requests[2]!.customTools.map((tool: any) => tool.name)).toEqual(["accept_current_attempt"]);
    } finally {
      await Promise.all([liveA, liveB].map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("keeps completeBlock constrained while adding workspace tools", async () => {
    const live = await mkdtemp(resolve(tmpdir(), "main-tutor-live-complete-"));
    try {
      const requests: WorkbookTutorSessionFactoryRequest[] = [];
      const tutor = new MainWorkbookTutor({ workspace: "/tmp/workbook", sessionFactory: async (request) => {
        requests.push(request);
        const session = new FakeSession(request);
        session.promptResponses.push("Continue.");
        return session;
      } });

      await tutor.reply({ records: [], activeContext: activeContext(), activeWorkspaceRoot: live, completionTool: { blockId: "lesson--block" }, learnerMessage: message("learner-1", 1, "learner", "user", "I am ready.") });

      expect(requests[0]!.tools).toEqual(["accept_current_attempt", "completeBlock", "list_files", "read_file"]);
      expect(requests[0]!.customTools.map((tool: any) => tool.name)).toEqual(["accept_current_attempt", "completeBlock", "list_files", "read_file"]);
    } finally {
      await rm(live, { recursive: true, force: true });
    }
  });

  it("exposes only accepted and feedback review outcomes through real custom tools", async () => {
    const sessions: FakeSession[] = [];
    const requests: WorkbookTutorSessionFactoryRequest[] = [];
    const tutor = new MainWorkbookTutor({ workspace: "/tmp/workbook", sessionFactory: async (request) => {
      requests.push(request);
      const session = new FakeSession(request);
      session.promptResponses.push("Use a concrete example.");
      sessions.push(session);
      return session;
    } });
    await expect(tutor.review({ records: [], activeContext: activeContext(), attempt: attempt("a-1"), privateGuidance: "Accept only complete answers." })).resolves.toEqual({ outcome: "feedback", message: "Use a concrete example." });

    expect(requests[0]!.tools).toEqual(["accept_current_attempt"]);
    expect(requests[0]!.customTools.map((tool: any) => tool.name)).toEqual(["accept_current_attempt"]);
    expect(requests[0]!.customTools.map((tool: any) => tool.name)).not.toContain("mark_attempt_still_working");
    for (const tool of requests[0]!.customTools as any[]) {
      expect(tool.parameters.required ?? []).toEqual([]);
      expect(tool.parameters.additionalProperties).toBe(false);
    }

    sessions[0]!.promptResponses.push(async () => {
      await (requests[0]!.customTools[0] as any).execute("tool-call", {});
      return "Nice work.";
    });
    await expect(tutor.review({ records: [], activeContext: activeContext(), attempt: attempt("a-2"), privateGuidance: "Accept only complete answers." })).resolves.toEqual({ outcome: "accepted", message: "Nice work." });

    sessions[0]!.promptResponses.push(async () => {
      await (requests[0]!.customTools[0] as any).execute("tool-call", {});
      return "   ";
    });
    const accepted = await tutor.review({ records: [], activeContext: activeContext(), attempt: attempt("a-accepted-empty"), privateGuidance: "Accept only complete answers." });
    expect(accepted).toEqual({ outcome: "accepted", message: "Accepted — this attempt satisfies the block." });
    if (accepted.outcome === "accepted") expect(accepted.message).not.toMatch(/revise|try again|specific feedback/i);

    const acceptedDecision: TutorDecision = { outcome: "accepted", message: "Accepted." };
    const feedbackDecision: TutorDecision = { outcome: "feedback", message: "Add a concrete example." };
    expect([acceptedDecision.outcome, feedbackDecision.outcome]).toEqual(["accepted", "feedback"]);
    // @ts-expect-error TutorDecision deliberately has no quiet working outcome.
    const invalidWorkingDecision: TutorDecision = { outcome: "working" };
    expect(invalidWorkingDecision.outcome).toBe("working");
  });

  it("records a usable block summary when Pi reports a short context needs no compaction", async () => {
    const session = new FakeSession({ systemPrompt: "", customTools: [], tools: [], history: { summaries: [], turns: [] } satisfies MainTutorHistoryProjection });
    const tutor = new MainWorkbookTutor({ workspace: "/tmp/workbook", sessionFactory: async () => session });
    session.compactError = new Error("Nothing to compact (session too small)");
    const records: WorkbookTimelineRecord[] = [
      { id: "accepted-1", sequence: 1, at: "2026-08-21T00:00:01.000Z", type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "a-1", version: 1, kind: "reflection", summary: "You distinguished the tutor from the validator." }
    ];

    await expect(tutor.summarizeBlock({ records, lessonId: "lesson", blockId: "block", coveredThroughId: "complete-1" })).resolves.toBe("Completed workbook block lesson/block. Accepted evidence: You distinguished the tutor from the validator.");

    session.compactError = new Error("compaction provider unavailable");
    await expect(tutor.summarizeBlock({ records, lessonId: "lesson", blockId: "block", coveredThroughId: "complete-2" })).rejects.toThrow("compaction provider unavailable");
  });

  it("records a usable lesson summary when Pi reports a short context needs no compaction", async () => {
    const session = new FakeSession({ systemPrompt: "", customTools: [], tools: [], history: { summaries: [], turns: [] } satisfies MainTutorHistoryProjection });
    const tutor = new MainWorkbookTutor({ workspace: "/tmp/workbook", sessionFactory: async () => session });
    session.compactError = new Error("Nothing to compact (session too small)");
    const records: WorkbookTimelineRecord[] = [
      message("authored-1", 1, "authored", "assistant", "## Orientation\n\nRead the authored narrative."),
      { id: "summary-1", sequence: 2, at: "2026-08-21T00:00:02.000Z", type: "block_summarized", lessonId: "lesson", blockId: "block-a", text: "The learner completed the first practice block.", coveredThroughId: "complete-1" },
      { id: "summary-2", sequence: 3, at: "2026-08-21T00:00:03.000Z", type: "block_summarized", lessonId: "lesson", blockId: "block-b", text: "The learner completed the second practice block.", coveredThroughId: "complete-2" },
    ];

    await expect(tutor.summarizeLesson({ records, lessonId: "lesson", coveredThroughId: "complete-lesson" })).resolves.toBe("Completed workbook lesson lesson. Completed block summaries: block-a: The learner completed the first practice block. block-b: The learner completed the second practice block. Authored history: block: ## Orientation Read the authored narrative.");

    session.compactError = new Error("compaction provider unavailable");
    await expect(tutor.summarizeLesson({ records, lessonId: "lesson", coveredThroughId: "complete-lesson-2" })).rejects.toThrow("compaction provider unavailable");
  });

  it("rejects empty material review feedback instead of inventing generic feedback", async () => {
    const session = new FakeSession({ systemPrompt: "", customTools: [], tools: [], history: { summaries: [], turns: [] } satisfies MainTutorHistoryProjection });
    const tutor = new MainWorkbookTutor({ workspace: "/tmp/workbook", sessionFactory: async () => session });

    session.promptResponses.push("  \n\t  ");

    await expect(tutor.review({ records: [], activeContext: activeContext(), attempt: attempt("a-empty-feedback"), privateGuidance: "Accept only complete answers." })).rejects.toThrow(/empty tutor response/i);
  });

  it("requires material feedback text and rejects empty ordinary replies", async () => {
    const session = new FakeSession({ systemPrompt: "", customTools: [], tools: [], history: { summaries: [], turns: [] } satisfies MainTutorHistoryProjection });
    const requests: WorkbookTutorSessionFactoryRequest[] = [];
    const tutor = new MainWorkbookTutor({ workspace: "/tmp/workbook", sessionFactory: async (request) => { requests.push(request); return session; } });

    session.promptResponses.push("Please explain what happened in learner-visible terms.");
    await expect(tutor.review({ records: [], activeContext: activeContext(), attempt: attempt("a-1", "terminal"), privateGuidance: "Accept only complete terminal evidence." })).resolves.toEqual({ outcome: "feedback", message: "Please explain what happened in learner-visible terms." });
    expect(requests[0]!.tools).not.toContain("mark_attempt_still_working");

    session.promptResponses.push("   ");
    await expect(tutor.reply({ records: [], activeContext: activeContext(), learnerMessage: message("learner-1", 1, "learner", "user", "Hello?") })).rejects.toThrow(/empty tutor response/i);
  });

});
