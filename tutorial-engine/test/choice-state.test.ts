import { describe, expect, it } from "vitest";
import { resolvedChoiceSelections } from "../web/src/choice-state.js";
import type { TutorialEvent } from "../src/protocol/events.js";

const choice: TutorialEvent = {
  type: "choice",
  id: "choice-1",
  question: "Continue?",
  options: [
    { id: "continue", label: "Continue", icon: "do" },
    { id: "pause", label: "Pause", icon: "pause" },
  ],
};

describe("resolvedChoiceSelections", () => {
  it("leaves an unresolved choice absent", () => {
    expect(resolvedChoiceSelections([choice]).has("choice-1")).toBe(false);
  });

  it("records the option selected for its matching choice", () => {
    expect(resolvedChoiceSelections([
      choice,
      { type: "choice-resolved", id: "choice-1", optionId: "continue" },
    ]).get("choice-1")).toBe("continue");
  });

  it("ignores resolutions for other choices", () => {
    expect(resolvedChoiceSelections([
      choice,
      { type: "choice-resolved", id: "choice-2", optionId: "pause" },
    ]).has("choice-1")).toBe(false);
  });
});
