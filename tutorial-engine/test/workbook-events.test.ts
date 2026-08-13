import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbookEventStore, nowEvent, project } from "../src/workbook/events.js";
import type { WorkbookLesson } from "../src/workbook/contract.js";

/**
 * A minimal in-memory lesson: enough shape for the projection to advance
 * through, with synthetic ids so these tests exercise projection alone and
 * never depend on the root curriculum's words, paths, or block order.
 */
const LESSON_ID = "part/lesson";
const lesson: WorkbookLesson = {
  id: LESSON_ID,
  hero: { title: "Hero", dek: "Dek", meta: [] },
  opening: { sectionLabel: "Label", heading: "Heading", markdown: "Body", outcomes: [] },
  blocks: [
    { id: "narrate", type: "narrative", title: "Narrate", markdown: "Body" },
    { id: "first-practice", type: "terminal-practice", title: "First", required: true, command: "c1", context: "x", expectedObservation: "o", help: {} },
    { id: "second-practice", type: "terminal-practice", title: "Second", required: true, command: "c2", context: "x", expectedObservation: "o", help: {} },
    { id: "reflect", type: "reflection", title: "Reflect", required: true, prompt: "?" },
    { id: "finish", type: "lesson-transition", title: "Finish", required: true, label: "Finish", markdown: "Body" },
  ],
};

let dirs: string[] = [];
async function workspace() { const dir = await mkdtemp(resolve(tmpdir(), "workbook-")); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); dirs = []; });

describe("workbook event projection", () => {
  it("keeps unexpected output as evidence without completing the active block", () => {
    const events = [nowEvent({ type: "unexpected_output_submitted", lessonId: LESSON_ID, blockId: "first-practice", evidence: "command not found" })];
    const state = project(events, lesson);
    expect(state.activeBlockId).toBe("first-practice");
    expect(state.blocks.find((block) => block.id === "first-practice")?.completed).toBe(false);
    expect(state.unexpected["first-practice"]).toEqual(["command not found"]);
  });

  it("holds verified terminal practice at its checkpoint until the learner completes it", () => {
    expect(project([], lesson).blocks.map((block) => [block.id, block.emerged])).toEqual([
      ["narrate", true], ["first-practice", true], ["second-practice", false], ["reflect", false], ["finish", false]
    ]);
    const verified = [nowEvent({ type: "observation_verified", lessonId: LESSON_ID, blockId: "first-practice", source: "terminal_observer", summary: "The expected output appeared." })];
    const checkpoint = project(verified, lesson);
    expect(checkpoint.activeBlockId).toBe("first-practice");
    expect(checkpoint.blocks.find((block) => block.id === "first-practice")).toMatchObject({ verified: true, completed: false, feedback: "The expected output appeared." });
    expect(checkpoint.blocks.find((block) => block.id === "second-practice")?.emerged).toBe(false);

    const events = [
      ...verified,
      nowEvent({ type: "block_completed", lessonId: LESSON_ID, blockId: "first-practice" }),
      nowEvent({ type: "observation_acknowledged", lessonId: LESSON_ID, blockId: "second-practice" }),
      nowEvent({ type: "reflection_submitted", lessonId: LESSON_ID, blockId: "reflect", response: "a reflection" }),
    ];
    expect(project(events, lesson).activeBlockId).toBe("finish");
    expect(project(events, lesson).blocks.map((block) => block.emerged)).toEqual([true, true, true, true, true]);
    expect(project([...events, nowEvent({ type: "lesson_transitioned", lessonId: LESSON_ID, blockId: "finish" })], lesson).completedLessons).toEqual([LESSON_ID]);
  });

  it("rebuilds resume state from JSONL events, not projection cache or scroll position", async () => {
    const dir = await workspace(); const store = new WorkbookEventStore(dir);
    await store.append(nowEvent({ type: "observation_acknowledged", lessonId: LESSON_ID, blockId: "first-practice" }));
    await store.writeProjection({ activeLessonId: LESSON_ID, activeBlockId: "wrong", completedLessons: [], blocks: [], unexpected: {}, reflections: {} });
    expect(project(await store.read(), lesson).activeBlockId).toBe("second-practice");
  });

  it("writes workbook events in the tutor's neutral state directory", async () => {
    const dir = await workspace(); const store = new WorkbookEventStore(dir);
    await store.append(nowEvent({ type: "observation_acknowledged", lessonId: LESSON_ID, blockId: "first-practice" }));
    expect(store.eventPath).toContain(".tutorial/.tmp/workbook/events.jsonl");
    expect(await readFile(store.eventPath, "utf8")).toContain("observation_acknowledged");
  });

  it("has no event that lets unrelated file changes complete terminal practice", () => {
    expect(project([{ type: "file_change_observed", at: new Date().toISOString(), lessonId: LESSON_ID, blockId: "first-practice" } as any], lesson).activeBlockId).toBe("first-practice");
  });
});
