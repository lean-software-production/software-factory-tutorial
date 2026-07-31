import { describe, expect, it } from "vitest";
import { coachingSystemPrompt } from "../src/agent/pi-adapter.js";

const lesson = {
  title: "Example lesson",
  workspace: "/tmp/example",
  validationCommands: []
};

describe("coachingSystemPrompt", () => {
  it("guides learner-led work in the current specification's stated order", () => {
    const prompt = coachingSystemPrompt(lesson);

    expect(prompt).toContain("implementation order stated by the current specification");
    expect(prompt).toContain("short conceptual outline");
    expect(prompt).toContain("small code snippet");
  });

  it("offers progressive help after each learner-led step", () => {
    const prompt = coachingSystemPrompt(lesson);

    expect(prompt).toContain("I’ll do it");
    expect(prompt).toContain("I’ve made this step");
    expect(prompt).toContain("Show me exactly what to type");
    expect(prompt).toContain("Make this step for me");
    expect(prompt).toContain("Every offer_choices option must supply an icon category.");
    expect(prompt).toContain("“I’ll do it”=do");
    expect(prompt).toContain("“Make it for me”=automate");
    expect(prompt).toContain("“I’ve made this step”=confirm");
    expect(prompt).toContain("“Show me exactly what to type”=show");
    expect(prompt).toContain("Use pause for a stop or pause choice.");
  });
});
