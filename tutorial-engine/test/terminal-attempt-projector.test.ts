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
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "running" });

    events.push(finished());
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "checking" });

    events.push(record({ type: "terminal-feedback-recorded", attemptId: "attempt-1", text: "Fix the path." }, 3));
    const feedback = projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block");
    expect(feedback).toEqual({ state: "feedback", feedback: "Fix the path." });
    expect(JSON.stringify(feedback)).not.toMatch(/attempt|command|evidence|rubric|handoff/i);

    events.push(record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "attempt-1", version: 1, kind: "terminal", summary: "Accepted." }, 4));
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "complete", successMessage: "Accepted." });
  });

  it("does not project feedback or acceptance before valid Bash-finished evidence", () => {
    const events: WorkbookTimelineRecord[] = [
      submitted(),
      record({ type: "terminal-feedback-recorded", attemptId: "attempt-1", text: "Too early." }, 2),
      record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "attempt-1", version: 1, kind: "terminal", summary: "Too early." }, 3),
    ];
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "running" });
  });

  it("drops stale model output when a newer Bash command is current", () => {
    const events: WorkbookTimelineRecord[] = [
      submitted("old"),
      finished("old"),
      record({ type: "terminal-feedback-recorded", attemptId: "old", text: "Old model result." }, 3),
      submitted("new"),
      record({ type: "terminal-feedback-recorded", attemptId: "new", text: "Too early." }, 5),
    ];
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "running" });
  });

  it("reopens an unfinished prior terminal session idle while preserving completed work", () => {
    expect(projectTerminalAttempts([submitted("old", "before-restart")], reader(finalEvidence), "after-restart").get("block")).toBeUndefined();

    const completed = [submitted("old", "before-restart"), finished("old"), record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "old", version: 1, kind: "terminal", summary: "Already accepted." }, 3)];
    expect(projectTerminalAttempts(completed, reader(finalEvidence), "after-restart").get("block")).toEqual({ state: "complete", successMessage: "Already accepted." });
  });
});
