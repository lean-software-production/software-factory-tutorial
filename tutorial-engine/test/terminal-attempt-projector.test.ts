import { describe, expect, it } from "vitest";
import { projectTerminalAttempts } from "../src/workbook/terminal-attempt-projector.js";
import type { TerminalEvidence, TerminalEvidenceReader } from "../src/workbook/terminal-evidence.js";
import type { TerminalLifecycleInput, WorkbookTimelineRecord } from "../src/workbook/timeline.js";

function record(input: TerminalLifecycleInput, sequence: number): WorkbookTimelineRecord {
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
      record({ type: "preliminary-coaching-received", attemptId: "attempt-1", outcome: "working" }, 2),
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

  it("projects a completed ready result as accepted-ready", () => {
    const evidence = reader({ finished: { kind: "finished", command: "npm test", interactions: [], exitStatus: 0 } });
    const events: WorkbookTimelineRecord[] = [
      record({ type: "terminal-command-submitted", attemptId: "attempt-1", lessonId: "lesson-1", blockId: "block-1", command: "npm test", terminalSessionId: "terminal-1" }, 1),
      record({ type: "terminal-command-finished", attemptId: "attempt-1", exitStatus: 0, evidenceRef: "finished" }, 2),
      record({ type: "result-coaching-received", attemptId: "attempt-1", outcome: "ready", text: "Ready for review." }, 3),
    ];

    expect(projectTerminalAttempts(events, evidence).get("block-1")).toMatchObject({
      state: "accepted-ready",
      feedback: { outcome: "ready", text: "Ready for review." },
    });
  });

  it("turns a final working outcome into visible feedback", () => {
    const evidence = reader({ finished: { kind: "finished", command: "npm test", interactions: [], exitStatus: 0 } });
    const events: WorkbookTimelineRecord[] = [
      record({ type: "terminal-command-submitted", attemptId: "attempt-1", lessonId: "lesson-1", blockId: "block-1", command: "npm test", terminalSessionId: "terminal-1" }, 1),
      record({ type: "terminal-command-finished", attemptId: "attempt-1", exitStatus: 0, evidenceRef: "finished" }, 2),
      record({ type: "result-coaching-received", attemptId: "attempt-1", outcome: "working" }, 3),
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
