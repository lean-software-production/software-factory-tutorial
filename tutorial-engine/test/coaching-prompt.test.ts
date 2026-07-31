import { describe, expect, it } from "vitest";
import { coachingSystemPrompt } from "../src/agent/pi-adapter.js";

const lesson = {
  title: "Example lesson",
  workspace: "/tmp/example",
  validationCommands: []
};

describe("coachingSystemPrompt", () => {
  it("guides learner-led work from the change's heart outward", () => {
    const prompt = coachingSystemPrompt(lesson);

    expect(prompt).toContain("smallest visible behavior");
    expect(prompt).toContain("heart of the change and work outward");
    expect(prompt).toContain("short conceptual outline");
    expect(prompt).toContain("small code snippet");
  });

  it("offers progressive help after each learner-led step", () => {
    const prompt = coachingSystemPrompt(lesson);

    expect(prompt).toContain("I’ll do it");
    expect(prompt).toContain("I’ve made this step");
    expect(prompt).toContain("Show me exactly what to type");
    expect(prompt).toContain("Make this step for me");
  });
});
