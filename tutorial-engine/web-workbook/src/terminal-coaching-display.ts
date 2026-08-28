export type TerminalCoachingBlueField =
  | { kind: "empty"; text: "" }
  | { kind: "submitting"; text: "Submitting command…" }
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
  | { type: "typing" }
  /** Xterm saw Enter. This is display-only until Bash publishes a submission fact. */
  | { type: "local-command-submitted" }
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
const submittingBlueField: TerminalCoachingBlueField = { kind: "submitting", text: "Submitting command…" };
const runningBlueField: TerminalCoachingBlueField = { kind: "running", text: "Running" };

/** Creates display-only state. Bash's submitted-command fact activates an attempt. */
export function createTerminalCoachingDisplayState(): TerminalCoachingDisplayState {
  return { currentAttemptId: undefined, blueField: emptyBlueField, activity: idleActivity };
}

/**
 * Reduces terminal and coach events into the browser display. A draft is local to the terminal, so
 * it has no attempt identity; only Bash's submitted-command fact can replace the active attempt.
 */
export function reduceTerminalCoachingDisplay(
  state: TerminalCoachingDisplayState,
  event: TerminalCoachingDisplayEvent
): TerminalCoachingDisplayState {
  if (event.type === "typing") return { ...state, activity: listeningActivity };
  // Enter is visible to xterm before Bash and the server can publish a durable submission. This
  // deliberately changes no attempt identity: Bash remains the lifecycle authority, so the UI
  // says only that it is submitting until Bash confirms that the command is running.
  if (event.type === "local-command-submitted") return { ...state, blueField: submittingBlueField, activity: idleActivity };
  // Reconcile the local busy card with Bash's durable submission without adding a second Running
  // label beneath it.
  if (event.type === "command-submitted") return { currentAttemptId: event.attemptId, blueField: runningBlueField, activity: idleActivity };
  if (event.attemptId !== state.currentAttemptId) return state;

  switch (event.type) {
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
      // A retry replaces the generic final feedback in the same highlighted surface. It must not
      // leave a stale card above a second retrying line.
      return {
        ...state,
        blueField: { kind: "feedback", text: retryingActivity.text, provisional: false, accepted: false },
        activity: idleActivity
      };
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
