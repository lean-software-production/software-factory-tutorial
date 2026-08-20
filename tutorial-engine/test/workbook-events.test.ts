import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbookEventStore, nowEvent, project } from "../src/workbook/events.js";
import type { WorkbookLesson } from "../src/workbook/contract.js";

/**
 * A minimal new-schema lesson: all listed blocks are sequenced. Narrative and
 * transition blocks advance through the generic continuation event, terminal
 * practice needs observer verification plus explicit completion, and reflection
 * keeps its explicit tutor-mediated completion.
 */
const LESSON_ID = "part/lesson";
const lesson: WorkbookLesson = {
  id: LESSON_ID,
  title: "Fixture lesson",
  dek: "Fixture dek.",
  durationMinutes: 10,
  outcomes: ["Fixture outcome."],
  blocks: [
    { id: "narrate", type: "narrative", title: "Narrate", markdown: "Body" },
    { id: "edit-answer", type: "editor-practice", title: "Edit", markdown: "Write the answer.", path: "factory/answer.md", tutor: "Private editor rubric." },
    { id: "first-practice", type: "terminal-practice", title: "First", markdown: "Practice body", tutor: "Observe the first result." },
    { id: "second-practice", type: "terminal-practice", title: "Second", markdown: "Practice body", tutor: "Observe the second result." },
    { id: "reflect", type: "reflection", title: "Reflect", markdown: "Question?", tutor: "Discuss the question." },
    { id: "finish", type: "lesson-transition", title: "Finish", markdown: "Body" },
  ],
};

let dirs: string[] = [];
async function workspace() { const dir = await mkdtemp(resolve(tmpdir(), "workbook-")); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); dirs = []; });

describe("workbook event projection", () => {
  it("sequences every listed block and advances active no-task blocks only through continuation", () => {
    const initial = project([], lesson);
    expect(initial.activeBlockId).toBe("narrate");
    expect(initial.blocks.map((block) => [block.id, block.emerged, block.ready, block.active])).toEqual([
      ["narrate", true, true, true],
      ["edit-answer", false, false, false],
      ["first-practice", false, false, false],
      ["second-practice", false, false, false],
      ["reflect", false, false, false],
      ["finish", false, false, false],
    ]);

    const continued = project([nowEvent({ type: "block_continued", lessonId: LESSON_ID, blockId: "narrate" })], lesson);
    expect(continued.activeBlockId).toBe("edit-answer");
    expect(continued.blocks.find((block) => block.id === "narrate")?.completed).toBe(true);
    expect(continued.blocks.find((block) => block.id === "edit-answer")).toMatchObject({ emerged: true, ready: true, active: true, editorStatus: "editing" });
  });

  it("keeps unexpected output as evidence without completing the active block", () => {
    const events = [
      nowEvent({ type: "block_continued", lessonId: LESSON_ID, blockId: "narrate" }),
      nowEvent({ type: "editor_practice_unlocked", lessonId: LESSON_ID, blockId: "edit-answer", revisionId: 2, path: "factory/answer.md" }),
      nowEvent({ type: "unexpected_output_submitted", lessonId: LESSON_ID, blockId: "first-practice", evidence: "command not found" }),
    ];
    const state = project(events, lesson);
    expect(state.activeBlockId).toBe("first-practice");
    expect(state.blocks.find((block) => block.id === "first-practice")?.completed).toBe(false);
    expect(state.unexpected["first-practice"]).toEqual(["command not found"]);
  });

  it("holds verified terminal practice at its checkpoint until the learner completes it", () => {
    const started = [
      nowEvent({ type: "block_continued", lessonId: LESSON_ID, blockId: "narrate" }),
      nowEvent({ type: "editor_practice_unlocked", lessonId: LESSON_ID, blockId: "edit-answer", revisionId: 2, path: "factory/answer.md" }),
    ];
    const verified = [...started, nowEvent({ type: "observation_verified", lessonId: LESSON_ID, blockId: "first-practice", source: "terminal_observer", summary: "The expected output appeared.", terminalHtml: "<pre class=\"frozen-terminal-output\">output</pre>" })];
    const checkpoint = project(verified, lesson);
    expect(checkpoint.activeBlockId).toBe("first-practice");
    expect(checkpoint.blocks.find((block) => block.id === "first-practice")).toMatchObject({ verified: true, completed: false, feedback: "The expected output appeared.", terminalHtml: expect.stringContaining("frozen-terminal-output") });
    expect(checkpoint.blocks.find((block) => block.id === "second-practice")?.emerged).toBe(false);

    const forgedCompletion = project([...started, nowEvent({ type: "block_completed", lessonId: LESSON_ID, blockId: "first-practice" })], lesson);
    expect(forgedCompletion.activeBlockId).toBe("first-practice");
    expect(forgedCompletion.blocks.find((block) => block.id === "first-practice")?.completed).toBe(false);

    const events = [...verified, nowEvent({ type: "block_completed", lessonId: LESSON_ID, blockId: "first-practice" })];
    expect(project(events, lesson).activeBlockId).toBe("second-practice");
  });

  it("completes editor practice only from a valid unlock while the editor block is active", () => {
    const started = [nowEvent({ type: "block_continued", lessonId: LESSON_ID, blockId: "narrate" })];
    const forgedCompletion = project([...started, nowEvent({ type: "block_completed", lessonId: LESSON_ID, blockId: "edit-answer" })], lesson);
    expect(forgedCompletion.activeBlockId).toBe("edit-answer");
    expect(forgedCompletion.blocks.find((block) => block.id === "edit-answer")).toMatchObject({ completed: false, editorStatus: "editing" });

    const staleUnlock = project([...started, nowEvent({ type: "editor_practice_unlocked", lessonId: LESSON_ID, blockId: "edit-answer", revisionId: 0, path: "factory/answer.md" })], lesson);
    expect(staleUnlock.activeBlockId).toBe("edit-answer");
    expect(staleUnlock.blocks.find((block) => block.id === "edit-answer")?.completed).toBe(false);

    const earlyUnlock = project([
      nowEvent({ type: "editor_practice_unlocked", lessonId: LESSON_ID, blockId: "edit-answer", revisionId: 2, path: "factory/answer.md" }),
      nowEvent({ type: "block_continued", lessonId: LESSON_ID, blockId: "narrate" }),
    ], lesson);
    expect(earlyUnlock.activeBlockId).toBe("edit-answer");
    expect(earlyUnlock.blocks.find((block) => block.id === "edit-answer")?.completed).toBe(false);

    const unlocked = project([...started, nowEvent({ type: "editor_practice_unlocked", lessonId: LESSON_ID, blockId: "edit-answer", revisionId: 2, path: "factory/answer.md" })], lesson);
    expect(unlocked.activeBlockId).toBe("first-practice");
    expect(unlocked.blocks.find((block) => block.id === "edit-answer")).toMatchObject({ completed: true, editorStatus: "unlocked", revision: 2 });
  });

  it("uses reflection completion and generic transition continuation to complete the lesson", () => {
    const events = [
      nowEvent({ type: "block_continued", lessonId: LESSON_ID, blockId: "narrate" }),
      nowEvent({ type: "editor_practice_unlocked", lessonId: LESSON_ID, blockId: "edit-answer", revisionId: 2, path: "factory/answer.md" }),
      nowEvent({ type: "observation_verified", lessonId: LESSON_ID, blockId: "first-practice", source: "terminal_observer", summary: "First done.", terminalHtml: "<pre>1</pre>" }),
      nowEvent({ type: "block_completed", lessonId: LESSON_ID, blockId: "first-practice" }),
      nowEvent({ type: "observation_verified", lessonId: LESSON_ID, blockId: "second-practice", source: "terminal_observer", summary: "Second done.", terminalHtml: "<pre>2</pre>" }),
      nowEvent({ type: "block_completed", lessonId: LESSON_ID, blockId: "second-practice" }),
      nowEvent({ type: "reflection_submitted", lessonId: LESSON_ID, blockId: "reflect", response: "a reflection" }),
      nowEvent({ type: "reflection_reply_recorded", lessonId: LESSON_ID, blockId: "reflect", response: "A tutor reply." }),
      nowEvent({ type: "reflection_completed", lessonId: LESSON_ID, blockId: "reflect" }),
    ];
    expect(project(events, lesson).activeBlockId).toBe("finish");
    expect(project(events, lesson).blocks.map((block) => block.emerged)).toEqual([true, true, true, true, true, true]);
    expect(project([...events, nowEvent({ type: "block_continued", lessonId: LESSON_ID, blockId: "finish" })], lesson).completedLessons).toEqual([LESSON_ID]);
  });

  it("rebuilds resume state from JSONL events, not projection cache or scroll position", async () => {
    const dir = await workspace(); const store = new WorkbookEventStore(dir);
    await store.append(nowEvent({ type: "block_continued", lessonId: LESSON_ID, blockId: "narrate" }));
    await store.append(nowEvent({ type: "editor_practice_unlocked", lessonId: LESSON_ID, blockId: "edit-answer", revisionId: 2, path: "factory/answer.md" }));
    await store.writeProjection({ activeLessonId: LESSON_ID, activeBlockId: "wrong", completedLessons: [], blocks: [], unexpected: {}, reflections: {}, reflectionConversations: {} });
    const replayed = project(await store.read(), lesson);
    expect(replayed.activeBlockId).toBe("first-practice");
    expect(replayed.blocks.find((block) => block.id === "edit-answer")).toMatchObject({ completed: true, editorStatus: "unlocked", revision: 2 });
  });

  it("writes workbook events in the tutor's neutral state directory", async () => {
    const dir = await workspace(); const store = new WorkbookEventStore(dir);
    await store.append(nowEvent({ type: "block_continued", lessonId: LESSON_ID, blockId: "narrate" }));
    expect(store.eventPath).toContain(".tutorial/.tmp/workbook/events.jsonl");
    expect(await readFile(store.eventPath, "utf8")).toContain("block_continued");
  });

  it("has no event that lets unrelated file changes complete terminal practice", () => {
    const events = [
      nowEvent({ type: "block_continued", lessonId: LESSON_ID, blockId: "narrate" }),
      nowEvent({ type: "editor_practice_unlocked", lessonId: LESSON_ID, blockId: "edit-answer", revisionId: 2, path: "factory/answer.md" }),
      { type: "file_change_observed", at: new Date().toISOString(), lessonId: LESSON_ID, blockId: "first-practice" } as any,
    ];
    expect(project(events, lesson).activeBlockId).toBe("first-practice");
  });
});
