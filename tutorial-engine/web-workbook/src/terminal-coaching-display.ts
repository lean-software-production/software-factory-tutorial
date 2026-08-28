import type { PublicTerminal } from "../../src/workbook/public-contract.js";

/** The six learner-facing states, including the browser-only Sending gate. */
export type TerminalCoachingDisplayState =
  | { phase: "idle" }
  | { phase: "sending"; text: "Sending…" }
  | { phase: "running"; text: "Running…" }
  | { phase: "checking"; text: "Checking…" }
  | { phase: "feedback"; text: string }
  | { phase: "complete"; text: string };

export type TerminalCoachingDisplayEvent =
  | { type: "local-enter" }
  | { type: "server-state"; terminal: PublicTerminal | undefined };

export function createTerminalCoachingDisplayState(): TerminalCoachingDisplayState {
  return { phase: "idle" };
}

/**
 * The browser opens Sending synchronously on Enter. It remains a local gate until a current
 * public Running projection from Bash's submitted marker arrives; older feedback or completion
 * snapshots cannot replace that gate. Every non-idle phase becomes one in-place terminal message.
 */
export function reduceTerminalCoachingDisplay(
  state: TerminalCoachingDisplayState,
  event: TerminalCoachingDisplayEvent,
): TerminalCoachingDisplayState {
  if (event.type === "local-enter") return { phase: "sending", text: "Sending…" };
  if (state.phase === "sending" && event.terminal?.phase !== "running") return state;
  switch (event.terminal?.phase) {
    case "running": return { phase: "running", text: "Running…" };
    case "checking": return { phase: "checking", text: "Checking…" };
    case "feedback": return { phase: "feedback", text: event.terminal.message };
    case "complete": return { phase: "complete", text: event.terminal.message };
    default: return { phase: "idle" };
  }
}
