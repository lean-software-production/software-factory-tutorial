import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeLessonJump, resolveLessonJump } from "../src/workbook/lesson-jump.js";
import { WorkbookTimeline } from "../src/workbook/timeline.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function loaded(): any {
  const lesson = (id: string) => ({ id, title: id, dek: "dek", introduction: "intro", durationMinutes: 1, outcomes: [], blocks: [{ id: "read", type: "narrative", title: "Read", markdown: "Read." }] });
  return { workspace: "/content", identity: { title: "Workbook" }, introduction: "Welcome.", chapters: [
    { id: "006-before", title: "006", lessonNumber: 1, lesson: lesson("006-before") },
    { id: "007-compose-and-branch", title: "007", lessonNumber: 2, lesson: lesson("007-compose-and-branch") },
  ] };
}

describe("lesson jumps", () => {
  it("resolves a numeric prefix and records completed prerequisites before the target preamble", async () => {
    const workbook = loaded();
    const target = resolveLessonJump(workbook, "007");
    expect(target).toEqual({ lessonId: "007-compose-and-branch", preambleBlockId: "lesson--007-compose-and-branch" });
    const root = await mkdtemp(resolve(tmpdir(), "lesson-jump-")); roots.push(root);

    await initializeLessonJump(root, workbook, target);

    const records = await new WorkbookTimeline({ stateRoot: root }).read();
    expect(records[0]).toMatchObject({ type: "lesson_jump_started", lessonId: target.lessonId });
    expect(records.filter((record) => record.type === "block_completed").map((record: any) => record.blockId)).toEqual([
      "workbook--introduction", "lesson--006-before", "lesson--006-before--read"
    ]);
    expect(records.some((record) => record.type === "message")).toBe(false);
    expect(records.some((record) => record.type === "block_completed" && record.blockId === target.preambleBlockId)).toBe(false);
  });

  it("rejects unknown and ambiguous selectors", () => {
    expect(() => resolveLessonJump(loaded(), "008")).toThrow(/No lesson matches/);
    const ambiguous = loaded(); ambiguous.chapters.push({ ...ambiguous.chapters[1], id: "007-other", lesson: { ...ambiguous.chapters[1].lesson, id: "007-other" } });
    expect(() => resolveLessonJump(ambiguous, "007")).toThrow(/ambiguous/);
  });
});
