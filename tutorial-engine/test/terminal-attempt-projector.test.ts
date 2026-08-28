import { describe, expect, it } from "vitest";
import { projectTerminalAttempts } from "../src/workbook/terminal-attempt-projector.js";
import type { TerminalEvidence, TerminalEvidenceReader } from "../src/workbook/terminal-evidence.js";
import type { TerminalLifecycleInput, WorkbookTimelineRecord, WorkbookWorkflowInput } from "../src/workbook/timeline.js";

function record(input: TerminalLifecycleInput | WorkbookWorkflowInput, sequence: number): WorkbookTimelineRecord {
  return { ...input, id: `event-${sequence}`, sequence, at: "2026-08-21T00:00:00.000Z" };
}

function reader(entries: Record<string, TerminalEvidence>): TerminalEvidenceReader {
  return (evidenceRef) => entries[evidenceRef];
}

describe("projectTerminalAttempts", () => {
  it("projects ordered lifecycle records and lets a result supersede preliminary and interim coaching", () => {
    const evidence = reader({
      checkpoint: { kind: "running", command: "npm test", interactions: [{ kind: "output", data: "PASS" }] },
      finished: { kind: "finished", command: "npm test", interactions: [{ kind: "output", data: "PASS" }], exitStatus: 0 },
    });
    const events: WorkbookTimelineRecord[] = [
      record({ type: "terminal-command-submitted", attemptId: "attempt-1", lessonId: "lesson-1", blockId: "block-1", command: "npm test", terminalSessionId: "terminal-1" }, 1),
      record({ type: "preliminary-coaching-received", attemptId: "attempt-1", outcome: "wait-for-result" }, 2),
    ];

    expect(projectTerminalAttempts(events, evidence).get("block-1")).toMatchObject({ state: "submitted" });

    events.push(record({ type: "terminal-output-settled", attemptId: "attempt-1", checkpointId: "checkpoint-1", evidenceRef: "checkpoint" }, 3));
    expect(projectTerminalAttempts(events, evidence).get("block-1")).toMatchObject({ state: "running" });

    events.push(record({ type: "interim-coaching-received", attemptId: "attempt-1", checkpointId: "checkpoint-1", outcome: "feedback", text: "The test is still running." }, 4));
    expect(projectTerminalAttempts(events, evidence).get("block-1")).toMatchObject({ state: "interim-feedback", feedback: { text: "The test is still running." } });

    events.push(record({ type: "terminal-command-finished", attemptId: "attempt-1", exitStatus: 0, evidenceRef: "finished" }, 5));
    expect(projectTerminalAttempts(events, evidence).get("block-1")).toMatchObject({ state: "reviewing-result" });

    events.push(record({ type: "result-coaching-received", attemptId: "attempt-1", outcome: "feedback", text: "The command failed." }, 6));
    const projected = projectTerminalAttempts(events, evidence).get("block-1");
    expect(projected).toEqual({
      attemptId: "attempt-1",
      lessonId: "lesson-1",
      blockId: "block-1",
      state: "final-feedback",
      feedback: { outcome: "feedback", text: "The command failed." },
    });
    expect(JSON.stringify(projected)).not.toContain("checkpoint");
    expect(JSON.stringify(projected)).not.toContain("finished");
  });

  it("projects a completed ready result as awaiting Main Tutor confirmation", () => {
    const evidence = reader({ finished: { kind: "finished", command: "npm test", interactions: [], exitStatus: 0 } });
    const events: WorkbookTimelineRecord[] = [
      record({ type: "terminal-command-submitted", attemptId: "attempt-1", lessonId: "lesson-1", blockId: "block-1", command: "npm test", terminalSessionId: "terminal-1" }, 1),
      record({ type: "terminal-command-finished", attemptId: "attempt-1", exitStatus: 0, evidenceRef: "finished" }, 2),
      record({ type: "result-coaching-received", attemptId: "attempt-1", outcome: "ready", text: "Ready for review." }, 3),
    ];

    expect(projectTerminalAttempts(events, evidence).get("block-1")).toMatchObject({
      state: "awaiting-confirmation",
      feedback: { outcome: "ready", text: "Ready for review." },
    });
  });

  it("projects a Main Tutor acceptance from the durable checkpoint after a ready handoff", () => {
    const evidence = reader({ finished: { kind: "finished", command: "npm test", interactions: [], exitStatus: 0 } });
    const events: WorkbookTimelineRecord[] = [
      record({ type: "terminal-command-submitted", attemptId: "attempt-1", lessonId: "lesson-1", blockId: "block-1", command: "npm test", terminalSessionId: "terminal-1" }, 1),
      record({ type: "terminal-command-finished", attemptId: "attempt-1", exitStatus: 0, evidenceRef: "finished" }, 2),
      record({ type: "result-coaching-received", attemptId: "attempt-1", outcome: "ready", text: "Ready for confirmation." }, 3),
      record({ type: "attempt_accepted", lessonId: "lesson-1", blockId: "block-1", attemptId: "attempt-1", version: 1, kind: "terminal", summary: "Confirmed by the Main Tutor." }, 4),
    ];

    expect(projectTerminalAttempts(events, evidence).get("block-1")).toEqual({
      attemptId: "attempt-1",
      lessonId: "lesson-1",
      blockId: "block-1",
      state: "accepted",
      successMessage: "Confirmed by the Main Tutor.",
    });
  });

  it("turns a final wait-for-result outcome into visible feedback", () => {
    const evidence = reader({ finished: { kind: "finished", command: "npm test", interactions: [], exitStatus: 0 } });
    const events: WorkbookTimelineRecord[] = [
      record({ type: "terminal-command-submitted", attemptId: "attempt-1", lessonId: "lesson-1", blockId: "block-1", command: "npm test", terminalSessionId: "terminal-1" }, 1),
      record({ type: "terminal-command-finished", attemptId: "attempt-1", exitStatus: 0, evidenceRef: "finished" }, 2),
      record({ type: "result-coaching-received", attemptId: "attempt-1", outcome: "wait-for-result" }, 3),
    ];

    expect(projectTerminalAttempts(events, evidence).get("block-1")).toEqual({
      attemptId: "attempt-1",
      lessonId: "lesson-1",
      blockId: "block-1",
      state: "final-feedback",
      feedback: {
        outcome: "feedback",
        text: "The command finished without showing the expected result. Run another command and try again."
      },
    });
  });

  it("ignores stale coaching for unknown attempts, unknown checkpoints, and superseded attempts", () => {
    const evidence = reader({
      checkpoint: { kind: "running", command: "npm test", interactions: [] },
      finished: { kind: "finished", command: "npm test", interactions: [], exitStatus: 0 },
    });
    const events: WorkbookTimelineRecord[] = [
      record({ type: "preliminary-coaching-received", attemptId: "missing", outcome: "feedback", text: "Ignore me" }, 1),
      record({ type: "terminal-command-submitted", attemptId: "attempt-1", lessonId: "lesson-1", blockId: "block-1", command: "npm test", terminalSessionId: "terminal-1" }, 2),
      record({ type: "interim-coaching-received", attemptId: "attempt-1", checkpointId: "unknown", outcome: "feedback", text: "Stale checkpoint" }, 3),
      record({ type: "interim-coaching-received", attemptId: "missing", checkpointId: "unknown", outcome: "feedback", text: "Unknown attempt" }, 4),
      record({ type: "terminal-output-settled", attemptId: "attempt-1", checkpointId: "checkpoint-1", evidenceRef: "checkpoint" }, 5),
      record({ type: "terminal-command-finished", attemptId: "attempt-1", exitStatus: 0, evidenceRef: "finished" }, 6),
      record({ type: "result-coaching-received", attemptId: "attempt-1", outcome: "feedback", text: "Old result" }, 7),
      record({ type: "terminal-command-submitted", attemptId: "attempt-2", lessonId: "lesson-1", blockId: "block-1", command: "npm test -- --run", terminalSessionId: "terminal-2" }, 8),
      record({ type: "result-coaching-received", attemptId: "attempt-2", outcome: "feedback", text: "Result before finish" }, 9),
    ];

    expect(projectTerminalAttempts(events, evidence).get("block-1")).toEqual({
      attemptId: "attempt-2",
      lessonId: "lesson-1",
      blockId: "block-1",
      state: "submitted",
    });
  });
});
