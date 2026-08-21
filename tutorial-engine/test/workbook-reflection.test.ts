import { describe, expect, it, vi } from "vitest";
import { appendTutorFeedback, submitReflectionAttempt, type ReflectionTurn } from "../src/workbook/reflection.js";
import type { SubmitAttempt } from "../src/workbook/terminal.js";

const priorConversation: ReflectionTurn[] = [
  { role: "learner", text: "I tried the command." },
  { role: "tutor", text: "What did the output show?" },
];

describe("reflection attempt helpers", () => {
  it("submits each learner message with the existing conversation as reflection evidence", async () => {
    const submitAttempt = vi.fn<SubmitAttempt>(async () => undefined);

    const turns = await submitReflectionAttempt({
      lessonId: "lesson-id",
      blockId: "reflect",
      privateGuidance: "Check that the learner connects evidence to the concept.",
      conversation: priorConversation,
      response: "It showed the bounded doer cannot write outside the workspace.",
      submitAttempt,
    });

    expect(submitAttempt).toHaveBeenCalledWith({
      lessonId: "lesson-id",
      blockId: "reflect",
      privateGuidance: "Check that the learner connects evidence to the concept.",
      evidence: {
        kind: "reflection",
        response: "It showed the bounded doer cannot write outside the workspace.",
        conversation: priorConversation,
      },
    });
    expect(turns).toEqual([...priorConversation, { role: "learner", text: "It showed the bounded doer cannot write outside the workspace." }]);
  });

  it("appends tutor feedback as the next conversation turn", () => {
    expect(appendTutorFeedback([...priorConversation, { role: "learner", text: "A new answer." }], "Name the exact boundary next.")).toEqual([
      ...priorConversation,
      { role: "learner", text: "A new answer." },
      { role: "tutor", text: "Name the exact boundary next." },
    ]);
  });
});
