import { describe, expect, it } from "vitest";
import { PRACTICE_COACH_REPORT_DESCRIPTION, practiceCoachSystemPrompt } from "../src/workbook/practice-coach.js";

describe("Practice Coach learner-facing instructions", () => {
  it("requires concise direct second-person feedback without internal mechanics", () => {
    const prompt = practiceCoachSystemPrompt();

    expect(prompt).toContain("address them as you");
    expect(prompt).toContain("never say “the learner”");
    expect(prompt).toContain("never mention the Coach, Tutor, rubric, model, assessment, handoff, or other internal mechanics");
    expect(PRACTICE_COACH_REPORT_DESCRIPTION).toContain("address them as you");
    expect(PRACTICE_COACH_REPORT_DESCRIPTION).toContain("never say ‘the learner’");
    expect(PRACTICE_COACH_REPORT_DESCRIPTION).toContain("never mention the Coach, Tutor, rubric, model, assessment, handoff, or other internal mechanics");
  });
});
