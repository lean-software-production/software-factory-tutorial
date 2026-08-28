export type TerminalCoachingBlueField =
  | { kind: "empty"; text: "" }
  | { kind: "running"; text: "Running" }
  | { kind: "feedback"; text: string; provisional: boolean; accepted: boolean };

export type TerminalCoachingActivity =
  | { kind: "idle"; text: ""; subtle: false }
  | { kind: "listening"; text: "Listening for a command…"; subtle: true }
  | { kind: "running"; text: "Running"; subtle: true }
  | { kind: "reviewing"; text: "Reviewing command result…"; subtle: false }
  | { kind: "confirming"; text: "Looks good — confirming…"; subtle: false }
  | { kind: "retrying"; text: "Review delayed — retrying automatically…"; subtle: false };

export interface TerminalCoachingDisplayState {
  readonly currentAttemptId: string | undefined;
  readonly blueField: TerminalCoachingBlueField;
  readonly activity: TerminalCoachingActivity;
}

export type TerminalCoachingDisplayEvent =
  | { type: "typing"; attemptId: string }
  | { type: "command-submitted"; attemptId: string }
  | { type: "command-output"; attemptId: string }
  | { type: "useful-feedback"; attemptId: string; feedback: string }
  | { type: "command-finished"; attemptId: string }
  | { type: "coach-ready"; attemptId: string }
  | { type: "review-retry-scheduled"; attemptId: string }
  | { type: "final-feedback"; attemptId: string; feedback: string }
  | { type: "accepted"; attemptId: string; feedback: string };

const idleActivity: TerminalCoachingActivity = { kind: "idle", text: "", subtle: false };
const listeningActivity: TerminalCoachingActivity = { kind: "listening", text: "Listening for a command…", subtle: true };
const runningActivity: TerminalCoachingActivity = { kind: "running", text: "Running", subtle: true };
const reviewingActivity: TerminalCoachingActivity = { kind: "reviewing", text: "Reviewing command result…", subtle: false };
const confirmingActivity: TerminalCoachingActivity = { kind: "confirming", text: "Looks good — confirming…", subtle: false };
const retryingActivity: TerminalCoachingActivity = { kind: "retrying", text: "Review delayed — retrying automatically…", subtle: false };
const emptyBlueField: TerminalCoachingBlueField = { kind: "empty", text: "" };
const runningBlueField: TerminalCoachingBlueField = { kind: "running", text: "Running" };

/** Creates display-only state; callers activate each new attempt before forwarding its events. */
export function createTerminalCoachingDisplayState(): TerminalCoachingDisplayState {
  return { currentAttemptId: undefined, blueField: emptyBlueField, activity: idleActivity };
}

/** Activates a locally-created attempt without clearing the feedback already visible to the learner. */
export function activateTerminalCoachingAttempt(
  state: TerminalCoachingDisplayState,
  attemptId: string
): TerminalCoachingDisplayState {
  return { ...state, currentAttemptId: attemptId, activity: idleActivity };
}

/**
 * Reduces terminal and coach events into the browser display. Events for any attempt other than the
 * active one are deliberately ignored, so late terminal output cannot overwrite a newer attempt.
 */
export function reduceTerminalCoachingDisplay(
  state: TerminalCoachingDisplayState,
  event: TerminalCoachingDisplayEvent
): TerminalCoachingDisplayState {
  if (event.attemptId !== state.currentAttemptId) return state;

  switch (event.type) {
    case "typing":
      return { ...state, activity: listeningActivity };
    case "command-submitted":
      return { ...state, blueField: runningBlueField, activity: runningActivity };
    case "command-output":
      return state;
    case "useful-feedback":
      return {
        ...state,
        blueField: { kind: "feedback", text: event.feedback, provisional: true, accepted: false },
        activity: runningActivity
      };
    case "command-finished":
      return { ...state, activity: reviewingActivity };
    case "coach-ready":
      return { ...state, activity: confirmingActivity };
    case "review-retry-scheduled":
      return { ...state, activity: retryingActivity };
    case "final-feedback":
      return {
        ...state,
        blueField: { kind: "feedback", text: event.feedback, provisional: false, accepted: false },
        activity: idleActivity
      };
    case "accepted":
      return {
        ...state,
        blueField: { kind: "feedback", text: event.feedback, provisional: false, accepted: true },
        activity: idleActivity
      };
  }
}
