import { describe, expect, it } from "vitest";
import { authoredBlockText, projectMainTutorHistory, projectPiHistory, type ActiveBlockContext } from "../src/workbook/pi-history.js";
import type { WorkbookTimelineRecord } from "../src/workbook/timeline.js";

function timestamp(sequence: number): string {
  return `2026-08-21T00:00:${String(sequence).padStart(2, "0")}.000Z`;
}

function record<T extends Omit<WorkbookTimelineRecord, "id" | "sequence" | "at">>(id: string, sequence: number, value: T): WorkbookTimelineRecord {
  return { ...value, id, sequence, at: timestamp(sequence) } as WorkbookTimelineRecord;
}

describe("workbook Pi history", () => {
  it("replays authored material as assistant history before the learner reply", () => {
    const history = projectPiHistory([
      record("1", 1, { type: "message", lessonId: "lesson", blockId: "write", role: "assistant", source: "authored", presentation: "course", text: "## Write it\n\nUse `.tmp`." }),
      record("2", 2, { type: "message", lessonId: "lesson", blockId: "write", role: "user", source: "learner", presentation: "chat", text: "Which path should I use?" }),
      record("3", 3, { type: "message", lessonId: "lesson", blockId: "write", role: "assistant", source: "main_tutor", presentation: "chat", text: "Write the generated file under `.tmp`." }),
    ]);

    expect(history).toEqual({
      summaries: [],
      turns: [
        { sourceEventId: "1", role: "assistant", text: "## Write it\n\nUse `.tmp`.", timestamp: Date.parse("2026-08-21T00:00:01.000Z") },
        { sourceEventId: "2", role: "user", text: "Which path should I use?", timestamp: Date.parse("2026-08-21T00:00:02.000Z") },
        { sourceEventId: "3", role: "assistant", text: "Write the generated file under `.tmp`.", timestamp: Date.parse("2026-08-21T00:00:03.000Z") },
      ]
    });
  });

  it("projects completed lesson and block summaries followed by active block turns", () => {
    const history = projectPiHistory([
      record("lesson-one-start", 1, { type: "message", lessonId: "lesson-one", blockId: "intro", role: "assistant", source: "authored", presentation: "course", text: "Lesson one start." }),
      record("lesson-one-learner", 2, { type: "message", lessonId: "lesson-one", blockId: "intro", role: "user", source: "learner", presentation: "chat", text: "I tried it." }),
      record("lesson-one-tutor", 3, { type: "message", lessonId: "lesson-one", blockId: "intro", role: "assistant", source: "main_tutor", presentation: "chat", text: "Good." }),
      record("lesson-one-end", 4, { type: "message", lessonId: "lesson-one", blockId: "wrap", role: "assistant", source: "authored", presentation: "course", text: "Lesson one end." }),
      record("lesson-one-summary", 5, { type: "lesson_summarized", lessonId: "lesson-one", text: "Lesson one summary.", coveredThroughId: "lesson-one-end" }),
      record("block-one-start", 6, { type: "message", lessonId: "lesson-two", blockId: "one", role: "assistant", source: "authored", presentation: "course", text: "Block one start." }),
      record("block-one-end", 7, { type: "message", lessonId: "lesson-two", blockId: "one", role: "user", source: "learner", presentation: "chat", text: "Finished block one." }),
      record("block-one-summary", 8, { type: "block_summarized", lessonId: "lesson-two", blockId: "one", text: "Block one summary.", coveredThroughId: "block-one-end" }),
      record("block-two-end", 10, { type: "message", lessonId: "lesson-two", blockId: "two", role: "assistant", source: "main_tutor", presentation: "chat", text: "Finished block two." }),
      record("block-two-summary", 11, { type: "block_summarized", lessonId: "lesson-two", blockId: "two", text: "Block two summary.", coveredThroughId: "block-two-end" }),
      record("active-authored", 12, { type: "message", lessonId: "lesson-two", blockId: "three", role: "assistant", source: "authored", presentation: "course", text: "## Active block" }),
      record("active-learner", 13, { type: "message", lessonId: "lesson-two", blockId: "three", role: "user", source: "learner", presentation: "chat", text: "What should I try next?" }),
    ]);

    expect(history.summaries).toEqual([
      {
        sourceEventId: "lesson-one-summary",
        scope: "lesson",
        lessonId: "lesson-one",
        text: "Lesson one summary.",
        coveredThroughId: "lesson-one-end",
        timestamp: Date.parse("2026-08-21T00:00:05.000Z")
      },
      {
        sourceEventId: "block-one-summary",
        scope: "block",
        lessonId: "lesson-two",
        blockId: "one",
        text: "Block one summary.",
        coveredThroughId: "block-one-end",
        timestamp: Date.parse("2026-08-21T00:00:08.000Z")
      },
      {
        sourceEventId: "block-two-summary",
        scope: "block",
        lessonId: "lesson-two",
        blockId: "two",
        text: "Block two summary.",
        coveredThroughId: "block-two-end",
        timestamp: Date.parse("2026-08-21T00:00:11.000Z")
      }
    ]);
    expect(history.turns).toEqual([
      {
        sourceEventId: "active-authored",
        role: "assistant",
        text: "## Active block",
        timestamp: Date.parse("2026-08-21T00:00:12.000Z")
      },
      {
        sourceEventId: "active-learner",
        role: "user",
        text: "What should I try next?",
        timestamp: Date.parse("2026-08-21T00:00:13.000Z")
      }
    ]);
  });

  it("lets a later lesson summary replace earlier block summaries for that lesson", () => {
    const history = projectPiHistory([
      record("lesson-one-end", 1, { type: "message", lessonId: "lesson-one", blockId: "wrap", role: "assistant", source: "authored", presentation: "course", text: "Lesson one end." }),
      record("lesson-one-summary", 2, { type: "lesson_summarized", lessonId: "lesson-one", text: "Earlier lesson summary.", coveredThroughId: "lesson-one-end" }),
      record("lesson-two-block-one-end", 3, { type: "message", lessonId: "lesson-two", blockId: "one", role: "assistant", source: "main_tutor", presentation: "chat", text: "Block one end." }),
      record("lesson-two-block-one-summary", 4, { type: "block_summarized", lessonId: "lesson-two", blockId: "one", text: "Block one summary.", coveredThroughId: "lesson-two-block-one-end" }),
      record("lesson-two-end", 5, { type: "message", lessonId: "lesson-two", blockId: "two", role: "assistant", source: "main_tutor", presentation: "chat", text: "Lesson two end." }),
      record("lesson-two-block-two-summary", 6, { type: "block_summarized", lessonId: "lesson-two", blockId: "two", text: "Block two summary.", coveredThroughId: "lesson-two-end" }),
      record("lesson-two-summary", 7, { type: "lesson_summarized", lessonId: "lesson-two", text: "Lesson two summary.", coveredThroughId: "lesson-two-end" }),
      record("active-authored", 8, { type: "message", lessonId: "lesson-three", blockId: "active", role: "assistant", source: "authored", presentation: "course", text: "Next lesson." }),
    ]);

    expect(history.summaries).toEqual([
      {
        sourceEventId: "lesson-one-summary",
        scope: "lesson",
        lessonId: "lesson-one",
        text: "Earlier lesson summary.",
        coveredThroughId: "lesson-one-end",
        timestamp: Date.parse("2026-08-21T00:00:02.000Z")
      },
      {
        sourceEventId: "lesson-two-summary",
        scope: "lesson",
        lessonId: "lesson-two",
        text: "Lesson two summary.",
        coveredThroughId: "lesson-two-end",
        timestamp: Date.parse("2026-08-21T00:00:07.000Z")
      }
    ]);
    expect(history.turns).toEqual([
      { sourceEventId: "active-authored", role: "assistant", text: "Next lesson.", timestamp: Date.parse("2026-08-21T00:00:08.000Z") }
    ]);
  });

  it("formats the title and markdown the learner sees for authored history", () => {
    expect(authoredBlockText({ title: "Write it", markdown: "Use `.tmp`." }))
      .toBe("## Write it\n\nUse `.tmp`.");
  });

  it("projects active block context separately from learner-visible history", () => {
    const records: WorkbookTimelineRecord[] = [
      record("1", 1, { type: "message", lessonId: "lesson", blockId: "complete", role: "assistant", source: "authored", presentation: "course", text: "Completed block" }),
      record("2", 2, { type: "block_summarized", lessonId: "lesson", blockId: "complete", text: "The completed block is done.", coveredThroughId: "1" }),
      record("3", 3, { type: "message", lessonId: "lesson", blockId: "active", role: "assistant", source: "authored", presentation: "course", text: "## Active block\n\nEdit the script." }),
      record("4", 4, { type: "message", lessonId: "lesson", blockId: "active", role: "assistant", source: "block_tutor", presentation: "hint", text: "Try changing the generated filename." }),
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
      summaries: [
        {
          sourceEventId: "2",
          scope: "block",
          lessonId: "lesson",
          blockId: "complete",
          text: "The completed block is done.",
          coveredThroughId: "1",
          timestamp: Date.parse("2026-08-21T00:00:02.000Z")
        }
      ],
      turns: [
        { sourceEventId: "3", role: "assistant", text: "## Active block\n\nEdit the script.", timestamp: Date.parse("2026-08-21T00:00:03.000Z") },
        { sourceEventId: "4", role: "assistant", text: "Try changing the generated filename.", timestamp: Date.parse("2026-08-21T00:00:04.000Z") },
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
