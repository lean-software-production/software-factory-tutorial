import { describe, expect, it } from "vitest";
import { createTerminalCoachingDisplayState, reduceTerminalCoachingDisplay } from "../web-workbook/src/terminal-coaching-display.js";

const server = (terminal: any) => reduceTerminalCoachingDisplay(createTerminalCoachingDisplayState(), { type: "server-state", terminal });

describe("terminal coaching display reducer", () => {
  it("has exactly the server-authoritative lifecycle states", () => {
    expect(createTerminalCoachingDisplayState()).toEqual({ phase: "idle" });
    expect(server({ phase: "running" })).toEqual({ phase: "running", text: "Running…" });
    expect(server({ phase: "checking" })).toEqual({ phase: "checking", text: "Checking…" });
    expect(server({ phase: "feedback", message: "Fix it." })).toEqual({ phase: "feedback", text: "Fix it." });
    expect(server({ phase: "complete", message: "Accepted." })).toEqual({ phase: "complete", text: "Accepted." });
  });

  it("renders each server state directly without a local submission event", () => {
    const feedback = server({ phase: "feedback", message: "Previous feedback." });

    expect(reduceTerminalCoachingDisplay(feedback, { type: "server-state", terminal: { phase: "running" } })).toEqual({ phase: "running", text: "Running…" });
    expect(reduceTerminalCoachingDisplay(feedback, { type: "server-state", terminal: { phase: "checking" } })).toEqual({ phase: "checking", text: "Checking…" });
    expect(reduceTerminalCoachingDisplay(feedback, { type: "server-state", terminal: { phase: "feedback", message: "New feedback." } })).toEqual({ phase: "feedback", text: "New feedback." });
    expect(reduceTerminalCoachingDisplay(feedback, { type: "server-state", terminal: { phase: "complete", message: "Accepted." } })).toEqual({ phase: "complete", text: "Accepted." });
  });
});
