import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { validateWorkbookLesson, validateWorkbookManifest } from "../src/workbook/contract.js";
import { loadWorkbook, loadWorkbookLesson, parseFrontMatter } from "../src/workbook/load.js";

const workspace = fileURLToPath(new URL("../../", import.meta.url));

describe("workbook lesson contract", () => {
  it("assembles lesson 001 from authored Markdown with stable ordered blocks", async () => {
    const lesson = await loadWorkbookLesson(workspace, "lessons/001");
    expect(lesson.id).toBe("001");
    expect(lesson.status).toBe("draft");
    expect(lesson.hero.title).toBe("Run an agent headlessly");
    expect(lesson.hero.meta).toContain("Your terminal");
    expect(lesson.opening.heading).toBe("A job, a harness, and a boundary.");
    expect(lesson.opening.outcomes.length).toBeGreaterThan(0);
    expect(lesson.opening.markdown).toMatch(/harness with a job to be done/);
    expect(lesson.blocks.map((block) => [block.id, block.type])).toEqual([
      ["orientation", "narrative"],
      ["run-supplied-command", "terminal-practice"],
      ["change-job", "terminal-practice"],
      ["reflection", "reflection"],
      ["transition", "lesson-transition"],
    ]);
    const orientation = lesson.blocks[0];
    if (orientation?.type !== "narrative") throw new Error("orientation must be narrative");
    expect(orientation.markdown).toMatch(/An \*\*agent\*\* is a harness/);
  });

  it("derives the rail from workbook.yaml, independent of docs/specs", async () => {
    const loaded = await loadWorkbook(workspace);
    expect(loaded.identity.title).toBe("Software factory workbook");
    expect(loaded.chapters[0]).toMatchObject({ id: "001", state: "migrated", part: "Part 1 — The validation loop" });
    expect(loaded.chapters.find((chapter) => chapter.id === "002")?.state).toBe("unavailable");
    expect(loaded.chapters.find((chapter) => chapter.id === "013")?.part).toBe("Part 2 — Build the factory");
  });

  it("parses front matter and prose without needing a body", () => {
    expect(parseFrontMatter("---\ntitle: X\n---\nbody text")).toEqual({ data: { title: "X" }, body: "body text" });
    expect(parseFrontMatter("no front matter")).toEqual({ data: {}, body: "no front matter" });
  });

  it("reports location-specific errors for a malformed lesson", () => {
    expect(() => validateWorkbookLesson({
      id: "x", status: "draft",
      hero: { title: "H", dek: "D", meta: [] },
      opening: { sectionLabel: "S", heading: "He", markdown: "M", outcomes: [] },
      blocks: [{ id: "dup", type: "terminal-practice", title: "One" }, { id: "dup", type: "mystery", title: "Two" }],
    }))
      .toThrow(/lesson\.blocks\[0\]\.command is required[\s\S]*lesson\.blocks\[1\]\.id must be unique[\s\S]*lesson\.blocks\[1\]\.type is unsupported/);
  });

  it("reports location-specific errors for a malformed manifest", () => {
    expect(() => validateWorkbookManifest({ title: "", brand: "B", tocTitle: "T", introduction: "i.md", parts: [{ name: "", lessons: [{ id: "", title: "" }] }] }))
      .toThrow(/workbook\.title is required[\s\S]*workbook\.parts\[0\]\.name is required[\s\S]*workbook\.parts\[0\]\.lessons\[0\]\.id is required/);
  });
});
