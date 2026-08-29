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

  it("validates public timeline messages while preserving legitimate extra public state fields", () => {
    const withExtra = validState() as PublicWorkbookState & { adapter: PublicWorkbookState["adapter"] & { prose: string } };
    withExtra.adapter.prose = "Visible public prose.";
    expect(parsePublicWorkbookState(withExtra)).toBe(withExtra);

    for (const bad of [
      { role: "tutor" },
      { source: "terminal_observer" },
      { presentation: "private" },
      { text: 12 },
      { sequence: "1" },
      { blockInView: 42 },
    ]) {
      const state = validState();
      state.timeline = [{ ...state.timeline[0]!, ...bad } as any];
      expect(isPublicWorkbookState(state), JSON.stringify(bad)).toBe(false);
      expect(() => parsePublicWorkbookState(state)).toThrow(/invalid public state/i);
    }
  });

  it("accepts public tutor failure records and rejects raw private timeline event types", () => {
    const failureState = validState();
    failureState.timeline = [{
      type: "tutor_failed",
      id: "failure-row",
      sequence: 2,
      at: "2026-08-21T00:00:01.000Z",
      lessonId: "001-first-lesson",
      blockId: "lesson--001-first-lesson--practice",
      failureId: "failure-row",
      operation: "review",
      publicMessage: "Review is temporarily unavailable.",
    }];
    expect(isPublicWorkbookState(failureState)).toBe(true);

    const raw = validState();
    raw.timeline = [{
      type: "lesson_jump_started",
      id: "private-row",
      sequence: 3,
      at: "2026-08-21T00:00:02.000Z",
      lessonId: "secret-lesson",
      privatePath: "/private/workbook/path",
    } as any];
    expect(isPublicWorkbookState(raw)).toBe(false);
    expect(() => parsePublicWorkbookState(raw)).toThrow(/invalid public state/i);
  });

  it("validates optional public terminal attempt revisions", () => {
    const state = validState();
    state.progress.blocks = [{ id: "terminal", ready: true, active: true, completed: false, verified: false, emerged: true, terminal: { phase: "running" }, terminalRevision: 1 }];
    expect(isPublicWorkbookState(state)).toBe(true);

    for (const terminalRevision of [-1, 1.5, "1"]) {
      const bad = validState();
      bad.progress.blocks = [{ id: "terminal", ready: true, active: true, completed: false, verified: false, emerged: true, terminal: { phase: "running" }, terminalRevision } as any];
      expect(isPublicWorkbookState(bad), String(terminalRevision)).toBe(false);
    }
  });
});
