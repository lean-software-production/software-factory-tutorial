import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { validateWorkbookLesson, validateWorkbookManifest } from "../src/workbook/contract.js";
import { loadWorkbook, loadWorkbookLesson, parseFrontMatter } from "../src/workbook/load.js";

const workspace = fileURLToPath(new URL("../../", import.meta.url));

describe("workbook lesson contract", () => {
  it("assembles lesson 001 from authored Markdown with stable ordered blocks", async () => {
    const lesson = await loadWorkbookLesson(resolve(workspace, "lessons/01-the-validation-loop/01-run-an-agent-headlessly"), "01-the-validation-loop/01-run-an-agent-headlessly");
    expect(lesson.id).toBe("01-the-validation-loop/01-run-an-agent-headlessly");
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

  it("derives the rail from ordered part and lesson directories", async () => {
    const loaded = await loadWorkbook(workspace);
    expect(loaded.identity.title).toBe("Software Factory Tutorial");
    expect(loaded.chapters[0]).toMatchObject({ id: "01-the-validation-loop/01-run-an-agent-headlessly", state: "migrated", part: "Part 1 — The validation loop" });
    expect(loaded.chapters.find((chapter) => chapter.id === "01-the-validation-loop/02-build-a-doer")?.state).toBe("unavailable");
    expect(loaded.chapters.find((chapter) => chapter.id === "02-build-the-factory/09-oversee-the-orchestrator")?.part).toBe("Part 2 — Build the factory");
  });

  it("parses front matter and prose without needing a body", () => {
    expect(parseFrontMatter("---\ntitle: X\n---\nbody text")).toEqual({ data: { title: "X" }, body: "body text" });
    expect(parseFrontMatter("no front matter")).toEqual({ data: {}, body: "no front matter" });
  });

  it("reports location-specific errors for a malformed lesson", () => {
    expect(() => validateWorkbookLesson({
      id: "x",
      hero: { title: "H", dek: "D", meta: [] },
      opening: { sectionLabel: "S", heading: "He", markdown: "M", outcomes: [] },
      blocks: [{ id: "dup", type: "terminal-practice", title: "One" }, { id: "dup", type: "mystery", title: "Two" }],
    }))
      .toThrow(/lesson\.blocks\[0\]\.command is required[\s\S]*lesson\.blocks\[1\]\.id must be unique[\s\S]*lesson\.blocks\[1\]\.type is unsupported/);
  });

  it("reports location-specific errors for a malformed manifest", () => {
    expect(() => validateWorkbookManifest({ title: "" }))
      .toThrow(/workbook\.title is required/);
  });
});
