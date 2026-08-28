import { describe, expect, it } from "vitest";
import {
  activateTerminalCoachingAttempt,
  createTerminalCoachingDisplayState,
  reduceTerminalCoachingDisplay,
  type TerminalCoachingDisplayEvent,
  type TerminalCoachingDisplayState
} from "../web-workbook/src/terminal-coaching-display.js";

function reduce(events: TerminalCoachingDisplayEvent[], attemptId = "attempt-1"): TerminalCoachingDisplayState {
  return events.reduce(reduceTerminalCoachingDisplay, activateTerminalCoachingAttempt(createTerminalCoachingDisplayState(), attemptId));
}

const submit = (attemptId = "attempt-1"): TerminalCoachingDisplayEvent => ({ type: "command-submitted", attemptId });
const usefulFeedback = (feedback = "Tests are passing.", attemptId = "attempt-1"): TerminalCoachingDisplayEvent => ({
  type: "useful-feedback",
  attemptId,
  feedback
});

describe("terminal coaching display reducer", () => {
  it("keeps the blue field unchanged while typing and shows a subtle listening indicator", () => {
    const beforeTyping = reduce([{ type: "final-feedback", attemptId: "attempt-1", feedback: "Previous feedback" }]);
    const afterTyping = reduceTerminalCoachingDisplay(beforeTyping, { type: "typing", attemptId: "attempt-1" });

    expect(afterTyping.blueField).toBe(beforeTyping.blueField);
    expect(afterTyping.activity).toEqual({ kind: "listening", text: "Listening for a command…", subtle: true });
  });

  it("replaces blue feedback with blue Running when a command is submitted", () => {
    const state = reduce([{ type: "final-feedback", attemptId: "attempt-1", feedback: "Previous feedback" }, submit()]);

    expect(state.blueField).toEqual({ kind: "running", text: "Running" });
    expect(state.activity).toEqual({ kind: "running", text: "Running", subtle: true });
  });

  it("shows preliminary useful feedback while retaining smaller running activity", () => {
    const state = reduce([submit(), usefulFeedback("The script wrote the evidence file.")]);

    expect(state.blueField).toEqual({
      kind: "feedback",
      text: "The script wrote the evidence file.",
      provisional: true,
      accepted: false
    });
    expect(state.activity).toEqual({ kind: "running", text: "Running", subtle: true });
  });

  it("retains provisional feedback when fresh command output arrives", () => {
    const beforeOutput = reduce([submit(), usefulFeedback()]);
    const afterOutput = reduceTerminalCoachingDisplay(beforeOutput, { type: "command-output", attemptId: "attempt-1" });

    expect(afterOutput).toBe(beforeOutput);
  });

  it("reports that the command result is being reviewed when the command finishes", () => {
    const state = reduce([submit(), { type: "command-finished", attemptId: "attempt-1" }]);

    expect(state.activity).toEqual({ kind: "reviewing", text: "Reviewing command result…", subtle: false });
  });

  it("shows the coach-ready confirmation handoff", () => {
    const state = reduce([submit(), { type: "coach-ready", attemptId: "attempt-1" }]);

    expect(state.activity).toEqual({ kind: "confirming", text: "Looks good — confirming…", subtle: false });
  });

  it("replaces provisional feedback with final feedback or accepted feedback", () => {
    const provisional = reduce([submit(), usefulFeedback("Provisional")]);
    const final = reduceTerminalCoachingDisplay(provisional, { type: "final-feedback", attemptId: "attempt-1", feedback: "Final review" });
    const accepted = reduceTerminalCoachingDisplay(final, { type: "accepted", attemptId: "attempt-1", feedback: "Accepted" });

    expect(final.blueField).toEqual({ kind: "feedback", text: "Final review", provisional: false, accepted: false });
    expect(accepted.blueField).toEqual({ kind: "feedback", text: "Accepted", provisional: false, accepted: true });
  });

  it("ignores stale events from a prior attempt", () => {
    const firstAttempt = reduce([submit("attempt-1")], "attempt-1");
    const current = reduceTerminalCoachingDisplay(
      activateTerminalCoachingAttempt(firstAttempt, "attempt-2"),
      { type: "typing", attemptId: "attempt-2" }
    );
    const stale = reduceTerminalCoachingDisplay(current, usefulFeedback("Stale feedback", "attempt-1"));

    expect(stale).toBe(current);
    expect(stale.currentAttemptId).toBe("attempt-2");
  });

  it("reports automatic retrying when review is delayed", () => {
    const state = reduce([submit(), { type: "review-retry-scheduled", attemptId: "attempt-1" }]);

    expect(state.activity).toEqual({ kind: "retrying", text: "Review delayed — retrying automatically…", subtle: false });
  });
});
