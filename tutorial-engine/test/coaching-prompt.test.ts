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

  it("defaults generated success criteria to Kent Beck's four rules", () => {
    const prompt = coachingSystemPrompt(lesson);

    expect(prompt).toContain("When generating `factory/refactor/success.md` on the learner's behalf");
    expect(prompt).toContain("Kent Beck's four rules of simple design");
    expect(prompt).toContain("passes its tests, reveals intention, no duplication, and fewest elements");
    expect(prompt).toContain("destination for the factory's accumulated refactorings");
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

  it("names the doer by its lexicon role rather than as a worker", () => {
    const prompt = coachingSystemPrompt(lesson);

    expect(prompt).not.toMatch(/\bworker\b/i);
    expect(prompt).not.toMatch(/\breviewer\b/i);
    expect(prompt).toContain("another doer CLI");
    expect(prompt).toContain("Do not act as the doer.");
  });

  it("holds the learner at the end of every lesson", () => {
    const prompt = coachingSystemPrompt(lesson);

    expect(prompt).toContain("At the end of every lesson, stop there.");
    expect(prompt).toContain("offer a choice between pausing for now and continuing to the next lesson");
  });

  it("names the terminal each command belongs in once more than one is in play", () => {
    // From lesson 010 the line keeps a terminal busy while the learner watches
    // or steers it from another. A watcher typed into the occupied terminal
    // prints nothing, which reads as a broken lesson rather than a wrong window.
    const prompt = coachingSystemPrompt(lesson);

    expect(prompt).toContain("second terminal at the repository root");
    expect(prompt).toContain("Name which terminal each command belongs in");
  });

  it("does not invent an artefact for a lesson that builds nothing", () => {
    const prompt = coachingSystemPrompt(lesson);

    expect(prompt).toContain("creates no files");
    expect(prompt).toContain("do not offer to build anything");
    expect(prompt).toContain("questions the learner answers in their own words");
  });

  it("holds the learner at the end of Part 1 with the stronger, more specific beat", () => {
    const prompt = coachingSystemPrompt(lesson);

    expect(prompt).toContain("end of Part 1");
    expect(prompt).toContain("offer a choice between finishing for now and continuing into Part 2");
  });
});
