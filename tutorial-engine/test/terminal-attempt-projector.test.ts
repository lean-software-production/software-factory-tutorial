import { describe, expect, it } from "vitest";
import { projectTerminalAttempts } from "../src/workbook/terminal-attempt-projector.js";
import type { TerminalEvidence, TerminalEvidenceReader } from "../src/workbook/terminal-evidence.js";
import type { WorkbookTimelineRecord } from "../src/workbook/timeline.js";

function record(input: Record<string, unknown>, sequence: number): WorkbookTimelineRecord {
  return { ...input, id: `event-${sequence}`, sequence, at: "2026-08-28T00:00:00.000Z" } as WorkbookTimelineRecord;
}
function reader(entries: Record<string, TerminalEvidence>): TerminalEvidenceReader { return (ref) => entries[ref]; }
const finalEvidence = { finished: { kind: "finished" as const, command: "npm test", interactions: [], exitStatus: 0 } };

function submitted(attemptId = "attempt-1", session = "terminal-1", sequence = 1) {
  return record({ type: "terminal-command-submitted", attemptId, lessonId: "lesson", blockId: "block", command: "npm test", terminalSessionId: session }, sequence);
}
function finished(attemptId = "attempt-1", sequence = 2) { return record({ type: "terminal-command-finished", attemptId, exitStatus: 0, evidenceRef: "finished" }, sequence); }
function reviewRequested(requestId = "request-1", sequence = 3, attemptId = "attempt-1", mode = "automatic", callNumber = 1) {
  return record({ type: "terminal-review-requested", attemptId, lessonId: "lesson", blockId: "block", evidenceRef: "finished", requestId, mode, callNumber }, sequence);
}
function reviewFailed(requestId = "request-1", failureId = "failure-1", sequence = 4, attemptId = "attempt-1", publicMessage = "Review is temporarily unavailable. You can retry the review without rerunning the command.") {
  return record({ type: "terminal-review-failed", attemptId, lessonId: "lesson", blockId: "block", evidenceRef: "finished", requestId, failureId, publicMessage }, sequence);
}

describe("projectTerminalAttempts", () => {
  it("projects direct terminal review states without private fields or legacy handoff requirements", () => {
    const events: WorkbookTimelineRecord[] = [submitted()];
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "running" });

    events.push(finished());
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "checking" });

    const feedbackEvents = [...events, reviewRequested(), record({ type: "terminal-feedback-recorded", attemptId: "attempt-1", text: "Fix the path." }, 4)];
    const feedback = projectTerminalAttempts(feedbackEvents, reader(finalEvidence), "terminal-1").get("block");
    expect(feedback).toEqual({ state: "feedback", feedback: "Fix the path." });
    expect(JSON.stringify(feedback)).not.toMatch(/attempt|command|evidence|rubric|handoff|request/i);

    events.push(reviewRequested());
    events.push(record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "attempt-1", version: 1, kind: "terminal", summary: "Accepted directly." }, 4));
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "complete", successMessage: "Accepted directly." });
  });

  it("projects retryable review infrastructure failure and returns to checking when the same evidence is retried", () => {
    const failedEvents: WorkbookTimelineRecord[] = [submitted(), finished(), reviewRequested("request-1", 3), reviewFailed("request-1", "failure-1", 4)];
    expect(projectTerminalAttempts(failedEvents, reader(finalEvidence), "terminal-1").get("block")).toEqual({
      state: "feedback",
      feedback: "Review is temporarily unavailable. You can retry the review without rerunning the command.",
      retryFailureId: "failure-1",
    });

    const retrying = [...failedEvents, reviewRequested("request-2", 5, "attempt-1", "manual")];
    expect(projectTerminalAttempts(retrying, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "checking" });

    retrying.push(record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "attempt-1", version: 1, kind: "terminal", summary: "Accepted after retry." }, 6));
    expect(projectTerminalAttempts(retrying, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "complete", successMessage: "Accepted after retry." });
  });

  it("does not expose another retry entitlement after the one manual review-only call fails", () => {
    const exhaustedEvents: WorkbookTimelineRecord[] = [
      submitted(),
      finished(),
      reviewRequested("automatic-1", 3, "attempt-1", "automatic", 1),
      reviewRequested("automatic-2", 4, "attempt-1", "automatic", 2),
      reviewFailed("automatic-2", "retryable-failure", 5),
      reviewRequested("manual-3", 6, "attempt-1", "manual", 3),
      reviewFailed("manual-3", "hidden-final-failure", 7, "attempt-1", "Review is temporarily unavailable. Please try another attempt in a moment."),
    ];

    expect(projectTerminalAttempts(exhaustedEvents, reader(finalEvidence), "terminal-1").get("block")).toEqual({
      state: "feedback",
      feedback: "Review is temporarily unavailable. Please try another attempt in a moment.",
    });
  });

  it("does not project feedback, failure, or acceptance before valid Bash-finished evidence", () => {
    const events: WorkbookTimelineRecord[] = [
      submitted(),
      reviewRequested("too-early", 2),
      record({ type: "terminal-feedback-recorded", attemptId: "attempt-1", text: "Too early." }, 3),
      reviewFailed("too-early", "failure-too-early", 4),
      record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "attempt-1", version: 1, kind: "terminal", summary: "Too early." }, 5),
    ];
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "running" });
  });

  it("continues to read legacy terminal-coach handoffs for old accepted sessions", () => {
    const completed = [
      submitted("old", "before-restart"),
      finished("old"),
      record({ type: "terminal-coach-handoff-recorded", attemptId: "old", outcome: "ready", text: "Ready for Main Tutor review." }, 3),
      record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "old", version: 1, kind: "terminal", summary: "Already accepted." }, 4),
    ];
    expect(projectTerminalAttempts(completed, reader(finalEvidence), "after-restart").get("block")).toEqual({ state: "complete", successMessage: "Already accepted." });
  });

  it("drops stale model output when a newer Bash command is current", () => {
    const events: WorkbookTimelineRecord[] = [
      submitted("old"),
      finished("old"),
      reviewRequested("old-request", 3, "old"),
      record({ type: "terminal-feedback-recorded", attemptId: "old", text: "Old model result." }, 4),
      submitted("new", "terminal-1", 5),
      reviewRequested("new-too-early", 6, "new"),
      record({ type: "terminal-feedback-recorded", attemptId: "new", text: "Too early." }, 7),
    ];
    expect(projectTerminalAttempts(events, reader(finalEvidence), "terminal-1").get("block")).toEqual({ state: "running" });
  });

  it("reopens an unfinished prior terminal session idle while preserving completed direct work", () => {
    expect(projectTerminalAttempts([submitted("old", "before-restart")], reader(finalEvidence), "after-restart").get("block")).toBeUndefined();

    const completed = [
      submitted("old", "before-restart"),
      finished("old"),
      reviewRequested("old-request", 3, "old"),
      record({ type: "attempt_accepted", lessonId: "lesson", blockId: "block", attemptId: "old", version: 1, kind: "terminal", summary: "Already accepted." }, 4),
    ];
    expect(projectTerminalAttempts(completed, reader(finalEvidence), "after-restart").get("block")).toEqual({ state: "complete", successMessage: "Already accepted." });
  });
});
