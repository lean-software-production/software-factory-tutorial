import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateWorkbookLesson, validateWorkbookManifest } from "../src/workbook/contract.js";
import { loadWorkbook, loadWorkbookLesson, parseFrontMatter } from "../src/workbook/load.js";

let dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); dirs = []; });

/**
 * Author a self-contained workbook whose every string is synthetic, so these
 * tests exercise front-matter assembly and directory-driven discovery without
 * coupling to a single authored word of the root curriculum. Two ordered parts,
 * a migrated lesson with a full lesson.yaml, and lessons without one prove both
 * the rail's ordering and the migrated/unavailable split.
 */
async function fixture() {
  const dir = await mkdtemp(resolve(tmpdir(), "workbook-contract-")); dirs.push(dir);
  await writeFile(resolve(dir, "workbook.md"), ["---", "title: Fixture Workbook Identity", "---", "Fixture introduction prose."].join("\n"));

  const alpha = resolve(dir, "lessons/02-alpha-part");
  const beta = resolve(dir, "lessons/01-beta-part");
  await mkdir(resolve(alpha, "10-first-lesson/blocks"), { recursive: true });
  await mkdir(resolve(alpha, "02-second-lesson"), { recursive: true });
  await mkdir(resolve(beta, "01-beta-lesson"), { recursive: true });
  await writeFile(resolve(alpha, "part.md"), "# Second Part Title\n");
  await writeFile(resolve(beta, "part.md"), "# First Part Title\n");

  const migrated = resolve(alpha, "10-first-lesson");
  await writeFile(resolve(migrated, "lesson.yaml"), [
    "hero: hero.md", "opening: opening.md", "blocks:",
    "  - id: intro", "    type: narrative", "    required: true", "    source: blocks/intro.md",
    "  - id: practice", "    type: terminal-practice", "    required: true", "    source: blocks/practice.md",
    "  - id: think", "    type: reflection", "    required: true", "    source: blocks/think.md",
    "  - id: onward", "    type: lesson-transition", "    required: true", "    source: blocks/onward.md",
  ].join("\n"));
  await writeFile(resolve(migrated, "hero.md"), ["---", "title: Synthetic Hero Title", "dek: Synthetic dek line.", "meta:", "  - Synthetic chip one", "  - Synthetic chip two", "---"].join("\n"));
  await writeFile(resolve(migrated, "opening.md"), ["---", "sectionLabel: Synthetic label", "heading: Synthetic heading.", "outcomes:", "  - Synthetic outcome.", "---", "Synthetic **opening** payoff prose."].join("\n"));
  await writeFile(resolve(migrated, "blocks/intro.md"), ["---", "title: Intro Block", "---", "Synthetic narrative body."].join("\n"));
  await writeFile(resolve(migrated, "blocks/practice.md"), ["---", "title: Practice Block", "command: synthetic-command", "context: Synthetic context", "expectedObservation: Synthetic observation", "terminalMode: observed-embedded-optional", "---"].join("\n"));
  await writeFile(resolve(migrated, "blocks/think.md"), ["---", "title: Reflect Block", "prompt: Synthetic prompt?", "---"].join("\n"));
  await writeFile(resolve(migrated, "blocks/onward.md"), ["---", "title: Onward Block", "label: Synthetic label", "---", "Synthetic transition body."].join("\n"));

  // A lesson with only a hero and no lesson.yaml stays unavailable.
  await writeFile(resolve(alpha, "02-second-lesson/hero.md"), "# Synthetic Second Lesson\n");
  await writeFile(resolve(beta, "01-beta-lesson/hero.md"), "# Synthetic Beta Lesson\n");
  return dir;
}

describe("workbook lesson contract", () => {
  it("assembles a lesson from authored Markdown with stable ordered blocks", async () => {
    const dir = await fixture();
    const lesson = await loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "02-alpha-part/10-first-lesson");
    expect(lesson.id).toBe("02-alpha-part/10-first-lesson");
    expect(lesson.hero).toMatchObject({ title: "Synthetic Hero Title", dek: "Synthetic dek line.", meta: ["Synthetic chip one", "Synthetic chip two"] });
    expect(lesson.opening).toMatchObject({ sectionLabel: "Synthetic label", heading: "Synthetic heading.", outcomes: ["Synthetic outcome."] });
    expect(lesson.opening.markdown).toBe("Synthetic **opening** payoff prose.");
    expect(lesson.blocks.map((block) => [block.id, block.type])).toEqual([
      ["intro", "narrative"],
      ["practice", "terminal-practice"],
      ["think", "reflection"],
      ["onward", "lesson-transition"],
    ]);
    const intro = lesson.blocks[0];
    if (intro?.type !== "narrative") throw new Error("intro must be narrative");
    expect(intro.markdown).toBe("Synthetic narrative body.");
    const practice = lesson.blocks[1];
    if (practice?.type !== "terminal-practice") throw new Error("practice must be terminal-practice");
    expect(practice.command).toBe("synthetic-command");
    expect(practice.terminalMode).toBe("observed-embedded-optional");
  });

  it("defaults terminal practice blocks to the external terminal mode", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/blocks/practice.md"), ["---", "title: Practice Block", "command: synthetic-command", "context: Synthetic context", "expectedObservation: Synthetic observation", "---"].join("\n"));
    const lesson = await loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "fixture/lesson");
    const practice = lesson.blocks.find((block) => block.type === "terminal-practice");
    expect(practice?.type === "terminal-practice" && practice.terminalMode).toBe("external");
  });

  it("derives the rail from ordered part and lesson directories", async () => {
    const dir = await fixture();
    const loaded = await loadWorkbook(dir);
    expect(loaded.identity.title).toBe("Fixture Workbook Identity");
    expect(loaded.introduction).toBe("Fixture introduction prose.");
    // Parts sort by directory name, so 01-beta-part precedes 02-alpha-part.
    expect(loaded.chapters.map((chapter) => [chapter.id, chapter.part, chapter.state])).toEqual([
      ["01-beta-part/01-beta-lesson", "First Part Title", "unavailable"],
      ["02-alpha-part/02-second-lesson", "Second Part Title", "unavailable"],
      ["02-alpha-part/10-first-lesson", "Second Part Title", "migrated"],
    ]);
    const migrated = loaded.chapters.find((chapter) => chapter.id === "02-alpha-part/10-first-lesson");
    expect(migrated?.lesson?.hero.title).toBe("Synthetic Hero Title");
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
