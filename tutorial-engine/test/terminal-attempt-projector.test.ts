import { describe, expect, it } from "vitest";
import { projectTerminalAttempts } from "../src/workbook/terminal-attempt-projector.js";
import type { TerminalEvidence, TerminalEvidenceReader } from "../src/workbook/terminal-evidence.js";
import type { TerminalLifecycleInput, WorkbookTimelineRecord, WorkbookWorkflowInput } from "../src/workbook/timeline.js";

function record(input: TerminalLifecycleInput | WorkbookWorkflowInput, sequence: number): WorkbookTimelineRecord {
  return { ...input, id: `event-${sequence}`, sequence, at: "2026-08-28T00:00:00.000Z" };
}
function reader(entries: Record<string, TerminalEvidence>): TerminalEvidenceReader { return (ref) => entries[ref]; }
const finalEvidence = { finished: { kind: "finished" as const, command: "npm test", interactions: [], exitStatus: 0 } };

function submitted(attemptId = "attempt-1", session = "terminal-1") {
  return record({ type: "terminal-command-submitted", attemptId, lessonId: "lesson", blockId: "block", command: "npm test", terminalSessionId: session }, 1);
}
function finished(attemptId = "attempt-1") { return record({ type: "terminal-command-finished", attemptId, exitStatus: 0, evidenceRef: "finished" }, 2); }

describe("projectTerminalAttempts", () => {
  it("projects only running, checking, feedback, and complete without private fields", () => {
    const events: WorkbookTimelineRecord[] = [submitted()];
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "running", revision: 1 });

    events.push(finished());
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "checking", revision: 1 });

    const feedbackEvents = [...events, record({ type: "terminal-feedback-recorded", attemptId: "attempt-1", text: "Fix the path." }, 3)];
    const feedback = projectTerminalAttempts(feedbackEvents, reader(finalEvidence), "terminal-1").get("block");
    expect(feedback).toEqual({ state: "feedback", revision: 1, feedback: "Fix the path." });
    expect(JSON.stringify(feedback)).not.toMatch(/attempt-1|npm test|evidence|rubric|handoff/i);

    events.push(record({ type: "terminal-coach-handoff-recorded", attemptId: "attempt-1", outcome: "ready", text: "Ready for Main Tutor review." }, 3));
    events.push(record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "attempt-1", version: 1, kind: "terminal", summary: "Accepted." }, 4));
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "complete", revision: 1, successMessage: "Accepted." });
  });

  it("does not project feedback or acceptance before valid Bash-finished evidence", () => {
    const events: WorkbookTimelineRecord[] = [
      submitted(),
      record({ type: "terminal-feedback-recorded", attemptId: "attempt-1", text: "Too early." }, 2),
      record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "attempt-1", version: 1, kind: "terminal", summary: "Too early." }, 3),
    ];
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "running", revision: 1 });
  });

  it("requires a prior positive Coach handoff and no final feedback before terminal acceptance can complete", () => {
    const events: WorkbookTimelineRecord[] = [
      submitted(),
      finished(),
      record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "attempt-1", version: 1, kind: "terminal", summary: "Malformed direct acceptance." }, 3),
    ];

    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "checking", revision: 1 });

    events.push(record({ type: "terminal-coach-handoff-recorded", attemptId: "attempt-1", outcome: "interesting", text: "Worth Main Tutor review." }, 4));
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "checking", revision: 1 });

    events.push(record({ type: "terminal-feedback-recorded", attemptId: "attempt-1", text: "Review is temporarily unavailable. Run the command again." }, 5));
    events.push(record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "attempt-1", version: 1, kind: "terminal", summary: "Late acceptance after feedback." }, 6));
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "feedback", revision: 1, feedback: "Review is temporarily unavailable. Run the command again." });

    const acceptedEvents: WorkbookTimelineRecord[] = [
      submitted(),
      finished(),
      record({ type: "terminal-coach-handoff-recorded", attemptId: "attempt-1", outcome: "interesting", text: "Worth Main Tutor review." }, 3),
      record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "attempt-1", version: 1, kind: "terminal", summary: "Accepted after handoff." }, 4),
    ];
    expect(projectTerminalAttempts(acceptedEvents, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "complete", revision: 1, successMessage: "Accepted after handoff." });
  });

  it("drops stale model output when a newer Bash command is current", () => {
    const events: WorkbookTimelineRecord[] = [
      submitted("old"),
      finished("old"),
      record({ type: "terminal-feedback-recorded", attemptId: "old", text: "Old model result." }, 3),
      submitted("new"),
      record({ type: "terminal-feedback-recorded", attemptId: "new", text: "Too early." }, 5),
    ];
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "running", revision: 2 });
  });

  it("increments a public revision for repeated attempts on the same block", () => {
    const firstAccepted: WorkbookTimelineRecord[] = [
      submitted("attempt-private-1"),
      finished("attempt-private-1"),
      record({ type: "terminal-coach-handoff-recorded", attemptId: "attempt-private-1", outcome: "ready", text: "Private handoff 1." }, 3),
      record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "attempt-private-1", version: 1, kind: "terminal", summary: "Same public result." }, 4),
    ];
    expect(projectTerminalAttempts(firstAccepted, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "complete", revision: 1, successMessage: "Same public result." });

    const repeated: WorkbookTimelineRecord[] = [
      ...firstAccepted,
      record({ type: "terminal-command-submitted", attemptId: "attempt-private-2", lessonId: "lesson", blockId: "block", command: "npm test", terminalSessionId: "terminal-1" }, 5),
      record({ type: "terminal-command-finished", attemptId: "attempt-private-2", exitStatus: 0, evidenceRef: "finished" }, 6),
      record({ type: "terminal-coach-handoff-recorded", attemptId: "attempt-private-2", outcome: "ready", text: "Private handoff 2." }, 7),
      record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "attempt-private-2", version: 2, kind: "terminal", summary: "Same public result." }, 8),
    ];
    const projection = projectTerminalAttempts(repeated, reader(finalEvidence), "terminal-1").get("block");
    expect(projection).toEqual({ state: "complete", revision: 2, successMessage: "Same public result." });
    expect(JSON.stringify(projection)).not.toMatch(/attempt-private|npm test|Private handoff|terminal-1/);
  });

  it("reopens an unfinished prior terminal session idle while preserving completed work", () => {
    expect(projectTerminalAttempts([submitted("old", "before-restart")], reader(finalEvidence), "after-restart").get("block")).toBeUndefined();

    const completed = [
      submitted("old", "before-restart"),
      finished("old"),
      record({ type: "terminal-coach-handoff-recorded", attemptId: "old", outcome: "ready", text: "Ready for Main Tutor review." }, 3),
      record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "old", version: 1, kind: "terminal", summary: "Already accepted." }, 4),
    ];
    expect(projectTerminalAttempts(completed, reader(finalEvidence), "after-restart").get("block")).toEqual({ state: "complete", revision: 1, successMessage: "Already accepted." });
  });
});
