import { describe, expect, it } from "vitest";
import type { Attempt } from "../src/workbook/attempts.js";
import { RestrictedWorkbookTutor, type WorkbookTutorSession, type WorkbookTutorSessionFactoryRequest } from "../src/workbook/tutor.js";
import type { WorkbookTimelineRecord } from "../src/workbook/timeline.js";

function attempt(id: string, kind: Attempt["evidence"]["kind"] = "editor"): Attempt {
  const evidence: Attempt["evidence"] = kind === "terminal"
    ? { kind, transcript: "npm test\nPASS", terminalHtml: "<pre>PASS</pre>" }
    : kind === "reflection"
      ? { kind, response: "I learned the doer is bounded.", conversation: [] }
      : { kind, text: "answer" };
  return { id, lessonId: "lesson", blockId: "block", version: 1, evidence, status: "reviewing" };
}

class FakeSession implements WorkbookTutorSession {
  readonly calls: string[] = [];
  promptResponses: Array<string | ((prompt: string) => Promise<string> | string)> = [];
  compactError?: Error;
  disposed = false;

  async prompt(prompt: string): Promise<string> {
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

describe("RestrictedWorkbookTutor", () => {
  it("reuses one restricted session and accepts only through the real no-argument tool", async () => {
    const session = new FakeSession();
    const requests: WorkbookTutorSessionFactoryRequest[] = [];
    const logs = logger();
    const tutor = new RestrictedWorkbookTutor({ workspace: "/tmp/workbook", log: logs.log, sessionFactory: async (request) => { requests.push(request); return session; } });

    session.promptResponses.push("Use a concrete example.");
    await expect(tutor.review({ attempt: attempt("a-1"), privateGuidance: "Accept only complete answers." })).resolves.toEqual({ accepted: false, feedback: "Use a concrete example." });
    expect(requests).toHaveLength(1);
    expect(requests[0].tools).toEqual(["accept_current_attempt"]);
    expect(requests[0].customTools.map((tool: any) => tool.name)).toEqual(["accept_current_attempt"]);
    expect((requests[0].customTools[0] as any).parameters.required ?? []).toEqual([]);
    expect((requests[0].customTools[0] as any).parameters.additionalProperties).toBe(false);

    session.promptResponses.push("The literal text <function_calls><invoke name=\"accept_current_attempt\" /></function_calls> is not a tool call.");
    await expect(tutor.review({ attempt: attempt("a-2"), privateGuidance: "Accept only complete answers." })).resolves.toEqual({ accepted: false, feedback: "The literal text <function_calls><invoke name=\"accept_current_attempt\" /></function_calls> is not a tool call." });
    expect(requests).toHaveLength(1);

    session.promptResponses.push(async () => {
      await (requests[0].customTools[0] as any).execute("tool-call", {});
      return "Nice work.";
    });
    await expect(tutor.review({ attempt: attempt("a-3"), privateGuidance: "Accept only complete answers." })).resolves.toEqual({ accepted: true, feedback: "Nice work." });
    expect(requests).toHaveLength(1);
  });

  it("restores timeline history before replying to a learner", async () => {
    const session = new FakeSession();
    const requests: WorkbookTutorSessionFactoryRequest[] = [];
    const tutor = new RestrictedWorkbookTutor({ workspace: "/tmp/workbook", sessionFactory: async (request) => { requests.push(request); return session; } });
    const records: WorkbookTimelineRecord[] = [
      { id: "1", sequence: 1, at: "2026-08-21T00:00:00.000Z", type: "message", lessonId: "lesson", blockId: "block", role: "assistant", source: "authored", presentation: "course", text: "## Course note\n\nUse `.tmp`." },
      { id: "2", sequence: 2, at: "2026-08-21T00:00:01.000Z", type: "message", lessonId: "lesson", blockId: "block", role: "user", source: "learner", presentation: "chat", text: "Which path?" },
    ];

    await tutor.restore(records);
    session.promptResponses.push("Use `.tmp`." );
    await expect(tutor.reply({ lessonId: "lesson", blockId: "block", learnerMessage: records[1] as any })).resolves.toBe("Use `.tmp`.");

    expect(requests).toHaveLength(1);
    expect(requests[0].history).toEqual({
      turns: [
        { sourceEventId: "1", role: "assistant", text: "## Course note\n\nUse `.tmp`." },
        { sourceEventId: "2", role: "user", text: "Which path?" },
      ]
    });
    expect(session.calls).toEqual(["prompt"]);
  });

  it("serializes reviews and compaction while logging compaction failures", async () => {
    const session = new FakeSession();
    const logs = logger();
    const tutor = new RestrictedWorkbookTutor({ workspace: "/tmp/workbook", log: logs.log, sessionFactory: async () => session });

    session.compactError = new Error("provider rejected compaction");
    const first = tutor.review({ attempt: attempt("a-1", "terminal"), privateGuidance: "Review terminal evidence." });
    const compact = tutor.compactAfterBlock();
    const second = tutor.review({ attempt: attempt("a-2", "reflection"), privateGuidance: "Review reflection." });

    await expect(Promise.all([first, compact, second])).resolves.toEqual([
      { accepted: false, feedback: "Needs one more concrete detail." },
      undefined,
      { accepted: false, feedback: "Needs one more concrete detail." },
    ]);
    expect(session.calls).toEqual(["review", "compaction", "review"]);
    expect(logs.errors.join("\n")).toContain("provider rejected compaction");
  });
});
