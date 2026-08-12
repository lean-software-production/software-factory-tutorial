import { describe, expect, it } from "vitest";
import { validateWorkbookLesson } from "../src/workbook/contract.js";
import { lesson001 } from "../src/workbook/lesson-001.js";

describe("workbook lesson contract", () => {
  it("accepts the lesson-001 vertical-slice contract with stable ordered blocks", () => {
    expect(lesson001.id).toBe("001");
    expect(lesson001.status).toBe("draft");
    expect(lesson001.blocks.map((block) => [block.id, block.type])).toEqual([
      ["orientation", "narrative"],
      ["run-supplied-command", "terminal-practice"],
      ["change-job", "terminal-practice"],
      ["reflection", "reflection"],
      ["transition", "lesson-transition"],
    ]);
  });

  it("reports location-specific errors for malformed manifests", () => {
    expect(() => validateWorkbookLesson({ id: "x", title: "Bad", status: "draft", keyConcepts: [], learningOutcomes: [], blocks: [{ id: "dup", type: "terminal-practice", title: "One" }, { id: "dup", type: "mystery", title: "Two" }] }))
      .toThrow(/lesson\.blocks\[0\]\.command is required[\s\S]*lesson\.blocks\[1\]\.id must be unique[\s\S]*lesson\.blocks\[1\]\.type is unsupported/);
  });
});
