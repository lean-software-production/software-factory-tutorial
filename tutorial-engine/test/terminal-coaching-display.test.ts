import { describe, expect, it } from "vitest";
import { createTerminalCoachingDisplayState, reduceTerminalCoachingDisplay } from "../web-workbook/src/terminal-coaching-display.js";

const server = (terminal: any) => reduceTerminalCoachingDisplay(createTerminalCoachingDisplayState(), { type: "server-state", terminal });

describe("terminal coaching display reducer", () => {
  it("has exactly the public lifecycle states", () => {
    expect(createTerminalCoachingDisplayState()).toEqual({ phase: "idle" });
    expect(server({ phase: "running" })).toEqual({ phase: "running", text: "Running…" });
    expect(server({ phase: "checking" })).toEqual({ phase: "checking", text: "Checking…" });
    expect(server({ phase: "feedback", message: "Fix it." })).toEqual({ phase: "feedback", text: "Fix it." });
    expect(server({ phase: "complete", message: "Accepted." })).toEqual({ phase: "complete", text: "Accepted." });
  });

  it("opens Sending immediately and ignores stale feedback and completion until current Running arrives", () => {
    const feedback = server({ phase: "feedback", message: "Previous feedback." });
    const sending = reduceTerminalCoachingDisplay(feedback, { type: "local-enter" });
    const staleFeedback = reduceTerminalCoachingDisplay(sending, { type: "server-state", terminal: { phase: "feedback", message: "Previous feedback." } });
    const staleComplete = reduceTerminalCoachingDisplay(staleFeedback, { type: "server-state", terminal: { phase: "complete", message: "Previous completion." } });

    expect(staleComplete).toEqual({ phase: "sending", text: "Sending…" });
    expect(reduceTerminalCoachingDisplay(staleComplete, { type: "server-state", terminal: { phase: "running" } })).toEqual({ phase: "running", text: "Running…" });
  });

  it("lets a later Enter replace feedback and complete normally locks after Bash state", () => {
    const feedback = server({ phase: "feedback", message: "Try again." });
    expect(reduceTerminalCoachingDisplay(feedback, { type: "local-enter" })).toEqual({ phase: "sending", text: "Sending…" });

    const complete = server({ phase: "complete", message: "Accepted." });
    expect(reduceTerminalCoachingDisplay(complete, { type: "local-enter" })).toEqual({ phase: "sending", text: "Sending…" });
  });
});
