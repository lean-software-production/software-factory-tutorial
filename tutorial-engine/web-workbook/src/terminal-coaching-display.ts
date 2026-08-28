import type { PublicTerminal } from "../../src/workbook/public-contract.js";

/** The browser displays only Bash-authoritative terminal lifecycle states. */
export type TerminalCoachingDisplayState =
  | { phase: "idle" }
  | { phase: "running"; text: "Running…" }
  | { phase: "checking"; text: "Checking…" }
  | { phase: "feedback"; text: string }
  | { phase: "complete"; text: string };

export type TerminalCoachingDisplayEvent = { type: "server-state"; terminal: PublicTerminal | undefined };

export function createTerminalCoachingDisplayState(): TerminalCoachingDisplayState {
  return { phase: "idle" };
}

/** Every server state becomes one in-place terminal message; local input never changes it. */
export function reduceTerminalCoachingDisplay(
  state: TerminalCoachingDisplayState,
  event: TerminalCoachingDisplayEvent,
): TerminalCoachingDisplayState {
  if (!event.terminal && state.phase === "idle") return state;
  switch (event.terminal?.phase) {
    case "running": return { phase: "running", text: "Running…" };
    case "checking": return { phase: "checking", text: "Checking…" };
    case "feedback": return { phase: "feedback", text: event.terminal.message };
    case "complete": return { phase: "complete", text: event.terminal.message };
    default: return { phase: "idle" };
  }
}
