import { describe, expect, it } from "vitest";
import { projectTerminalAttempts } from "../src/workbook/terminal-attempt-projector.js";
import { MAX_TERMINAL_COMMAND_BYTES, type TerminalEvidence } from "../src/workbook/terminal-evidence.js";
import type { WorkbookTimelineRecord } from "../src/workbook/timeline.js";

function record(input: Record<string, unknown>, sequence: number): WorkbookTimelineRecord {
  return { ...input, id: `event-${sequence}`, sequence, at: "2026-08-28T00:00:00.000Z" } as WorkbookTimelineRecord;
}
const finalEvidence: TerminalEvidence = { kind: "finished", command: "npm test", interactions: [], exitStatus: 0 };

function submitted(attemptId = "attempt-1", session = "terminal-1", sequence = 1) {
  return record({ type: "terminal-command-submitted", attemptId, lessonId: "lesson", blockId: "block", command: "npm test", terminalSessionId: session }, sequence);
}
function finished(attemptId = "attempt-1", sequence = 2, evidence: unknown = finalEvidence) { return record({ type: "terminal-command-finished", attemptId, evidence }, sequence); }

describe("projectTerminalAttempts", () => {
  it("projects direct terminal review states with revisions and without private fields", () => {
    const events: WorkbookTimelineRecord[] = [submitted()];
    expect(projectTerminalAttempts(events, "terminal-1").get("block")).toEqual({ state: "running", revision: 1 });

    events.push(finished());
    expect(projectTerminalAttempts(events, "terminal-1").get("block")).toEqual({ state: "checking", revision: 1 });

    const feedbackEvents = [...events, record({ type: "terminal-feedback-recorded", attemptId: "attempt-1", text: "Fix the path." }, 3)];
    const feedback = projectTerminalAttempts(feedbackEvents, "terminal-1").get("block");
    expect(feedback).toEqual({ state: "feedback", revision: 1, feedback: "Fix the path." });
    expect(JSON.stringify(feedback)).not.toMatch(/attempt-1|npm test|evidence|rubric|handoff|request/i);

    events.push(record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "attempt-1", version: 1, kind: "terminal", summary: "Accepted directly." }, 3));
    expect(projectTerminalAttempts(events, "terminal-1").get("block")).toEqual({ state: "complete", revision: 1, successMessage: "Accepted directly." });
  });

  it("does not project feedback or acceptance before valid Bash-finished evidence", () => {
    const events: WorkbookTimelineRecord[] = [
      submitted(),
      record({ type: "terminal-feedback-recorded", attemptId: "attempt-1", text: "Too early." }, 2),
      record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "attempt-1", version: 1, kind: "terminal", summary: "Too early." }, 3),
    ];
    expect(projectTerminalAttempts(events, "terminal-1").get("block")).toEqual({ state: "running", revision: 1 });
  });

  it("ignores malformed or inconsistent inline finished evidence", () => {
    const malformed = [submitted(), finished("attempt-1", 2, { kind: "finished", command: "x".repeat(MAX_TERMINAL_COMMAND_BYTES + 1), interactions: [], exitStatus: 0 })];
    expect(projectTerminalAttempts(malformed, "terminal-1").get("block")).toEqual({ state: "running", revision: 1 });

    const inconsistent = [submitted(), finished("attempt-1", 2, { ...finalEvidence, command: "different command" })];
    expect(projectTerminalAttempts(inconsistent, "terminal-1").get("block")).toEqual({ state: "running", revision: 1 });
  });

  it("drops stale model output when a newer Bash command is current", () => {
    const events: WorkbookTimelineRecord[] = [
      submitted("old"),
      finished("old"),
      record({ type: "terminal-feedback-recorded", attemptId: "old", text: "Old model result." }, 3),
      submitted("new", "terminal-1", 4),
      record({ type: "terminal-feedback-recorded", attemptId: "new", text: "Too early." }, 5),
    ];
    expect(projectTerminalAttempts(events, "terminal-1").get("block")).toEqual({ state: "running", revision: 2 });
  });

  it("increments a public revision for repeated attempts on the same block", () => {
    const firstAccepted: WorkbookTimelineRecord[] = [
      submitted("attempt-private-1"),
      finished("attempt-private-1"),
      record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "attempt-private-1", version: 1, kind: "terminal", summary: "Same public result." }, 3),
    ];
    expect(projectTerminalAttempts(firstAccepted, "terminal-1").get("block")).toEqual({ state: "complete", revision: 1, successMessage: "Same public result." });

    const repeated: WorkbookTimelineRecord[] = [
      ...firstAccepted,
      record({ type: "terminal-command-submitted", attemptId: "attempt-private-2", lessonId: "lesson", blockId: "block", command: "npm test", terminalSessionId: "terminal-1" }, 4),
      record({ type: "terminal-command-finished", attemptId: "attempt-private-2", evidence: finalEvidence }, 5),
      record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "attempt-private-2", version: 2, kind: "terminal", summary: "Same public result." }, 6),
    ];
    const projection = projectTerminalAttempts(repeated, "terminal-1").get("block");
    expect(projection).toEqual({ state: "complete", revision: 2, successMessage: "Same public result." });
    expect(JSON.stringify(projection)).not.toMatch(/attempt-private|request-private|npm test|terminal-1/);
  });

  it("reopens an unfinished prior terminal session idle while preserving completed direct work", () => {
    expect(projectTerminalAttempts([submitted("old", "before-restart")], "after-restart").get("block")).toBeUndefined();

    const completed = [
      submitted("old", "before-restart"),
      finished("old"),
      record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "old", version: 1, kind: "terminal", summary: "Already accepted." }, 3),
    ];
    expect(projectTerminalAttempts(completed, "after-restart").get("block")).toEqual({ state: "complete", revision: 1, successMessage: "Already accepted." });
  });
});
