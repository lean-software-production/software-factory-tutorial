import { describe, expect, it } from "vitest";
import { authoredBlockText, projectMainTutorHistory, projectPiHistory, type ActiveBlockContext } from "../src/workbook/pi-history.js";
import type { WorkbookTimelineRecord } from "../src/workbook/timeline.js";

function record<T extends Omit<WorkbookTimelineRecord, "id" | "sequence" | "at">>(sequence: number, value: T): WorkbookTimelineRecord {
  return { ...value, id: `${sequence}`, sequence, at: `2026-08-21T00:00:0${sequence}.000Z` } as WorkbookTimelineRecord;
}

describe("workbook Pi history", () => {
  it("replays authored material as assistant history before the learner reply", () => {
    const history = projectPiHistory([
      record(1, { type: "message", lessonId: "lesson", blockId: "write", role: "assistant", source: "authored", presentation: "course", text: "## Write it\n\nUse `.tmp`." }),
      record(2, { type: "message", lessonId: "lesson", blockId: "write", role: "user", source: "learner", presentation: "chat", text: "Which path should I use?" }),
      record(3, { type: "message", lessonId: "lesson", blockId: "write", role: "assistant", source: "main_tutor", presentation: "chat", text: "Write the generated file under `.tmp`." }),
    ]);

    expect(history).toEqual({
      turns: [
        { sourceEventId: "1", role: "assistant", text: "## Write it\n\nUse `.tmp`." },
        { sourceEventId: "2", role: "user", text: "Which path should I use?" },
        { sourceEventId: "3", role: "assistant", text: "Write the generated file under `.tmp`." },
      ]
    });
  });

  it("uses the newest summary and keeps only later messages", () => {
    const history = projectPiHistory([
      record(1, { type: "message", lessonId: "lesson", blockId: "one", role: "assistant", source: "authored", presentation: "course", text: "First idea" }),
      record(2, { type: "block_summarized", lessonId: "lesson", blockId: "one", text: "Learner completed the first idea.", coveredThroughId: "1" }),
      record(3, { type: "message", lessonId: "lesson", blockId: "two", role: "assistant", source: "authored", presentation: "course", text: "Second idea" }),
      record(4, { type: "lesson_summarized", lessonId: "lesson", text: "The lesson covered the first two ideas.", coveredThroughId: "3" }),
      record(5, { type: "message", lessonId: "lesson", blockId: "three", role: "user", source: "learner", presentation: "chat", text: "Can we continue?" }),
    ]);

    expect(history).toEqual({
      summary: { sourceEventId: "4", text: "The lesson covered the first two ideas.", coveredThroughId: "3" },
      turns: [{ sourceEventId: "5", role: "user", text: "Can we continue?" }]
    });
  });

  it("formats the title and markdown the learner sees for authored history", () => {
    expect(authoredBlockText({ id: "write", type: "narrative", title: "Write it", markdown: "Use `.tmp`." }))
      .toBe("## Write it\n\nUse `.tmp`.");
  });

  it("projects active block context separately from learner-visible history", () => {
    const records: WorkbookTimelineRecord[] = [
      record(1, { type: "message", lessonId: "lesson", blockId: "complete", role: "assistant", source: "authored", presentation: "course", text: "Completed block" }),
      record(2, { type: "block_summarized", lessonId: "lesson", blockId: "complete", text: "The completed block is done.", coveredThroughId: "1" }),
      record(3, { type: "message", lessonId: "lesson", blockId: "active", role: "assistant", source: "authored", presentation: "course", text: "## Active block\n\nEdit the script." }),
      record(4, { type: "message", lessonId: "lesson", blockId: "active", role: "assistant", source: "block_tutor", presentation: "hint", text: "Try changing the generated filename." }),
    ];
    const activeContext: ActiveBlockContext = {
      lessonId: "lesson",
      blockId: "active",
      title: "Active block",
      markdown: "Edit the script.",
      authorGuidance: "Do not reveal this private rubric.",
      attempts: [
        { id: "attempt-1", lessonId: "lesson", blockId: "active", version: 1, status: "superseded", evidence: { kind: "editor", text: "first" } },
        { id: "attempt-2", lessonId: "lesson", blockId: "active", version: 2, status: "working", evidence: { kind: "editor", text: "second" } },
      ]
    };

    const publicHistory = projectPiHistory(records);
    const mainHistory = projectMainTutorHistory(records, activeContext);

    expect(publicHistory).toEqual({
      summary: { sourceEventId: "2", text: "The completed block is done.", coveredThroughId: "1" },
      turns: [
        { sourceEventId: "3", role: "assistant", text: "## Active block\n\nEdit the script." },
        { sourceEventId: "4", role: "assistant", text: "Try changing the generated filename." },
      ]
    });
    expect(JSON.stringify(publicHistory)).not.toContain("private rubric");
    expect(mainHistory.turns).toEqual(publicHistory.turns);
    expect(mainHistory.activeContext).toMatchObject({ name: "workbook-active-block", sourceEventIds: ["3", "4"] });
    expect(JSON.parse(mainHistory.activeContext?.text ?? "{}")).toMatchObject({
      lessonId: "lesson",
      blockId: "active",
      title: "Active block",
      markdown: "Edit the script.",
      authorGuidance: "Do not reveal this private rubric.",
      attempts: [
        { id: "attempt-1", version: 1, status: "superseded", evidence: { kind: "editor", text: "first" } },
        { id: "attempt-2", version: 2, status: "working", evidence: { kind: "editor", text: "second" } },
      ]
    });
  });
});
