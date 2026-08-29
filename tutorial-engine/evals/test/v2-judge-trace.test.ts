import { describe, expect, it } from "vitest";
import type { WorkbookTimelineRecord } from "../../src/workbook/timeline.js";
import { buildV2JudgePrompt, createV2Report, enumerateTraceCitations, verifyV2JudgeResult } from "../v2/judge.js";
import { findV2Scenario } from "../v2/scenarios.js";
import { createEmptyV2SessionTrace, projectV2JudgeTrace } from "../v2/session.js";

const lessonId = "001-live-session";

function record(event: Record<string, unknown>): WorkbookTimelineRecord {
  return { id: "raw-id", sequence: 1, at: "2026-08-20T00:00:00.000Z", ...event } as WorkbookTimelineRecord;
}

describe("v2 public judge trace projection", () => {
  it("drops every private terminal lifecycle variant from trace, prompt, and report", () => {
    const trace = createEmptyV2SessionTrace("v2-exact-command-success");
    trace.publicStates.push({ label: "public", state: { progress: { activeBlockId: "exact-command" } } });
    trace.events.push(
      record({ type: "terminal-command-submitted", attemptId: "attempt-command-secret", lessonId, blockId: "exact-command", command: "echo command-secret", terminalSessionId: "terminal-session-secret" }),
      record({ type: "terminal-command-finished", attemptId: "attempt-finished-secret", exitStatus: 0, evidenceRef: "evidence-ref-secret" }),
      record({ type: "terminal-transcript-snapshotted", attemptId: "attempt-transcript-secret", lessonId, blockId: "exact-command", transcript: "transcript-secret" }),
      record({ type: "terminal-feedback-recorded", attemptId: "attempt-feedback-secret", text: "feedback-secret" }),
      record({ type: "terminal-coach-handoff-recorded", attemptId: "attempt-handoff-secret", outcome: "interesting", text: "coach-handoff-text-secret" }),
      record({ type: "attempt_accepted", lessonId, blockId: "exact-command", attemptId: "attempt-accepted-secret", version: 1, kind: "terminal", summary: "accepted-summary-secret" })
    );
    trace.artifacts.push({ path: "factory/.tmp/evaluator-command.txt", content: "public artifact\n" });

    const judgeTrace = projectV2JudgeTrace(trace);
    const scenario = findV2Scenario(trace.scenarioId);
    const gate = { passed: true, assertions: [] };
    const prompt = buildV2JudgePrompt(scenario, judgeTrace, gate);
    const judge = verifyV2JudgeResult({
      dimensions: {
        protocolUse: { score: 2, citations: [0], rationale: "public state" },
        tutorQuality: { score: 2, citations: [1], rationale: "public progression" },
        criteriaFit: { score: 2, citations: [2], rationale: "public artifact" }
      },
      summary: "ok"
    }, judgeTrace);
    const report = createV2Report({ scenario, trace: judgeTrace, gate, judgeInput: prompt, judge, tutorModel: "tutor", judgeModel: "judge" });

    expect(judgeTrace.progressionEvents).toEqual([{ type: "attempt_accepted", lessonId, blockId: "exact-command", kind: "terminal" }]);
    expect(judgeTrace).not.toHaveProperty("events");
    expect(report.trace).not.toHaveProperty("events");

    const publicSerializations = [JSON.stringify(judgeTrace), prompt, JSON.stringify(report)];
    for (const serialized of publicSerializations) {
      expect(serialized).not.toContain("terminal-command-submitted");
      expect(serialized).not.toContain("terminal-command-finished");
      expect(serialized).not.toContain("terminal-transcript-snapshotted");
      expect(serialized).not.toContain("terminal-feedback-recorded");
      expect(serialized).not.toContain("terminal-coach-handoff-recorded");
      expect(serialized).not.toContain("attempt-command-secret");
      expect(serialized).not.toContain("attempt-finished-secret");
      expect(serialized).not.toContain("attempt-transcript-secret");
      expect(serialized).not.toContain("attempt-feedback-secret");
      expect(serialized).not.toContain("attempt-handoff-secret");
      expect(serialized).not.toContain("attempt-accepted-secret");
      expect(serialized).not.toContain("terminal-session-secret");
      expect(serialized).not.toContain("evidence-ref-secret");
      expect(serialized).not.toContain("transcript-secret");
      expect(serialized).not.toContain("feedback-secret");
      expect(serialized).not.toContain("coach-handoff-text-secret");
      expect(serialized).not.toContain("accepted-summary-secret");
      expect(serialized).not.toContain("interesting");
    }
  });

  it("drops unknown future events and reconstructs allowlisted events without private extras", () => {
    const trace = createEmptyV2SessionTrace("projection");
    trace.events.push(
      record({ type: "future_private_event", lessonId, blockId: "exact-command", text: "future-event-secret" }),
      record({
        type: "block_completed",
        lessonId,
        blockId: "exact-command",
        response: "response-secret",
        summary: "summary-secret",
        path: "path-secret",
        terminalHtml: "html-secret",
        attemptId: "attempt-secret",
        evidenceRef: "evidence-secret",
        tutor: "private tutor field"
      })
    );

    const judgeTrace = projectV2JudgeTrace(trace);

    expect(judgeTrace.progressionEvents).toEqual([{ type: "block_completed", lessonId, blockId: "exact-command" }]);
    expect(JSON.stringify(trace.events)).toContain("future-event-secret");
    expect(JSON.stringify(trace.events)).toContain("private tutor field");
    expect(JSON.stringify(judgeTrace)).not.toContain("future-event-secret");
    expect(JSON.stringify(judgeTrace)).not.toContain("response-secret");
    expect(JSON.stringify(judgeTrace)).not.toContain("summary-secret");
    expect(JSON.stringify(judgeTrace)).not.toContain("path-secret");
    expect(JSON.stringify(judgeTrace)).not.toContain("html-secret");
    expect(JSON.stringify(judgeTrace)).not.toContain("attempt-secret");
    expect(JSON.stringify(judgeTrace)).not.toContain("evidence-secret");
    expect(JSON.stringify(judgeTrace)).not.toContain("private tutor field");
  });

  it("drops malformed known progression events before trace, prompt, and report serialization", () => {
    const trace = createEmptyV2SessionTrace("v2-exact-command-success");
    trace.publicStates.push({ label: "public", state: { progress: { activeBlockId: "exact-command" } } });
    trace.events.push(
      record({ type: "attempt_accepted", lessonId, blockId: "exact-command", kind: "terminal" }),
      record({ type: "attempt_accepted", lessonId, blockId: "exact-command", kind: "not-public-kind", attemptId: "invalid-kind-secret" }) as WorkbookTimelineRecord,
      record({ type: "block_completed", lessonId: { secret: "object-lesson-secret" }, blockId: "exact-command" }) as WorkbookTimelineRecord,
      record({ type: "reflection_submitted", lessonId, blockId: ["array-block-secret"], response: "response-secret" }) as WorkbookTimelineRecord,
      record({ type: "lesson_jump_started", lessonId: ["array-lesson-secret"] }) as WorkbookTimelineRecord,
      record({ type: "message", lessonId, blockId: "exact-command", text: "message-secret", role: "assistant", source: "main_tutor", presentation: "chat" }),
      record({ type: "tutor_failed", lessonId, blockId: "exact-command", requestId: "request-secret", operation: "reply", publicMessage: "failure-secret" }),
      record({ type: "block_summarized", lessonId, blockId: "exact-command", text: "block-summary-secret", coveredThroughId: "covered-block-secret" }),
      record({ type: "lesson_summarized", lessonId, text: "lesson-summary-secret", coveredThroughId: "covered-lesson-secret" }),
      record({ type: "workbook_completion_summary", text: "completion-secret" })
    );

    const judgeTrace = projectV2JudgeTrace(trace);
    const scenario = findV2Scenario(trace.scenarioId);
    const gate = { passed: true, assertions: [] };
    const prompt = buildV2JudgePrompt(scenario, judgeTrace, gate);
    const judge = verifyV2JudgeResult({
      dimensions: {
        protocolUse: { score: 2, citations: [0], rationale: "public state" },
        tutorQuality: { score: 2, citations: [1], rationale: "valid event" },
        criteriaFit: { score: 2, citations: [0, 1], rationale: "both" }
      },
      summary: "ok"
    }, judgeTrace);
    const report = createV2Report({ scenario, trace: judgeTrace, gate, judgeInput: prompt, judge, tutorModel: "tutor", judgeModel: "judge" });

    expect(judgeTrace.progressionEvents).toEqual([{ type: "attempt_accepted", lessonId, blockId: "exact-command", kind: "terminal" }]);
    expect(report.scenario).not.toHaveProperty("actions");
    for (const serialized of [JSON.stringify(judgeTrace), prompt, JSON.stringify(report)]) {
      expect(serialized).not.toContain("invalid-kind-secret");
      expect(serialized).not.toContain("object-lesson-secret");
      expect(serialized).not.toContain("array-block-secret");
      expect(serialized).not.toContain("array-lesson-secret");
      expect(serialized).not.toContain("message-secret");
      expect(serialized).not.toContain("request-secret");
      expect(serialized).not.toContain("failure-secret");
      expect(serialized).not.toContain("block-summary-secret");
      expect(serialized).not.toContain("covered-block-secret");
      expect(serialized).not.toContain("lesson-summary-secret");
      expect(serialized).not.toContain("covered-lesson-secret");
      expect(serialized).not.toContain("completion-secret");
    }
  });

  it("defensively rebuilds exported prompt and report traces without injected extras or judge-channel timestamps", () => {
    const unsafeTrace = {
      scenarioId: "v2-exact-command-success",
      events: [{ type: "terminal-command-submitted", attemptId: "top-level-events-secret" }],
      publicStates: [{
        label: "browser-public",
        state: {
          customPublicEvidence: { kept: true },
          timeline: [{ id: "public-message-id", at: "public-state-at", text: "browser-public-message" }]
        },
        extra: "public-state-extra-secret"
      }],
      terminalTranscript: [{ blockId: "exact-command", direction: "input", text: "echo ok", at: "terminal-at-secret", html: "terminal-extra-secret" }],
      reflections: [{ blockId: "reflection", role: "learner", text: "learner text", at: "reflection-at-secret", extra: "reflection-extra-secret" }],
      editors: [{ blockId: "editor", revision: 1, status: "feedback", feedback: "revise", at: "editor-at-secret", patch: "editor-extra-secret" }],
      progressionEvents: [{ type: "block_completed", lessonId, blockId: "exact-command", attemptId: "progression-extra-secret", at: "progression-at-secret" }],
      artifacts: [{ path: "factory/.tmp/public.txt", content: "artifact public", at: "artifact-at-secret", extra: "artifact-extra-secret" }]
    } as unknown as ReturnType<typeof projectV2JudgeTrace>;
    const scenario = findV2Scenario("v2-exact-command-success");
    const gate = { passed: true, assertions: [] };

    const citations = enumerateTraceCitations(unsafeTrace);
    const prompt = buildV2JudgePrompt(scenario, unsafeTrace, gate);
    const judge = verifyV2JudgeResult({
      dimensions: {
        protocolUse: { score: 2, citations: [0], rationale: "public state" },
        tutorQuality: { score: 2, citations: [1, 2, 3], rationale: "turns" },
        criteriaFit: { score: 2, citations: [4, 5], rationale: "progress and artifact" }
      },
      summary: "ok"
    }, unsafeTrace);
    const report = createV2Report({ scenario, trace: unsafeTrace, gate, judgeInput: "raw prompt secret top-level-events-secret", judge, tutorModel: "tutor", judgeModel: "judge" });

    expect(citations).toHaveLength(6);
    expect(citations[0]).toEqual({
      id: 0,
      kind: "publicState",
      value: { label: "browser-public", state: { customPublicEvidence: { kept: true }, timeline: [{ id: "public-message-id", at: "public-state-at", text: "browser-public-message" }] } }
    });
    expect(report.trace).not.toHaveProperty("events");
    expect(report.trace.terminalTranscript[0]).not.toHaveProperty("at");
    expect(report.trace.reflections[0]).not.toHaveProperty("at");
    expect(report.trace.editors[0]).not.toHaveProperty("at");
    expect(report.trace.progressionEvents[0]).not.toHaveProperty("at");
    expect(report.trace.artifacts[0]).not.toHaveProperty("at");
    expect(report.trace.publicStates[0]?.state).toHaveProperty("customPublicEvidence");
    expect(JSON.stringify(report.trace.publicStates[0]?.state)).toContain("public-state-at");
    expect(prompt).toContain("customPublicEvidence");
    expect(prompt).toContain("public-state-at");
    expect(report.judgeInput).toEqual({ prompt });
    expect(report.scenario).not.toHaveProperty("actions");
    for (const serialized of [JSON.stringify(citations), prompt, JSON.stringify(report)]) {
      expect(serialized).not.toContain("raw prompt secret");
      expect(serialized).not.toContain("top-level-events-secret");
      expect(serialized).not.toContain("public-state-extra-secret");
      expect(serialized).not.toContain("terminal-at-secret");
      expect(serialized).not.toContain("terminal-extra-secret");
      expect(serialized).not.toContain("reflection-at-secret");
      expect(serialized).not.toContain("reflection-extra-secret");
      expect(serialized).not.toContain("editor-at-secret");
      expect(serialized).not.toContain("editor-extra-secret");
      expect(serialized).not.toContain("progression-extra-secret");
      expect(serialized).not.toContain("progression-at-secret");
      expect(serialized).not.toContain("artifact-at-secret");
      expect(serialized).not.toContain("artifact-extra-secret");
    }
  });

  it("fails closed on invalid top-level judge traces with a sanitized message", () => {
    const scenario = findV2Scenario("v2-exact-command-success");
    expect(() => buildV2JudgePrompt(scenario, { scenarioId: "x", publicStates: [] } as unknown as ReturnType<typeof projectV2JudgeTrace>, { passed: true, assertions: [] })).toThrow("Invalid public judge trace.");
  });

  it("keeps whole browser-public states but rejects private tutor state", () => {
    const trace = createEmptyV2SessionTrace("v2-exact-command-success");
    trace.publicStates.push({
      label: "state",
      state: {
        arbitraryPublicField: { nested: ["kept"] },
        timeline: [{ type: "message", id: "public-id", at: "public-at", text: "public tutor failure shown to learner" }]
      }
    });

    const judgeTrace = projectV2JudgeTrace(trace);

    expect(judgeTrace.publicStates[0]?.state).toEqual({
      arbitraryPublicField: { nested: ["kept"] },
      timeline: [{ type: "message", id: "public-id", at: "public-at", text: "public tutor failure shown to learner" }]
    });
    trace.publicStates.push({ label: "private", state: { tutor: { text: "private" } } });
    expect(() => projectV2JudgeTrace(trace)).toThrow(/private tutor field/i);
  });

  it("validates judge citations against projected citation IDs only", () => {
    const trace = createEmptyV2SessionTrace("citations");
    trace.publicStates.push({ label: "public", state: { progress: { activeBlockId: "exact-command" } } });
    trace.events.push(
      record({ type: "terminal-command-submitted", attemptId: "attempt-secret", lessonId, blockId: "exact-command", command: "echo secret", terminalSessionId: "session-secret" }),
      record({ type: "terminal-command-finished", attemptId: "attempt-secret", exitStatus: 0, evidenceRef: "evidence-secret" }),
      record({ type: "terminal-feedback-recorded", attemptId: "attempt-secret", text: "feedback-secret" }),
      record({ type: "terminal-coach-handoff-recorded", attemptId: "attempt-secret", outcome: "ready", text: "handoff-secret" }),
      record({ type: "block_completed", lessonId, blockId: "exact-command" })
    );
    const judgeTrace = projectV2JudgeTrace(trace);
    const projectedIds = enumerateTraceCitations(judgeTrace).map((citation) => citation.id);

    expect(projectedIds).toEqual([0, 1]);
    expect(trace.events).toHaveLength(5);
    expect(verifyV2JudgeResult({
      dimensions: {
        protocolUse: { score: 2, citations: [0], rationale: "public state" },
        tutorQuality: { score: 2, citations: [1], rationale: "public event" },
        criteriaFit: { score: 2, citations: [0, 1], rationale: "both" }
      },
      summary: "ok"
    }, judgeTrace).summary).toBe("ok");
    expect(() => verifyV2JudgeResult({
      dimensions: {
        protocolUse: { score: 2, citations: [4], rationale: "would have been inside the old raw event count" },
        tutorQuality: { score: 2, citations: [1], rationale: "public event" },
        criteriaFit: { score: 2, citations: [0], rationale: "public state" }
      },
      summary: "bad"
    }, judgeTrace)).toThrow(/unknown trace citation/i);
  });
});
