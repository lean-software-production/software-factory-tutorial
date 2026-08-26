import { describe, expect, it } from "vitest";
import {
  authoredBlockText,
  authoredIntroductionText,
  authoredLessonFrameText,
  authoredPartText,
} from "../src/workbook/pi-history.js";
import type { LoadedWorkbook } from "../src/workbook/load.js";
import { blockText, buildWorkbookBlockStream } from "../src/workbook/workbook-blocks.js";

const loaded: LoadedWorkbook = {
  workspace: "/workbook",
  identity: { title: "Validation loops" },
  introduction: "Welcome to the workbook.",
  chapters: [{
    id: "001-orientation",
    title: "Orientation",
    partId: "part-one",
    part: "Part one",
    partMarkdown: "Build one small loop.",
    partNumber: 1,
    lessonNumber: 1,
    lesson: {
      id: "001-orientation",
      title: "Orientation",
      dek: "Start with the smallest useful loop.",
      introduction: "Then make its evidence visible.",
      durationMinutes: 5,
      outcomes: ["Identify a loop."],
      blocks: [{
        id: "read",
        type: "narrative",
        title: "Read the result",
        markdown: "Inspect the evidence.",
      }],
    },
  }],
};

describe("authored workbook text", () => {
  it("keeps the workbook stream and Pi history text in exact parity", () => {
    const stream = buildWorkbookBlockStream(loaded);
    const lesson = loaded.chapters[0]!.lesson;
    const declared = lesson.blocks[0]!;
    const artefacts = [
      {
        name: "workbook introduction",
        block: stream.find((block) => block.kind === "workbook-introduction")!,
        historyText: authoredIntroductionText(loaded.identity, loaded.introduction),
        expected: "# Validation loops\n\nWelcome to the workbook.",
      },
      {
        name: "part preamble",
        block: stream.find((block) => block.kind === "part-preamble")!,
        historyText: authoredPartText({ title: "Part one", markdown: "Build one small loop." }),
        expected: "# Part one\n\nBuild one small loop.",
      },
      {
        name: "lesson frame",
        block: stream.find((block) => block.kind === "lesson-preamble")!,
        historyText: authoredLessonFrameText(lesson),
        expected: "# Orientation\n\nStart with the smallest useful loop.\n\n## What you will learn\n\n- Identify a loop.\n\nThen make its evidence visible.",
      },
      {
        name: "declared block",
        block: stream.find((block) => block.origin === "declared")!,
        historyText: authoredBlockText(declared),
        expected: "## Read the result\n\nInspect the evidence.",
      },
    ];

    for (const artefact of artefacts) {
      expect(blockText(artefact.block, loaded.identity.title), artefact.name).toBe(artefact.expected);
      expect(artefact.historyText, artefact.name).toBe(artefact.expected);
    }
  });
});
