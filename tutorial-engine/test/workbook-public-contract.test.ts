import { describe, expect, it } from "vitest";
import { isPublicWorkbookState, parsePublicWorkbookState } from "../src/workbook/public-contract.js";
import type { PublicWorkbookState } from "../src/workbook/public-contract.js";

/**
 * The narrowest state the browser will accept. The server builds public state in one place, and
 * that place always attaches a timeline, so the guard treats a state without one as invalid rather
 * than as an older shape worth rendering.
 */
function validState(): PublicWorkbookState {
  return {
    workbook: { title: "Fixture Workbook" },
    introduction: "Fixture introduction.",
    introductionComplete: false,
    chapters: [{ id: "001-first-lesson", title: "First Lesson", lessonNumber: 1 }],
    progress: {
      activeLessonId: "001-first-lesson",
      activeBlockId: "workbook--introduction",
      completedLessons: [],
      blocks: [],
      reflections: {},
      reflectionConversations: {},
    },
    adapter: { modelBackedHelp: true },
    timeline: [{
      type: "message",
      id: "record-1",
      sequence: 1,
      at: "2026-08-21T00:00:00.000Z",
      lessonId: "workbook",
      blockId: "workbook--introduction",
      role: "assistant",
      source: "authored",
      presentation: "course",
      text: "Fixture introduction.",
    }],
  };
}

describe("public workbook state contract", () => {
  it("accepts a state that carries a timeline, including an empty one", () => {
    expect(isPublicWorkbookState(validState())).toBe(true);
    expect(isPublicWorkbookState({ ...validState(), timeline: [] })).toBe(true);
  });

  it("accepts terminal-local retry review failure IDs only on safe terminal state", () => {
    const retryable = validState();
    retryable.progress.blocks = [{ id: "terminal", ready: false, active: true, completed: false, verified: false, emerged: true, terminal: { phase: "feedback", message: "Review is temporarily unavailable.", retryFailureId: "failure-1" } }];
    expect(isPublicWorkbookState(retryable)).toBe(true);
  });

  it("rejects a state whose timeline is missing", () => {
    const { timeline: _timeline, ...withoutTimeline } = validState();
    expect(isPublicWorkbookState(withoutTimeline)).toBe(false);
    expect(() => parsePublicWorkbookState(withoutTimeline)).toThrow(/invalid public state/i);
  });

  it("rejects a state whose timeline is not an array", () => {
    for (const timeline of [null, undefined, "", 0, {}, { 0: "record" }]) {
      expect(isPublicWorkbookState({ ...validState(), timeline })).toBe(false);
    }
  });
});
