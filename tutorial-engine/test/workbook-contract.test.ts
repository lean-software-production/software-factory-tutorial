import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  validateBlockFrontMatter,
  validateLessonFrontMatter,
  validatePartManifest,
  validateWorkbookLesson,
  validateWorkbookManifest,
} from "../src/workbook/contract.js";
import { loadWorkbook, loadWorkbookLesson, parseFrontMatter } from "../src/workbook/load.js";

let dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))); dirs = []; });

const learnerVisibleAuthorDirections = [
  /\b(?:have|ask|tell)\s+the\s+learner\b/i,
  /\bshow\s+this\s+diagram\b/i,
  /\bthe\s+tutor\s+must\b/i,
  /\bteach\s+and\s+build\b/i,
  /\bbuild\s+this\s+lesson\b/i,
  /\bsay\s+this\s+out\s+loud\s+in\s+the\s+lesson\b/i,
  /\bsay\s+plainly\s+why\s+this\s+is\s+in\s+the\s+lesson\b/i,
];
function exposesAuthorDirection(markdown: string) { return learnerVisibleAuthorDirections.some((pattern) => pattern.test(markdown)); }

/**
 * Author a self-contained workbook whose every string is synthetic, so these
 * tests exercise front-matter assembly and directory-driven discovery without
 * coupling to a single authored word of the root curriculum. Two ordered
 * parts and one fully migrated lesson prove ordering and convention-based
 * block discovery.
 */
async function fixture() {
  const dir = await mkdtemp(resolve(tmpdir(), "workbook-contract-")); dirs.push(dir);
  await writeFile(resolve(dir, "workbook.md"), ["---", "---", "# Fixture Workbook Identity", "", "Fixture introduction prose."].join("\n"));

  const alpha = resolve(dir, "lessons/02-alpha-part");
  const beta = resolve(dir, "lessons/01-beta-part");
  await mkdir(resolve(alpha, "10-first-lesson/blocks"), { recursive: true });
  await mkdir(resolve(beta, "01-beta-lesson/blocks"), { recursive: true });
  await writeFile(resolve(alpha, "part.md"), "---\n---\n# Second Part Title\n\nSecond part copy.\n");
  await writeFile(resolve(beta, "part.md"), "---\n---\n# First Part Title\n\nFirst part copy.\n");

  const migrated = resolve(alpha, "10-first-lesson");
  await writeFile(resolve(migrated, "lesson.md"), [
    "---",
    "durationMinutes: 12",
    "outcomes:",
    "  - Synthetic outcome one.",
    "  - Synthetic outcome two.",
    "blocks:",
    "  - intro",
    "  - practice",
    "  - think",
    "  - onward",
    "---",
    "# Synthetic Lesson Title",
    "",
    "Synthetic dek paragraph.",
  ].join("\n"));
  await writeFile(resolve(migrated, "blocks/intro.md"), ["---", "type: narrative", "---", "## Intro Block", "", "Synthetic narrative body."].join("\n"));
  await writeFile(resolve(migrated, "blocks/practice.md"), ["---", "type: terminal-practice", "tutor: Synthetic tutor guidance.", "---", "## Practice Block", "", "Synthetic practice body."].join("\n"));
  await writeFile(resolve(migrated, "blocks/think.md"), ["---", "type: reflection", "tutor: Synthetic tutor guidance.", "---", "## Reflect Block", "", "Synthetic reflection question?"].join("\n"));
  await writeFile(resolve(migrated, "blocks/onward.md"), ["---", "type: lesson-transition", "---", "## Onward Block", "", "Synthetic transition body."].join("\n"));

  const second = resolve(beta, "01-beta-lesson");
  await writeFile(resolve(second, "lesson.md"), [
    "---", "durationMinutes: 5", "outcomes:", "  - Beta outcome.", "blocks:", "  - only", "---",
    "# Beta Lesson Title", "", "Beta dek paragraph.",
  ].join("\n"));
  await writeFile(resolve(second, "blocks/only.md"), ["---", "type: narrative", "---", "## Only Block", "", "Beta body."].join("\n"));
  return dir;
}

describe("workbook lesson contract", () => {
  it("assembles a lesson from authored Markdown with stable ordered blocks", async () => {
    const dir = await fixture();
    const lesson = await loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "02-alpha-part/10-first-lesson");
    expect(lesson.id).toBe("02-alpha-part/10-first-lesson");
    expect(lesson.title).toBe("Synthetic Lesson Title");
    expect(lesson.dek).toBe("Synthetic dek paragraph.");
    expect(lesson.durationMinutes).toBe(12);
    expect(lesson.outcomes).toEqual(["Synthetic outcome one.", "Synthetic outcome two."]);
    expect(lesson.blocks.map((block) => [block.id, block.type, block.title])).toEqual([
      ["intro", "narrative", "Intro Block"],
      ["practice", "terminal-practice", "Practice Block"],
      ["think", "reflection", "Reflect Block"],
      ["onward", "lesson-transition", "Onward Block"],
    ]);
    const intro = lesson.blocks[0];
    if (intro?.type !== "narrative") throw new Error("intro must be narrative");
    expect(intro.markdown).toBe("Synthetic narrative body.");
    const practice = lesson.blocks[1];
    if (practice?.type !== "terminal-practice") throw new Error("practice must be terminal-practice");
    expect(practice.tutor).toBe("Synthetic tutor guidance.");
    expect(practice.markdown).toBe("Synthetic practice body.");
    // The private tutor field never appears on narrative or transition blocks.
    expect((intro as any).tutor).toBeUndefined();
    expect((lesson.blocks[3] as any).tutor).toBeUndefined();
  });

  it("derives the rail from ordered part and lesson directories", async () => {
    const dir = await fixture();
    const loaded = await loadWorkbook(dir);
    expect(loaded.identity.title).toBe("Fixture Workbook Identity");
    expect(loaded.introduction).toBe("Fixture introduction prose.");
    // Parts sort by directory name, so 01-beta-part precedes 02-alpha-part.
    expect(loaded.chapters.map((chapter) => [chapter.id, chapter.part, chapter.title])).toEqual([
      ["01-beta-part/01-beta-lesson", "First Part Title", "Beta Lesson Title"],
      ["02-alpha-part/10-first-lesson", "Second Part Title", "Synthetic Lesson Title"],
    ]);
    const first = loaded.chapters.find((chapter) => chapter.id === "02-alpha-part/10-first-lesson");
    expect(first?.lesson.title).toBe("Synthetic Lesson Title");
    expect(first?.partMarkdown).toBe("Second part copy.");
  });

  it("loads the real migrated lesson 001 content unchanged", async () => {
    const lessonDir = resolve(import.meta.dirname, "../../lessons/01-the-validation-loop/01-run-an-agent-headlessly");
    const lesson = await loadWorkbookLesson(lessonDir, "01-the-validation-loop/01-run-an-agent-headlessly");
    expect(lesson.title).toBe("Run an agent headlessly");
    expect(lesson.durationMinutes).toBe(10);
    expect(lesson.blocks.map((block) => block.id)).toEqual(["orientation", "run-supplied-command", "change-job", "reflection", "transition"]);
    const practice = lesson.blocks.find((block) => block.id === "run-supplied-command");
    if (practice?.type !== "terminal-practice") throw new Error("run-supplied-command must be terminal-practice");
    expect(practice.tutor.length).toBeGreaterThan(0);
    expect(practice.markdown).toContain("pi --no-session");
  });

  it("keeps real curriculum block Markdown learner-facing", async () => {
    const workbook = await loadWorkbook(resolve(import.meta.dirname, "../.."));
    const offenders = workbook.chapters.flatMap((chapter) =>
      chapter.lesson.blocks
        .filter((block) => exposesAuthorDirection(block.markdown))
        .map((block) => `${chapter.id}/blocks/${block.id}`));

    expect(offenders).toEqual([]);
  });

  it("allows ordinary learner-facing examples that mention learner vocabulary", () => {
    expect(exposesAuthorDirection('The output may include "learner changed calculator.py" after the script runs.')).toBe(false);
  });

  it("rejects author directions in learner-visible block Markdown", () => {
    expect(exposesAuthorDirection("Ask the learner to explain why the validator is read-only.")).toBe(true);
    expect(exposesAuthorDirection("The tutor must check the command output before moving on.")).toBe(true);
  });

  it("parses front matter and requires it even when empty", () => {
    expect(parseFrontMatter("---\ntitle: X\n---\nbody text")).toEqual({ data: { title: "X" }, body: "body text" });
    expect(parseFrontMatter("---\n---\nbody text")).toEqual({ data: {}, body: "body text" });
    expect(() => parseFrontMatter("no front matter")).toThrow(/front matter/i);
  });

  it("rejects a lesson without exactly one H1 title heading", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/lesson.md"), [
      "---", "durationMinutes: 12", "outcomes:", "  - X", "blocks:", "  - intro", "---",
      "No heading at all, just a dek paragraph.",
    ].join("\n"));
    await expect(loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "id")).rejects.toThrow(/exactly one H1/i);
  });

  it("rejects a lesson with two H1 title headings", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/lesson.md"), [
      "---", "durationMinutes: 12", "outcomes:", "  - X", "blocks:", "  - intro", "---",
      "# First Title", "", "Dek.", "", "# Second Title",
    ].join("\n"));
    await expect(loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "id")).rejects.toThrow(/exactly one H1/i);
  });

  it("rejects lesson prose before its H1 title heading", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/lesson.md"), [
      "---", "durationMinutes: 12", "outcomes:", "  - X", "blocks:", "  - intro", "  - practice", "  - think", "  - onward", "---",
      "This prose appears before the title and must not become the dek.", "", "# Title",
    ].join("\n"));
    await expect(loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "id")).rejects.toThrow(/content before the H1 title/i);
  });

  it("rejects extra lesson body content after the dek paragraph", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/lesson.md"), [
      "---", "durationMinutes: 12", "outcomes:", "  - X", "blocks:", "  - intro", "---",
      "# Title", "", "Dek paragraph.", "", "Extra lesson body that belongs in a block.",
    ].join("\n"));
    await expect(loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "id")).rejects.toThrow(/extra content after the dek/i);
  });

  it("rejects a block without exactly one H2 title heading", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/blocks/intro.md"), ["---", "type: narrative", "---", "# Wrong Level", "", "Body."].join("\n"));
    await expect(loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "id")).rejects.toThrow(/exactly one H2/i);
  });

  it("rejects block prose before its H2 title heading", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/blocks/intro.md"), ["---", "type: narrative", "---", "Body before title.", "", "## Intro", "", "Body after title."].join("\n"));
    await expect(loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "id")).rejects.toThrow(/content before the H2 title/i);
  });

  it("rejects a lesson.md that lists a block file which does not exist", async () => {
    const dir = await fixture();
    const lessonDir = resolve(dir, "lessons/02-alpha-part/10-first-lesson");
    // Remove the other authored block files so the only mismatch under test is the missing one.
    await Promise.all(["practice", "think", "onward"].map((id) => unlink(resolve(lessonDir, `blocks/${id}.md`))));
    await writeFile(resolve(lessonDir, "lesson.md"), [
      "---", "durationMinutes: 12", "outcomes:", "  - X", "blocks:", "  - intro", "  - missing-block", "---",
      "# Title", "", "Dek.",
    ].join("\n"));
    await expect(loadWorkbookLesson(lessonDir, "id")).rejects.toThrow(/missing-block/);
  });

  it("rejects a lesson.md that duplicates a block id", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/lesson.md"), [
      "---", "durationMinutes: 12", "outcomes:", "  - X", "blocks:", "  - intro", "  - intro", "---",
      "# Title", "", "Dek.",
    ].join("\n"));
    await expect(loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "id")).rejects.toThrow(/more than once|duplicate/i);
  });

  it("rejects a blocks/ directory that contains a file unlisted in front matter", async () => {
    const dir = await fixture();
    await writeFile(resolve(dir, "lessons/02-alpha-part/10-first-lesson/blocks/extra.md"), ["---", "type: narrative", "---", "## Extra", "", "Body."].join("\n"));
    await expect(loadWorkbookLesson(resolve(dir, "lessons/02-alpha-part/10-first-lesson"), "id")).rejects.toThrow(/extra/);
  });

  it("rejects a lesson.md that is missing entirely", async () => {
    const dir = await fixture();
    const empty = resolve(dir, "lessons/02-alpha-part/20-empty-lesson");
    await mkdir(resolve(empty, "blocks"), { recursive: true });
    await expect(loadWorkbookLesson(empty, "id")).rejects.toThrow();
  });

  it("reports location-specific errors for malformed lesson front matter", () => {
    let message = "";
    try { validateLessonFrontMatter({ durationMinutes: "twelve", outcomes: [], blocks: [], extra: true }, "lessons/x/lesson.md"); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toMatch(/lessons\/x\/lesson\.md: unknown front matter field "extra"/);
    expect(message).toMatch(/lessons\/x\/lesson\.md: durationMinutes must be a positive number/);
    expect(message).toMatch(/lessons\/x\/lesson\.md: outcomes must be a non-empty list/);
    expect(message).toMatch(/lessons\/x\/lesson\.md: blocks must be a non-empty ordered list/);
  });

  it("rejects an outcomes list containing a non-string or empty entry", () => {
    expect(() => validateLessonFrontMatter({ durationMinutes: 5, outcomes: ["Fine.", ""], blocks: ["a"] }, "lesson.md")).toThrow(/outcomes/);
    expect(() => validateLessonFrontMatter({ durationMinutes: 5, outcomes: ["Fine.", 4], blocks: ["a"] }, "lesson.md")).toThrow(/outcomes/);
  });

  it("rejects malformed block ids", () => {
    expect(() => validateLessonFrontMatter({ durationMinutes: 5, outcomes: ["X"], blocks: ["Bad Id!"] }, "lesson.md")).toThrow(/blocks/);
  });

  it("requires a non-empty tutor field for terminal-practice and reflection blocks", () => {
    expect(() => validateBlockFrontMatter({ type: "terminal-practice" }, "blocks/x.md")).toThrow(/tutor/);
    expect(() => validateBlockFrontMatter({ type: "reflection", tutor: "   " }, "blocks/x.md")).toThrow(/tutor/);
    expect(validateBlockFrontMatter({ type: "terminal-practice", tutor: "Do X." }, "blocks/x.md")).toEqual({ type: "terminal-practice", tutor: "Do X." });
  });

  it("rejects a tutor field on narrative and lesson-transition blocks", () => {
    expect(() => validateBlockFrontMatter({ type: "narrative", tutor: "Not allowed." }, "blocks/x.md")).toThrow(/tutor/);
    expect(() => validateBlockFrontMatter({ type: "lesson-transition", tutor: "Not allowed." }, "blocks/x.md")).toThrow(/tutor/);
  });

  it("rejects an unsupported block type", () => {
    expect(() => validateBlockFrontMatter({ type: "mystery" }, "blocks/x.md")).toThrow(/type/);
  });

  it("rejects unknown front matter fields on blocks", () => {
    expect(() => validateBlockFrontMatter({ type: "narrative", command: "echo hi" }, "blocks/x.md")).toThrow(/unknown front matter field "command"/);
  });

  it("requires workbook and part front matter to be an empty map, since no fields are defined yet", () => {
    expect(validateWorkbookManifest({}, "workbook.md")).toEqual({});
    expect(() => validateWorkbookManifest({ title: "X" }, "workbook.md")).toThrow(/unknown front matter field "title"/);
    expect(validatePartManifest({}, "lessons/x/part.md")).toEqual({});
    expect(() => validatePartManifest({ order: 1 }, "lessons/x/part.md")).toThrow(/unknown front matter field "order"/);
  });

  it("reports location-specific errors for a malformed assembled lesson", () => {
    expect(() => validateWorkbookLesson({
      id: "x",
      title: "Title",
      dek: "Dek",
      durationMinutes: 5,
      outcomes: ["Outcome."],
      blocks: [
        { id: "dup", type: "terminal-practice", title: "One", markdown: "Body" },
        { id: "dup", type: "mystery", title: "Two", markdown: "Body" },
      ],
    }, "lesson"))
      .toThrow(/lesson\.blocks\[0\]\.tutor is required[\s\S]*lesson\.blocks\[1\]\.id must be unique[\s\S]*lesson\.blocks\[1\]\.type is unsupported/);
  });

  it("rejects an invalid or non-positive duration on the assembled lesson", () => {
    expect(() => validateWorkbookLesson({
      id: "x", title: "Title", dek: "Dek", durationMinutes: 0, outcomes: ["Outcome."],
      blocks: [{ id: "a", type: "narrative", title: "A", markdown: "Body" }],
    }, "lesson")).toThrow(/durationMinutes/);
  });
});
