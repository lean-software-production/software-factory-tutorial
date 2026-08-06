import { describe, expect, it } from "vitest";
import { isBrowserMessage, parseTutorialEvent, serializeBrowserMessage } from "../src/protocol/events.js";

describe("shared browser protocol smoke", () => {
  it("serializes a browser choice and parses the initial event without browser-only types", () => {
    const message = { type: "choose" as const, choiceId: "choice-1", optionId: "hands-on" };
    const body = serializeBrowserMessage(message);
    expect(isBrowserMessage(JSON.parse(body))).toBe(true);
    const event = parseTutorialEvent(JSON.stringify({ type: "choice", id: "choice-1", question: "How would you like to continue?", options: [{ id: "hands-on", label: "I’ll do it", icon: "do" }] }));
    expect(event).toMatchObject({ type: "choice", id: "choice-1" });
  });

  it("accepts every way the learner can be started, and no other", () => {
    for (const mode of ["resume", "fresh", "part-2"]) {
      expect(isBrowserMessage({ type: "start-session", mode }), mode).toBe(true);
    }
    expect(isBrowserMessage({ type: "start-session", mode: "part-3" })).toBe(false);
  });

  it("rejects malformed requests before they reach the tutor", () => {
    expect(isBrowserMessage({ type: "choose", choiceId: "only-id" })).toBe(false);
    expect(isBrowserMessage({ type: "chat", text: "hello", delivery: "untrusted" })).toBe(false);
  });
});
